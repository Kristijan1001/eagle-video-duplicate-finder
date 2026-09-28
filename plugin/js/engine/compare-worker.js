'use strict';
// worker_threads worker for the CPU-bound matching passes. All bulk data arrives as
// SharedArrayBuffers (zero-copy); the main engine thread hands out row ranges on demand
// (dynamic scheduling, like Parallel.For) and merges the returned pairs deterministically.

const { parentPort, workerData } = require('worker_threads');
const path = require('path');
const { Matcher } = require(path.join(__dirname, '..', 'core', 'matcher.js'));
const { slidingWindowCompare } = require(path.join(__dirname, '..', 'core', 'chroma.js'));
const { matchDenseFrames } = require(path.join(__dirname, '..', 'core', 'partial.js'));
const { anySameFolder } = require(path.join(__dirname, '..', 'core', 'matcher.js'));

const FRAME = 1024;
const EMB = 384;

/** Build snapshot objects over the shared buffers (views only, no copies). */
function buildSnapshots(set, N) {
	if (!set || !set.count) return [];
	const gray = new Uint8Array(set.gray);
	const ph = set.ph ? new Uint32Array(set.ph) : null;
	const emb = set.emb ? new Int8Array(set.emb) : null;
	const embValid = set.embValid ? new Uint8Array(set.embValid) : null;
	const dur = new Float64Array(set.durations);
	const tol = new Float64Array(set.tolerances);
	const size = new Float64Array(set.sizes);
	const frames = set.isImage ? 1 : N;
	const snaps = new Array(set.count);
	for (let k = 0; k < set.count; k++) {
		snaps[k] = {
			index: set.baseIndex + k,
			isImage: !!set.isImage,
			duration: dur[k],
			tolerance: tol[k],
			gray: gray.subarray(k * frames * FRAME, (k + 1) * frames * FRAME),
			ph: ph ? ph.subarray(k * frames * 2, (k + 1) * frames * 2) : null,
			emb: emb ? emb.subarray(k * frames * EMB, (k + 1) * frames * EMB) : null,
			embValid: embValid ? embValid.subarray(k * frames, (k + 1) * frames) : null,
			folders: set.folders[k],
			size: size[k],
			dev: set.devs[k],
			ino: set.inos[k],
			flippedGray: null,
			flippedPh: null,
		};
	}
	return snaps;
}

const d = workerData;
let matcher = null;
let sets = null;

function init() {
	if (d.kind === 'dup') {
		matcher = new Matcher(d.settings, d.N);
		sets = {
			images: buildSnapshots(d.images, d.N),
			videos: buildSnapshots(d.videos, d.N),
		};
		sets.videoOrder = d.videos && d.videos.count ? new Int32Array(d.videos.order) : new Int32Array(0);
		sets.imageScope = d.images && d.images.count ? new Uint8Array(d.images.scope) : new Uint8Array(0);
		sets.videoScope = d.videos && d.videos.count ? new Uint8Array(d.videos.scope) : new Uint8Array(0);
	}
}

class EdgeBuffer {
	constructor() { this.a = []; this.b = []; this.diff = []; this.flags = []; this.extra = []; }
	push(a, b, diff, flags, extra = 0) { this.a.push(a); this.b.push(b); this.diff.push(diff); this.flags.push(flags); this.extra.push(extra); }
	pack() {
		const n = this.a.length;
		const A = Int32Array.from(this.a), B = Int32Array.from(this.b);
		const D = Float32Array.from(this.diff), F = Int32Array.from(this.flags), X = Float64Array.from(this.extra);
		return { n, A, B, D, F, X, transfer: [A.buffer, B.buffer, D.buffer, F.buffer, X.buffer] };
	}
}

function runDupImages(start, end, out) {
	const imgs = sets.images;
	const scope = sets.imageScope;
	for (let i = start; i < end; i++) {
		const a = imgs[i];
		const aIn = scope[i];
		for (let j = i + 1; j < imgs.length; j++) {
			if (!aIn && !scope[j]) continue;
			const r = matcher.comparePair(a, imgs[j]);
			if (r) out.push(a.index, imgs[j].index, r.difference, r.flags);
		}
		a.flippedGray = null;
	}
}

function runDupVideos(start, end, out) {
	const vids = sets.videos;
	const order = sets.videoOrder;
	const scope = sets.videoScope;
	for (let r = start; r < end; r++) {
		const x = order[r];
		const a = vids[x];
		const limit = a.duration + a.tolerance;
		for (let r2 = r + 1; r2 < order.length; r2++) {
			const y = order[r2];
			const b = vids[y];
			if (b.duration > limit) break;
			if (!scope[x] && !scope[y]) continue;
			// VDF compares (lower compareIndex, higher compareIndex): direction matters for
			// the flipped check and for which item carries the pair flags.
			const lo = x < y ? a : b, hi = x < y ? b : a;
			const res = matcher.comparePair(lo, hi);
			if (res) out.push(lo.index, hi.index, res.difference, res.flags);
		}
		a.flippedGray = null; a.flippedPh = null;
	}
}

// ── audio partial clips ──
let audio = null;
function initAudio() {
	if (audio) return;
	audio = {
		fp: new Uint32Array(d.fp),
		offsets: new Int32Array(d.offsets),
		lengths: new Int32Array(d.lengths),
		durations: new Float64Array(d.durations),
		folders: d.folders,
	};
}
function fpOf(i) { return audio.fp.subarray(audio.offsets[i], audio.offsets[i] + audio.lengths[i]); }
function gate(i, j, folders) {
	if (d.folderMatchMode === 'same') return anySameFolder(folders[i], folders[j], d.sameFolderDepth);
	if (d.folderMatchMode === 'different') return !anySameFolder(folders[i], folders[j], d.sameFolderDepth);
	return true;
}
function runAudio(start, end, out) {
	initAudio();
	const n = audio.durations.length;
	const minSim = Math.fround(d.threshold);
	for (let i = start; i < end && i < n - 1; i++) {
		const sourceSec = audio.durations[i];
		if (sourceSec < 1.0) continue;
		for (let j = i + 1; j < n; j++) {
			const ratio = audio.durations[j] / sourceSec;
			if (ratio >= 0.95) continue;
			if (ratio < d.minRatio) break;
			if (!gate(i, j, audio.folders)) continue;
			if (d.clipOk && !d.clipOk[j]) continue;
			if (audio.durations[j] < 1.0) continue;
			if (!(audio.lengths[j] < audio.lengths[i])) continue;
			const m = slidingWindowCompare(fpOf(j), fpOf(i), minSim);
			if (m.similarity >= minSim) out.push(i, j, m.similarity, 0, m.offset);
		}
	}
}

// ── AI dense partial clips ──
let dense = null;
function initDense() {
	if (dense) return;
	const emb = new Int8Array(d.emb);
	const valid = new Uint8Array(d.valid);
	const sig = new Uint32Array(d.sig);
	const offsets = new Int32Array(d.offsets);
	const counts = new Int32Array(d.counts);
	const intervals = new Float64Array(d.intervals);
	const present = new Uint8Array(d.present);
	dense = {
		durations: new Float64Array(d.durations),
		folders: d.folders,
		present,
		recs: Array.from({ length: counts.length }, (_, i) => present[i] ? {
			interval: intervals[i], count: counts[i],
			emb: emb.subarray(offsets[i] * EMB, (offsets[i] + counts[i]) * EMB),
			valid: valid.subarray(offsets[i], offsets[i] + counts[i]),
			sig: sig.subarray(offsets[i] * 12, (offsets[i] + counts[i]) * 12),
		} : null),
	};
}
function runDense(start, end, out) {
	initDense();
	const n = dense.durations.length;
	for (let i = start; i < end && i < n - 1; i++) {
		const sourceSec = dense.durations[i];
		if (sourceSec < 1.0) continue;
		for (let j = i + 1; j < n; j++) {
			const ratio = dense.durations[j] / sourceSec;
			if (ratio >= 0.95) continue;
			if (ratio < d.minRatio) break;
			if (!gate(i, j, dense.folders)) continue;
			if (d.clipOk && !d.clipOk[j]) continue;
			if (!dense.present[i] || !dense.present[j]) continue;
			const m = matchDenseFrames(dense.recs[i], dense.recs[j], d.hitThreshold, d.hammingBound);
			if (m) out.push(i, j, m.sim, 0, m.offset);
		}
	}
}

init();

parentPort.on('message', (msg) => {
	if (msg.type !== 'range') return;
	const out = new EdgeBuffer();
	try {
		if (msg.task === 'images') runDupImages(msg.start, msg.end, out);
		else if (msg.task === 'videos') runDupVideos(msg.start, msg.end, out);
		else if (msg.task === 'audio') runAudio(msg.start, msg.end, out);
		else if (msg.task === 'dense') runDense(msg.start, msg.end, out);
		const p = out.pack();
		parentPort.postMessage({ type: 'done', id: msg.id, rows: msg.end - msg.start, n: p.n, A: p.A, B: p.B, D: p.D, F: p.F, X: p.X }, p.transfer);
	}
	catch (err) {
		parentPort.postMessage({ type: 'error', id: msg.id, error: String(err && err.stack || err) });
	}
});
