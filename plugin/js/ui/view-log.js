'use strict';
// Log page: everything the plugin and the engine reported (also mirrored to Eagle's own log).

const fs = require('fs');
const { h, icon, clear } = require('./dom');

function create(app) {
	const el = h('div.page');
	let level = 'all';
	let text = '';
	let list = null;
	let off = null;

	function line(l) {
		return h(`div.log-line.${l.level}`, h('span.t', new Date(l.t).toLocaleTimeString()), h('span.m', l.message));
	}
	function visible(l) {
		if (level === 'warn' && l.level !== 'warn' && l.level !== 'error') return false;
		if (level === 'error' && l.level !== 'error') return false;
		if (level !== 'debug' && l.level === 'debug' && level !== 'all') return false;
		return !text || l.message.toLowerCase().includes(text.toLowerCase());
	}
	function render() {
		clear(el);
		const seg = h('div.seg', [['all', 'All'], ['warn', 'Warnings'], ['error', 'Errors']].map(([k, l]) => h(`button${level === k ? '.on' : ''}`, { onclick: () => { level = k; render(); } }, l)));
		const search = h('input.input', { placeholder: 'Filter', value: text, style: { width: '220px' } });
		search.addEventListener('input', () => { text = search.value; fill(); });
		el.appendChild(h('div.page-head', h('h1', 'Log'), h('span.spacer'), seg, search,
			h('button.btn', { onclick: copy }, icon('copy', 14), 'Copy'),
			h('button.btn', { onclick: save }, icon('download', 14), 'Save…'),
			h('button.btn.ghost', { onclick: () => { app.logs.length = 0; fill(); } }, 'Clear')));
		list = h('div.log-view.card', { style: { padding: '8px 12px' } });
		el.appendChild(list);
		fill();
	}
	function fill() {
		clear(list);
		const items = app.logs.filter(visible).slice(-3000);
		if (!items.length) list.appendChild(h('div.faint', 'Nothing logged yet.'));
		for (const l of items) list.appendChild(line(l));
		el.scrollTop = el.scrollHeight;
	}
	function asText() { return app.logs.filter(visible).map((l) => `${new Date(l.t).toISOString()} [${l.level}] ${l.message}`).join('\r\n'); }
	function copy() { eagle.clipboard.writeText(asText()); app.kit.toast('Log copied.'); }
	async function save() {
		const r = await eagle.dialog.showSaveDialog({ title: 'Save log', defaultPath: 'VDF log.txt', filters: [{ name: 'Text', extensions: ['txt'] }] });
		if (r && !r.canceled && r.filePath) fs.writeFileSync(r.filePath, asText(), 'utf8');
	}

	return {
		el,
		show() {
			render();
			off = app.on('log', (l) => { if (!list || !visible(l)) return; const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30; list.appendChild(line(l)); if (atBottom) el.scrollTop = el.scrollHeight; });
		},
		hide() { if (off) off(); off = null; },
	};
}

module.exports = { create };
