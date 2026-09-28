'use strict';
// Hover diff (ported from VDF.GUI.Tests/HoverDiffTests.cs): every value of a group shown as
// its difference to the best one; nothing at all when the group ties on the metric.
const test = require('node:test');
const assert = require('node:assert');
const { core } = require('../lib/helpers');
const R = core('core/results.js');

let n = 0;
const item = (o = {}) => ({ id: `i${n++}`, duration: 0, frameSizeInt: 0, size: 0, fps: 0, bitRateKbs: 0, audioBitRateKbs: 0, ...o });

test('all tied shows nothing instead of BEST on every row (#849)', () => {
	const a = item({ duration: 120, isBestDuration: true });
	const b = item({ duration: 120, isBestDuration: true });
	assert.strictEqual(R.hoverDiffs([a, b], 'duration'), null);
});

test('distinct values: best gets the label, the other its delta', () => {
	const best = item({ duration: 120, isBestDuration: true });
	const worse = item({ duration: 107 });
	const d = R.hoverDiffs([best, worse], 'duration');
	assert.strictEqual(d.get(best.id), 'BEST');
	assert.strictEqual(d.get(worse.id), '-13s');
});

test('a tie on one metric does not suppress another', () => {
	const a = item({ frameSizeInt: 1920 * 1080, size: 1000, isBestFrameSize: true, isBestSize: true });
	const b = item({ frameSizeInt: 1920 * 1080, size: 800, isBestFrameSize: true });
	assert.strictEqual(R.hoverDiffs([a, b], 'framesize'), null);
	const s = R.hoverDiffs([a, b], 'size');
	assert.strictEqual(s.get(a.id), 'BEST');
	assert.strictEqual(s.get(b.id), '-20%');
});

test('bitrate metrics diff like the others', () => {
	const best = item({ bitRateKbs: 1000, isBestBitRateKbs: true });
	const worse = item({ bitRateKbs: 750 });
	const d = R.hoverDiffs([best, worse], 'bitrate');
	assert.strictEqual(d.get(best.id), 'BEST');
	assert.strictEqual(d.get(worse.id), '-25%');
});

test('every hoverable metric detects ties', () => {
	const a = item({ duration: 60, frameSizeInt: 100, size: 5 });
	const b = item({ duration: 60, frameSizeInt: 100, size: 5 });
	for (const m of R.HOVER_METRICS) assert.strictEqual(R.hoverDiffs([a, b], m), null, m);
	b.fps = 30;
	assert.notStrictEqual(R.hoverDiffs([a, b], 'fps'), null);
});

test('formatting matches VDF (FormatPercentDiff / FormatDurationDiff)', () => {
	assert.strictEqual(R.formatPercentDiff(0.4), '=');
	assert.strictEqual(R.formatPercentDiff(-0.6), '-1%');
	assert.strictEqual(R.formatPercentDiff(12.5), '+13%');
	assert.strictEqual(R.formatDurationDiff(0), '=');
	assert.strictEqual(R.formatDurationDiff(-75), '-1m15s');
	assert.strictEqual(R.formatDurationDiff(3725), '+1h02m05s');
});
