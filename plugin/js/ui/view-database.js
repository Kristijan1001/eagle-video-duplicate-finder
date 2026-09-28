'use strict';
// Database page — VDF's database viewer/cleanup tools for this library's fingerprint cache,
// plus the excluded-items and "not a match" lists.

const { h, icon, clear, bytes, duration, number, debounce } = require('./dom');

const FLAG_NAMES = [[4, 'sampling failed'], [8, 'metadata error'], [16, 'too dark'], [2, 'excluded'], [32, 'no audio'], [64, 'audio error'], [128, 'silent'], [1 << 16, 'deleted before'], [1 << 17, 'file missing']];

function create(app) {
	const kit = app.kit;
	const el = h('div.page');
	let stats = null;
	let rows = null;
	let filter = '';
	let offset = 0;
	const LIMIT = 200;
	let excluded = null;
	let notAMatch = null;
	// One persistent input: re-rendering the page must not steal focus while typing.
	const search = h('input.input', { type: 'search', placeholder: 'Filter by name or id', style: { width: '260px' } });
	search.addEventListener('input', debounce(() => { filter = search.value; offset = 0; refresh(); }, 300));

	async function refresh() {
		try {
			stats = await app.engine.call('db.stats');
			const r = await app.engine.call('db.list', { offset, limit: LIMIT, filter });
			rows = r;
			excluded = await app.engine.call('db.excludedList');
			notAMatch = await app.engine.call('lists.notAMatch.get');
		}
		catch (err) { stats = { error: err.message }; }
		render();
		app.refreshCacheStats();
	}

	function render() {
		const typing = document.activeElement === search;
		const caret = typing ? search.selectionStart : 0;
		clear(el);
		el.appendChild(h('div.page-head', h('h1', 'Fingerprint database'), h('span.sub', app.eagleData.libraryName), h('span.spacer'),
			h('button.btn', { onclick: refresh }, icon('refresh', 14), 'Refresh')));
		if (!stats) { el.appendChild(h('div.muted', 'Loading…')); return; }
		if (stats.error) { el.appendChild(h('div.callout.bad', icon('error', 18), h('div', stats.error))); return; }
		const kv = h('div.kv',
			h('div.k', 'Files known'), h('div', `${number(stats.entries)} (${number(stats.videos)} videos, ${number(stats.images)} images)`),
			h('div.k', 'Files fingerprinted'), h('div', number(stats.fingerprinted)),
			h('div.k', 'Frames cached'), h('div', number(stats.frames)),
			h('div.k', 'Audio fingerprints'), h('div', number(stats.audio)),
			h('div.k', 'AI embeddings'), h('div', number(stats.emb)),
			h('div.k', 'Failed / too dark'), h('div', number(stats.errors)),
			h('div.k', 'Deleted content remembered'), h('div', number(stats.tombstones)),
			h('div.k', 'Excluded by you'), h('div', number(stats.excluded)),
			h('div.k', 'Size on disk'), h('div', bytes(stats.bytes)),
			h('div.k', 'Location'), h('div.row', h('span.mono.small.selectable', stats.dir), h('button.btn.small', { onclick: () => eagle.shell.openPath(stats.dir) }, icon('folderOpen', 13), 'Open')));
		el.appendChild(h('div.card', h('div.card-head', h('h2', 'Overview')), h('div.card-body', kv)));

		const tools = h('div.row.wrap', { style: { gap: '8px' } },
			h('button.btn', { onclick: cleanup }, icon('broom', 14), 'Clean up'),
			h('button.btn', { onclick: retryFailed }, icon('refresh', 14), 'Retry failed files'),
			h('button.btn', { onclick: exportDb }, icon('upload', 14), 'Export as JSON'),
			h('button.btn', { onclick: importDb }, icon('download', 14), 'Import JSON'),
			h('button.btn.danger', { onclick: clearDb }, icon('trash', 14), 'Clear database'));
		el.appendChild(h('div.card', { style: { marginTop: '14px' } }, h('div.card-head', h('h2', 'Maintenance'), h('span.hint', 'nothing here touches your Eagle library')),
			h('div.card-body', h('div.muted.small', { style: { marginBottom: '10px' } }, 'Clean up removes fingerprints of items that are no longer in the library (remembered deleted content is kept when that option is on). Clearing forces every file to be analysed again.'), tools)));

		// excluded items
		const exBody = h('div.card-body');
		if (!excluded || !excluded.length) exBody.appendChild(h('div.muted', 'No items are excluded. Use "Remove and exclude from future scans" in Results to add some.'));
		else {
			const t = h('table.table', h('tr', h('th', 'Name'), h('th', 'Id'), h('th', '')));
			for (const x of excluded) t.appendChild(h('tr', h('td', `${x.name}.${x.ext}`), h('td.mono.small.faint', x.id),
				h('td', h('button.btn.small', { onclick: async () => { await app.engine.call('db.exclude', { ids: [x.id], value: false }); refresh(); } }, 'Include again'))));
			exBody.appendChild(t);
		}
		el.appendChild(h('div.card', { style: { marginTop: '14px' } }, h('div.card-head', h('h2', `Excluded items (${excluded ? excluded.length : 0})`)), exBody));

		// not a match
		const nmBody = h('div.card-body');
		if (!notAMatch || !notAMatch.length) nmBody.appendChild(h('div.muted', 'No groups are marked as "not a match".'));
		else {
			const items = app.eagleData.itemCache;
			const t = h('table.table', h('tr', h('th', 'Items'), h('th', '')));
			notAMatch.forEach((ids, i) => t.appendChild(h('tr',
				h('td', ids.map((id) => { const it = items && items.get(id); return it ? `${it.name}.${it.ext}` : id; }).join(' · ')),
				h('td', h('button.btn.small', { onclick: async () => { await app.engine.call('lists.notAMatch.remove', { index: i }); refresh(); } }, 'Forget')))));
			nmBody.append(t, h('button.btn.small', { style: { marginTop: '8px' }, onclick: async () => { const all = await app.eagleData.allItems(true); const n = await app.engine.call('lists.notAMatch.prune', { allIds: [...all.keys()] }); kit.toast(`${n} stale entr${n === 1 ? 'y' : 'ies'} removed.`); refresh(); } }, 'Remove entries for deleted items'));
		}
		el.appendChild(h('div.card', { style: { marginTop: '14px' } }, h('div.card-head', h('h2', `"Not a match" groups (${notAMatch ? notAMatch.length : 0})`)), nmBody));

		// entries
		const t = h('table.table', h('tr', h('th', 'Name'), h('th', 'Type'), h('th', 'Size'), h('th', 'Duration'), h('th', 'Frames'), h('th', 'Audio'), h('th', 'AI'), h('th', 'State'), h('th', '')));
		for (const r of (rows && rows.rows) || []) {
			const states = FLAG_NAMES.filter(([f]) => r.flags & f).map(([, n]) => n);
			t.appendChild(h('tr',
				h('td', { title: r.id }, `${r.name}.${r.ext}`), h('td', r.isImage ? 'image' : 'video'), h('td', bytes(r.size)), h('td', r.isImage ? '—' : duration(r.duration)),
				h('td', r.frames), h('td', r.audio == null ? '—' : r.audio ? `${r.audio} s` : 'none'), h('td', r.emb || '—'),
				h('td', states.length ? states.map((x) => h('span.badge', { style: { marginRight: '4px' } }, x)) : h('span.faint', 'ok')),
				h('td', h('button.icon-btn.small', { title: 'Actions', onclick: (e) => entryMenu(e.currentTarget, r) }, icon('more', 14)))));
		}
		const total = rows ? rows.total : 0;
		const pager = h('div.row', { style: { marginTop: '8px' } },
			h('span.faint.small', `${total ? offset + 1 : 0}–${Math.min(total, offset + LIMIT)} of ${number(total)}`),
			h('button.btn.small', { disabled: offset === 0, onclick: () => { offset = Math.max(0, offset - LIMIT); refresh(); } }, icon('chevronLeft', 13)),
			h('button.btn.small', { disabled: offset + LIMIT >= total, onclick: () => { offset += LIMIT; refresh(); } }, icon('chevronRight', 13)));
		el.appendChild(h('div.card', { style: { marginTop: '14px' } }, h('div.card-head', h('h2', 'Entries'), h('span.spacer'), search), h('div.card-body', t, pager)));
		if (typing) { search.focus(); search.setSelectionRange(caret, caret); }
	}

	function entryMenu(anchor, r) {
		kit.menu(anchor, [
			{ label: 'Clear cached data (re-analyse next scan)', icon: 'refresh', onClick: async () => { await app.engine.call('db.clearEntry', { ids: [r.id] }); refresh(); } },
			{ label: r.flags & 2 ? 'Include in scans again' : 'Exclude from scans', icon: 'ban', onClick: async () => { await app.engine.call('db.exclude', { ids: [r.id], value: !(r.flags & 2) }); refresh(); } },
			{ label: 'Show in Eagle', icon: 'target', onClick: () => app.eagleData.select([r.id]) },
			'-',
			{ label: 'Delete entry', icon: 'trash', danger: true, onClick: async () => { await app.engine.call('db.deleteEntry', { ids: [r.id] }); refresh(); } },
		]);
	}

	async function cleanup() {
		const all = await app.eagleData.allItems(true);
		const n = await app.engine.call('db.cleanup', { allIds: [...all.keys()], keepTombstones: app.settings.rememberDeletedContent });
		kit.toast(`${number(n)} stale entr${n === 1 ? 'y' : 'ies'} removed.`, { kind: 'good' });
		refresh();
	}

	async function retryFailed() {
		const r = await app.engine.call('db.list', { offset: 0, limit: 1e9, filter: '' });
		const ids = r.rows.filter((x) => x.flags & (4 | 8 | 16 | 64)).map((x) => x.id);
		if (!ids.length) { kit.toast('No failed files.'); return; }
		await app.engine.call('db.clearEntry', { ids });
		kit.toast(`${ids.length} file(s) will be analysed again on the next scan.`, { kind: 'good' });
		refresh();
	}

	async function exportDb() {
		const r = await eagle.dialog.showSaveDialog({ title: 'Export fingerprint database', defaultPath: `VDF cache ${app.eagleData.libraryName}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
		if (!r || r.canceled || !r.filePath) return;
		const b = kit.busy('Exporting');
		try { const n = await app.engine.call('db.export', { file: r.filePath }); kit.toast(`${number(n)} entries exported.`, { kind: 'good' }); }
		catch (err) { kit.alertDialog('Export failed', err.message, 'error'); }
		finally { b.close(); }
	}

	async function importDb() {
		const r = await eagle.dialog.showOpenDialog({ title: 'Import fingerprint database', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
		if (!r || r.canceled || !r.filePaths.length) return;
		const b = kit.busy('Importing');
		try { const n = await app.engine.call('db.import', { file: r.filePaths[0] }); kit.toast(`${number(n)} entries imported.`, { kind: 'good' }); refresh(); }
		catch (err) { kit.alertDialog('Import failed', err.message, 'error'); }
		finally { b.close(); }
	}

	async function clearDb() {
		if (app.scan.running) { kit.toast('Stop the running scan first.'); return; }
		if (!await kit.confirmDialog({ title: 'Clear the fingerprint database?', message: 'Every file of this library will be analysed again on the next scan. Your Eagle library is not affected.', okLabel: 'Clear', danger: true })) return;
		await app.engine.call('db.clear');
		kit.toast('Database cleared.', { kind: 'good' });
		refresh();
	}

	return { el, show() { stats = null; render(); refresh(); }, hide() {} };
}

module.exports = { create };
