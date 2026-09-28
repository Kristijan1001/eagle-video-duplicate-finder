'use strict';
// End-to-end: runs the real engine process (Eagle runtime + Eagle's FFmpeg) over the
// synthetic fixture library and checks the expected groups. Skips when fixtures or FFmpeg
// are missing (run tools/make-fixtures.js first).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { fork } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const library = path.join(root, 'test', 'fixtures', 'library');
const itemsFile = path.join(root, 'test', 'fixtures', 'items.json');
const ffDir = path.join(process.env.APPDATA || '', 'Eagle', 'Plugins', 'ffmpeg-win-x64');
const ready = fs.existsSync(itemsFile) && fs.existsSync(path.join(ffDir, 'ffmpeg.exe'));

function engine() {
	const child = fork(path.join(root, 'plugin', 'js', 'engine', 'main.js'), [], {
		execPath: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
	});
	let id = 1;
	const pending = new Map();
	child.on('message', (m) => { if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.ok ? p.resolve(m.result) : p.reject(new Error(m.error)); } });
	return {
		call: (cmd, args) => new Promise((resolve, reject) => { const n = id++; pending.set(n, { resolve, reject }); child.send({ id: n, cmd, args }); }),
		kill: () => child.kill(),
	};
}

function groupsByName(res) {
	const g = new Map();
	for (const it of res.items) { if (!g.has(it.groupId)) g.set(it.groupId, []); g.get(it.groupId).push(it.name); }
	return [...g.values()].map((x) => x.sort().join(',')).sort();
}

test('fixture library: expected groups (classic + audio partial)', { skip: !ready }, async () => {
	const items = JSON.parse(fs.readFileSync(itemsFile, 'utf8'));
	const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdf-e2e-'));
	const e = engine();
	try {
		await e.call('init', { cacheDir, aiDir: path.join(cacheDir, 'ai'), tempDir: os.tmpdir(), ffmpeg: path.join(ffDir, 'ffmpeg.exe'), ffprobe: path.join(ffDir, 'ffprobe.exe') });
		const res = await e.call('scan', { settings: { enablePartialClipDetection: true }, libraryPath: library, items, allIds: items.map((i) => i.id) });
		const groups = groupsByName(res);
		assert.deepStrictEqual(groups, ['A,A_box,A_crf,A_flip,A_small', 'L,L_clip', 'img,img_flip,img_small']);
		const clip = res.items.find((i) => i.name === 'L_clip');
		assert.ok(Math.abs(clip.partialOffset - 20) <= 1);
		assert.ok(res.items.find((i) => i.name === 'A_flip').flags & 1);
		// second run is served from the cache and gives the same answer
		const again = await e.call('scan', { settings: { enablePartialClipDetection: true }, libraryPath: library, items, allIds: items.map((i) => i.id) });
		assert.deepStrictEqual(groupsByName(again), groups);
		// scope: only A and B in scope, rest as context → only A's group survives
		const scoped = items.map((i) => ({ ...i, inScope: i.name === 'A_small' }));
		const r3 = await e.call('scan', { settings: {}, libraryPath: library, items: scoped, allIds: items.map((i) => i.id) });
		assert.deepStrictEqual(groupsByName(r3), ['A,A_box,A_crf,A_flip,A_small']);
	}
	finally {
		e.kill();
		fs.rmSync(cacheDir, { recursive: true, force: true });
	}
});

// Deep clean with AI: needs the DINOv2 model (VDF_AI_MODEL_DIR, default %TEMP%\vdf-eagle-ai).
const aiDir = process.env.VDF_AI_MODEL_DIR || path.join(os.tmpdir(), 'vdf-eagle-ai');
const aiReady = ready && fs.existsSync(path.join(aiDir, 'dinov2-small-int8.onnx'));

test('fixture library: deep clean (AI match + audio and AI partial clips)', { skip: !aiReady }, async () => {
	const items = JSON.parse(fs.readFileSync(itemsFile, 'utf8'));
	const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdf-e2e-'));
	const e = engine();
	try {
		await e.call('init', { cacheDir, aiDir, tempDir: os.tmpdir(), ffmpeg: path.join(ffDir, 'ffmpeg.exe'), ffprobe: path.join(ffDir, 'ffprobe.exe') });
		const res = await e.call('scan', {
			settings: { enablePartialClipDetection: true, useAiMatching: true, aiPercent: 92, enableAiPartialDetection: true },
			libraryPath: library, items, allIds: items.map((i) => i.id),
		});
		assert.deepStrictEqual(groupsByName(res), ['A,A_box,A_crf,A_flip,A_small,A_zoom', 'L,L_clip,L_silent_part', 'img,img_flip,img_small']);
		const zoom = res.items.find((i) => i.name === 'A_zoom');
		assert.ok(zoom.flags & 4, 'A_zoom is an AI match');
		const silent = res.items.find((i) => i.name === 'L_silent_part');
		assert.ok((silent.flags & 2) && (silent.flags & 4), 'silent clip found by the AI partial pass');
		assert.ok(silent.partialOffset >= 0 && silent.partialOffset <= 15);

		// VDF semantics: the AI pass has its own threshold (AiPercent). At a 100% similarity
		// threshold only pixel-identical copies pass the classic check, yet AI matches still
		// appear down to aiPercent; raising aiPercent above them removes them again.
		const strict = await e.call('scan', { settings: { percent: 100, useAiMatching: true, aiPercent: 92 }, libraryPath: library, items, allIds: items.map((i) => i.id) });
		const aiHits = strict.items.filter((i) => i.flags & 4);
		assert.ok(aiHits.length > 0, 'AI matches are reported although the similarity threshold is 100%');
		// anything below 100% is in a group held together by an AI pair (the AI flag sits on one
		// side of each pair, as in VDF, so the partner shows the pair's similarity unflagged)
		const byGroup = new Map();
		for (const i of strict.items) { if (!byGroup.has(i.groupId)) byGroup.set(i.groupId, []); byGroup.get(i.groupId).push(i); }
		for (const g of byGroup.values()) if (g.some((i) => i.similarity < 99.99)) assert.ok(g.some((i) => i.flags & 4), 'sub-100% group without an AI match');
		const classic = await e.call('scan', { settings: { percent: 100, useAiMatching: false }, libraryPath: library, items, allIds: items.map((i) => i.id) });
		assert.ok(classic.items.every((i) => i.similarity >= 99.99), 'without AI, 100% means identical only');
		const noAi = await e.call('scan', { settings: { percent: 100, useAiMatching: true, aiPercent: 99.5 }, libraryPath: library, items, allIds: items.map((i) => i.id) });
		assert.ok(noAi.items.filter((i) => i.flags & 4).length < aiHits.length, 'a higher AI threshold drops them');
	}
	finally {
		e.kill();
		fs.rmSync(cacheDir, { recursive: true, force: true });
	}
});
