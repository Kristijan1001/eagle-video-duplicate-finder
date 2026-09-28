'use strict';
// Drives the plugin's engine process exactly like the plugin window does (fork on Eagle's
// runtime + IPC), against the synthetic fixture library. Used for end-to-end checks.
//
//   node tools/engine-run.js [settingsJSON] [--fresh] [--cache <dir>]

const path = require('path');
const fs = require('fs');
const os = require('os');
const { fork } = require('child_process');

const root = path.resolve(__dirname, '..');
const enginePath = path.join(root, 'plugin', 'js', 'engine', 'main.js');
const library = path.join(root, 'test', 'fixtures', 'library');
const items = JSON.parse(fs.readFileSync(path.join(root, 'test', 'fixtures', 'items.json'), 'utf8'));
const eagleExe = process.env.EAGLE_EXE || path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Eagle', 'Eagle.exe');
const pluginsDir = path.join(process.env.APPDATA || '', 'Eagle', 'Plugins', 'ffmpeg-win-x64');

const args = process.argv.slice(2);
const settings = args[0] && args[0].startsWith('{') ? JSON.parse(args[0]) : {};
const cacheIdx = args.indexOf('--cache');
const cacheDir = cacheIdx >= 0 ? args[cacheIdx + 1] : path.join(os.tmpdir(), 'vdf-eagle-test-cache');
if (args.includes('--fresh')) fs.rmSync(cacheDir, { recursive: true, force: true });

const child = fork(enginePath, [], {
	execPath: fs.existsSync(eagleExe) ? eagleExe : process.execPath,
	env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
	stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});
let nextId = 1;
const pending = new Map();
function call(cmd, a) {
	return new Promise((resolve, reject) => {
		const id = nextId++;
		pending.set(id, { resolve, reject });
		child.send({ id, cmd, args: a });
	});
}
child.on('message', (m) => {
	if (m.event === 'log') { if (m.data.level !== 'debug') console.log(`[${m.data.level}] ${m.data.message}`); return; }
	if (m.event === 'progress') { if (m.data.done === m.data.total || m.data.done === 0) console.log(`  … ${m.data.label} ${m.data.done}/${m.data.total}`); return; }
	if (m.event) return;
	const p = pending.get(m.id);
	if (!p) return;
	pending.delete(m.id);
	if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error + '\n' + (m.stack || '')));
});

(async () => {
	const t0 = Date.now();
	const init = await call('init', {
		cacheDir, aiDir: path.join(os.tmpdir(), 'vdf-eagle-ai'), tempDir: os.tmpdir(),
		ffmpeg: path.join(pluginsDir, 'ffmpeg.exe'), ffprobe: path.join(pluginsDir, 'ffprobe.exe'),
	});
	console.log('init', init);
	const di = args.indexOf('--diagnose');
	if (di >= 0) {
		const pick = (id) => { const it = items.find((x) => x.id === id); return { id, ext: it.ext, isImage: /png|jpg/.test(it.ext), file: path.join(library, 'images', `${id}.info`, `${it.name}.${it.ext}`) }; };
		const rep = await call('diagnose', { a: pick(args[di + 1]), b: pick(args[di + 2]), settings });
		console.log(JSON.stringify(rep, null, 1));
		await call('shutdown', {}).catch(() => {});
		return;
	}
	const res = await call('scan', { settings, libraryPath: library, items, allIds: items.map((i) => i.id) });
	const byGroup = new Map();
	for (const it of res.items || []) {
		if (!byGroup.has(it.groupId)) byGroup.set(it.groupId, []);
		byGroup.get(it.groupId).push(it);
	}
	console.log(`\n=== ${byGroup.size} group(s) in ${Date.now() - t0} ms ===`);
	for (const [g, members] of byGroup) {
		console.log(`group ${g}: ` + members.map((m) => `${m.name}(${m.similarity.toFixed(1)}%${m.flags & 1 ? ',flipped' : ''}${m.flags & 2 ? `,partial@${m.partialOffset}s` : ''}${m.flags & 4 ? ',AI' : ''})`).join('  '));
	}
	fs.writeFileSync(path.join(os.tmpdir(), 'vdf-eagle-last-result.json'), JSON.stringify(res, null, 1));
	await call('shutdown', {}).catch(() => {});
})().catch((err) => { console.error(err); child.kill(); process.exit(1); });
