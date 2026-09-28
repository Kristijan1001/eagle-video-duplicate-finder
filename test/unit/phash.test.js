'use strict';
// Ported from VDF.Core.Tests/pHash/PerceptualHashTests.cs + PHashCompareTests.cs
const test = require('node:test');
const assert = require('node:assert');
const { core, rng, blur } = require('../lib/helpers');
const P = core('core/phash.js');

const f = Math.fround;
const dist = (a, b) => P.hamming(a[0], a[1], b[0], b[1]);

// VDF's spec implementation (ReferenceFullDct), float32 throughout.
function referenceFullDct(gray) {
	const N = 32, K = 8;
	const cos = new Float32Array(N * N);
	for (let k = 0; k < N; k++) for (let i = 0; i < N; i++) cos[k * N + i] = Math.cos((2 * i + 1) * k * Math.PI / (2.0 * N));
	const alpha = new Float32Array(N);
	alpha[0] = Math.sqrt(1.0 / N);
	for (let k = 1; k < N; k++) alpha[k] = Math.sqrt(2.0 / N);
	const temp = new Float32Array(N * N);
	for (let y = 0; y < N; y++) for (let u = 0; u < N; u++) {
		let sum = 0;
		for (let x = 0; x < N; x++) sum = f(sum + f(gray[y * N + x] * cos[u * N + x]));
		temp[y * N + u] = f(alpha[u] * sum);
	}
	const dct = new Float32Array(N * N);
	for (let u = 0; u < N; u++) for (let v = 0; v < N; v++) {
		let sum = 0;
		for (let y = 0; y < N; y++) sum = f(sum + f(temp[y * N + u] * cos[v * N + y]));
		dct[v * N + u] = f(alpha[v] * sum);
	}
	const ac = new Float32Array(K * K);
	let k = 0;
	for (let v = 1; v <= K; v++) for (let u = 1; u <= K; u++) ac[k++] = dct[v * N + u];
	const sorted = Float32Array.from(ac).sort();
	const median = f(f(sorted[31] + sorted[32]) * 0.5);
	let lo = 0, hi = 0;
	for (let i = 0; i < 64; i++) if (ac[i] > median) { if (i < 32) lo |= 1 << i; else hi |= 1 << (i - 32); }
	return [lo >>> 0, hi >>> 0];
}

test('deterministic for black, white, random', () => {
	const black = new Uint8Array(1024);
	assert.deepStrictEqual(P.computePHash(black), P.computePHash(black));
	const white = new Uint8Array(1024).fill(255);
	assert.deepStrictEqual(P.computePHash(white), P.computePHash(white));
	const img = rng(42).bytes(1024);
	assert.deepStrictEqual(P.computePHash(img), P.computePHash(img));
});

test('slight change -> small hamming distance', () => {
	const img = rng(42).bytes(1024);
	const mod = Uint8Array.from(img); mod[512] ^= 0x10;
	assert.ok(dist(P.computePHash(img), P.computePHash(mod)) <= 10);
});

test('negative image -> most bits flip', () => {
	const textured = blur(rng(7).bytes(1024), 2);
	const inverse = textured.map((v) => 255 - v);
	assert.ok(dist(P.computePHash(textured), P.computePHash(inverse)) > 20);
});

test('wrong length throws', () => {
	assert.throws(() => P.computePHash(new Uint8Array(512)));
});

test('matches the full-DCT reference (VDF scalar path is exact)', () => {
	const r = rng(20260501);
	let differing = 0, total = 0;
	const gens = [
		() => r.bytes(1024),
		() => blur(r.bytes(1024), 2),
		() => blur(r.bytes(1024), 5),
		() => { const b = new Uint8Array(1024); const base = r.int(0, 240); for (let p = 0; p < 1024; p++) b[p] = base + r.int(0, 12); return blur(b, 2); },
		() => { const b = blur(r.bytes(1024), 3); for (let p = 0; p < 1024; p++) b[p] = Math.floor(b[p] / 12); return b; },
	];
	for (const g of gens) for (let i = 0; i < 300; i++) {
		const gray = g();
		const d = dist(P.computePHash(gray), referenceFullDct(gray));
		total++;
		if (d > 0) differing++;
		assert.ok(d <= 2, `distance ${d} exceeds 2-bit tolerance`);
	}
	assert.ok(differing <= total / 100, `${differing}/${total} differ`);
});

test('isDuplicateByPercent semantics', () => {
	const H = (x) => [x >>> 0, 0];
	const same = [0xCAFEBABE, 0xDEADBEEF];
	assert.strictEqual(P.isDuplicateByPercent(same[0], same[1], same[0], same[1], 0.90).pass, true);
	assert.strictEqual(P.isDuplicateByPercent(same[0], same[1], same[0], same[1]).similarity, 1);
	assert.strictEqual(P.isDuplicateByPercent(0, 0, 0xFFFFFFFF, 0xFFFFFFFF).pass, false);
	assert.strictEqual(P.isDuplicateByPercent(0, 0, 0xFFFFFFFF, 0xFFFFFFFF).similarity, 0);
	const one = P.isDuplicateByPercent(0, 0, 1, 0, 0.90);
	assert.strictEqual(one.pass, true);
	assert.strictEqual(one.similarity, f(63 / 64));
	assert.throws(() => P.isDuplicateByPercent(0, 0, 0, 0, -0.1));
	assert.throws(() => P.isDuplicateByPercent(0, 0, 0, 0, 1.1));
	assert.strictEqual(P.isDuplicateByPercent(0, 0, 0xFFFFFFFF, 0xFFFFFFFF, 0).pass, true);
	for (const [b, s] of [[0, 1], [1, 63 / 64], [3, 62 / 64], [0xFF, 56 / 64]])
		assert.ok(Math.abs(P.isDuplicateByPercent(0, 0, ...H(b)).similarity - s) < 1e-5);
	for (const strict of [true, false]) {
		assert.strictEqual(P.isDuplicateByPercent(0, 0, 0b111111, 0, 0.90, strict).pass, true);
		assert.strictEqual(P.isDuplicateByPercent(0, 0, 0b1111111, 0, 0.90, strict).pass, false);
	}
	assert.strictEqual(P.isDuplicateByPercent(same[0], same[1], same[0], same[1], 1.0).pass, true);
	assert.strictEqual(P.isDuplicateByPercent(same[0], same[1], (same[0] ^ 1) >>> 0, same[1], 1.0).pass, false);
});
