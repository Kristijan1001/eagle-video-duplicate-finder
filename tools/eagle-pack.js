'use strict';
// Packs plugin/ exactly like Eagle's "Pack Plugin" menu item, without clicking through Eagle:
// the same code (Eagle 4 app.asar pluginModule.packPlugin: archiver zip, level 9, glob "**/*",
// ignoring .git) with Eagle's own bundled archiver, run on Eagle's runtime.
//
//   node tools/eagle-pack.js [out.eagleplugin]
//
// Default output: dist/<name> <version> (Eagle pack).eagleplugin. EAGLE_EXE overrides where
// Eagle is installed (as in run-tests.js).

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const pluginDir = path.join(root, 'plugin');

function eagleExe() {
	const candidates = [
		process.env.EAGLE_EXE,
		process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Eagle', 'Eagle.exe') : null,
		process.platform === 'darwin' ? '/Applications/Eagle.app/Contents/MacOS/Eagle' : null,
	].filter(Boolean);
	return candidates.find((p) => fs.existsSync(p)) || null;
}

function eagleResources(exe) {
	return process.platform === 'darwin' ? path.join(path.dirname(exe), '..', 'Resources', 'app.asar') : path.join(path.dirname(exe), 'resources', 'app.asar');
}

const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));
const out = path.resolve(process.argv[2] || path.join(root, 'dist', `${manifest.name} ${manifest.version} (Eagle pack).eagleplugin`));

if (!process.env.VDF_EAGLE_PACK_CHILD) {
	// re-run inside Eagle's runtime, where its app.asar (and the archiver inside it) is readable
	const exe = eagleExe();
	if (!exe) { console.error('Eagle is not installed in the standard location; set EAGLE_EXE.'); process.exit(1); }
	fs.mkdirSync(path.dirname(out), { recursive: true });
	const r = spawnSync(exe, [__filename, out], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VDF_EAGLE_PACK_CHILD: exe } });
	process.exit(r.status == null ? 1 : r.status);
}

const asar = eagleResources(process.env.VDF_EAGLE_PACK_CHILD);
const archiver = require(path.join(asar, 'node_modules', 'archiver'));
new Promise((resolve, reject) => {
	const archive = archiver('zip', { zlib: { level: 9, chunkSize: 16 * 1024 * 4 } });
	const output = fs.createWriteStream(out);
	archive.pipe(output);
	archive.glob('**/*', { cwd: pluginDir, ignore: ['.git/**'] });
	archive.on('error', (err) => { archive.abort(); reject(err); });
	output.on('close', resolve);
	archive.finalize();
}).then(() => console.log(`${path.relative(root, out)}  ${(fs.statSync(out).size / 1048576).toFixed(1)} MB (Eagle's packer, archiver ${require(path.join(asar, 'node_modules', 'archiver', 'package.json')).version})`))
	.catch((err) => { console.error(err.stack || err); process.exit(1); });
