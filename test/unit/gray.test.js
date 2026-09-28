'use strict';
// Ported from VDF.Core.Tests/Utils/GrayBytesUtilsTests.cs
const test = require('node:test');
const assert = require('node:assert');
const { core, rng } = require('../lib/helpers');
const G = core('core/gray.js');
const M = core('core/matcher.js');

const f = Math.fround;
function referenceDifference(a, b) {
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
	return f(f(f(diff) / a.length) / 256);
}
function scalarMasked(a, b, ib, iw) {
	let diff = 0, counter = 0;
	for (let i = 0; i < a.length; i++) {
		let valid = true;
		if (ib) valid = a[i] > 0x20 && b[i] > 0x20;
		if (!valid) continue;
		if (iw) valid = a[i] < 0xF0 && b[i] < 0xF0;
		if (!valid) continue;
		diff += Math.abs(a[i] - b[i]);
		counter++;
	}
	return f(f(f(diff) / counter) / 256);
}

test('max difference (black vs white) equals the scalar reference', () => {
	const black = new Uint8Array(1024), white = new Uint8Array(1024).fill(255);
	assert.strictEqual(G.percentageDifference(black, white), referenceDifference(black, white));
	assert.ok(Math.abs(G.percentageDifference(black, white) - 255 / 256) < 1e-6);
});

test('dissimilar pair matches scalar reference', () => {
	const a = new Uint8Array(1024), b = new Uint8Array(1024);
	for (let i = 0; i < 1024; i++) { a[i] = i % 64; b[i] = 200 + (i % 56); }
	const expected = referenceDifference(a, b);
	assert.ok(expected > 0.25);
	assert.strictEqual(G.percentageDifference(a, b), expected);
});

test('large buffer does not overflow', () => {
	const a = new Uint8Array(4096), b = new Uint8Array(4096).fill(255);
	assert.strictEqual(G.percentageDifference(a, b), referenceDifference(a, b));
});

test('masked large buffer matches reference', () => {
	const a = new Uint8Array(4096), b = new Uint8Array(4096);
	for (let i = 0; i < a.length; i++) { a[i] = 40 + i % 40; b[i] = 170 + i % 40; }
	assert.strictEqual(G.percentageDifferenceWithoutSpecificPixels(a, b, true, true), scalarMasked(a, b, true, true));
});

test('verifyGrayScaleValues thresholds', () => {
	assert.strictEqual(G.verifyGrayScaleValues(new Uint8Array(1024)), false);
	assert.strictEqual(G.verifyGrayScaleValues(new Uint8Array(1024).fill(0xFF)), true);
	const d79 = new Uint8Array(100); d79.fill(0x80, 79);
	assert.strictEqual(G.verifyGrayScaleValues(d79), true);
	const d80 = new Uint8Array(100); d80.fill(0x80, 80);
	assert.strictEqual(G.verifyGrayScaleValues(d80), false);
	const d50 = new Uint8Array(100); d50.fill(0x80, 50);
	assert.strictEqual(G.verifyGrayScaleValues(d50, 60), true);
	assert.strictEqual(G.verifyGrayScaleValues(d50, 40), false);
});

test('identical frames -> 0, opposite -> ~1, near -> small', () => {
	const img = rng(42).bytes(1024);
	assert.strictEqual(G.percentageDifference(img, img), 0);
	assert.ok(G.percentageDifference(new Uint8Array(1024), new Uint8Array(1024).fill(255)) > 0.9);
	assert.ok(G.percentageDifference(new Uint8Array(1024).fill(128), new Uint8Array(1024).fill(130)) < 0.01);
});

test('flip: double flip is identity, rows reversed, 16x16 supported', () => {
	const img = rng(42).bytes(1024);
	assert.deepStrictEqual(G.flipGrayScale(G.flipGrayScale(img)), img);
	const rows = new Uint8Array(1024);
	for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) rows[y * 32 + x] = x;
	const fl = G.flipGrayScale(rows);
	for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) assert.strictEqual(fl[y * 32 + x], 31 - x);
	const small = rng(42).bytes(256);
	assert.deepStrictEqual(G.flipGrayScale(G.flipGrayScale(small)), small);
});

test('masked: black / white / boundary semantics', () => {
	const a = new Uint8Array(1024).fill(0x10), b = new Uint8Array(1024);
	a[0] = 0x80; b[0] = 0x80;
	assert.strictEqual(G.percentageDifferenceWithoutSpecificPixels(a, b, true, false), 0);
	const w1 = new Uint8Array(1024).fill(0xFF), w2 = new Uint8Array(1024).fill(0xF8);
	w1[0] = 0x80; w2[0] = 0x80;
	assert.strictEqual(G.percentageDifferenceWithoutSpecificPixels(w1, w2, false, true), 0);
	const c1 = new Uint8Array(1024).fill(0x20), c2 = new Uint8Array(1024).fill(0xF0);
	c1[0] = 0x80; c2[0] = 0x80; c1[1] = 0x21; c2[1] = 0x21; c1[2] = 0xEF; c2[2] = 0xEF;
	assert.strictEqual(G.percentageDifferenceWithoutSpecificPixels(c1, c2, true, true), 0);
});

test('masked matches scalar reference for all four mask combos (incl. NaN)', () => {
	const r = rng(20260501);
	for (const [ib, iw] of [[false, false], [true, false], [false, true], [true, true]]) {
		for (let t = 0; t < 8; t++) {
			const a = r.bytes(1024), b = r.bytes(1024);
			const actual = G.percentageDifferenceWithoutSpecificPixels(a, b, ib, iw);
			const expected = (!ib && !iw) ? referenceDifference(a, b) : scalarMasked(a, b, ib, iw);
			if (Number.isNaN(expected)) assert.ok(Number.isNaN(actual));
			else assert.strictEqual(actual, expected);
		}
	}
	const allBlack = new Uint8Array(1024);
	assert.ok(Number.isNaN(G.percentageDifferenceWithoutSpecificPixels(allBlack, allBlack, true, false)));
});

test('matcher offset kernels equal gray.js', () => {
	const r = rng(7);
	for (let t = 0; t < 20; t++) {
		const a = r.bytes(2048), b = r.bytes(2048);
		const a1 = a.subarray(1024), b1 = b.subarray(1024);
		assert.strictEqual(M.frameDiff(a, 1024, b, 1024), G.percentageDifference(a1, b1));
		for (const [ib, iw] of [[true, false], [false, true], [true, true]])
			assert.strictEqual(M.frameDiffMasked(a, 1024, b, 1024, ib, iw), G.percentageDifferenceWithoutSpecificPixels(a1, b1, ib, iw));
	}
});
