'use strict';
// Settings: normalisation, profiles and the per-library scope swap.
const test = require('node:test');
const assert = require('node:assert');
const { core } = require('../lib/helpers');
const S = core('core/settings.js');

const apply = (s, patch) => S.normalize({ ...s, ...(patch || {}) });

test('normalize: unknown keys dropped, wrong types fall back, ranges clamped', () => {
	const s = S.normalize({ percent: 140, thumbnails: 0, bogus: 1, scopeFolderIds: 'x', aiPercent: '93' });
	assert.strictEqual(s.percent, 100);
	assert.strictEqual(s.thumbnails, 1);
	assert.ok(!('bogus' in s));
	assert.deepStrictEqual(s.scopeFolderIds, []);
	assert.strictEqual(s.aiPercent, S.DEFAULTS.aiPercent);
});

test('confirmations: all on by default, a saved "don\'t ask again" is kept', () => {
	const keys = ['confirmTrash', 'confirmMoveToFolder', 'confirmAddToFolder', 'confirmAddTag'];
	const d = S.normalize({});
	for (const k of keys) assert.strictEqual(d[k], true, k);
	const s = S.normalize({ confirmMoveToFolder: false, confirmTrash: 'no' });
	assert.strictEqual(s.confirmMoveToFolder, false);
	assert.strictEqual(s.confirmTrash, true); // a wrong type never switches a confirmation off
});

test('profiles: applying one is detected as active', () => {
	for (const name of Object.keys(S.PROFILES)) {
		const s = S.applyProfile(S.normalize({}), name);
		assert.strictEqual(S.activeProfile(s), name, name);
	}
});

test('scope swap: first library adopts the current scope', () => {
	let s = S.normalize({ scopeMode: 'folders', scopeFolderIds: ['F1'] });
	s = apply(s, S.scopeForLibrary(s, 'libA'));
	assert.strictEqual(s.scopeLibraryKey, 'libA');
	assert.deepStrictEqual(s.scopeFolderIds, ['F1']);
	assert.strictEqual(S.scopeForLibrary(s, 'libA'), null);
});

test('scope swap: each library keeps its own folders, tags and exclusions', () => {
	let s = S.normalize({ scopeLibraryKey: 'libA', scopeMode: 'folders', scopeFolderIds: ['F1'], excludeTags: ['wip'], percent: 90 });
	s = apply(s, S.scopeForLibrary(s, 'libB'));
	assert.strictEqual(s.scopeMode, 'library');
	assert.deepStrictEqual(s.scopeFolderIds, []);
	assert.deepStrictEqual(s.excludeTags, []);
	assert.strictEqual(s.percent, 90, 'global settings are untouched');
	s = apply(s, { scopeMode: 'tags', scopeTags: ['cats'] });
	s = apply(s, S.scopeForLibrary(s, 'libA'));
	assert.strictEqual(s.scopeMode, 'folders');
	assert.deepStrictEqual(s.scopeFolderIds, ['F1']);
	assert.deepStrictEqual(s.excludeTags, ['wip']);
	assert.ok(!s.libraryScopes.libA, 'the active library is not also parked');
	s = apply(s, S.scopeForLibrary(s, 'libB'));
	assert.strictEqual(s.scopeMode, 'tags');
	assert.deepStrictEqual(s.scopeTags, ['cats']);
});
