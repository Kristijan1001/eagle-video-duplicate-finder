'use strict';
// Compare phase orchestration: packs compare snapshots into SharedArrayBuffers, fans row
// ranges out to worker threads, then merges the pairs deterministically (VDF's sequential
// order) into groups with representative gating and daisy-chain validation.

const path = require('path');
const { Worker } = require('worker_threads');
const { Matcher } = require('../core/matcher');
const { GroupBuilder, daisySplit } = require('../core/grouping');
const { computePHash } = require('../core/phash');
const { verifyGrayScaleValues } = require('../core/gray');

const FRAME = 1024;
const EMB = 384;
const WORKER_FILE = path.join(__dirname, 'compare-worker.js');

function sab(bytes) { return new SharedArrayBuffer(Math.max(8, bytes)); }

/**
 * Run `task` over rows [0, rows) on `workers` threads with dynamic chunking.
 * Resolves the concatenated pairs { a, b, diff, flags, extra } (typed arrays).
 */
function runPool(workerData, task, rows, workers, { chunk = 64, onRows, isCancelled, gate } = {}) {
	return new Promise((resolve, reject) => {
		if (rows <= 0) { resolve(packEdges([])); return; }
		const n = Math.max(1, Math.min(workers, Math.ceil(rows / chunk)));
		const pool = [];
		const parts = [];
		let next = 0, done = 0, active = 0, failed = false, finished = false;
		const finish = (err) => {
			if (finished) return;
			finished = true;
			for (const w of pool) w.terminate().catch(() => {});
			if (err) reject(err); else resolve(packEdges(parts));
		};
		const feed = (w) => {
			if (failed) return;
			// Pause: a worker that finished its range waits here before taking the next one.
			if (gate && gate.paused && !(isCancelled && isCancelled()) && next < rows) { gate.wait().then(() => feed(w)); return; }
			if ((isCancelled && isCancelled()) || next >= rows) {
				if (active === 0) finish(isCancelled && isCancelled() ? Object.assign(new Error('cancelled'), { cancelled: true }) : null);
				return;
			}
			const start = next;
			const end = Math.min(rows, next + chunk);
			next = end;
			active++;
			w.postMessage({ type: 'range', task, start, end, id: start });
		};
		for (let i = 0; i < n; i++) {
			const w = new Worker(WORKER_FILE, { workerData });
			pool.push(w);
			w.on('message', (m) => {
				active--;
				if (m.type === 'error') { failed = true; finish(new Error(m.error)); return; }
				if (m.n) parts.push(m);
				done += m.rows;
				if (onRows) onRows(done, rows);
				feed(w);
			});
			w.on('error', (err) => { failed = true; finish(err); });
			feed(w);
		}
	});
}

function packEdges(parts) {
	let total = 0;
	for (const p of parts) total += p.n;
	const a = new Int32Array(total), b = new Int32Array(total), diff = new Float32Array(total), flags = new Int32Array(total), extra = new Float64Array(total);
	let o = 0;
	for (const p of parts) {
		a.set(p.A, o); b.set(p.B, o); diff.set(p.D, o); flags.set(p.F, o); extra.set(p.X, o);
		o += p.n;
	}
	return { n: total, a, b, diff, flags, extra };
}

/**
 * Snapshot one side (images or videos) into shared buffers.
 * items: [{ entry, positions:number[], inScope, folders, isImage, duration, tolerance }]
 */
function packSet(items, N, isImage, baseIndex, opts) {
	const frames = isImage ? 1 : N;
	const count = items.length;
	const set = {
		isImage, count, baseIndex,
		gray: sab(count * frames * FRAME),
		ph: opts.usePHash && !isImage ? sab(count * frames * 8) : null,
		emb: opts.useAi ? sab(count * frames * EMB) : null,
		embValid: opts.useAi ? sab(count * frames) : null,
		durations: sab(count * 8),
		tolerances: sab(count * 8),
		sizes: sab(count * 8),
		scope: sab(count),
		order: null,
		folders: new Array(count),
		devs: new Array(count),
		inos: new Array(count),
	};
	const gray = new Uint8Array(set.gray);
	const ph = set.ph ? new Uint32Array(set.ph) : null;
	const emb = set.emb ? new Int8Array(set.emb) : null;
	const embValid = set.embValid ? new Uint8Array(set.embValid) : null;
	const dur = new Float64Array(set.durations), tol = new Float64Array(set.tolerances), size = new Float64Array(set.sizes);
	const scope = new Uint8Array(set.scope);
	items.forEach((it, k) => {
		const e = it.entry;
		for (let j = 0; j < frames; j++) {
			const pos = it.positions[j];
			const g = e.gray.get(pos);
			gray.set(g, (k * frames + j) * FRAME);
			if (ph) {
				let h = e.ph.get(pos);
				if (!h) { h = computePHash(g); e.ph.set(pos, h); opts.markDirty(e); }
				ph[(k * frames + j) * 2] = h[0];
				ph[(k * frames + j) * 2 + 1] = h[1];
			}
			if (emb) {
				const v = e.emb.get(pos);
				if (v && v.length === EMB) {
					emb.set(v, (k * frames + j) * EMB);
					embValid[k * frames + j] = verifyGrayScaleValues(g) ? 1 : 0;
				}
			}
		}
		dur[k] = it.duration;
		tol[k] = it.tolerance;
		size[k] = e.size;
		scope[k] = it.inScope ? 1 : 0;
		set.folders[k] = it.folders;
		set.devs[k] = e.dev || '';
		set.inos[k] = e.ino || '';
	});
	if (!isImage) {
		const idx = Array.from({ length: count }, (_, k) => k);
		idx.sort((x, y) => dur[x] - dur[y] || x - y);
		set.order = sab(count * 4);
		new Int32Array(set.order).set(idx);
	}
	return set;
}

/** Local snapshot views (main thread) over the same shared buffers, for gating checks. */
function localSnapshots(set, N) {
	if (!set || !set.count) return [];
	const frames = set.isImage ? 1 : N;
	const gray = new Uint8Array(set.gray);
	const ph = set.ph ? new Uint32Array(set.ph) : null;
	const emb = set.emb ? new Int8Array(set.emb) : null;
	const embValid = set.embValid ? new Uint8Array(set.embValid) : null;
	const dur = new Float64Array(set.durations), tol = new Float64Array(set.tolerances), size = new Float64Array(set.sizes);
	return Array.from({ length: set.count }, (_, k) => ({
		index: set.baseIndex + k, isImage: set.isImage, duration: dur[k], tolerance: tol[k],
		gray: gray.subarray(k * frames * FRAME, (k + 1) * frames * FRAME),
		ph: ph ? ph.subarray(k * frames * 2, (k + 1) * frames * 2) : null,
		emb: emb ? emb.subarray(k * frames * EMB, (k + 1) * frames * EMB) : null,
		embValid: embValid ? embValid.subarray(k * frames, (k + 1) * frames) : null,
		folders: set.folders[k], size: size[k], dev: set.devs[k], ino: set.inos[k],
	}));
}

/**
 * ScanForDuplicates + SplitDaisyChainGroups.
 * @returns {{ groups: Array<Array<{index, difference, flags}>>, items: Array, stats }}
 *   `index` refers to the combined list [...images, ...videos].
 */
async function findDuplicates({ images, videos, N, settings, workers, onProgress, isCancelled, gate, markDirty, log }) {
	const opts = { usePHash: !!(settings.usePHash || settings.combineGrayPHash), useAi: !!settings.useAiMatching, markDirty };
	const imgSet = packSet(images, N, true, 0, opts);
	const vidSet = packSet(videos, N, false, images.length, opts);
	const workerData = { kind: 'dup', settings, N, images: imgSet, videos: vidSet };
	const total = images.length + videos.length;
	const report = (done) => onProgress && onProgress(done, total);

	const imgEdges = await runPool(workerData, 'images', images.length, workers, {
		chunk: Math.max(8, Math.ceil(images.length / (workers * 16))), isCancelled, gate,
		onRows: (d) => report(d),
	});
	const vidEdges = await runPool(workerData, 'videos', videos.length, workers, {
		chunk: Math.max(16, Math.ceil(videos.length / (workers * 32))), isCancelled, gate,
		onRows: (d) => report(images.length + d),
	});

	// Deterministic merge in VDF's sequential order: (entry index, candidate index).
	const snaps = [...localSnapshots(imgSet, N), ...localSnapshots(vidSet, N)];
	const matcher = new Matcher(settings, N);
	// Group validation (representative gate + daisy-chain split) must use the same verdict
	// that found the pairs. VDF checks those in normal orientation only, which silently
	// drops every mirrored copy from groups of 3+ even with "compare flipped" on; here the
	// check is orientation-aware whenever flipped comparison is enabled.
	const isSimilar = settings.compareHorizontallyFlipped
		? (x, y) => !!matcher.tryCheck(snaps[x], snaps[y])
		: (x, y) => matcher.isSimilar(snaps[x], snaps[y]);
	const builder = new GroupBuilder(isSimilar);
	for (const edges of [imgEdges, vidEdges]) {
		const order = Array.from({ length: edges.n }, (_, k) => k);
		order.sort((p, q) => edges.a[p] - edges.a[q] || edges.b[p] - edges.b[q]);
		for (const k of order) builder.add(edges.a[k], edges.b[k], edges.diff[k], edges.flags[k]);
	}
	if (builder.mergesBlocked && log) log('info', `Group merge validation: blocked ${builder.mergesBlocked} merge(s) where group representatives were not similar`);

	// Daisy-chain validation for groups of 3+.
	const groups = [];
	let split = 0, removed = 0, skipped = 0;
	for (const members of builder.groups()) {
		if (members.length < 3) { groups.push(members); continue; }
		const r = daisySplit(members.length, (i, j) => isSimilar(members[i].index, members[j].index), 1 << 30);
		if (r.skipped) { skipped++; groups.push(members); continue; }
		if (!r.changed) { groups.push(members); continue; }
		split++;
		removed += r.removed.length;
		for (const g of r.groups) groups.push(g.map((idx) => members[idx]));
	}
	if ((split || skipped) && log) log('info', `Daisy-chain validation: split ${split} group(s), removed ${removed} singleton item(s)${skipped ? `, skipped ${skipped} oversized group(s)` : ''}`);
	if (settings.combineGrayPHash && log) {
		let g = 0, p = 0, both = 0;
		for (const grp of groups) for (const it of grp) {
			const G = it.flags & 8, P = it.flags & 16;
			if (G && P) both++; else if (G) g++; else if (P) p++;
		}
		log('info', `Combined matching: ${both} match(es) found by both algorithms, ${g} only by grayscale, ${p} only by pHash`);
	}
	return { groups, stats: { pairs: imgEdges.n + vidEdges.n, mergesBlocked: builder.mergesBlocked, split, removed } };
}

/**
 * Audio partial-clip candidates. videos: [{ fp: Uint32Array, duration, folders }] sorted
 * by duration DESC. Returns matches [{source, clip, sim, offset}].
 */
async function findAudioCandidates(videos, s, workers, hooks) {
	let total = 0;
	for (const v of videos) total += v.fp.length;
	const fp = new Uint32Array(sab(total * 4));
	const offsets = new Int32Array(sab(videos.length * 4));
	const lengths = new Int32Array(sab(videos.length * 4));
	const durations = new Float64Array(sab(videos.length * 8));
	let o = 0;
	videos.forEach((v, i) => { fp.set(v.fp, o); offsets[i] = o; lengths[i] = v.fp.length; durations[i] = v.duration; o += v.fp.length; });
	const workerData = {
		kind: 'audio', fp: fp.buffer, offsets: offsets.buffer, lengths: lengths.buffer, durations: durations.buffer,
		folders: videos.map((v) => v.folders), folderMatchMode: s.folderMatchMode, sameFolderDepth: s.sameFolderDepth,
		minRatio: s.partialClipMinRatio, threshold: s.partialClipSimilarityThreshold,
		clipOk: videos.map((v) => v.clipOk !== false),
	};
	const edges = await runPool(workerData, 'audio', Math.max(0, videos.length - 1), workers, { chunk: 4, ...hooks });
	const matches = [];
	for (let k = 0; k < edges.n; k++) matches.push({ source: edges.a[k], clip: edges.b[k], sim: edges.diff[k], offset: edges.extra[k] });
	return matches;
}

/** AI dense partial candidates. recs[i] = { interval, count, emb, valid, sig } | null (duration DESC). */
async function findDenseCandidates(videos, recs, s, hitThreshold, hammingBound, workers, hooks) {
	let totalFrames = 0;
	for (const r of recs) if (r) totalFrames += r.count;
	const emb = new Int8Array(sab(totalFrames * EMB));
	const valid = new Uint8Array(sab(totalFrames));
	const sig = new Uint32Array(sab(totalFrames * 12 * 4));
	const offsets = new Int32Array(sab(recs.length * 4));
	const counts = new Int32Array(sab(recs.length * 4));
	const intervals = new Float64Array(sab(recs.length * 8));
	const present = new Uint8Array(sab(recs.length));
	const durations = new Float64Array(sab(recs.length * 8));
	let o = 0;
	recs.forEach((r, i) => {
		durations[i] = videos[i].duration;
		if (!r) return;
		emb.set(r.emb, o * EMB); valid.set(r.valid, o); sig.set(r.sig, o * 12);
		offsets[i] = o; counts[i] = r.count; intervals[i] = r.interval; present[i] = 1;
		o += r.count;
	});
	const workerData = {
		kind: 'dense', emb: emb.buffer, valid: valid.buffer, sig: sig.buffer, offsets: offsets.buffer, counts: counts.buffer,
		intervals: intervals.buffer, present: present.buffer, durations: durations.buffer,
		folders: videos.map((v) => v.folders), folderMatchMode: s.folderMatchMode, sameFolderDepth: s.sameFolderDepth,
		minRatio: s.partialClipMinRatio, hitThreshold, hammingBound,
		clipOk: videos.map((v) => v.clipOk !== false),
	};
	const edges = await runPool(workerData, 'dense', Math.max(0, recs.length - 1), workers, { chunk: 2, ...hooks });
	const matches = [];
	for (let k = 0; k < edges.n; k++) matches.push({ source: edges.a[k], clip: edges.b[k], sim: edges.diff[k], offset: edges.extra[k] });
	return matches;
}

module.exports = { findDuplicates, findAudioCandidates, findDenseCandidates, runPool, packSet, localSnapshots };
