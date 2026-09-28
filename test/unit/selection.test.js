'use strict';
// Selection tools, quality ranker (ported from VDF QualityRankerTests semantics) and the
// expression language.
const test = require('node:test');
const assert = require('node:assert');
const { core } = require('../lib/helpers');
const S = core('core/selection.js');
const X = core('core/expression.js');

const item = (o) => ({ id: o.id, groupId: o.g || 1, size: 100, duration: 60, frameSizeInt: 3000, frameSize: '1920x1080', format: 'h264',
	audioFormat: 'aac', audioChannel: 'stereo', audioSampleRate: 48000, bitRateKbs: 5000, fps: 25, audioBitRateKbs: 128,
	isImage: false, similarity: 99, checked: false, visible: true, dateCreated: 0, ...o });

test('quality keeper: resolution decides, near ties fall through', () => {
	const crit = S.resolveCriteria(['Duration', 'Resolution', 'Bitrate', 'FPS', 'Bits per pixel', 'Audio Bitrate', 'Size', 'SizeLarger'], ['SizeLarger']);
	const a = item({ id: 'a', duration: 60.2, frameSizeInt: 1280 + 720, frameSize: '1280x720' });
	const b = item({ id: 'b', duration: 60, frameSizeInt: 1920 + 1080 });
	const r = S.pickKeeper([a, b], crit);
	assert.strictEqual(r.keeper.id, 'b');
	assert.strictEqual(r.decidedBy, 'Resolution');
	// bitrate within 5% ties → size (smaller wins) decides
	const c = item({ id: 'c', bitRateKbs: 5000, size: 300 });
	const d = item({ id: 'd', bitRateKbs: 5200, size: 200, fps: 25 });
	const r2 = S.pickKeeper([c, d], crit);
	assert.strictEqual(r2.keeper.id, 'd');
	assert.strictEqual(r2.decidedBy, 'Size');
});

test('video-only criteria are skipped for images', () => {
	const crit = S.resolveCriteria(['Duration', 'Resolution', 'Size'], []);
	const a = item({ id: 'a', isImage: true, duration: 0, frameSizeInt: 1000, size: 50 });
	const b = item({ id: 'b', isImage: true, duration: 0, frameSizeInt: 1000, size: 40 });
	assert.strictEqual(S.pickKeeper([a, b], crit).keeper.id, 'b');
});

test('check lowest quality checks everything except the keeper', () => {
	const crit = S.resolveCriteria(S.CRITERIA ? Object.keys(S.CRITERIA) : [], ['SizeLarger']);
	const items = [item({ id: 'a', frameSizeInt: 2000 }), item({ id: 'b', frameSizeInt: 3000 }), item({ id: 'c', frameSizeInt: 1000 }), item({ id: 'z', g: 2 })];
	const ch = new Map(S.checkLowestQuality(items, crit).map(([d, v]) => [d.id, v]));
	assert.deepStrictEqual([ch.get('a'), ch.get('b'), ch.get('c')], [true, false, true]);
	assert.ok(!ch.has('z')); // single-member group untouched
});

test('check oldest keeps newest; check newest keeps oldest', () => {
	const items = [item({ id: 'a', dateCreated: 1 }), item({ id: 'b', dateCreated: 3 }), item({ id: 'c', dateCreated: 2 })];
	const date = (d) => d.dateCreated;
	assert.deepStrictEqual(new Map(S.checkOldest(items, date).map(([d, v]) => [d.id, v])), new Map([['b', false], ['c', true], ['a', true]]));
	assert.deepStrictEqual(new Map(S.checkNewest(items, date).map(([d, v]) => [d.id, v])), new Map([['a', false], ['c', true], ['b', true]]));
});

test('check identical / identical but size', () => {
	const items = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c', size: 50 })];
	const m = new Map(S.checkWhenIdentical(items).map(([d, v]) => [d.id, v]));
	assert.deepStrictEqual(m, new Map([['b', true], ['a', false]]));
	const m2 = new Map(S.checkWhenIdenticalButSize(items).map(([d, v]) => [d.id, v]));
	assert.deepStrictEqual(m2, new Map([['c', false], ['b', true], ['a', true]]));
});

test('custom selection: partial match checks matched, keeps unmatched', () => {
	const items = [item({ id: 'a', size: 5 << 20 }), item({ id: 'b', size: 50 << 20 }), item({ id: 'c', size: 60 << 20 })];
	const plan = S.computeCustomSelection(items, { minimumFileSize: 40 }, (d) => d.dateCreated, () => ['x']);
	assert.deepStrictEqual(plan.toCheck.map((d) => d.id), ['b', 'c']);
	assert.deepStrictEqual(plan.keepers, []);
	const all = S.computeCustomSelection(items, {}, (d) => d.dateCreated, () => ['x']);
	assert.deepStrictEqual(all.keepers.map((d) => d.id), ['a']);
	assert.deepStrictEqual(all.toCheck.map((d) => d.id), ['b', 'c']);
	const pathed = S.computeCustomSelection(items, { pathContains: ['*keep*'] }, (d) => 0, (d) => [d.id === 'b' ? 'Anime/keep/b.mp4' : 'x']);
	assert.deepStrictEqual(pathed.toCheck.map((d) => d.id), ['b']);
});

test('expressions: VDF examples and Eagle fields', () => {
	const d = item({ id: 'a', isImage: true, size: 4000, duration: 16 * 60 + 5, name: 'Show S01E02', path: 'X:/imageFolder/a.png' });
	assert.strictEqual(X.compile('item.IsImage && item.SizeLong > 3000')(d, {}), true);
	assert.strictEqual(X.compile('item.Path.Contains("imageFolder")')(d, {}), true);
	assert.strictEqual(X.compile('item.Duration.Minutes > 15')(d, {}), true);
	assert.strictEqual(X.compile('Regex.IsMatch(item.Name, "S\\\\d+E\\\\d+")')(d, {}), true);
	assert.strictEqual(X.compile('item.Tags.Contains("WIP") || item.Rating < 2')(d, { tags: ['wip'], star: 5 }), true);
	assert.strictEqual(X.compile('item.Duration.TotalSeconds >= 60 ? true : false')(d, {}), true);
	assert.strictEqual(X.compile('!(item.Similarity < 50) && item.Format == "h264"')(d, {}), true);
});

test('expressions: assignment and unknown members are rejected', () => {
	assert.throws(() => X.compile('item.IsBestSize = true'), /Assignment/);
	assert.throws(() => X.compile('item.Nope > 1')(item({ id: 'a' }), {}), /Unknown member/);
	assert.throws(() => X.compile('require("fs")')(item({ id: 'a' }), {}), X.ExprError);
	assert.throws(() => X.compile('item.Name.constructor')(item({ id: 'a' }), {}), /Unknown member/);
	assert.throws(() => X.compile('(1 + '), /Unexpected end/);
});

test('partition expression matches: full groups separated', () => {
	const items = [item({ id: 'a', g: 1, size: 10 }), item({ id: 'b', g: 1, size: 20 }), item({ id: 'c', g: 2, size: 30 }), item({ id: 'd', g: 2, size: 40 })];
	const p = S.partitionExpressionMatches(items, (d) => d.size >= 20);
	assert.deepStrictEqual(p.partial.map((d) => d.id), ['b']);
	assert.strictEqual(p.full.length, 1);
});
