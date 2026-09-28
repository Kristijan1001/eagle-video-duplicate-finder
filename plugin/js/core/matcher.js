'use strict';
// Port of the pair verdict in VDF.Core/ScanEngine.cs (VideoDuplicateFinder, AGPL-3.0):
// CheckIfDuplicate / CheckIfDuplicateClassic / TryComparePHashes / TryCompareGrayVideos /
// ComputeAiSimilarity / TryCheckDuplicate / ComparePair / PassesFolderMatchGate.
//
// A "snapshot" is the compare-ready form of one file (VDF's compareGray / comparePHashes /
// compareEmbeddings), built once per scan:
//   { index, isImage, duration, tolerance, gray: Uint8Array(N*1024),
//     ph: Uint32Array(2N) | null, emb: Int8Array(N*384) | null, embValid: Uint8Array(N) | null,
//     folders: string[] (Eagle folder paths), size, dev, ino }
// Flipped gray/pHash arrays are created on demand, once per entry (never per pair).

const { f } = require('./f32');
const { computePHash, maxBitsFor, popcount32 } = require('./phash');
const { flipGrayScale } = require('./gray');
const { DIMENSIONS } = require('./ai/embedding-math');

const FRAME = 1024;
const BLACK = 0x20;
const WHITE = 0xF0;

const Flags = Object.freeze({
	None: 0,
	Flipped: 1,
	PartialClip: 2,
	AiMatched: 4,
	GrayscaleMatched: 8,
	PHashMatched: 16,
});

// ── Kernels on (buffer, offset) so the hot path never allocates views ──

function frameDiff(a, ao, b, bo) {
	let diff = 0;
	for (let i = 0; i < FRAME; i++) {
		const d = a[ao + i] - b[bo + i];
		diff += d < 0 ? -d : d;
	}
	return f(f(f(diff) / FRAME) / 256);
}

function frameDiffMasked(a, ao, b, bo, ignoreBlack, ignoreWhite) {
	let diff = 0, counter = 0;
	for (let i = 0; i < FRAME; i++) {
		const x = a[ao + i], y = b[bo + i];
		if (ignoreBlack && (x <= BLACK || y <= BLACK)) continue;
		if (ignoreWhite && (x >= WHITE || y >= WHITE)) continue;
		const d = x - y;
		diff += d < 0 ? -d : d;
		counter++;
	}
	return f(f(f(diff) / f(counter)) / 256);
}

function cosineAt(a, ao, b, bo) {
	let dot = 0;
	for (let i = 0; i < DIMENSIONS; i++) dot += a[ao + i] * b[bo + i];
	let c = f(dot / 16129);
	if (c > 1) c = 1; else if (c < -1) c = -1;
	return c;
}

/** Returns true when the last `depth` path segments of two folder paths are equal (case-insensitive). */
function sameFolderAtDepth(a, b, depth) {
	for (let i = 0; i < depth; i++) {
		a = a.replace(/[\\/]+$/, '');
		b = b.replace(/[\\/]+$/, '');
		const sa = Math.max(a.lastIndexOf('/'), a.lastIndexOf('\\'));
		const sb = Math.max(b.lastIndexOf('/'), b.lastIndexOf('\\'));
		const segA = sa >= 0 ? a.slice(sa + 1) : a;
		const segB = sb >= 0 ? b.slice(sb + 1) : b;
		if (segA.toLowerCase() !== segB.toLowerCase()) return false;
		a = sa >= 0 ? a.slice(0, sa) : '';
		b = sb >= 0 ? b.slice(0, sb) : '';
	}
	return true;
}

/**
 * Eagle items may live in several folders (or none). SameFolderOnly passes when ANY folder
 * pair is "same" at the configured depth; DifferentFolderOnly passes when NO pair is.
 * An item in no folder counts as being in the unfiled root ("").
 */
function anySameFolder(fa, fb, depth) {
	const A = fa && fa.length ? fa : [''];
	const B = fb && fb.length ? fb : [''];
	for (const x of A) for (const y of B) if (sameFolderAtDepth(x, y, depth)) return true;
	return false;
}

class Matcher {
	/**
	 * @param {object} s engine settings view (see settings.engineView)
	 * @param {number} positions sample positions per video (N)
	 */
	constructor(s, positions) {
		this.s = s;
		this.N = positions;
		this.percentLimit = f(1 - f(f(s.percent) / 100));            // 1.0f - Percent / 100f
		this.grayVideoLimit = f(this.percentLimit * positions);        // (1 - P/100) * N
		this.pHashPercent = f(f(s.percent) / 100);                     // Percent / 100f (as double)
		this.pHashMaxBits = maxBitsFor(this.pHashPercent, true);
		const ratio = Math.min(1, Math.max(0.01, f(s.pHashSampleRatio)));
		this.requiredMatches = Math.max(1, Math.ceil(f(positions * f(ratio))));
		this.usePHash = !!(s.usePHash || s.combineGrayPHash);
		this.aiLimit = f(f(s.aiPercent) / 100);
		this.ignoreBlack = !!s.ignoreBlackPixels;
		this.ignoreWhite = !!s.ignoreWhitePixels;
		this.masked = this.ignoreBlack || this.ignoreWhite;
		this.mergesBlocked = 0;
		// reusable out-params (no per-pair allocation)
		this.difference = 1;
		this.algorithms = 0;
		this.aiMatched = false;
		this._gd = 0;
		this._pd = 0;
	}

	/** Lazily create the mirrored gray frames (and their pHashes when needed) for one entry. */
	ensureFlipped(e) {
		if (e.flippedGray) return;
		const frames = e.isImage ? 1 : this.N;
		const out = new Uint8Array(frames * FRAME);
		for (let j = 0; j < frames; j++)
			out.set(flipGrayScale(e.gray.subarray(j * FRAME, (j + 1) * FRAME)), j * FRAME);
		e.flippedGray = out;
		if (this.usePHash && !e.isImage) {
			const ph = new Uint32Array(frames * 2);
			for (let j = 0; j < frames; j++) {
				const [lo, hi] = computePHash(out.subarray(j * FRAME, (j + 1) * FRAME));
				ph[2 * j] = lo; ph[2 * j + 1] = hi;
			}
			e.flippedPh = ph;
		}
	}

	/** TryCompareGrayVideos. Sets this._gd. */
	grayVideos(ga, b) {
		const gb = b.gray;
		const n = this.N;
		const limit = this.grayVideoLimit;
		let sum = 0;
		for (let j = 0; j < n; j++) {
			const o = j * FRAME;
			const d = this.masked
				? frameDiffMasked(ga, o, gb, o, this.ignoreBlack, this.ignoreWhite)
				: frameDiff(ga, o, gb, o);
			sum = f(sum + d);
			if (sum > limit) return false;
		}
		const diff = f(sum / n);
		this._gd = diff;
		return diff === diff; // !NaN
	}

	/** TryComparePHashes (quorum over all sampled positions). Sets this._pd. */
	pHashes(pa, pb) {
		if (!pa || !pb) return false;
		const count = Math.min(pa.length, pb.length) >> 1;
		if (count === 0) return false;
		const required = count === this.N ? this.requiredMatches
			: Math.max(1, Math.ceil(f(count * f(Math.min(1, Math.max(0.01, this.s.pHashSampleRatio))))));
		const maxBits = this.pHashMaxBits;
		let matches = 0;
		let sum = 0;
		for (let j = 0; j < count; j++) {
			const d = popcount32((pa[2 * j] ^ pb[2 * j]) >>> 0) + popcount32((pa[2 * j + 1] ^ pb[2 * j + 1]) >>> 0);
			const similarity = f(1 - f(d / 64));
			sum = f(sum + f(1 - similarity));
			if (d <= maxBits) matches++;
			else if (matches + (count - j - 1) < required) return false;
		}
		if (matches < required) return false;
		const diff = f(sum / count);
		this._pd = diff;
		return diff === diff;
	}

	/** CheckIfDuplicateClassic. Sets difference + algorithms. */
	classic(a, overrideGray, overridePh, b) {
		const s = this.s;
		const ga = overrideGray || a.gray;
		this.algorithms = 0;
		this.difference = 1;

		if (a.isImage) {
			const d = this.masked
				? frameDiffMasked(ga, 0, b.gray, 0, this.ignoreBlack, this.ignoreWhite)
				: frameDiff(ga, 0, b.gray, 0);
			this.difference = d;
			const dup = d <= this.percentLimit;
			if (dup && s.combineGrayPHash) this.algorithms = Flags.GrayscaleMatched;
			return dup;
		}

		if (s.combineGrayPHash) {
			const gm = this.grayVideos(ga, b);
			const pm = this.pHashes(overrideGray ? overridePh : a.ph, b.ph);
			if (!gm && !pm) return false;
			if (gm) this.algorithms |= Flags.GrayscaleMatched;
			if (pm) this.algorithms |= Flags.PHashMatched;
			this.difference = gm && pm ? Math.min(this._gd, this._pd) : gm ? this._gd : this._pd;
			return true;
		}
		if (s.usePHash) {
			const ok = this.pHashes(overrideGray ? overridePh : a.ph, b.ph);
			if (ok) this.difference = this._pd;
			return ok;
		}
		const ok = this.grayVideos(ga, b);
		if (ok) this.difference = this._gd;
		return ok;
	}

	/** ComputeAiSimilarity: mean cosine over positions where both are valid; -1 when too few. */
	aiSimilarity(a, b) {
		const ea = a.emb, eb = b.emb;
		if (!ea || !eb) return -1;
		const n = Math.min(a.embValid.length, b.embValid.length);
		let sum = 0, count = 0;
		for (let j = 0; j < n; j++) {
			if (!a.embValid[j] || !b.embValid[j]) continue;
			sum = f(sum + cosineAt(ea, j * DIMENSIONS, eb, j * DIMENSIONS));
			count++;
		}
		const required = Math.max(1, (n + 1) >> 1);
		return count < required ? -1 : f(sum / count);
	}

	/**
	 * CheckIfDuplicate: classic verdict unioned with the AI pass (normal orientation only).
	 * Sets difference, algorithms, aiMatched.
	 */
	check(a, overrideGray, overridePh, b) {
		this.aiMatched = false;
		if (this.classic(a, overrideGray, overridePh, b)) return true;
		if (overrideGray || !this.s.useAiMatching) return false;
		const sim = this.aiSimilarity(a, b);
		if (sim < this.aiLimit) return false;
		this.difference = f(1 - sim);
		this.aiMatched = true;
		return true;
	}

	/** TryCheckDuplicate: normal + optional flipped orientation. Returns {difference, flags} or null. */
	tryCheck(a, b) {
		let flags = 0;
		let isDup = this.check(a, null, null, b);
		let difference = this.difference;
		if (isDup) flags |= this.algorithms;
		if (this.aiMatched) flags |= Flags.AiMatched;
		if (this.s.compareHorizontallyFlipped) {
			this.ensureFlipped(a);
			if (this.check(a, a.flippedGray, a.flippedPh || null, b)) {
				const fd = this.difference;
				if (!isDup || fd < difference) {
					flags = Flags.Flipped | this.algorithms;
					isDup = true;
					difference = fd;
				}
			}
		}
		return isDup ? { difference, flags } : null;
	}

	passesFolderGate(a, b) {
		switch (this.s.folderMatchMode) {
			case 'same': return anySameFolder(a.folders, b.folders, this.s.sameFolderDepth);
			case 'different': return !anySameFolder(a.folders, b.folders, this.s.sameFolderDepth);
			default: return true;
		}
	}

	/** Duration gate for a video pair: |Δ| <= min(tolerance(a), tolerance(b)). */
	durationOk(a, b) {
		const allowed = Math.min(a.tolerance, b.tolerance);
		return Math.abs(a.duration - b.duration) <= allowed;
	}

	/** ComparePair: every gate + verdict. Returns {difference, flags} or null. */
	comparePair(a, b) {
		if (!a.isImage && !this.durationOk(a, b)) return null;
		if (!this.passesFolderGate(a, b)) return null;
		const r = this.tryCheck(a, b);
		if (!r) return null;
		if (this.s.excludeHardLinks && a.size === b.size && (a.isImage || a.duration === b.duration)
			&& a.ino && a.ino === b.ino && a.dev === b.dev)
			return null;
		return r;
	}

	/** Representative gate used by grouping: plain CheckIfDuplicate(rep, candidate). */
	isSimilar(a, b) {
		return this.check(a, null, null, b);
	}
}

module.exports = {
	Flags,
	Matcher,
	frameDiff,
	frameDiffMasked,
	sameFolderAtDepth,
	anySameFolder,
	FRAME,
};
