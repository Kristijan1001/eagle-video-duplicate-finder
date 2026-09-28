'use strict';
// Difference map (ported from VDF.GUI.Tests/DifferenceMapTests.cs): a logo/subtitle/crop must
// light up, while a global brightness, contrast or gamma change must not flood the mask.
const test = require('node:test');
const assert = require('node:assert');
const { core } = require('../lib/helpers');
const D = core('core/diffmap.js');

function checker(w, h, cell, dark, light) {
	const r = new Float32Array(w * h);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) r[y * w + x] = ((Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0) ? dark : light;
	return r;
}
function withRect(src, w, x0, y0, rw, rh, v) {
	const r = Float32Array.from(src);
	for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) r[y * w + x] = v;
	return r;
}
const count = (mask) => mask.reduce((n, m) => n + (m > 0 ? 1 : 0), 0);
function blobs(w, h, list) {
	const m = new Uint8Array(w * h);
	for (const [bx, by, bw, bh] of list) for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) m[y * w + x] = 200;
	return m;
}

test('brightness and contrast shift produces no highlight', () => {
	const a = checker(96, 96, 8, 40, 210);
	const b = a.map((v) => v * 1.15 + 10);
	assert.strictEqual(count(D.compute(a, b, 96, 96, 0.85)), 0);
});

test('gamma shift produces no highlight at default sensitivity', () => {
	const a = checker(96, 96, 8, 40, 210);
	const b = a.map((v) => 255 * Math.pow(v / 255, 0.85));
	assert.strictEqual(count(D.compute(a, b, 96, 96, 0.5)), 0);
});

test('identical images produce no highlight even at max sensitivity', () => {
	const a = checker(64, 64, 8, 40, 210);
	assert.strictEqual(count(D.compute(a, Float32Array.from(a), 64, 64, 1)), 0);
});

test('flat images at different levels produce no highlight', () => {
	const a = new Float32Array(64 * 64).fill(30), b = new Float32Array(64 * 64).fill(200);
	assert.strictEqual(count(D.compute(a, b, 64, 64, 1)), 0);
});

test('a logo highlights only the logo region', () => {
	const W = 128, H = 128, LX = 84, LY = 84, LS = 32, margin = 3;
	const a = checker(W, H, 16, 40, 210);
	const mask = D.compute(a, withRect(a, W, LX, LY, LS, LS, 255), W, H, 0.5);
	let inH = 0, inT = 0, outH = 0, outT = 0;
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
		const inside = x >= LX && x < LX + LS && y >= LY && y < LY + LS;
		const near = x >= LX - margin && x < LX + LS + margin && y >= LY - margin && y < LY + LS + margin;
		if (inside) { inT++; if (mask[y * W + x]) inH++; }
		else if (!near) { outT++; if (mask[y * W + x]) outH++; }
	}
	assert.ok(inH >= inT * 0.30, `only ${inH}/${inT} logo pixels`);
	assert.ok(outH <= outT * 0.005, `${outH}/${outT} non-logo pixels`);
});

test('higher sensitivity never highlights fewer pixels', () => {
	const a = checker(128, 128, 16, 40, 210);
	const b = withRect(a, 128, 84, 84, 32, 32, 255);
	let prev = -1;
	for (const s of [0.2, 0.5, 0.8]) { const c = count(D.compute(a, b, 128, 128, s)); assert.ok(c >= prev); prev = c; }
});

test('threshold mask drops isolated specks, keeps regions', () => {
	const W = 32, diff = new Float32Array(W * W);
	diff[5 * W + 5] = 10;
	for (let y = 20; y < 23; y++) for (let x = 20; x < 23; x++) diff[y * W + x] = 10;
	const mask = D.thresholdMask(diff, W, W, 1);
	assert.strictEqual(mask[5 * W + 5], 0);
	for (let y = 20; y < 23; y++) for (let x = 20; x < 23; x++) assert.ok(mask[y * W + x] > 0);
});

test('mask intensity scales with difference strength', () => {
	const weak = D.thresholdMask(new Float32Array(64).fill(1.05), 8, 8, 1);
	const strong = D.thresholdMask(new Float32Array(64).fill(5), 8, 8, 1);
	assert.ok(weak[0] > 0 && strong[0] > weak[0] && strong[0] <= 230);
});

test('analysis size fits without upscaling', () => {
	assert.deepStrictEqual(D.analysisSize(3840, 2160), [384, 216]);
	assert.deepStrictEqual(D.analysisSize(2160, 3840), [216, 384]);
	assert.deepStrictEqual(D.analysisSize(300, 200), [300, 200]);
	assert.deepStrictEqual(D.analysisSize(0, 100), [0, 0]);
});

test('luma downscaler averages cells', () => {
	const grays = [[10, 20, 100, 200], [30, 40, 100, 200], [0, 0, 50, 50], [0, 0, 50, 50]];
	const rgba = new Uint8ClampedArray(16 * 4);
	grays.flat().forEach((g, i) => { rgba[i * 4] = g; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = g; rgba[i * 4 + 3] = 255; });
	const l = D.downscaleLuma(rgba, 4, 4, 2, 2);
	[25, 150, 0, 50].forEach((v, i) => assert.ok(Math.abs(l[i] - v) < 0.01, `${l[i]} vs ${v}`));
});

test('normalize removes an affine shift and zeroes flat input', () => {
	const n1 = D.normalize(Float32Array.from([10, 20, 30, 40]));
	const n2 = D.normalize(Float32Array.from([25, 45, 65, 85]));
	n1.forEach((v, i) => assert.ok(Math.abs(v - n2[i]) < 1e-4));
	assert.ok(D.normalize(Float32Array.from([7, 7, 7, 7])).every((v) => v === 0));
});

test('threshold maps and clamps sensitivity', () => {
	for (const [s, e] of [[0, 1.8], [0.5, 1.025], [1, 0.25], [-3, 1.8], [9, 0.25]]) assert.ok(Math.abs(D.thresholdFor(s) - e) < 1e-3, `${s}`);
});

test('a logo yields one region around the logo', () => {
	const W = 128, LX = 84, LS = 32, slack = 8 / W;
	const a = checker(W, W, 16, 40, 210);
	const regions = D.findRegions(D.compute(a, withRect(a, W, LX, LX, LS, LS, 255), W, W, 0.5), W, W);
	assert.strictEqual(regions.length, 1);
	const r = regions[0];
	for (const [v, e] of [[r.x, LX / W], [r.y, LX / W], [r.x + r.width, (LX + LS) / W], [r.y + r.height, (LX + LS) / W]]) assert.ok(Math.abs(v - e) <= slack, `${v} vs ${e}`);
});

test('brightness shift yields no regions', () => {
	const a = checker(96, 96, 8, 40, 210);
	assert.strictEqual(D.findRegions(D.compute(a, a.map((v) => v * 1.15 + 10), 96, 96, 0.85), 96, 96).length, 0);
});

test('two distant changes yield two regions', () => {
	const a = checker(128, 128, 16, 40, 210);
	const b = withRect(withRect(a, 128, 4, 4, 12, 12, 255), 128, 100, 100, 12, 12, 255);
	assert.strictEqual(D.findRegions(D.compute(a, b, 128, 128, 0.5), 128, 128).length, 2);
});

test('nearby fragments merge, distant ones stay apart', () => {
	assert.strictEqual(D.findRegions(blobs(64, 64, [[10, 10, 6, 6], [19, 10, 6, 6]]), 64, 64).length, 1);
	assert.strictEqual(D.findRegions(blobs(64, 64, [[10, 10, 6, 6], [40, 10, 6, 6]]), 64, 64).length, 2);
});

test('tiny components are dropped', () => {
	assert.strictEqual(D.findRegions(blobs(64, 64, [[10, 10, 1, 3]]), 64, 64).length, 0);
	assert.strictEqual(D.findRegions(blobs(64, 64, [[10, 10, 2, 2]]), 64, 64).length, 1);
});

test('region count is capped', () => {
	const list = [];
	for (let by = 0; by < 5; by++) for (let bx = 0; bx < 5; bx++) list.push([bx * 24 + 2, by * 24 + 2, 4, 4]);
	assert.strictEqual(D.findRegions(blobs(128, 128, list), 128, 128).length, D.MAX_REGIONS);
});
