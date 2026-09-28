'use strict';
// Ported from VDF.Core.Tests: PHashQuorumTests, CombinedMatchingTests, DurationToleranceTests,
// IgnorePixelCompareTests (semantics), plus flip / folder-gate / AI-union coverage.
const test = require('node:test');
const assert = require('node:assert');
const { core } = require('../lib/helpers');
const { Matcher, Flags, sameFolderAtDepth } = core('core/matcher.js');
const S = core('core/settings.js');

const f = Math.fround;

function view(over) {
	return S.engineView({ ...S.normalize({}), ...over });
}
/** Video snapshot with N positions: gray fill per position + explicit pHash per position. */
function video(n, grayFill, phashes, extra = {}) {
	const gray = new Uint8Array(n * 1024);
	for (let j = 0; j < n; j++) gray.fill(Array.isArray(grayFill) ? grayFill[j] : grayFill, j * 1024, (j + 1) * 1024);
	let ph = null;
	if (phashes) {
		ph = new Uint32Array(2 * n);
		phashes.forEach((h, j) => {
			const big = BigInt.asUintN(64, BigInt(h));
			ph[2 * j] = Number(big & 0xFFFFFFFFn);
			ph[2 * j + 1] = Number(big >> 32n);
		});
	}
	return { isImage: false, duration: 4, tolerance: 1e9, gray, ph, emb: null, embValid: null, folders: [], size: 1, ...extra };
}
const MAX = 0xFFFFFFFFFFFFFFFFn;

test('pHash quorum: uses all samples, not just the first', () => {
	const m = new Matcher(view({ usePHash: true, percent: 90, pHashSampleRatioPercent: 100, compareHorizontallyFlipped: false }), 2);
	const a = video(2, 0, [0n, 0n]), b = video(2, 0, [0n, MAX]);
	assert.strictEqual(m.check(a, null, null, b), false);
});

test('pHash quorum catches pairs the first sample misses; difference averaged over all', () => {
	const m = new Matcher(view({ usePHash: true, percent: 90, pHashSampleRatioPercent: 60 }), 4);
	const a = video(4, 0, [MAX, 7n, 7n, 7n]), b = video(4, 0, [0n, 7n, 7n, 7n]);
	assert.strictEqual(m.check(a, null, null, b), true);
	assert.strictEqual(m.difference, 0.25);
});

test('pHash required ratio honored', () => {
	const hashesA = [0n, 0n, 0n, 0n, 0n], hashesB = [0n, 0n, 0xFFFFFn, 0xFFFFFn, 0xFFFFFn];
	let m = new Matcher(view({ usePHash: true, percent: 75, pHashSampleRatioPercent: 60 }), 5);
	assert.strictEqual(m.check(video(5, 0, hashesA), null, null, video(5, 0, hashesB)), false);
	m = new Matcher(view({ usePHash: true, percent: 75, pHashSampleRatioPercent: 40 }), 5);
	assert.strictEqual(m.check(video(5, 0, hashesA), null, null, video(5, 0, hashesB)), true);
});

test('pHash difference averaged (0 and 16 bits at 75% -> 0.125)', () => {
	const m = new Matcher(view({ usePHash: true, percent: 75, pHashSampleRatioPercent: 100 }), 2);
	assert.strictEqual(m.check(video(2, 0, [0n, 0n]), null, null, video(2, 0, [0n, 0xFFFFn])), true);
	assert.ok(m.difference > 0.124 && m.difference < 0.126);
});

test('full-orientation match reports lower difference than a partial match', () => {
	const six = 0x3Fn;
	const m = new Matcher(view({ usePHash: true, percent: 90, pHashSampleRatioPercent: 60 }), 4);
	assert.ok(m.check(video(4, 0, [0n, 0n, 0n, 0n]), null, null, video(4, 0, [six, six, six, six])));
	const full = m.difference;
	assert.ok(m.check(video(4, 0, [MAX, 0n, 0n, 0n]), null, null, video(4, 0, [0n, 0n, 0n, 0n])));
	assert.ok(full < m.difference);
});

test('combined mode: flags and difference', () => {
	const m = new Matcher(view({ combineGrayPHash: true, usePHash: false, percent: 96, pHashSampleRatioPercent: 100, ignoreBlackPixels: false, ignoreWhitePixels: false }), 1);
	assert.ok(m.check(video(1, 7, [0n]), null, null, video(1, 7, [MAX])));
	assert.strictEqual(m.algorithms, Flags.GrayscaleMatched); assert.strictEqual(m.difference, 0);
	assert.ok(m.check(video(1, 0, [7n]), null, null, video(1, 255, [7n])));
	assert.strictEqual(m.algorithms, Flags.PHashMatched); assert.strictEqual(m.difference, 0);
	assert.ok(m.check(video(1, 0, [7n]), null, null, video(1, 10, [7n])));
	assert.strictEqual(m.algorithms, Flags.GrayscaleMatched | Flags.PHashMatched); assert.strictEqual(m.difference, 0);
	assert.strictEqual(m.check(video(1, 0, [0n]), null, null, video(1, 255, [MAX])), false);
	assert.strictEqual(m.algorithms, 0);
	const single = new Matcher(view({ combineGrayPHash: false, percent: 96, ignoreBlackPixels: false, ignoreWhitePixels: false }), 1);
	assert.ok(single.check(video(1, 7, [7n]), null, null, video(1, 7, [7n])));
	assert.strictEqual(single.algorithms, 0);
});

test('images always compare by grayscale; combined badge says so', () => {
	const m = new Matcher(view({ combineGrayPHash: true, percent: 96, ignoreBlackPixels: false, ignoreWhitePixels: false }), 1);
	const img = (fill) => ({ isImage: true, gray: new Uint8Array(1024).fill(fill), ph: null, folders: [] });
	assert.ok(m.check(img(7), null, null, img(7)));
	assert.strictEqual(m.algorithms, Flags.GrayscaleMatched);
});

test('duration tolerance (VDF DurationToleranceTests)', () => {
	const t = (o, d) => S.durationToleranceSeconds({ ...S.DEFAULTS, durationDifferenceMinSeconds: 0, durationDifferenceMaxSeconds: 0, ...o }, d);
	const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
	near(t({ percentDurationDifference: 1 }, 3600), 36);
	near(t({ percentDurationDifference: 1 }, 60), 0.6);
	near(t({ percentDurationDifference: 1, durationDifferenceMinSeconds: 5 }, 60), 5);
	near(t({ percentDurationDifference: 1, durationDifferenceMinSeconds: 5 }, 3600), 36);
	near(t({ percentDurationDifference: 1, durationDifferenceMaxSeconds: 10 }, 3600), 10);
	near(t({ percentDurationDifference: 1, durationDifferenceMaxSeconds: 10 }, 60), 0.6);
	near(t({ percentDurationDifference: 1, durationDifferenceMinSeconds: 5, durationDifferenceMaxSeconds: 10 }, 700), 7);
	assert.strictEqual(t({ percentDurationDifference: 0 }, 3600), 0);
	near(t({ percentDurationDifference: 0, durationDifferenceMaxSeconds: 15 }, 60), 15);
	near(t({ percentDurationDifference: 0, durationDifferenceMinSeconds: 8 }, 3600), 8);
	near(t({ percentDurationDifference: 0, durationDifferenceMinSeconds: 5, durationDifferenceMaxSeconds: 15 }, 3600), 15);
});

test('duration gate uses min of both tolerances', () => {
	const m = new Matcher(view({ percent: 90, compareHorizontallyFlipped: false }), 1);
	const a = video(1, 100, null, { duration: 100, tolerance: 20 });
	const b = video(1, 100, null, { duration: 115, tolerance: 5 });
	assert.strictEqual(m.comparePair(a, b), null);
	b.tolerance = 15;
	assert.ok(m.comparePair(a, b));
});

test('gray threshold boundary is float32-exact', () => {
	// diff of exactly 10 per pixel -> 10/256 = 0.0390625; limit at 96% is f(1-0.96f)
	const m = new Matcher(view({ percent: 96, ignoreBlackPixels: false, ignoreWhitePixels: false, compareHorizontallyFlipped: false }), 1);
	const limit = f(1 - f(f(96) / 100));
	const d = f(f(10 * 1024) / 1024 / 256);
	assert.strictEqual(m.check(video(1, 100), null, null, video(1, 110)), d <= limit);
});

test('ignore black pixels: all-black frames give NaN -> not a duplicate', () => {
	const m = new Matcher(view({ percent: 90, ignoreBlackPixels: true, ignoreWhitePixels: false, compareHorizontallyFlipped: false }), 1);
	assert.strictEqual(m.check(video(1, 0), null, null, video(1, 0)), false);
	const mOff = new Matcher(view({ percent: 90, ignoreBlackPixels: false, ignoreWhitePixels: false }), 1);
	assert.strictEqual(mOff.check(video(1, 0), null, null, video(1, 0)), true);
});

test('flipped copy is found and flagged', () => {
	const m = new Matcher(view({ percent: 95, ignoreBlackPixels: false, ignoreWhitePixels: false, compareHorizontallyFlipped: true }), 1);
	const g = new Uint8Array(1024);
	for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) g[y * 32 + x] = x * 8;
	const mirrored = new Uint8Array(1024);
	for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) mirrored[y * 32 + x] = (31 - x) * 8;
	const a = { ...video(1, 0), gray: g }, b = { ...video(1, 0), gray: mirrored };
	const r = m.comparePair(a, b);
	assert.ok(r);
	assert.strictEqual(r.flags & Flags.Flipped, Flags.Flipped);
	assert.strictEqual(r.difference, 0);
	const noFlip = new Matcher(view({ percent: 95, ignoreBlackPixels: false, ignoreWhitePixels: false, compareHorizontallyFlipped: false }), 1);
	assert.strictEqual(noFlip.comparePair({ ...a }, { ...b }), null);
});

test('folder gate: same / different at depth', () => {
	assert.ok(sameFolderAtDepth('Anime/Bleach/Rukia', 'Other/Rukia', 1));
	assert.ok(!sameFolderAtDepth('Anime/Bleach/Rukia', 'Other/Rukia', 2));
	assert.ok(sameFolderAtDepth('A/B/', 'x/A/b', 2));
	const same = new Matcher(view({ folderMatchMode: 'same', percent: 90 }), 1);
	const a = video(1, 100, null, { folders: ['A/B'] }), b = video(1, 100, null, { folders: ['C/D', 'Z/B'] });
	assert.ok(same.comparePair(a, b));
	const diff = new Matcher(view({ folderMatchMode: 'different', percent: 90 }), 1);
	assert.strictEqual(diff.comparePair(a, b), null);
	assert.ok(diff.comparePair(a, video(1, 100, null, { folders: ['Q'] })));
});

test('hard links excluded when enabled', () => {
	const m = new Matcher(view({ excludeHardLinks: true, percent: 90 }), 1);
	const a = video(1, 100, null, { size: 5, dev: '1', ino: '42' });
	const b = video(1, 100, null, { size: 5, dev: '1', ino: '42' });
	assert.strictEqual(m.comparePair(a, b), null);
	b.ino = '43';
	assert.ok(m.comparePair(a, b));
});

test('AI union: classic miss + embeddings above threshold -> AiMatched', () => {
	const m = new Matcher(view({ useAiMatching: true, aiPercent: 94, percent: 99, ignoreBlackPixels: false, ignoreWhitePixels: false, compareHorizontallyFlipped: false }), 2);
	const emb = new Int8Array(2 * 384).fill(0);
	for (let j = 0; j < 2; j++) emb[j * 384] = 127;
	const a = { ...video(2, 50), emb, embValid: new Uint8Array([1, 1]) };
	const b = { ...video(2, 90), emb: Int8Array.from(emb), embValid: new Uint8Array([1, 1]) };
	const r = m.comparePair(a, b);
	assert.ok(r);
	assert.strictEqual(r.flags & Flags.AiMatched, Flags.AiMatched);
	assert.strictEqual(r.difference, 0);
	// fewer than half the positions valid -> abstain
	b.embValid = new Uint8Array([0, 0]);
	assert.strictEqual(m.comparePair(a, b), null);
});
