'use strict';
// Installs the plugin's one runtime dependency (onnxruntime-node, pinned in plugin/package.json)
// and trims plugin/node_modules down to what the release needs, so that Eagle's own
// "Pack Plugin" can pack the plugin folder as it is:
//   - only the onnxruntime binaries of the target platform (Eagle's review rejects bundles
//     for unrelated platforms),
//   - no lockfiles, source maps or TypeScript sources.
//
//   node tools/setup-runtime.js [win-x64 | win-arm64 | mac]     (default: win-x64)
//   node tools/setup-runtime.js --prune-only win-x64            (skip npm, just trim)

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const plugin = path.resolve(__dirname, '..', 'plugin');
const args = process.argv.slice(2);
const pruneOnly = args.includes('--prune-only');
const target = args.find((a) => !a.startsWith('-')) || 'win-x64';
const KEEP = { 'win-x64': ['win32/x64'], 'win-arm64': ['win32/arm64'], mac: ['darwin/arm64', 'darwin/x64'] }[target];
if (!KEEP) { console.error(`Unknown target "${target}"`); process.exit(1); }

if (!pruneOnly) {
	console.log('npm install (onnxruntime-node, exact version from plugin/package.json)…');
	execSync('npm install --omit=dev --no-audit --no-fund', { cwd: plugin, stdio: 'inherit' });
}

const rm = (p) => { if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); console.log(`removed ${path.relative(plugin, p)}`); } };
rm(path.join(plugin, 'package-lock.json'));
rm(path.join(plugin, 'node_modules', '.package-lock.json'));
for (const pkg of ['onnxruntime-node', 'onnxruntime-common']) rm(path.join(plugin, 'node_modules', pkg, 'lib')); // TypeScript sources

const bin = path.join(plugin, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3');
for (const os of fs.existsSync(bin) ? fs.readdirSync(bin) : []) {
	for (const arch of fs.readdirSync(path.join(bin, os))) {
		if (!KEEP.includes(`${os}/${arch}`)) rm(path.join(bin, os, arch));
	}
	if (!fs.readdirSync(path.join(bin, os)).length) rm(path.join(bin, os));
}

let maps = 0;
(function walk(d) {
	for (const e of fs.readdirSync(d, { withFileTypes: true })) {
		const p = path.join(d, e.name);
		if (e.isDirectory()) walk(p);
		else if (e.name.endsWith('.map')) { fs.unlinkSync(p); maps++; }
	}
})(path.join(plugin, 'node_modules'));
if (maps) console.log(`removed ${maps} source map(s)`);

for (const k of KEEP) {
	if (!fs.existsSync(path.join(bin, k, 'onnxruntime_binding.node'))) { console.error(`missing onnxruntime binaries for ${k}`); process.exit(1); }
}
console.log(`plugin/node_modules is ready for ${target}.`);
