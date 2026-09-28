'use strict';
// Scan orchestration — the Eagle counterpart of VDF.Core/ScanEngine.cs StartSearch /
// GatherInfos / StartCompare (VideoDuplicateFinder, AGPL-3.0).
//
// Phases: prepare (validate scope entries, refresh changed files) → analyse (probe, sample
// gray frames, AI frames, audio fingerprints; drive-aware concurrency) → compare (worker
// threads) → partial clips (audio) → partial clips (AI) → results.

const fs = require('fs');
const path = require('path');
const { f } = require('../core/f32');
const settingsMod = require('../core/settings');
const { verifyGrayScaleValues, verifyRgbFrameValues, percentageDifference } = require('../core/gray');
const { computePHash, isDuplicateByPercent } = require('../core/phash');
const { ChromaContext, isSilentFingerprint, FRAME_SIZE } = require('../core/chroma');
const partial = require('../core/partial');
const results = require('../core/results');
const { Flags } = require('../core/matcher');
const { signatureHammingBound } = require('../core/ai/embedding-math');
const { EntryFlags, osHash } = require('./cache');
const { isImageExt, isVideoExt } = require('./ff');
const drive = require('./drive');
const compare = require('./compare');
const ai = require('./ai');
const exif = require('./exif');

/** ScanEngine.BuildSamplePositions: k/(N+1) accumulated in float32. */
function buildSamplePositions(count) {
	const out = [];
	let c = 0;
	const step = f(1 / (count + 1));
	for (let i = 0; i < count; i++) { c = f(c + step); out.push(c); }
	return out;
}

/** FileEntry.GetGrayBytesIndex(position, maxSamplingDurationSeconds). */
function grayIndex(durationSeconds, position, maxSampling) {
	let d = durationSeconds;
	if (maxSampling > 0 && d > maxSampling) d = maxSampling;
	return d * position;
}

/** FileSystemName.MatchesSimpleExpression (Windows semantics: case-insensitive, * and ?). */
function wildcardMatch(pattern, text) {
	const re = new RegExp('^' + String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'is');
	return re.test(text);
}

function bytesToMegaBytes(n) { return Math.trunc(f(f(n / 1024) / 1024)); }

class Gate {
	constructor() { this.paused = false; this.waiters = []; }
	pause() { this.paused = true; }
	resume() { this.paused = false; const w = this.waiters; this.waiters = []; w.forEach((r) => r()); }
	wait() { return this.paused ? new Promise((r) => this.waiters.push(r)) : Promise.resolve(); }
}

class Scan {
	/**
	 * @param {{ff, cache, log, emit, aiDir, tempDir}} ctx
	 */
	constructor(ctx) {
		this.ff = ctx.ff;
		this.cache = ctx.cache;
		this.log = ctx.log;
		this.emit = ctx.emit;
		this.aiDir = ctx.aiDir;
		this.cancelled = false;
		this.gate = new Gate();
		this.phase = null;
		this.excludedCounts = new Map();
	}

	stop() { this.cancelled = true; this.gate.resume(); this.ff.killAll(); }
	pause() { this.gate.pause(); this.progress(true); }
	resume() { this.gate.resume(); this.progress(true); }

	isCancelled() { return this.cancelled; }

	// ── progress ──
	startPhase(key, label, total) {
		this.phase = { key, label, total, done: 0, started: Date.now(), file: '', sub: '' };
		this.progress(true);
	}
	tick(file, n = 1) {
		if (!this.phase) return;
		this.phase.done += n;
		if (file) this.phase.file = file;
		this.progress(false);
	}
	progress(force) {
		const now = Date.now();
		if (!force && this.lastEmit && now - this.lastEmit < 200) return;
		this.lastEmit = now;
		const p = this.phase;
		if (!p) return;
		const elapsed = now - p.started;
		const remaining = p.total - (p.done + 1);
		const eta = remaining > 0 && p.done >= 0 && elapsed > 0 ? Math.round(elapsed * remaining / (p.done + 1)) : 0;
		this.emit('progress', {
			phase: p.key, label: p.label, done: Math.min(p.done, p.total), total: p.total, file: p.file, sub: p.sub,
			elapsedMs: now - this.startedAt, phaseElapsedMs: elapsed, etaMs: eta, paused: this.gate.paused,
		});
	}

	excluded(entryName, reason) {
		this.excludedCounts.set(reason, (this.excludedCounts.get(reason) || 0) + 1);
		if (this.s.logExcludedFiles && this.excludedCounts.get(reason) <= 50)
			this.log('warn', `Excluded '${entryName}': ${reason}`);
	}

	checkpoint() {
		const minutes = this.s.databaseCheckpointIntervalMinutes;
		if (!minutes || minutes <= 0) return;
		const now = Date.now();
		if (now - this.lastCheckpoint < minutes * 60000) return;
		this.lastCheckpoint = now;
		try {
			const n = this.cache.save();
			if (n) this.log('info', `Checkpoint: fingerprint cache saved (${n} shard(s)).`);
		}
		catch (err) { this.log('error', `Checkpoint failed: ${err.message}`); }
	}

	/**
	 * @param {object} req {
	 *   settings, libraryPath, items:[{id,name,ext,size,width,height,folders:[paths],importedAt,inScope}],
	 *   allIds: string[] | null, compareOnly: bool }
	 */
	async run(req) {
		this.startedAt = Date.now();
		this.lastCheckpoint = Date.now();
		this.s = settingsMod.normalize(req.settings);
		const s = this.s;
		const ev = settingsMod.engineView(s);
		this.ev = ev;
		this.ff.configure(s);
		this.positions = buildSamplePositions(s.thumbnails);
		this.libraryPath = req.libraryPath;
		this.log('info', `Scan started: ${req.items.length} item(s), ${s.thumbnails} sample position(s), threshold ${s.percent}%, algorithm ${s.combineGrayPHash ? 'grayscale+pHash' : s.usePHash ? 'pHash' : 'grayscale'}, flipped ${s.compareHorizontallyFlipped ? 'on' : 'off'}, ignore black ${s.ignoreBlackPixels ? 'on' : 'off'}, ignore white ${s.ignoreWhitePixels ? 'on' : 'off'}, AI ${s.useAiMatching ? 'on' : 'off'}`);

		// ── Prepare ──
		this.startPhase('prepare', 'Preparing', req.items.length);
		const work = [];
		const seen = new Set();
		for (const it of req.items) {
			if (this.cancelled) break;
			const w = this.prepareItem(it);
			seen.add(it.id);
			if (w) work.push(w);
			this.tick(null);
		}
		// Items that left the library (trashed/deleted): keep as tombstones when remembering
		// deleted content; otherwise leave them for the explicit cleanup.
		if (req.allIds) {
			const all = new Set(req.allIds);
			for (const e of this.cache.entries.values()) {
				if (all.has(e.id)) { if (e.flags & EntryFlags.Tombstone) { e.flags &= ~EntryFlags.Tombstone; this.cache.markDirty(e.id); } continue; }
				if (s.rememberDeletedContent && !(e.flags & EntryFlags.Tombstone)) { e.flags |= EntryFlags.Tombstone; this.cache.markDirty(e.id); }
			}
		}

		// ── Analyse (GatherInfos) ──
		if (!req.compareOnly && !this.cancelled) await this.gatherInfos(work);
		if (this.embedQueue) await this.embedQueue.complete();
		try { this.cache.save(); } catch (err) { this.log('error', `Saving the fingerprint cache failed: ${err.message}`); }
		if (this.cancelled) return this.aborted();

		// ── Compare ──
		const valid = work.filter((w) => !w.invalid);
		if (s.rememberDeletedContent || s.includeNonExistingFiles) {
			// tombstones participate (never in scope, so they only join groups through a live item)
			for (const e of this.cache.entries.values()) {
				if (!(e.flags & EntryFlags.Tombstone) || seen.has(e.id)) continue;
				if (!s.rememberDeletedContent) continue;
				valid.push({ entry: e, isImage: !!(e.flags & EntryFlags.IsImage), inScope: false, folders: [], tombstone: true });
			}
		}
		const duplicateResult = await this.compareDuplicates(valid);
		if (this.cancelled) return this.aborted();

		let groups = duplicateResult.groups; // arrays of {entry, difference, flags, offset}
		if (s.enablePartialClipDetection && !this.cancelled) groups = groups.concat(await this.audioPartials(valid, groups));
		if (this.cancelled) return this.aborted();
		if (s.enableAiPartialDetection && !this.cancelled) groups = groups.concat(await this.aiPartials(valid, groups));
		if (this.cancelled) return this.aborted();

		try { this.cache.save(); } catch (err) { this.log('error', `Saving the fingerprint cache failed: ${err.message}`); }
		return this.buildResults(groups, valid);
	}

	aborted() {
		try { this.cache.save(); } catch { /* ignore */ }
		this.log('info', 'Scan aborted.');
		return { aborted: true };
	}

	/** Validate one Eagle item and set up its cache entry. Returns a work record or null. */
	prepareItem(it) {
		const s = this.s;
		const ext = String(it.ext || '').toLowerCase();
		let kind = null;
		let file = path.join(this.libraryPath, 'images', `${it.id}.info`, `${it.name}.${it.ext}`);
		if (isVideoExt(ext)) kind = s.includeVideos ? 'video' : null;
		else if (isImageExt(ext)) kind = s.includeImages ? 'image' : null;
		else if (s.includeOtherFormatsViaThumbnail && s.includeImages) {
			const thumb = path.join(this.libraryPath, 'images', `${it.id}.info`, `${it.name}_thumbnail.png`);
			if (fs.existsSync(thumb)) { kind = 'image'; file = thumb; }
		}
		if (!kind) return null;
		const e = this.cache.getOrCreate(it.id);
		if (e.name !== it.name || e.ext !== it.ext || e.path !== file) { e.name = it.name; e.ext = it.ext; e.path = file; this.cache.markDirty(e.id); }
		if (kind === 'image') e.flags |= EntryFlags.IsImage; else e.flags &= ~EntryFlags.IsImage;
		e.dateCreated = it.importedAt || e.dateCreated;
		const w = { entry: e, item: it, file, isImage: kind === 'image', inScope: it.inScope !== false, folders: it.folders || [], invalid: false };
		const reject = (reason) => { w.invalid = true; this.excluded(it.name, reason); return w; };

		if (e.flags & EntryFlags.ManuallyExcluded) return reject('file has been manually excluded');
		if (e.flags & EntryFlags.TooDark) return reject('file is marked as too dark');
		if (s.filterByFileSize) {
			const mb = bytesToMegaBytes(it.size || e.size || 0);
			if (mb > s.maximumFileSize || mb < s.minimumFileSize) return reject('file size is outside the configured range');
		}
		const virtualPaths = (w.folders.length ? w.folders : ['']).map((fp) => `${fp ? fp + '/' : ''}${it.name}.${it.ext}`);
		virtualPaths.push(file);
		if (s.filterByFilePathContains && s.filePathContainsTexts.length) {
			if (!s.filePathContainsTexts.some((p) => virtualPaths.some((v) => wildcardMatch(p, v)))) return reject('file path does not match the required patterns');
		}
		if (s.filterByFilePathNotContains && s.filePathNotContainsTexts.length) {
			if (s.filePathNotContainsTexts.some((p) => virtualPaths.some((v) => wildcardMatch(p, v)))) return reject('file path matches an excluded pattern');
		}
		return w;
	}

	// ── GatherInfos ──

	async gatherInfos(work) {
		const s = this.s;
		const pending = work.filter((w) => !w.invalid);
		const cls = await drive.classify(this.libraryPath, s.driveTypeOverride, pending.slice(0, 50).map((w) => w.file));
		const parallel = drive.readParallelism(cls.fast, s.maxDegreeOfParallelism, s.hddMaxDegreeOfParallelism);
		this.log('info', `Library drive: ${cls.fast ? 'fast' : 'slow'} (${cls.source}); reading ${parallel} file(s) at a time.`);

		if (s.useAiMatching || s.enableAiPartialDetection) await this.startEmbedder();

		this.startPhase('analyse', 'Analysing files', pending.length);
		let next = 0;
		const worker = async () => {
			while (!this.cancelled) {
				await this.gate.wait();
				if (this.cancelled) break;
				const i = next++;
				if (i >= pending.length) break;
				const w = pending[i];
				try { await this.processEntry(w); }
				catch (err) {
					w.invalid = true;
					if (this.cancelled) break;
					this.log('error', `Unhandled error processing '${w.item.name}': ${err && err.stack || err}`);
					w.entry.flags |= EntryFlags.ThumbnailError;
					this.cache.markDirty(w.entry.id);
				}
				this.tick(w.item.name);
				this.checkpoint();
			}
		};
		await Promise.all(Array.from({ length: parallel }, worker));
		if (this.excludedCounts.size && s.logExcludedFiles)
			for (const [reason, n] of this.excludedCounts) this.log('warn', `Excluded: ${reason} — ${n} file(s)`);
	}

	async processEntry(w) {
		const s = this.s;
		const e = w.entry;
		let st = null;
		try { st = await fs.promises.stat(w.file, { bigint: true }); } catch { st = null; }

		if (!st) {
			e.flags |= EntryFlags.Missing;
			this.cache.markDirty(e.id);
			if (s.includeNonExistingFiles && this.hasCompleteGray(e, w.isImage)) return;
			w.invalid = true;
			this.excluded(w.item.name, 'file does not exist');
			return;
		}
		if (e.flags & EntryFlags.Missing) { e.flags &= ~EntryFlags.Missing; this.cache.markDirty(e.id); }

		const size = Number(st.size);
		const mtime = Number(st.mtimeMs);
		// RefreshExistingEntry: size changed → re-analyse; same size but new timestamp →
		// keep the analysis only when the content hash proves the bytes unchanged.
		if (e.size && e.size !== size) this.cache.clearDerived(e);
		else if (e.mtime && e.mtime !== mtime) {
			const h = osHash(w.file);
			if (!(h && e.osHash && h === e.osHash)) this.cache.clearDerived(e);
			if (h) e.osHash = h;
		}
		if (e.size !== size || e.mtime !== mtime) { e.size = size; e.mtime = mtime; this.cache.markDirty(e.id); }
		e.dateModified = Math.round(Number(st.mtimeMs));
		e.dev = String(st.dev); e.ino = String(st.ino);

		if (s.ignoreReparsePoints) {
			try { if ((await fs.promises.lstat(w.file)).isSymbolicLink()) { w.invalid = true; this.excluded(w.item.name, 'file is a reparse point'); return; } } catch { /* ignore */ }
		}
		if (s.ignoreReadOnlyFolders && (Number(st.mode) & 0o200) === 0) { w.invalid = true; this.excluded(w.item.name, 'file is read-only'); return; }

		if ((e.flags & EntryFlags.ThumbnailError) && !s.alwaysRetryFailedSampling) {
			w.invalid = true;
			this.excluded(w.item.name, 'previous thumbnail sampling failed and retry is disabled');
			return;
		}
		if (e.flags & EntryFlags.ThumbnailError) { e.flags &= ~EntryFlags.ThumbnailError; this.cache.markDirty(e.id); }

		if (w.isImage) await this.processImage(w);
		else await this.processVideo(w);
		if (w.invalid) return;
		if (!w.isImage) await this.audioFingerprint(w);
	}

	hasCompleteGray(e, isImage) {
		if (isImage) { const g = e.gray.get(0); return !!(g && g.length === 1024); }
		if (!e.mi) return false;
		return this.positions.every((p) => { const g = e.gray.get(grayIndex(e.mi.duration, p, this.s.maxSamplingDurationSeconds)); return g && g.length === 1024; });
	}

	wantsEmbedding(e, key) {
		return !!this.embedQueue && !this.embedQueue.faulted && this.s.useAiMatching && !e.emb.has(key);
	}

	async processImage(w) {
		const s = this.s;
		const e = w.entry;
		const it = w.item;
		this.phase.sub = 'Sampling image';
		if (!e.gray.size) {
			let gray, rgb = null;
			const wantRgb = this.wantsEmbedding(e, 0);
			if (wantRgb && !s.customFFArguments) ({ gray, rgb } = await this.ff.grayAndRgb(w.file, 0, { isImage: true, ext: it.ext }));
			else gray = await this.ff.grayFrame(w.file, 0, { isImage: true, ext: it.ext });
			if (!gray) {
				if (this.cancelled) { w.invalid = true; return; } // a stopped scan must not poison the entry
				e.flags |= EntryFlags.ThumbnailError; this.cache.markDirty(e.id);
				w.invalid = true; return;
			}
			e.mi = { duration: 0, streams: [{ width: it.width || 0, height: it.height || 0, codecType: 'video', codecName: String(it.ext || '').toLowerCase() }] };
			if (s.useExifCreationDate) {
				let d = exif.dateTaken(w.file);
				if (!d && /^hei[cf]$/i.test(it.ext)) d = await this.ff.creationTime(w.file);
				e.exifDate = d || 0;
			}
			if (!verifyGrayScaleValues(gray)) {
				e.flags |= EntryFlags.TooDark; this.cache.markDirty(e.id);
				this.log('warn', `Graybytes too dark of: ${it.name}`);
				w.invalid = true; return;
			}
			e.gray.set(0, gray);
			this.cache.markDirty(e.id);
			if (wantRgb) {
				if (!rgb) rgb = await this.ff.rgbFrame(w.file, 0, { isImage: true });
				if (rgb) await this.embedQueue.submit(e, 0, rgb);
			}
		}
		else {
			if (!e.mi) e.mi = { duration: 0, streams: [{ width: it.width || 0, height: it.height || 0, codecType: 'video' }] };
			if (this.wantsEmbedding(e, 0)) {
				const rgb = await this.ff.rgbFrame(w.file, 0, { isImage: true });
				if (rgb) await this.embedQueue.submit(e, 0, rgb);
			}
		}
		if (s.useExifCreationDate && e.exifDate) e.dateCreated = e.exifDate;
	}

	async processVideo(w) {
		const s = this.s;
		const e = w.entry;
		if (!e.mi) {
			this.phase.sub = 'Probing';
			const info = await this.ff.probe(w.file);
			if (!info) {
				if (this.cancelled) { w.invalid = true; return; }
				e.flags |= EntryFlags.MetadataError; this.cache.markDirty(e.id);
				w.invalid = true; return;
			}
			e.mi = info;
			this.cache.markDirty(e.id);
		}
		if (s.useExifCreationDate && !e.exifDate) {
			const d = await this.ff.creationTime(w.file);
			if (d) { e.exifDate = d; this.cache.markDirty(e.id); }
		}
		if (s.useExifCreationDate && e.exifDate) e.dateCreated = e.exifDate;

		const keys = this.positions.map((p) => grayIndex(e.mi.duration, p, s.maxSamplingDurationSeconds));
		const missing = keys.filter((k) => !e.gray.has(k)).length;
		let tooDark = 0;
		for (let i = 0; i < keys.length; i++) {
			if (this.cancelled) return;
			const key = keys[i];
			const needGray = !e.gray.has(key);
			const needRgb = this.wantsEmbedding(e, key);
			this.phase.sub = `Sampling frame ${i + 1}/${keys.length}`;
			if (needGray && needRgb && !s.customFFArguments) {
				const { gray, rgb } = await this.ff.grayAndRgb(w.file, key);
				if (!gray) { this.failSampling(w); return; }
				if (!verifyGrayScaleValues(gray)) tooDark++;
				e.gray.set(key, gray); e.ph.set(key, computePHash(gray)); this.cache.markDirty(e.id);
				if (rgb) await this.embedQueue.submit(e, key, rgb);
				continue;
			}
			if (needGray) {
				const gray = await this.ff.grayFrame(w.file, key);
				if (!gray) { this.failSampling(w); return; }
				if (!verifyGrayScaleValues(gray)) tooDark++;
				e.gray.set(key, gray); e.ph.set(key, computePHash(gray)); this.cache.markDirty(e.id);
			}
			if (needRgb) {
				const rgb = await this.ff.rgbFrame(w.file, key);
				if (rgb) await this.embedQueue.submit(e, key, rgb);
			}
		}
		if (missing > 0 && tooDark === missing) {
			e.flags |= EntryFlags.TooDark; this.cache.markDirty(e.id);
			this.log('warn', `Graybytes too dark of: ${w.item.name}`);
			w.invalid = true;
		}
	}

	failSampling(w) {
		w.invalid = true;
		if (this.cancelled) return; // killed by Stop, the file itself is fine
		w.entry.flags |= EntryFlags.ThumbnailError;
		this.cache.markDirty(w.entry.id);
	}

	/** ScanEngine.NeedsAudioFingerprint + ExtractAudioFingerprint. */
	async audioFingerprint(w) {
		const s = this.s;
		const e = w.entry;
		if (!s.enablePartialClipDetection) return;
		if (e.flags & (EntryFlags.NoAudioTrack | EntryFlags.SilentAudioTrack)) return;
		if ((e.flags & EntryFlags.AudioFingerprintError) && !s.alwaysRetryFailedSampling) return;
		if (e.audio) return;
		const hasAudio = (e.mi && e.mi.streams || []).some((st) => String(st.codecType).toLowerCase() === 'audio');
		if (!hasAudio) { e.flags |= EntryFlags.NoAudioTrack; e.audio = new Uint32Array(0); this.cache.markDirty(e.id); return; }
		this.phase.sub = 'Audio fingerprint';
		const ctx = new ChromaContext();
		const r = await this.ff.pcm(w.file, (pcm) => ctx.feed(pcm));
		if (this.cancelled) return; // a stopped scan must not poison the entry
		e.flags &= ~EntryFlags.AudioFingerprintError;
		if (!r.ok || ctx.totalSamples * 2 < FRAME_SIZE * 2) {
			e.flags |= r.noAudio ? EntryFlags.NoAudioTrack : EntryFlags.AudioFingerprintError;
			e.audio = new Uint32Array(0);
		}
		else {
			ctx.finish();
			const fp = ctx.fingerprint();
			if (fp.length === 0) { e.flags |= EntryFlags.NoAudioTrack; e.audio = new Uint32Array(0); }
			else if (isSilentFingerprint(fp)) { e.flags |= EntryFlags.SilentAudioTrack; e.audio = new Uint32Array(0); }
			else e.audio = fp;
		}
		this.cache.markDirty(e.id);
	}

	// ── AI embedding pipeline (EmbeddingPipeline) ──

	async startEmbedder() {
		const st = await ai.status(this.aiDir);
		if (!st.runtime || !st.model) {
			this.log('warn', 'AI matching is enabled but the AI model is not installed — the AI pass will abstain. Install it from Settings → AI.');
			return;
		}
		try {
			const embedder = await ai.Embedder.create(st.modelPath);
			this.embedder = embedder;
			this.embedQueue = new EmbedQueue(embedder, this.cache, this.log);
		}
		catch (err) {
			this.log('error', `AI model could not be loaded: ${err.message}`);
		}
	}

	// ── Compare (ScanForDuplicates) ──

	snapshotItem(w) {
		const e = w.entry;
		if (!e.mi) return null;
		if (e.flags & (EntryFlags.ThumbnailError | EntryFlags.TooDark | EntryFlags.ManuallyExcluded)) return null;
		let positions;
		if (w.isImage) positions = [0];
		else positions = this.positions.map((p) => grayIndex(e.mi.duration, p, this.s.maxSamplingDurationSeconds));
		for (const k of positions) { const g = e.gray.get(k); if (!g || g.length !== 1024) return null; }
		return {
			entry: e, positions, inScope: w.inScope, folders: w.folders, isImage: w.isImage,
			duration: w.isImage ? 0 : e.mi.duration,
			tolerance: w.isImage ? 0 : settingsMod.durationToleranceSeconds(this.s, e.mi.duration),
		};
	}

	async compareDuplicates(valid) {
		const images = [], videos = [];
		let dropped = 0;
		for (const w of valid) {
			const snap = this.snapshotItem(w);
			if (!snap) { dropped++; continue; }
			(snap.isImage ? images : videos).push(snap);
		}
		if (dropped) this.log('warn', `Excluded ${dropped} file(s) with incomplete cached scan data for the current sample positions. Rescan to repopulate.`);
		this.compareList = [...images, ...videos];
		const workers = drive.matchingParallelism(this.s.matchingMaxDegreeOfParallelism);
		this.log('info', `Comparing ${images.length} image(s) and ${videos.length} video(s) on ${workers} worker(s).`);
		this.startPhase('compare', 'Comparing', images.length + videos.length);
		let res;
		try {
			res = await compare.findDuplicates({
				images, videos, N: this.s.thumbnails, settings: this.ev, workers,
				onProgress: (done) => { this.phase.done = done; this.progress(false); },
				isCancelled: () => this.cancelled, gate: this.gate,
				markDirty: (e) => this.cache.markDirty(e.id),
				log: this.log,
			});
		}
		catch (err) {
			if (err && err.cancelled) return { groups: [] };
			throw err;
		}
		const groups = res.groups.map((members) => members.map((m) => ({
			entry: this.compareList[m.index].entry, difference: m.difference, flags: m.flags, offset: 0,
		})));
		this.log('info', `Found ${groups.length} duplicate group(s) from ${res.stats.pairs} matching pair(s).`);
		return { groups };
	}

	groupedIds(groups) {
		const set = new Set();
		for (const g of groups) for (const m of g) set.add(m.entry.id);
		return set;
	}

	// ── Partial clips: audio (ScanForPartialDuplicates) ──

	async audioPartials(valid, groups) {
		const s = this.s;
		const already = this.groupedIds(groups);
		const vids = valid
			.filter((w) => !w.isImage && !w.invalid && !w.tombstone && w.entry.mi && w.entry.audio && w.entry.audio.length >= 2
				&& !(w.entry.flags & EntryFlags.SilentAudioTrack) && !isSilentFingerprint(w.entry.audio))
			.sort((a, b) => b.entry.mi.duration - a.entry.mi.duration);
		// VDF skips every video that is already in a group, so a clip whose source already had a
		// duplicate could never be found. Here grouped videos still act as sources; only videos
		// that are not grouped yet can be clips, and a found clip joins its source's group.
		const clipOk = vids.map((w) => !already.has(w.entry.id));
		if (vids.length < 2 || !clipOk.some(Boolean)) { this.log('info', 'Partial clip detection: fewer than 2 eligible videos, skipping.'); return []; }
		this.startPhase('partial', 'Partial clips (audio)', vids.length - 1);
		const workers = drive.matchingParallelism(s.matchingMaxDegreeOfParallelism);
		let matches;
		try {
			matches = await compare.findAudioCandidates(vids.map((w, k) => ({ fp: w.entry.audio, duration: w.entry.mi.duration, folders: w.folders, clipOk: clipOk[k] })), this.ev, workers, {
				onRows: (d) => { this.phase.done = d; this.progress(false); }, isCancelled: () => this.cancelled, gate: this.gate,
			});
		}
		catch (err) { if (err && err.cancelled) return []; throw err; }
		let assignments;
		if (s.partialClipRequireVisualMatch) {
			this.startPhase('partialVerify', 'Verifying partial clips', matches.length);
			assignments = await partial.assignAndVerify(matches, async (a) => {
				await this.gate.wait();
				const r = await this.verifyPartialVisually(vids[a.source], vids[a.clip], a.offset);
				this.tick(vids[a.clip].item && vids[a.clip].item.name);
				return r;
			}, () => this.cancelled);
		}
		else assignments = partial.assignGroups(matches);
		this.log('info', `Partial clip detection: found ${matches.length} candidate match(es), formed ${assignments.length} clip-source assignment(s).`);
		return this.emitPartialGroups(vids, assignments, Flags.PartialClip, groups);
	}

	/** ScanEngine.VerifyPartialClipVisually */
	async verifyPartialVisually(source, clip, offsetSec) {
		const s = this.s;
		const se = source.entry, ce = clip.entry;
		if ((se.flags | ce.flags) & EntryFlags.ThumbnailError) return { pass: true, visualSim: 0 };
		const sourceSec = se.mi.duration, clipSec = ce.mi.duration;
		if (sourceSec <= 0 || clipSec <= 0) return { pass: true, visualSim: 0 };
		const times = partial.visualSampleTimes(sourceSec, clipSec, ce.audio ? ce.audio.length : 0, offsetSec);
		if (!times.length) return { pass: false, visualSim: 0 };
		const srcFrames = await this.ff.grayFrames(source.file, times.map((t) => offsetSec + t));
		const clipFrames = await this.ff.grayFrames(clip.file, times);
		let comparisons = 0, simSum = 0;
		const threshold = s.partialClipVisualThresholdPercent / 100;
		for (let i = 0; i < times.length; i++) {
			const a = srcFrames[i], b = clipFrames[i];
			if (!a || !b) continue;
			let pairSim;
			if (s.usePHash) {
				const ha = computePHash(a), hb = computePHash(b);
				pairSim = isDuplicateByPercent(ha[0], ha[1], hb[0], hb[1], threshold, true).similarity;
			}
			else pairSim = f(1 - percentageDifference(a, b));
			simSum = f(simSum + pairSim);
			comparisons++;
		}
		if (!comparisons) return { pass: true, visualSim: 0 };
		const visualSim = f(simSum / comparisons);
		return { pass: visualSim >= threshold, visualSim };
	}

	/**
	 * EmitPartialClipAssignments: one group per source (source first, difference 0) plus each
	 * clip with its offset. A source that already belongs to a group gets its clips added to
	 * that group instead (existing arrays are extended in place); returns only the new groups.
	 */
	emitPartialGroups(vids, assignments, flags, existing = []) {
		const groupOf = new Map();
		for (const g of existing) for (const m of g) groupOf.set(m.entry.id, g);
		const byGroup = new Map();
		for (const a of assignments) {
			const clip = { entry: vids[a.clip].entry, difference: f(1 - a.sim), flags, offset: a.offset };
			const home = groupOf.get(vids[a.source].entry.id);
			if (home) { home.push(clip); continue; }
			if (!byGroup.has(a.group)) byGroup.set(a.group, [{ entry: vids[a.source].entry, difference: 0, flags: 0, offset: 0 }]);
			byGroup.get(a.group).push(clip);
		}
		return [...byGroup.values()];
	}

	// ── Partial clips: AI keyframes (ScanForPartialDuplicatesVisual) ──

	async aiPartials(valid, groups) {
		const s = this.s;
		if (!this.embedder) await this.startEmbedder();
		if (!this.embedder) return [];
		const already = this.groupedIds(groups);
		const vids = valid
			.filter((w) => !w.isImage && !w.invalid && !w.tombstone && w.entry.mi && w.entry.mi.duration >= 3)
			.sort((a, b) => b.entry.mi.duration - a.entry.mi.duration);
		const clipOk = vids.map((w) => !already.has(w.entry.id));
		if (vids.length < 2 || !clipOk.some(Boolean)) { this.log('info', 'AI partial detection: fewer than 2 eligible videos, skipping.'); return []; }
		this.startPhase('aiDense', 'AI keyframes', vids.length);
		const recs = new Array(vids.length).fill(null);
		const cls = await drive.classify(this.libraryPath, s.driveTypeOverride, []);
		const parallel = drive.readParallelism(cls.fast, s.maxDegreeOfParallelism, s.hddMaxDegreeOfParallelism);
		let next = 0, cached = 0, computed = 0, failed = 0;
		const worker = async () => {
			while (!this.cancelled) {
				await this.gate.wait();
				if (this.cancelled) break;
				const i = next++;
				if (i >= vids.length) break;
				const w = vids[i];
				const e = w.entry;
				try {
					const hit = this.cache.readDense(e.id, e.size, e.mtime);
					if (hit && hit.failed && !s.alwaysRetryFailedSampling) { /* failed on an earlier scan, file unchanged */ }
					else if (hit && !hit.failed) {
						recs[i] = partial.buildSignatures({ interval: hit.interval, count: hit.count, emb: hit.emb, valid: hit.valid });
						cached++;
					}
					else {
						const interval = ai.aiPartialIntervalSeconds(e.mi.duration);
						const frames = await this.ff.denseRgbFrames(w.file, interval, ai.AI_PARTIAL_MAX_FRAMES_PER_FILE);
						if (this.cancelled) break; // killed mid-read: the frames are incomplete, cache nothing
						if (!frames.length) {
							failed++;
							this.cache.writeDense(e.id, e.size, e.mtime, { failed: true });
						}
						else {
							// DenseFrameFilter: dark or repeated frames stay on the timeline as invalid slots.
							const filter = new partial.DenseFrameFilter(verifyRgbFrameValues);
							const valid = new Uint8Array(frames.length);
							const use = [];
							frames.forEach((fr, k) => { if (filter.isUsable(fr)) { valid[k] = 1; use.push(k); } });
							const emb = new Int8Array(frames.length * 384);
							const vecs = await this.embedder.embedQuantized(use.map((k) => frames[k]));
							use.forEach((k, n) => emb.set(vecs[n], k * 384));
							const rec = { interval, count: frames.length, emb, valid };
							this.cache.writeDense(e.id, e.size, e.mtime, rec);
							recs[i] = partial.buildSignatures(rec);
							computed++;
						}
					}
				}
				catch (err) { failed++; this.log('warn', `AI partial detection: dense sampling failed for '${w.item.name}': ${err.message}`); }
				this.tick(w.item.name);
			}
		};
		await Promise.all(Array.from({ length: parallel }, worker));
		if (this.cancelled) return [];
		this.log('info', `AI partial detection: dense embeddings ready (${cached} cached, ${computed} computed, ${failed} failed).`);
		const hitThreshold = f(s.aiPartialHitPercent / 100);
		const bound = signatureHammingBound(hitThreshold);
		this.startPhase('aiPartial', 'AI partial clips', vids.length - 1);
		let matches;
		try {
			matches = await compare.findDenseCandidates(vids.map((w, k) => ({ duration: w.entry.mi.duration, folders: w.folders, clipOk: clipOk[k] })), recs, this.ev, hitThreshold, bound,
				drive.matchingParallelism(s.matchingMaxDegreeOfParallelism), { onRows: (d) => { this.phase.done = d; this.progress(false); }, isCancelled: () => this.cancelled, gate: this.gate });
		}
		catch (err) { if (err && err.cancelled) return []; throw err; }
		const assignments = partial.assignGroups(matches);
		this.log('info', `AI partial detection: found ${matches.length} candidate match(es), formed ${assignments.length} clip-source assignment(s).`);
		return this.emitPartialGroups(vids, assignments, Flags.PartialClip | Flags.AiMatched, groups);
	}

	// ── Results ──

	buildResults(groups, valid) {
		const s = this.s;
		const posOf = new Map();
		for (const w of valid) {
			const e = w.entry;
			posOf.set(e.id, w.isImage ? [0] : (e.mi ? this.positions.map((p) => grayIndex(e.mi.duration, p, s.maxSamplingDurationSeconds)) : []));
		}
		const blacklisted = results.blacklistedGroups(groups.map((g, i) => [i, g.map((m) => m.entry.id)]), this.cache.lists.notAMatch);
		const items = [];
		let groupId = 0;
		groups.forEach((g, i) => {
			if (blacklisted.has(i) || g.length < 2) return;
			groupId++;
			for (const m of g) items.push(results.describe(m.entry, m.difference, groupId, m.flags, { offset: m.offset, positions: posOf.get(m.entry.id) || [] }));
		});
		results.highlightBest(items);
		const elapsed = Date.now() - this.startedAt;
		this.log('info', `Scan done in ${Math.round(elapsed / 1000)} s: ${groupId} group(s), ${items.length} item(s)${blacklisted.size ? `, ${blacklisted.size} group(s) hidden as "not a match"` : ''}.`);
		return { aborted: false, items, groups: groupId, elapsedMs: elapsed, settings: s };
	}

	async dispose() {
		if (this.embedder) await this.embedder.release();
	}
}

/** Bounded producer/consumer stage between frame decoding and serial ONNX inference. */
class EmbedQueue {
	constructor(embedder, cache, log) {
		this.embedder = embedder;
		this.cache = cache;
		this.log = log;
		this.queue = [];
		this.running = null;
		this.faulted = false;
		this.count = 0;
		this.waiters = [];
	}
	async submit(entry, key, rgb) {
		if (this.faulted) return;
		while (this.queue.length >= 256) await new Promise((r) => this.waiters.push(r));
		this.queue.push({ entry, key, rgb });
		if (!this.running) this.running = this.drain();
	}
	async drain() {
		while (this.queue.length) {
			const batch = this.queue.splice(0, ai.MAX_BATCH);
			const w = this.waiters; this.waiters = []; w.forEach((r) => r());
			if (this.faulted) continue;
			try {
				const vecs = await this.embedder.embedQuantized(batch.map((b) => b.rgb));
				batch.forEach((b, i) => { b.entry.emb.set(b.key, vecs[i]); this.cache.markDirty(b.entry.id); });
				this.count += batch.length;
			}
			catch (err) {
				this.faulted = true;
				this.log('error', `AI embedding stage failed — continuing without AI matching for the remaining files: ${err.message}`);
			}
		}
		this.running = null;
	}
	async complete() { while (this.running) await this.running; }
}

module.exports = { Scan, buildSamplePositions, grayIndex, wildcardMatch, bytesToMegaBytes };
