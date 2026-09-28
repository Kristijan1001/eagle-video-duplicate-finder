'use strict';
// Compare window logic (ported from VDF.GUI.Tests/ComparerCullingTests.cs).
const test = require('node:test');
const assert = require('node:assert');
const { core } = require('../lib/helpers');
const { CullingPairFlow, buildChips, formatChipDuration } = core('core/comparer-logic.js');

test('starts with the first two items', () => {
	const f = new CullingPairFlow(3);
	assert.deepStrictEqual([f.leftIndex, f.rightIndex, f.pairNumber, f.pairCount, f.hasPair], [0, 1, 1, 2, true]);
});

test('single-item group has no pair', () => {
	const f = new CullingPairFlow(1);
	assert.strictEqual(f.hasPair, false);
	assert.strictEqual(f.advance('keepLeft').groupFinished, true);
});

test('keep left checks the challenger, keeper stays', () => {
	const f = new CullingPairFlow(3);
	const s = f.advance('keepLeft');
	assert.deepStrictEqual([s.checkIndex, s.keepIndex, s.groupFinished], [1, 0, false]);
	assert.deepStrictEqual([f.leftIndex, f.rightIndex, f.pairNumber], [0, 2, 2]);
});

test('keep right crowns the challenger, checks the old keeper', () => {
	const f = new CullingPairFlow(4);
	const s = f.advance('keepRight');
	assert.deepStrictEqual([s.checkIndex, s.keepIndex, f.leftIndex, f.rightIndex], [0, 1, 1, 2]);
});

test('skip decides nothing and advances the challenger', () => {
	const f = new CullingPairFlow(3);
	const s = f.advance('skip');
	assert.deepStrictEqual([s.checkIndex, s.keepIndex, f.leftIndex, f.rightIndex], [-1, -1, 0, 2]);
});

test('a group of N finishes after N-1 pairs', () => {
	const f = new CullingPairFlow(4);
	assert.strictEqual(f.advance('keepLeft').groupFinished, false);
	assert.strictEqual(f.advance('keepRight').groupFinished, false);
	assert.strictEqual(f.advance('keepLeft').groupFinished, true);
	assert.strictEqual(f.hasPair, false);
});

test('full walk checks every loser exactly once', () => {
	const f = new CullingPairFlow(4);
	const checked = [];
	for (const d of ['keepLeft', 'keepRight', 'keepLeft']) { const s = f.advance(d); if (s.checkIndex >= 0) checked.push(s.checkIndex); }
	assert.deepStrictEqual(checked, [1, 0, 3]);
	assert.strictEqual(f.leftIndex, 2);
});

test('setPair re-anchors the walk, invalid picks are ignored', () => {
	const f = new CullingPairFlow(5);
	f.setPair(2, 3);
	assert.deepStrictEqual([f.leftIndex, f.rightIndex], [2, 3]);
	assert.strictEqual(f.advance('keepLeft').checkIndex, 3);
	assert.strictEqual(f.rightIndex, 4);
	f.setPair(1, 1); assert.strictEqual(f.leftIndex, 2);
	f.setPair(-1, 2); assert.strictEqual(f.leftIndex, 2);
});

const fmt = { bytes: (n) => `${n} B`, date: (it) => it.date || '' };
const video = (o = {}) => ({ size: 1000, frameSizeInt: 1920 * 1080, frameSize: '1920x1080', format: 'hevc', fps: 24, audioFormat: 'aac', audioSampleRate: 48000, duration: 20 * 60 + 26, date: '4/28/2024', isImage: false, ...o });

test('chips: equal values stay neutral', () => {
	assert.ok(buildChips(video(), video(), fmt).every((c) => c.state === 'neutral'));
});

test('chips: higher resolution and size turn better, lower worse', () => {
	const a = video({ size: 2000, frameSizeInt: 3840 * 2160, frameSize: '3840x2160' }), b = video();
	const ca = buildChips(a, b, fmt), cb = buildChips(b, a, fmt);
	assert.strictEqual(ca.find((c) => c.text === '3840x2160').state, 'better');
	assert.strictEqual(ca.find((c) => c.text === '2000 B').state, 'better');
	assert.strictEqual(cb.find((c) => c.text === '1920x1080').state, 'worse');
	assert.strictEqual(cb.find((c) => c.text === '1000 B').state, 'worse');
});

test('chips: duration, codec, audio and date are never judged', () => {
	const c = buildChips(video({ fps: 60 }), video({ fps: 24 }), fmt);
	for (const t of ['20:26']) assert.strictEqual(c.find((x) => x.text === t).state, 'neutral');
	assert.strictEqual(c.find((x) => x.text.startsWith('HEVC')).state, 'neutral');
	assert.strictEqual(c.find((x) => x.text.startsWith('aac')).state, 'neutral');
	assert.ok(c.find((x) => x.text === 'HEVC · 60 fps'));
	assert.ok(c.find((x) => x.text === 'aac · 48 kHz'));
});

test('chips: images skip video-only chips; no other = all neutral', () => {
	const img = { size: 500, frameSizeInt: 100, frameSize: '800x600', isImage: true, format: 'nope', audioFormat: 'nope' };
	const c = buildChips(img, null, fmt);
	assert.ok(!c.some((x) => x.text.includes('nope')));
	assert.ok(c.some((x) => x.text === '800x600'));
	assert.ok(buildChips(video(), null, fmt).every((x) => x.state === 'neutral'));
});

test('chips: video bitrate is shown and judged, audio bitrate joins the audio chip', () => {
	const hi = video({ bitRateKbs: 60932, audioBitRateKbs: 317 }), lo = video({ bitRateKbs: 60880, audioBitRateKbs: 317 });
	const ch = buildChips(hi, lo, fmt), cl = buildChips(lo, hi, fmt);
	assert.strictEqual(ch.find((c) => c.kind === 'bitrate').text, '60932 kb/s');
	assert.strictEqual(ch.find((c) => c.kind === 'bitrate').state, 'better');
	assert.strictEqual(cl.find((c) => c.kind === 'bitrate').state, 'worse');
	assert.ok(ch.find((c) => c.text === 'aac · 48 kHz · 317 kb/s'));
	assert.strictEqual(buildChips(hi, video({ bitRateKbs: 60932 }), fmt).find((c) => c.kind === 'bitrate').state, 'neutral');
	assert.strictEqual(buildChips(video({ bitRateKbs: 0 }), hi, fmt).some((c) => c.kind === 'bitrate'), false);
});

test('chips: HDR beats SDR', () => {
	assert.strictEqual(buildChips(video({ hdrFormat: 'HDR10+' }), video(), fmt).find((c) => c.text === 'HDR10+').state, 'better');
});

test('chip duration format', () => {
	assert.strictEqual(formatChipDuration(20 * 60 + 26), '20:26');
	assert.strictEqual(formatChipDuration(3723), '1:02:03');
	assert.strictEqual(formatChipDuration(42), '0:42');
});
