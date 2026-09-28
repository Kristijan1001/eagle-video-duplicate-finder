'use strict';
// Port of VDF.Core/pHash/PerceptualHash.cs + PHashCompare.cs (VideoDuplicateFinder, AGPL-3.0).
//
// 64-bit perceptual hash of a 32x32 gray frame: the 8x8 low-frequency DCT block
// (u, v = 1..8, DC excluded), thresholded against its median. Hashes are held as two
// unsigned 32-bit halves: `lo` = bits 0..31, `hi` = bits 32..63 (bit i = ac[i] > median).
//
// Arithmetic follows VDF's scalar path (sequential float32 accumulation), which VDF's own
// tests pin as bit-identical to its full-DCT reference. VDF's SIMD paths may differ from
// that by <= 2 bits on < 0.01% of frames; that is VDF's own documented drift.

const { f } = require('./f32');

const N = 32;
const K = 8;
const ALPHA = f(Math.sqrt(2.0 * (1.0 / N)));

// COS[k * N + i] = cos((2i + 1)(k + 1)π / 2N), stored as float32.
const COS = (() => {
	const t = new Float32Array(K * N);
	for (let k = 0; k < K; k++)
		for (let i = 0; i < N; i++)
			t[k * N + i] = Math.cos(((2 * i + 1) * (k + 1) * Math.PI) / (2.0 * N));
	return t;
})();

/** Returns [lo, hi] (two uint32) or throws for a non-1024-byte frame. */
function computePHash(gray) {
	if (!gray || gray.length !== N * N) throw new Error('expected 32x32=1024 bytes');

	// Row transform: temp[u * N + y] = ALPHA * Σx gray[y, x] * COS[u, x]
	const temp = new Float32Array(K * N);
	for (let y = 0; y < N; y++) {
		const row = y * N;
		for (let u = 0; u < K; u++) {
			const cb = u * N;
			let sum = 0;
			for (let x = 0; x < N; x++)
				sum = f(sum + f(gray[row + x] * COS[cb + x]));
			temp[u * N + y] = f(ALPHA * sum);
		}
	}

	// Column transform of the K rows we need: ac[v * K + u] = ALPHA * Σy temp[u, y] * COS[v, y]
	const ac = new Float32Array(K * K);
	let idx = 0;
	for (let v = 0; v < K; v++) {
		const cb = v * N;
		for (let u = 0; u < K; u++) {
			const tb = u * N;
			let sum = 0;
			for (let y = 0; y < N; y++)
				sum = f(sum + f(temp[tb + y] * COS[cb + y]));
			ac[idx++] = f(ALPHA * sum);
		}
	}

	const sorted = Float32Array.from(ac).sort();
	const median = f(f(sorted[31] + sorted[32]) * 0.5);

	let lo = 0, hi = 0;
	for (let i = 0; i < 32; i++) if (ac[i] > median) lo |= (1 << i);
	for (let i = 32; i < 64; i++) if (ac[i] > median) hi |= (1 << (i - 32));
	return [lo >>> 0, hi >>> 0];
}

function popcount32(x) {
	x = x - ((x >>> 1) & 0x55555555);
	x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
	x = (x + (x >>> 4)) & 0x0F0F0F0F;
	return Math.imul(x, 0x01010101) >>> 24;
}

function hamming(aLo, aHi, bLo, bHi) {
	return popcount32((aLo ^ bLo) >>> 0) + popcount32((aHi ^ bHi) >>> 0);
}

/**
 * Max differing bits for "at least `percent` similar" (percent in 0..1, a double).
 * strict = floor, otherwise round — C# Math.Round is banker's rounding (to even).
 */
function maxBitsFor(percent, strict = true) {
	if (percent < 0 || percent > 1) throw new RangeError('percent');
	const bits = (1.0 - percent) * 64.0;
	return strict ? Math.floor(bits) : roundHalfEven(bits);
}

function roundHalfEven(x) {
	const r = Math.round(x);
	return (Math.abs(x % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r;
}

/**
 * PHashCompare.IsDuplicateByPercent. Returns { pass, similarity } where
 * similarity = 1f - d / 64f (float32).
 */
function isDuplicateByPercent(aLo, aHi, bLo, bHi, percent = 0.90, strict = true) {
	const maxBits = maxBitsFor(percent, strict);
	const d = hamming(aLo, aHi, bLo, bHi);
	return { pass: d <= maxBits, similarity: f(1 - f(d / 64)), distance: d };
}

module.exports = {
	N,
	K,
	computePHash,
	popcount32,
	hamming,
	maxBitsFor,
	isDuplicateByPercent,
};
