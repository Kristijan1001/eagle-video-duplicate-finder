'use strict';
// Port of VDF.Core/AI/EmbeddingMath.cs (VideoDuplicateFinder, AGPL-3.0).
// Embeddings are L2-normalized DINOv2-small vectors (384 floats) quantized to int8
// (round(x * 127), banker's rounding, clamped to ±127). Cosine = int dot / 127².

const { f } = require('../f32');

const DIMENSIONS = 384;
const QUANT_SCALE = 127;
const SIGNATURE_WORDS = DIMENSIONS / 32; // 12 × uint32 (VDF: 6 × uint64)

/** C# MathF.Round: round half to even. */
function roundHalfEven(x) {
	const r = Math.round(x);
	if (Math.abs(x - Math.trunc(x)) === 0.5) return 2 * Math.round(x / 2);
	return r;
}

/** Float vector (already L2-normalized) -> Int8Array. */
function quantizeUnitVector(vector) {
	const q = new Int8Array(vector.length);
	for (let i = 0; i < vector.length; i++) {
		let r = roundHalfEven(f(f(vector[i]) * QUANT_SCALE));
		if (r > 127) r = 127; else if (r < -127) r = -127;
		q[i] = r;
	}
	return q;
}

/** L2-normalize in place (float32), returns the same array. */
function l2Normalize(v) {
	let s = 0;
	for (let i = 0; i < v.length; i++) s += v[i] * v[i];
	const n = Math.sqrt(s);
	if (n > 0) for (let i = 0; i < v.length; i++) v[i] = v[i] / n;
	return v;
}

/** Cosine similarity of two Int8Array embeddings (views allowed), clamped to [-1, 1]. */
function cosineSimilarity(a, b) {
	const len = Math.min(a.length, b.length);
	let dot = 0;
	for (let i = 0; i < len; i++) dot += a[i] * b[i];
	let c = f(dot / f(QUANT_SCALE * QUANT_SCALE));
	if (c > 1) c = 1; else if (c < -1) c = -1;
	return c;
}

/** Sign bitmask (bit i set when component i is negative) as Uint32Array(12). */
function signSignature(q) {
	const sig = new Uint32Array(SIGNATURE_WORDS);
	const len = Math.min(q.length, DIMENSIONS);
	for (let i = 0; i < len; i++)
		if (q[i] < 0) sig[i >>> 5] |= (1 << (i & 31));
	return sig;
}

function popcount32(x) {
	x = x - ((x >>> 1) & 0x55555555);
	x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
	x = (x + (x >>> 4)) & 0x0F0F0F0F;
	return Math.imul(x, 0x01010101) >>> 24;
}

function hammingDistance(a, b, aOff = 0, bOff = 0, words = SIGNATURE_WORDS) {
	let d = 0;
	for (let i = 0; i < words; i++) d += popcount32((a[aOff + i] ^ b[bOff + i]) >>> 0);
	return d;
}

/** Sign-LSH prefilter bound (see VDF EmbeddingMath.SignatureHammingBound). */
function signatureHammingBound(cosineThreshold) {
	const t = Math.max(-1, Math.min(1, f(cosineThreshold)));
	const p = Math.acos(t) / Math.PI;
	const expected = DIMENSIONS * p;
	const sigma = Math.sqrt(DIMENSIONS * p * (1 - p));
	return Math.ceil(expected + 4.6 * sigma);
}

module.exports = {
	DIMENSIONS,
	SIGNATURE_WORDS,
	quantizeUnitVector,
	l2Normalize,
	cosineSimilarity,
	signSignature,
	hammingDistance,
	signatureHammingBound,
	roundHalfEven,
};
