'use strict';
// Item ids name cache files: they must never be able to point outside the cache folder,
// whatever an imported JSON file contains (Eagle review, 1.0.2).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { core } = require('../lib/helpers');
const ids = core('core/ids.js');
const { Cache, newEntry, encodeEntry } = core('engine/cache.js');

const TRAVERSAL = ['../evil', '..\\evil', '../../evil', '..\\..\\evil', 'dense/../../evil', 'a/b', 'a\\b', 'C:\\Temp\\evil',
	'C:evil', '/tmp/evil', '\\\\server\\share\\evil', '..', '.', '', 'evil\0', 'KBHG6KA0Y5S9W/..', ' KBHG6KA0Y5S9W', 'x'.repeat(65)];

test('isItemId: real Eagle ids pass, anything path-like fails', () => {
	for (const ok of ['KBHG6KA0Y5S9W', 'LK6L91LNA1W4O', 'FIXA00000003', 'a1']) assert.ok(ids.isItemId(ok), ok);
	for (const bad of [...TRAVERSAL, null, undefined, 42, {}, ['KBHG6KA0Y5S9W']]) assert.ok(!ids.isItemId(bad), JSON.stringify(bad));
});

test('fileFor: only direct children of the folder, never for a bad id or suffix', () => {
	const dir = path.join(os.tmpdir(), 'vdf-ids-test', 'cache', 'dense');
	assert.strictEqual(ids.fileFor(dir, 'KBHG6KA0Y5S9W', '.bin'), path.join(path.resolve(dir), 'KBHG6KA0Y5S9W.bin'));
	for (const bad of TRAVERSAL) assert.strictEqual(ids.fileFor(dir, bad, '.bin'), null, JSON.stringify(bad));
	for (const suffix of ['/../x.bin', '\\..\\x.bin', '..bin', ':ads', '-1/2.jpg']) assert.strictEqual(ids.fileFor(dir, 'KBHG6KA0Y5S9W', suffix), null, suffix);
	assert.ok(ids.fileFor(dir, 'KBHG6KA0Y5S9W', '-12.5-160.jpg'));
});

test('cache: imported records with path-like ids are rejected and cannot touch files outside the cache', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vdf-ids-'));
	const dir = path.join(root, 'libraries', 'lib-1234');
	fs.mkdirSync(path.join(dir, 'dense'), { recursive: true });
	// files a crafted id would aim at: next to the cache, above it, and the drive-relative case
	const victims = [path.join(dir, 'evil.bin'), path.join(root, 'libraries', 'evil.bin'), path.join(root, 'evil.bin')];
	for (const v of victims) fs.writeFileSync(v, 'keep me');
	const good = 'KBHG6KA0Y5S9W';
	fs.writeFileSync(path.join(dir, 'dense', `${good}.bin`), 'dense');
	const record = (id) => ({ id, name: 'x', ext: 'mp4', size: 1, mtime: 1, flags: 0, gray: [], pHash: [], emb: [] });
	const file = path.join(root, 'import.json');
	fs.writeFileSync(file, JSON.stringify({ format: 'vdf-eagle-cache', version: 2, entries: [...TRAVERSAL.map(record), record(good)] }));

	const cache = new Cache(dir);
	cache.load();
	const r = cache.importJson(file);
	assert.deepStrictEqual(r, { imported: 1, rejected: TRAVERSAL.length });
	assert.deepStrictEqual([...cache.entries.keys()], [good]);

	// even when handed a bad id directly, delete / clearDerived / readDense / writeDense stay inside
	for (const bad of TRAVERSAL) {
		cache.delete(bad);
		cache.clearDerived({ ...newEntry('x'), id: bad });
		assert.strictEqual(cache.readDense(bad, 1, 1), null);
		assert.throws(() => cache.writeDense(bad, 1, 1, { failed: true }));
		assert.throws(() => cache.getOrCreate(bad));
	}
	for (const v of victims) assert.strictEqual(fs.readFileSync(v, 'utf8'), 'keep me', `${v} must survive`);

	// the valid entry still works normally
	cache.delete(good);
	assert.ok(!fs.existsSync(path.join(dir, 'dense', `${good}.bin`)));
	fs.rmSync(root, { recursive: true, force: true });
});

test('cache: malformed imported data is skipped, not half-imported', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vdf-ids-'));
	const cache = new Cache(path.join(root, 'c'));
	cache.load();
	const gray = Buffer.alloc(1024, 7).toString('base64');
	const ok = { id: 'AAAA1', gray: [[1.5, gray]], pHash: [[1.5, [1, 2]]], emb: [], audio: Buffer.alloc(8).toString('base64') };
	const bad = [
		{ ...ok, id: 'B1', gray: [[1, Buffer.alloc(10).toString('base64')]] }, // wrong frame size
		{ ...ok, id: 'B2', gray: 'nope' },
		{ ...ok, id: 'B3', pHash: [[1, [1]]] },
		{ ...ok, id: 'B4', emb: [[1, Buffer.alloc(3).toString('base64')]] },
		{ ...ok, id: 'B5', audio: Buffer.alloc(5).toString('base64') },
		{ ...ok, id: 'B6', gray: [[-1, gray]] },
		{ ...ok, id: 'B7', gray: [[1, '***']] },
	];
	const file = path.join(root, 'i.json');
	fs.writeFileSync(file, JSON.stringify({ format: 'vdf-eagle-cache', entries: [ok, ...bad, null, 'x'] }));
	assert.deepStrictEqual(cache.importJson(file), { imported: 1, rejected: bad.length + 2 });
	const e = cache.get('AAAA1');
	assert.strictEqual(e.gray.get(1.5).length, 1024);
	assert.deepStrictEqual(e.ph.get(1.5), [1, 2]);
	assert.strictEqual(e.audio.length, 2);
	fs.rmSync(root, { recursive: true, force: true });
});

test('cache: a shard holding a bad id (e.g. written by an older import) is cleaned on load', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vdf-ids-'));
	const dir = path.join(root, 'c');
	const db = path.join(dir, 'db');
	fs.mkdirSync(db, { recursive: true });
	const head = Buffer.alloc(12);
	head.writeUInt32LE(0x43464456, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(2, 8);
	fs.writeFileSync(path.join(db, '00.bin'), Buffer.concat([head, encodeEntry(newEntry('../evil')), encodeEntry(newEntry('GOOD1'))]));
	const warnings = [];
	const cache = new Cache(dir, (lvl, msg) => warnings.push(msg));
	cache.load();
	assert.deepStrictEqual([...cache.entries.keys()], ['GOOD1']);
	assert.ok(warnings.some((w) => /invalid item id/.test(w)));
	assert.ok(cache.dirty.size > 0, 'the shard is rewritten without the bad entry');
	fs.rmSync(root, { recursive: true, force: true });
});
