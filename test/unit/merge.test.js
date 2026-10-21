'use strict';
// "Merge into the copy that stays": the plan the confirmation shows is the plan that is applied.
const test = require('node:test');
const assert = require('node:assert');
const { core } = require('../lib/helpers');
const { planMerge, MAX_ANNOTATION } = core('core/merge.js');

const ALL = { mergeTags: true, mergeFolders: true, mergeRating: true, mergeAnnotation: true, mergeUrl: true };
const keeper = { tags: ['Anime'], folders: ['F1'], star: 2, annotation: 'mine', url: '' };
const others = [
	{ tags: ['Anime', 'Fav'], folders: ['F2'], star: 5, annotation: 'theirs', url: 'https://example.com/a' },
	{ tags: ['Clip'], folders: ['F1'], star: 0, annotation: '  mine ', url: 'https://example.com/b' },
];

test('planMerge: lists exactly what the kept copy gains', () => {
	const p = planMerge(keeper, others, ALL);
	assert.deepStrictEqual(p.addTags, ['Fav', 'Clip']);
	assert.deepStrictEqual(p.addFolders, ['F2']);
	assert.deepStrictEqual(p.star, { from: 2, to: 5 });
	assert.strictEqual(p.notesAdded, 1); // "mine" twice counts once
	assert.strictEqual(p.url, 'https://example.com/a');
	assert.strictEqual(p.changed, true);
	assert.deepStrictEqual(p.next, { tags: ['Anime', 'Fav', 'Clip'], folders: ['F1', 'F2'], star: 5, annotation: 'mine\n\ntheirs', url: 'https://example.com/a' });
});

test('planMerge: options off or nothing new means no change', () => {
	const off = planMerge(keeper, others, {});
	assert.strictEqual(off.changed, false);
	assert.deepStrictEqual(off.next, { ...keeper });
	const same = planMerge(keeper, [{ tags: ['Anime'], folders: ['F1'], star: 1, annotation: 'mine', url: '' }], ALL);
	assert.strictEqual(same.changed, false);
	assert.strictEqual(same.star, null);
});

test('planMerge: a keeper with a source URL keeps it; notes beyond Eagle\'s limit are reported', () => {
	assert.strictEqual(planMerge({ ...keeper, url: 'https://keep' }, others, ALL).url, null);
	const big = 'x'.repeat(MAX_ANNOTATION - 10);
	const p = planMerge({ ...keeper, annotation: big }, [{ annotation: 'y'.repeat(50) }], { mergeAnnotation: true });
	assert.strictEqual(p.notesSkipped, 1);
	assert.strictEqual(p.notesAdded, 0);
	assert.strictEqual(p.changed, false);
});
