'use strict';
// Background engine process. The plugin window starts it with Eagle's own runtime
// (Eagle.exe with ELECTRON_RUN_AS_NODE=1 — the same Node 16 the plugin page has), so all
// heavy work (FFmpeg orchestration, hashing, matching on worker threads, ONNX inference)
// runs outside Eagle's UI thread. Talks to the window over the fork IPC channel.

const fs = require('fs');
const path = require('path');
const { FF } = require('./ff');
const { Cache, EntryFlags } = require('./cache');
const { Scan, buildSamplePositions, grayIndex } = require('./scan');
const ai = require('./ai');
const exif = require('./exif');
const settingsMod = require('../core/settings');
const { Matcher, Flags } = require('../core/matcher');
const { percentageDifference, percentageDifferenceWithoutSpecificPixels, verifyGrayScaleValues } = require('../core/gray');
const { computePHash, hamming } = require('../core/phash');

let ff = null;
let cache = null;
let scan = null;
let ctx = null;
const logBuffer = [];

function send(msg) {
	if (process.send) {
		try { process.send(msg); } catch { /* window gone */ }
	}
}
function emit(event, data) { send({ event, data }); }
function log(level, message) {
	const entry = { t: Date.now(), level, message: String(message) };
	logBuffer.push(entry);
	if (logBuffer.length > 5000) logBuffer.shift();
	emit('log', entry);
}

process.on('uncaughtException', (err) => log('error', `Engine error: ${err && err.stack || err}`));
process.on('unhandledRejection', (err) => log('error', `Engine error: ${err && err.stack || err}`));
// The window went away (plugin closed / Eagle quit): save and exit — never linger.
process.on('disconnect', () => { shutdown(); });

function shutdown() {
	try { if (scan) scan.stop(); } catch { /* ignore */ }
	try { if (cache) cache.save(); } catch { /* ignore */ }
	try { if (ff) ff.killAll(); } catch { /* ignore */ }
	setTimeout(() => process.exit(0), 50);
}

function requireInit() {
	if (!cache || !ff) throw new Error('Engine not initialised');
}

// ── commands ──

const commands = {
	async init(a) {
		ctx = a;
		fs.mkdirSync(a.cacheDir, { recursive: true });
		ff = new FF({ ffmpeg: a.ffmpeg, ffprobe: a.ffprobe, log, tempDir: a.tempDir });
		if (cache) { try { cache.save(); } catch { /* ignore */ } }
		cache = new Cache(a.cacheDir, log);
		const r = cache.load();
		if (r.corrupt) log('warn', `${r.corrupt} cache shard(s) were unreadable and set aside.`);
		return { entries: r.entries, ffmpeg: ff.available(), node: process.versions.node };
	},

	async scan(req) {
		requireInit();
		if (scan) throw new Error('A scan is already running');
		scan = new Scan({ ff, cache, log, emit, aiDir: ctx.aiDir, tempDir: ctx.tempDir });
		try {
			return await scan.run(req);
		}
		finally {
			await scan.dispose();
			scan = null;
		}
	},
	pause() { if (scan) scan.pause(); return true; },
	resume() { if (scan) scan.resume(); return true; },
	stop() { if (scan) scan.stop(); return true; },

	/** Display thumbnails (JPEG) at the sampled positions; cached on disk. */
	async thumbs({ items, width }) {
		requireInit();
		const dir = cache.thumbDir;
		fs.mkdirSync(dir, { recursive: true });
		const out = {};
		for (const it of items) {
			const files = [];
			const positions = it.isImage ? [0] : it.positions;
			for (const pos of positions) {
				const name = `${it.id}-${String(pos).replace(/[^0-9.]/g, '_')}-${width}.jpg`;
				const file = path.join(dir, name);
				if (!fs.existsSync(file) && fs.existsSync(it.file)) {
					const jpg = await ff.jpegFrame(it.file, pos, { isImage: it.isImage, maxWidth: width });
					if (jpg) fs.writeFileSync(file, jpg);
				}
				files.push(fs.existsSync(file) ? file : null);
			}
			out[it.id] = files;
		}
		return out;
	},

	/** Full-size (or bounded) PNG frame for the thumbnail comparer. */
	async frame({ id, file, seconds, isImage, maxSide }) {
		requireInit();
		const dir = path.join(cache.thumbDir, 'full');
		fs.mkdirSync(dir, { recursive: true });
		const out = path.join(dir, `${id}-${String(seconds).replace(/[^0-9.]/g, '_')}-${maxSide || 0}.png`);
		if (!fs.existsSync(out)) {
			const png = await ff.pngFrame(file, seconds, { isImage, maxSide });
			if (!png) return null;
			fs.writeFileSync(out, png);
		}
		return out;
	},

	/** Metadata comparison: container/stream tags + EXIF. */
	async metadata({ file, isImage }) {
		requireInit();
		const tags = await ff.tags(file);
		const ex = isImage ? exif.allTags(file) : [];
		const info = isImage ? null : await ff.probe(file);
		return { tags, exif: ex, info };
	},

	/** Pair diagnostic: why are / aren't these two a match? */
	async diagnose({ a, b, settings }) {
		requireInit();
		const s = settingsMod.normalize(settings);
		const ev = settingsMod.engineView(s);
		const positions = buildSamplePositions(s.thumbnails);
		const prep = async (x) => {
			const e = cache.get(x.id);
			const isImage = x.isImage;
			let mi = e && e.mi;
			if (!mi && !isImage) mi = await ff.probe(x.file);
			const keys = isImage ? [0] : positions.map((p) => grayIndex(mi ? mi.duration : 0, p, s.maxSamplingDurationSeconds));
			const frames = [];
			for (const k of keys) {
				let g = e && e.gray.get(k);
				if (!g) g = await ff.grayFrame(x.file, k, { isImage, ext: x.ext });
				frames.push(g || null);
			}
			return { e, mi, keys, frames, isImage, duration: mi ? mi.duration : 0, folders: x.folders || [] };
		};
		const A = await prep(a), B = await prep(b);
		const report = { positionsA: A.keys, positionsB: B.keys, durationA: A.duration, durationB: B.duration, frames: [], gates: {} };
		if (A.isImage !== B.isImage) { report.verdict = 'Images are only compared with images, videos only with videos.'; return report; }
		const tolA = settingsMod.durationToleranceSeconds(s, A.duration), tolB = settingsMod.durationToleranceSeconds(s, B.duration);
		report.gates.duration = A.isImage ? { pass: true } : { pass: Math.abs(A.duration - B.duration) <= Math.min(tolA, tolB), diff: Math.abs(A.duration - B.duration), allowed: Math.min(tolA, tolB) };
		const n = Math.min(A.frames.length, B.frames.length);
		for (let j = 0; j < n; j++) {
			const fa = A.frames[j], fb = B.frames[j];
			if (!fa || !fb) { report.frames.push({ missing: true }); continue; }
			const ha = computePHash(fa), hb = computePHash(fb);
			report.frames.push({
				grayDiff: percentageDifference(fa, fb),
				grayDiffMasked: (s.ignoreBlackPixels || s.ignoreWhitePixels) ? percentageDifferenceWithoutSpecificPixels(fa, fb, s.ignoreBlackPixels, s.ignoreWhitePixels) : null,
				pHashDistance: hamming(ha[0], ha[1], hb[0], hb[1]),
				darkA: !verifyGrayScaleValues(fa), darkB: !verifyGrayScaleValues(fb),
			});
		}
		if (A.frames.some((x) => !x) || B.frames.some((x) => !x)) { report.verdict = 'Frames could not be sampled for one of the files.'; return report; }
		const snap = (X) => {
			const frames = X.isImage ? 1 : s.thumbnails;
			const gray = new Uint8Array(frames * 1024);
			const ph = new Uint32Array(frames * 2);
			X.frames.forEach((g, j) => { gray.set(g, j * 1024); const h = computePHash(g); ph[2 * j] = h[0]; ph[2 * j + 1] = h[1]; });
			let emb = null, embValid = null;
			if (X.e && s.useAiMatching) {
				emb = new Int8Array(frames * 384); embValid = new Uint8Array(frames);
				X.keys.forEach((k, j) => { const v = X.e.emb.get(k); if (v) { emb.set(v, j * 384); embValid[j] = verifyGrayScaleValues(X.frames[j]) ? 1 : 0; } });
			}
			return { isImage: X.isImage, duration: X.duration, tolerance: settingsMod.durationToleranceSeconds(s, X.duration), gray, ph, emb, embValid, folders: X.folders, size: X.e ? X.e.size : 0, dev: X.e ? X.e.dev : '', ino: X.e ? X.e.ino : '' };
		};
		const sa = snap(A), sb = snap(B);
		const m = new Matcher(ev, s.thumbnails);
		report.gates.folder = { pass: m.passesFolderGate(sa, sb), mode: s.folderMatchMode };
		const normal = m.check(sa, null, null, sb);
		report.normal = { match: normal, difference: m.difference, algorithms: m.algorithms, aiMatched: m.aiMatched };
		if (s.compareHorizontallyFlipped) {
			m.ensureFlipped(sa);
			const fl = m.check(sa, sa.flippedGray, sa.flippedPh || null, sb);
			report.flipped = { match: fl, difference: m.difference, algorithms: m.algorithms };
		}
		if (s.useAiMatching) report.aiSimilarity = m.aiSimilarity(sa, sb);
		const final = m.comparePair(sa, sb);
		report.result = final ? { match: true, similarity: (1 - final.difference) * 100, flipped: !!(final.flags & Flags.Flipped), ai: !!(final.flags & Flags.AiMatched) } : { match: false };
		report.threshold = s.percent;
		return report;
	},

	// ── database ──
	'db.stats'() { requireInit(); return { ...cache.stats(), dir: cache.dir, notAMatch: cache.lists.notAMatch.length }; },
	'db.save'() { requireInit(); return cache.save(); },
	/** Remove entries whose item left the library (tombstones kept when remembering deleted content). */
	'db.cleanup'({ allIds, keepTombstones }) {
		requireInit();
		const all = new Set(allIds);
		let removed = 0;
		for (const e of [...cache.entries.values()]) {
			if (all.has(e.id)) continue;
			if (keepTombstones && (e.flags & EntryFlags.Tombstone)) continue;
			cache.delete(e.id);
			removed++;
		}
		// thumbnails of removed entries
		try {
			for (const f of fs.readdirSync(cache.thumbDir)) {
				const id = f.split('-')[0];
				if (!cache.entries.has(id) && f.endsWith('.jpg')) fs.unlinkSync(path.join(cache.thumbDir, f));
			}
		}
		catch { /* no thumbs */ }
		cache.save();
		return removed;
	},
	'db.clear'() { requireInit(); cache.clearAll(); cache.save(); return true; },
	'db.export'({ file }) { requireInit(); return cache.exportJson(file); },
	'db.import'({ file }) { requireInit(); const n = cache.importJson(file); cache.save(); return n; },
	'db.list'({ offset = 0, limit = 200, filter = '' }) {
		requireInit();
		const q = String(filter || '').toLowerCase();
		const all = [...cache.entries.values()].filter((e) => !q || (e.name || '').toLowerCase().includes(q) || e.id.toLowerCase().includes(q));
		return {
			total: all.length,
			rows: all.slice(offset, offset + limit).map((e) => ({
				id: e.id, name: e.name, ext: e.ext, size: e.size, flags: e.flags, duration: e.mi ? e.mi.duration : 0,
				frames: e.gray.size, audio: e.audio ? e.audio.length : null, emb: e.emb.size, isImage: !!(e.flags & EntryFlags.IsImage),
			})),
		};
	},
	'db.clearEntry'({ ids }) { requireInit(); for (const id of ids) { const e = cache.get(id); if (e) cache.clearDerived(e); } cache.save(); return true; },
	'db.deleteEntry'({ ids }) { requireInit(); for (const id of ids) cache.delete(id); cache.save(); return true; },
	'db.exclude'({ ids, value }) {
		requireInit();
		for (const id of ids) {
			const e = cache.getOrCreate(id);
			if (value) e.flags |= EntryFlags.ManuallyExcluded; else e.flags &= ~EntryFlags.ManuallyExcluded;
			cache.markDirty(id);
		}
		cache.save();
		return true;
	},
	'db.excludedList'() {
		requireInit();
		return [...cache.entries.values()].filter((e) => e.flags & EntryFlags.ManuallyExcluded).map((e) => ({ id: e.id, name: e.name, ext: e.ext }));
	},
	'db.markDeleted'({ ids, remember }) {
		requireInit();
		for (const id of ids) {
			const e = cache.get(id);
			if (!e) continue;
			if (remember) { e.flags |= EntryFlags.Tombstone; cache.markDirty(id); }
		}
		cache.save();
		return true;
	},
	'db.restoreDeleted'({ ids }) {
		requireInit();
		for (const id of ids) { const e = cache.get(id); if (e && (e.flags & EntryFlags.Tombstone)) { e.flags &= ~EntryFlags.Tombstone; cache.markDirty(id); } }
		cache.save();
		return true;
	},
	'lists.notAMatch.add'({ ids }) { requireInit(); cache.lists.notAMatch.push([...new Set(ids)]); cache.saveLists(); return cache.lists.notAMatch.length; },
	'lists.notAMatch.remove'({ index }) { requireInit(); cache.lists.notAMatch.splice(index, 1); cache.saveLists(); return true; },
	'lists.notAMatch.get'() { requireInit(); return cache.lists.notAMatch; },
	'lists.notAMatch.prune'({ allIds }) {
		requireInit();
		const all = new Set(allIds);
		const before = cache.lists.notAMatch.length;
		cache.lists.notAMatch = cache.lists.notAMatch.filter((g) => g.every((id) => all.has(id)));
		cache.saveLists();
		return before - cache.lists.notAMatch.length;
	},

	// ── results persistence ──
	'results.save'({ name, data }) {
		requireInit();
		fs.mkdirSync(cache.resultsDir, { recursive: true });
		const file = path.join(cache.resultsDir, `${name || 'last'}.json`);
		const tmp = `${file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(data));
		fs.renameSync(tmp, file);
		return file;
	},
	'results.load'({ name }) {
		requireInit();
		const file = path.join(cache.resultsDir, `${name || 'last'}.json`);
		if (!fs.existsSync(file)) return null;
		try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
	},

	// ── AI ──
	async 'ai.status'() { return ai.status(ctx.aiDir); },
	async 'ai.download'() {
		const file = await ai.downloadModel(ctx.aiDir, (got, total) => emit('aiDownload', { got, total }));
		return file;
	},
	async 'ai.remove'() {
		for (const f of [ai.modelPath(ctx.aiDir), `${ai.modelPath(ctx.aiDir)}.verified`]) { try { fs.unlinkSync(f); } catch { /* none */ } }
		return true;
	},

	logs() { return logBuffer.slice(-2000); },
	ping() { return { ok: true, scanning: !!scan }; },
	shutdown() { shutdown(); return true; },
};

process.on('message', async (msg) => {
	if (!msg || typeof msg !== 'object' || !msg.cmd) return;
	const fn = commands[msg.cmd];
	if (!fn) { send({ id: msg.id, ok: false, error: `Unknown command ${msg.cmd}` }); return; }
	try {
		const result = await fn(msg.args || {});
		send({ id: msg.id, ok: true, result });
	}
	catch (err) {
		send({ id: msg.id, ok: false, error: err && err.message || String(err), stack: err && err.stack });
	}
});

emit('ready', { pid: process.pid, node: process.versions.node });
