'use strict';
// Runs the unit tests on Eagle's own runtime (Eagle.exe as Node 16), so tests exercise
// exactly the engine the plugin ships with. Falls back to the current Node when Eagle is
// not installed in the standard location (set EAGLE_EXE to point elsewhere).
//
//   node tools/run-tests.js            all unit tests
//   node tools/run-tests.js gray phash only files whose name contains one of the words

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const testDir = path.join(root, 'test', 'unit');

function eagleExe() {
	const candidates = [
		process.env.EAGLE_EXE,
		process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Eagle', 'Eagle.exe') : null,
		process.platform === 'darwin' ? '/Applications/Eagle.app/Contents/MacOS/Eagle' : null,
	].filter(Boolean);
	return candidates.find((p) => fs.existsSync(p)) || null;
}

const filters = process.argv.slice(2);
const files = fs.readdirSync(testDir)
	.filter((f) => f.endsWith('.test.js'))
	.filter((f) => !filters.length || filters.some((w) => f.includes(w)))
	.sort();

const exe = eagleExe();
const runtime = exe || process.execPath;
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_NO_WARNINGS: '1' };
console.log(`runtime: ${exe ? 'Eagle (Electron-as-Node)' : 'system node'} ${runtime}`);

let failed = 0;
for (const file of files) {
	const r = spawnSync(runtime, [path.join(testDir, file)], { env, encoding: 'utf8', cwd: root, maxBuffer: 64 << 20 });
	const out = (r.stdout || '') + (r.stderr || '');
	const ok = r.status === 0;
	const pass = (out.match(/^# pass (\d+)/m) || [])[1];
	const fail = (out.match(/^# fail (\d+)/m) || [])[1];
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${file}  (${pass || '?'} passed, ${fail || '?'} failed)`);
	if (!ok) {
		failed++;
		console.log(out.split('\n').filter((l) => /not ok|Error|expected|actual|at .*test|operator|message/i.test(l)).slice(0, 60).join('\n'));
	}
}
console.log(failed ? `\n${failed} file(s) failed` : '\nall test files passed');
process.exit(failed ? 1 : 0);
