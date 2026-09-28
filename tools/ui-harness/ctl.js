'use strict';
// Tiny client for the harness control endpoint.
//   node ctl.js eval "<js>"        run JS in the page (statements; use `return` for a value)
//   node ctl.js evalfile file.js
//   node ctl.js shot out.png
//   node ctl.js console
//   node ctl.js reload | quit | size W H

const http = require('http');
const fs = require('fs');
const port = Number(process.env.HARNESS_PORT) || 47611;

function req(method, pathname, body) {
	return new Promise((resolve, reject) => {
		const r = http.request({ host: '127.0.0.1', port, method, path: pathname }, (res) => {
			let data = '';
			res.on('data', (d) => { data += d; });
			res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
		});
		r.on('error', reject);
		if (body) r.write(body);
		r.end();
	});
}

(async () => {
	const [cmd, a, b] = process.argv.slice(2);
	let out;
	if (cmd === 'eval') out = await req('POST', '/eval', a);
	else if (cmd === 'evalfile') out = await req('POST', '/eval', fs.readFileSync(a, 'utf8'));
	else if (cmd === 'shot') out = await req('GET', `/shot?file=${encodeURIComponent(a)}`);
	else if (cmd === 'console') out = await req('GET', '/console');
	else if (cmd === 'reload') out = await req('GET', '/reload');
	else if (cmd === 'quit') out = await req('GET', '/quit');
	else if (cmd === 'size') out = await req('GET', `/size?w=${a}&h=${b}`);
	console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
})().catch((e) => { console.error(String(e)); process.exit(1); });
