'use strict';
// Port of VDF.Core/Chromaprint (ChromaContext, FftService, Chroma, ChromaFilter,
// ChromaNormalizer, FingerprintCalculator) — VideoDuplicateFinder (AGPL-3.0), itself derived
// from AcoustID.NET by wo80 (LGPL 2.1).
//
// Input: mono 16-bit PCM at 11025 Hz. Output: one uint32 per second of audio (majority vote
// of ~8 per-frame 32-bit chroma fingerprints).

const FRAME_SIZE = 4096;
const SAMPLE_RATE = 11025;
const FRAME_HOP = 1365;
const MIN_FREQ = 27.5;
const MAX_FREQ = 3520.0;

const HANN = (() => {
	const w = new Float64Array(FRAME_SIZE);
	const factor = 2.0 * Math.PI / (FRAME_SIZE - 1);
	for (let i = 0; i < FRAME_SIZE; i++) w[i] = 0.5 * (1.0 - Math.cos(i * factor));
	return w;
})();

const CHROMA_MAP = (() => {
	const bins = FRAME_SIZE / 2 + 1;
	const map = new Int8Array(bins).fill(-1);
	for (let i = 1; i < bins; i++) {
		const freq = i * SAMPLE_RATE / FRAME_SIZE;
		if (freq < MIN_FREQ || freq > MAX_FREQ) continue;
		const note = 12.0 * Math.log2(freq / MIN_FREQ);
		let c = Math.trunc(note) % 12;
		if (c < 0) c += 12;
		map[i] = c;
	}
	return map;
})();

// Butterfly twiddle base per stage, precomputed like the C# (cos/sin of -2π/len).
const STAGES = (() => {
	const s = [];
	for (let len = 2; len <= FRAME_SIZE; len <<= 1) {
		const ang = -2.0 * Math.PI / len;
		s.push([len, Math.cos(ang), Math.sin(ang)]);
	}
	return s;
})();

/** In-place radix-2 DIT Cooley–Tukey FFT (FftService.Forward). */
function fftForward(re, im) {
	const n = re.length;
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; (j & bit) !== 0; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			let t = re[i]; re[i] = re[j]; re[j] = t;
			t = im[i]; im[i] = im[j]; im[j] = t;
		}
	}
	for (const [len, wRe, wIm] of STAGES) {
		const half = len >> 1;
		for (let i = 0; i < n; i += len) {
			let curRe = 1.0, curIm = 0.0;
			for (let j = 0; j < half; j++) {
				const a = i + j, b = a + half;
				const uRe = re[a], uIm = im[a];
				const vRe = re[b] * curRe - im[b] * curIm;
				const vIm = re[b] * curIm + im[b] * curRe;
				re[a] = uRe + vRe; im[a] = uIm + vIm;
				re[b] = uRe - vRe; im[b] = uIm - vIm;
				const tmp = curRe * wRe - curIm * wIm;
				curIm = curRe * wIm + curIm * wRe;
				curRe = tmp;
			}
		}
	}
}

const PAIRS = (() => {
	const p = [];
	for (let i = 0; i < 12; i++) p.push([i, (i + 1) % 12]);
	for (let i = 0; i < 12; i++) p.push([i, (i + 3) % 12]);
	for (let i = 0; i < 8; i++) p.push([i, (i + 6) % 12]);
	return p;
})();

function fingerprintOf(chroma) {
	let fp = 0;
	for (let i = 0; i < 32; i++) if (chroma[PAIRS[i][0]] > chroma[PAIRS[i][1]]) fp |= (1 << i);
	return fp >>> 0;
}

function aggregateMajorityVote(list) {
	if (!list.length) return 0;
	const threshold = (list.length >> 1) + 1;
	let result = 0;
	for (let bit = 0; bit < 32; bit++) {
		const mask = (1 << bit) >>> 0;
		let count = 0;
		for (let i = 0; i < list.length; i++) if ((list[i] & mask) !== 0) count++;
		if (count >= threshold) result |= mask;
	}
	return result >>> 0;
}

const COEFF = [0.25, 0.50, 1.00, 0.50, 0.25];
const FILTER_NORM = 2.50;

class ChromaContext {
	constructor() {
		this.re = new Float64Array(FRAME_SIZE);
		this.im = new Float64Array(FRAME_SIZE);
		this.ring = new Float64Array(5 * 12);
		this.chromaBuf = new Float64Array(12);
		this.filtered = new Float64Array(12);
		this.start();
	}

	start() {
		this.samples = new Int16Array(0);
		this.sampleCount = 0;
		this.frameIndex = 0;
		this.secondFrames = [];
		this.aggregated = [];
		this.ring.fill(0);
		this.head = 0;
		this.count = 0;
		this.totalSamples = 0;
	}

	/** Feed mono s16 samples (Int16Array). */
	feed(samples) {
		this.totalSamples += samples.length;
		const needed = this.sampleCount + samples.length;
		if (this.samples.length < needed) {
			const nb = new Int16Array(needed + FRAME_SIZE);
			nb.set(this.samples.subarray(0, this.sampleCount));
			this.samples = nb;
		}
		this.samples.set(samples, this.sampleCount);
		this.sampleCount += samples.length;
		this._process();
	}

	finish() {
		if (this.secondFrames.length) {
			this.aggregated.push(aggregateMajorityVote(this.secondFrames));
			this.secondFrames = [];
		}
	}

	fingerprint() { return Uint32Array.from(this.aggregated); }

	_filterFeed(input, output) {
		const base = this.head * 12;
		for (let j = 0; j < 12; j++) this.ring[base + j] = input[j];
		this.head = (this.head + 1) % 5;
		if (this.count < 5) {
			this.count++;
			if (this.count < 5) return false;
		}
		output.fill(0);
		for (let i = 0; i < 5; i++) {
			const slot = ((this.head + i) % 5) * 12;
			const w = COEFF[i];
			for (let j = 0; j < 12; j++) output[j] += this.ring[slot + j] * w;
		}
		for (let j = 0; j < 12; j++) output[j] /= FILTER_NORM;
		return true;
	}

	_process() {
		const { re, im, chromaBuf, filtered } = this;
		let pos = 0;
		while (pos + FRAME_SIZE <= this.sampleCount) {
			for (let i = 0; i < FRAME_SIZE; i++) {
				re[i] = (this.samples[pos + i] * (1.0 / 32768.0)) * HANN[i];
				im[i] = 0.0;
			}
			chromaBuf.fill(0);
			fftForward(re, im);
			for (let i = 1; i < FRAME_SIZE / 2; i++) {
				const c = CHROMA_MAP[i];
				if (c < 0) continue;
				chromaBuf[c] += re[i] * re[i] + im[i] * im[i];
			}
			if (this._filterFeed(chromaBuf, filtered)) {
				let sumSq = 0;
				for (let i = 0; i < 12; i++) sumSq += filtered[i] * filtered[i];
				if (sumSq < 1e-10) filtered.fill(0);
				else { const inv = 1.0 / Math.sqrt(sumSq); for (let i = 0; i < 12; i++) filtered[i] *= inv; }
				const fp = fingerprintOf(filtered);
				const frameSec = this.frameIndex * FRAME_HOP / SAMPLE_RATE;
				const bucket = Math.floor(frameSec);
				if (this.secondFrames.length > 0 && bucket > this.aggregated.length) {
					this.aggregated.push(aggregateMajorityVote(this.secondFrames));
					this.secondFrames = [];
				}
				this.secondFrames.push(fp);
			}
			this.frameIndex++;
			pos += FRAME_HOP;
		}
		const leftover = this.sampleCount - pos;
		if (leftover > 0 && pos > 0) this.samples.copyWithin(0, pos, this.sampleCount);
		this.sampleCount = leftover;
	}
}

function isSilentFingerprint(fp) {
	if (!fp || fp.length === 0) return false;
	for (let i = 0; i < fp.length; i++) if (fp[i] !== 0) return false;
	return true;
}

function popcount32(x) {
	x = x - ((x >>> 1) & 0x55555555);
	x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
	x = (x + (x >>> 4)) & 0x0F0F0F0F;
	return Math.imul(x, 0x01010101) >>> 24;
}

/**
 * ScanEngine.SlidingWindowCompare: best average Hamming similarity of `shorter` slid over
 * `longer`, with early exit once an offset cannot beat max(best, minSim).
 * Returns { similarity, offset } (offset in blocks ≈ seconds).
 */
function slidingWindowCompare(shorter, longer, minSim = 0) {
	const lenS = shorter.length, lenL = longer.length;
	const maxOffset = lenL - lenS;
	const capacity = lenS * 32;
	const f = Math.fround;
	let bestSim = 0, bestOffset = 0;
	for (let offset = 0; offset <= maxOffset; offset++) {
		const maxAllowed = Math.trunc(f(f(1 - Math.max(bestSim, f(minSim))) * capacity));
		let bits = 0;
		for (let k = 0; k < lenS; k++) {
			bits += popcount32((shorter[k] ^ longer[offset + k]) >>> 0);
			if (bits > maxAllowed && (k & 7) === 7) break;
		}
		if (bits > maxAllowed) continue;
		const sim = f(1 - f(bits / capacity));
		if (sim > bestSim) { bestSim = sim; bestOffset = offset; }
	}
	return { similarity: bestSim, offset: bestOffset };
}

module.exports = {
	FRAME_SIZE,
	SAMPLE_RATE,
	FRAME_HOP,
	ChromaContext,
	fftForward,
	fingerprintOf,
	aggregateMajorityVote,
	isSilentFingerprint,
	slidingWindowCompare,
};
