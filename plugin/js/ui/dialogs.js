'use strict';
// Dialogs used by the Results page.

const { h, icon, clear, bytes, duration, dateTime, number } = require('./dom');
const sel = require('../core/selection');
const expr = require('../core/expression');
const { openComparer } = require('./comparer');

function bind(app) {
	const kit = app.kit;
	const s = () => app.settings;

	// ── Compare window (see comparer.js) ──
	function comparer(members, focusId, nav) {
		return openComparer(app, { members, focusId, nav });
	}

	// ── Metadata compare ──
	async function metadataCompare(members, eagleInfo, filePath) {
		const list = members.filter((m) => !m.gone);
		const m = kit.modal({ title: 'Compare metadata', width: 'wide', icon: 'info', body: h('div.muted', 'Reading metadata…') });
		const cols = [];
		for (const x of list) {
			let meta = null;
			try { meta = await app.engine.call('metadata', { file: filePath(x), isImage: x.isImage }); } catch { /* ignore */ }
			cols.push({ x, meta, e: eagleInfo.get(x.id) });
		}
		const rows = [];
		const add = (label, fn) => rows.push({ label, vals: cols.map((c) => { try { const v = fn(c); return v == null || v === '' ? '—' : String(v); } catch { return '—'; } }) });
		add('File', (c) => `${c.x.name}.${c.x.ext}`);
		add('Size', (c) => bytes(c.x.size));
		add('Resolution', (c) => c.x.frameSize);
		if (list.some((x) => !x.isImage)) {
			add('Duration', (c) => (c.x.isImage ? '' : duration(c.x.duration)));
			add('Video codec', (c) => c.x.format);
			add('Video bitrate', (c) => (c.x.isImage ? '' : `${number(c.x.bitRateKbs)} kb/s`));
			add('Frame rate', (c) => (c.x.fps ? c.x.fps.toFixed(3) : ''));
			add('HDR', (c) => c.x.hdrFormat);
			add('Audio', (c) => (c.x.audioFormat ? `${c.x.audioFormat} ${c.x.audioChannel} ${c.x.audioSampleRate} Hz ${number(c.x.audioBitRateKbs)} kb/s` : ''));
			add('Audio languages', (c) => c.x.audioLanguages);
			add('Subtitles', (c) => c.x.subtitleLanguages);
		}
		add('Imported', (c) => dateTime(c.x.dateCreated));
		add('File modified', (c) => dateTime(c.x.dateModified));
		add('Eagle folders', (c) => (c.e ? app.eagleData.folderPaths(c.e.folders).join(', ') : ''));
		add('Eagle tags', (c) => (c.e ? c.e.tags.join(', ') : ''));
		add('Rating', (c) => (c.e && c.e.star ? '★'.repeat(c.e.star) : ''));
		add('Annotation', (c) => (c.e ? c.e.annotation : ''));
		add('Source URL', (c) => (c.e ? c.e.url : ''));
		const tagKeys = new Set();
		for (const c of cols) {
			const t = c.meta && c.meta.tags;
			if (t && t.format && t.format.tags) for (const k of Object.keys(t.format.tags)) tagKeys.add(`format:${k}`);
			for (const ex of (c.meta && c.meta.exif) || []) tagKeys.add(`exif:${ex.name}`);
		}
		for (const k of [...tagKeys].sort()) {
			const [kind, name] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
			add(`${kind === 'exif' ? 'EXIF' : 'Tag'} ${name}`, (c) => {
				if (kind === 'format') return c.meta && c.meta.tags && c.meta.tags.format && c.meta.tags.format.tags ? c.meta.tags.format.tags[name] : '';
				const f = ((c.meta && c.meta.exif) || []).find((x) => x.name === name);
				return f ? f.value : '';
			});
		}
		const onlyDiff = h('input', { type: 'checkbox' });
		const table = h('table.table');
		const renderTable = () => {
			clear(table);
			table.appendChild(h('tr', h('th', ''), cols.map((c) => h('th', c.x.name))));
			for (const r of rows) {
				const differs = new Set(r.vals).size > 1;
				if (onlyDiff.checked && !differs) continue;
				table.appendChild(h(`tr${differs ? '.diff' : ''}`, h('td.faint', r.label), r.vals.map((v) => h('td.selectable', v))));
			}
		};
		onlyDiff.addEventListener('change', renderTable);
		renderTable();
		clear(m.body);
		m.body.append(h('label.check', { style: { marginBottom: '10px' } }, onlyDiff, h('span', 'Only rows that differ')), table);
	}

	// ── Pair diagnostic ──
	async function diagnose(a, b, eagleInfo, filePath) {
		const m = kit.modal({ title: 'Why do these match?', width: 'wide', icon: 'cpu', body: h('div.muted', 'Comparing…') });
		const pick = (x) => {
			const e = eagleInfo.get(x.id);
			return { id: x.id, ext: x.ext, isImage: x.isImage, file: filePath(x), folders: e ? app.eagleData.folderPaths(e.folders) : [] };
		};
		let r;
		try { r = await app.engine.call('diagnose', { a: pick(a), b: pick(b), settings: s() }); }
		catch (err) { clear(m.body).append(h('div.callout.bad', icon('error', 18), h('div', err.message))); return; }
		const pct = (d) => (d == null ? '—' : `${((1 - d) * 100).toFixed(2)}%`);
		const body = h('div.col');
		body.append(h('div.kv',
			h('div.k', 'A'), h('div', `${a.name}.${a.ext}`),
			h('div.k', 'B'), h('div', `${b.name}.${b.ext}`),
			h('div.k', 'Result'), h('div', r.result ? (r.result.match ? h('span.badge.good', `Match · ${r.result.similarity.toFixed(2)}%${r.result.flipped ? ' · mirrored' : ''}${r.result.ai ? ' · AI' : ''}`) : h('span.badge.bad', 'Not a match')) : r.verdict || '—'),
			h('div.k', 'Threshold'), h('div', `${r.threshold}%`),
			h('div.k', 'Duration gate'), h('div', r.gates.duration ? (r.gates.duration.pass ? `pass${r.gates.duration.allowed != null ? ` (Δ ${r.gates.duration.diff}s ≤ ${r.gates.duration.allowed.toFixed(1)}s)` : ''}` : `blocked (Δ ${r.gates.duration.diff}s > ${r.gates.duration.allowed.toFixed(1)}s allowed)`) : '—'),
			h('div.k', 'Folder gate'), h('div', r.gates.folder ? (r.gates.folder.pass ? `pass (${r.gates.folder.mode})` : `blocked (${r.gates.folder.mode})`) : '—'),
			h('div.k', 'Normal orientation'), h('div', r.normal ? (r.normal.match ? `match · similarity ${pct(r.normal.difference)}` : 'no match (below the threshold)') : '—'),
			h('div.k', 'Mirrored'), h('div', r.flipped ? (r.flipped.match ? `match · similarity ${pct(r.flipped.difference)}` : 'no match (below the threshold)') : 'not compared'),
			h('div.k', 'AI similarity'), h('div', r.aiSimilarity != null ? (r.aiSimilarity < 0 ? 'abstained (too few usable frames)' : `${(r.aiSimilarity * 100).toFixed(2)}% (threshold ${s().aiPercent}%)`) : 'AI matching off')));
		const t = h('table.table', h('tr', h('th', 'Frame'), h('th', 'Time A'), h('th', 'Time B'), h('th', 'Gray similarity'), h('th', 'Masked'), h('th', 'pHash distance'), h('th', 'Notes')));
		(r.frames || []).forEach((f, i) => t.appendChild(h('tr',
			h('td', `#${i + 1}`), h('td', duration(r.positionsA[i] || 0)), h('td', duration(r.positionsB[i] || 0)),
			h('td', f.missing ? '—' : pct(f.grayDiff)), h('td', f.grayDiffMasked == null ? '—' : pct(f.grayDiffMasked)),
			h('td', f.missing ? '—' : `${f.pHashDistance} / 64`),
			h('td', f.missing ? 'frame missing' : [f.darkA && 'A dark', f.darkB && 'B dark'].filter(Boolean).join(', ')))));
		body.append(h('div.hr'), t);
		clear(m.body).append(body);
	}

	// ── Quality order (Check lowest quality) ──
	async function qualityOrder() {
		let order = [...s().qualityCriteriaOrder];
		for (const k of Object.keys(sel.CRITERIA)) if (!order.includes(k)) order.push(k);
		const disabled = new Set(s().qualityCriteriaDisabled);
		const listEl = h('div.order-list');
		const render = () => {
			clear(listEl);
			order.forEach((k, i) => {
				const cb = h('input', { type: 'checkbox' });
				cb.checked = !disabled.has(k);
				cb.addEventListener('change', () => { if (cb.checked) disabled.delete(k); else disabled.add(k); render(); });
				listEl.appendChild(h(`div.order-item${disabled.has(k) ? '.off' : ''}`, cb, h('span.nm', `${i + 1}. ${sel.CRITERIA_LABELS[k] || k}`),
					h('button.icon-btn.small', { disabled: i === 0, title: 'Up', onclick: () => { [order[i - 1], order[i]] = [order[i], order[i - 1]]; render(); } }, icon('chevronDown', 14, 'up')),
					h('button.icon-btn.small', { disabled: i === order.length - 1, title: 'Down', onclick: () => { [order[i + 1], order[i]] = [order[i], order[i + 1]]; render(); } }, icon('chevronDown', 14))));
			});
			for (const b of listEl.querySelectorAll('.ico.up')) b.style.transform = 'rotate(180deg)';
		};
		render();
		const ok = h('button.btn.primary', 'Apply');
		const reset = h('button.btn.ghost.left', 'Reset to default');
		const m = kit.modal({
			title: 'Which copy is the best?', icon: 'star',
			body: [h('div.muted', { style: { marginBottom: '10px' } }, 'Criteria are tried in this order. When copies tie on one (within a small tolerance), the next one decides. The best copy stays unchecked; the others get checked.'), listEl],
			foot: [reset, h('button.btn', { onclick: () => m.close(false) }, 'Cancel'), ok],
		});
		reset.onclick = () => { order = ['Duration', 'Resolution', 'Bitrate', 'FPS', 'Bits per pixel', 'Audio Bitrate', 'Size', 'SizeLarger']; disabled.clear(); disabled.add('SizeLarger'); render(); };
		ok.onclick = () => { app.setSettings({ qualityCriteriaOrder: order, qualityCriteriaDisabled: [...disabled] }); m.close(true); };
		return m.result;
	}

	// ── Custom selection ──
	async function customSelection(visibleItems, dateOf, pathsOf) {
		let data = { ...sel.DEFAULT_CUSTOM };
		const form = h('div.col');
		const render = () => {
			clear(form);
			const segRow = (label, key, opts) => h('div.set-row', h('div.l', h('div.n', label)), h('div.r', h('div.seg', opts.map(([v, l]) => h(`button${data[key] === v ? '.on' : ''}`, { onclick: () => { data[key] = v; render(); } }, l)))));
			const listEdit = (label, key) => {
				const input = h('input.input', { placeholder: 'Wildcard, e.g. *\\Downloads\\* or *720p*', style: { flex: 1 }, dataset: { list: key } });
				const add = () => { const v = input.value.trim(); if (v) { data[key] = [...data[key], v]; render(); } };
				input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
				return h('div.set-row', h('div.l', h('div.n', label), h('div.tags-edit', { style: { marginTop: '6px' } }, data[key].map((p) => h('span.tg', p, h('button', { onclick: () => { data[key] = data[key].filter((x) => x !== p); render(); } }, icon('close', 11)))))),
					h('div.r', input, h('button.btn', { onclick: add }, 'Add')));
			};
			const num = (label, key, unit) => {
				const i = h('input.input.num', { type: 'number', value: data[key] });
				i.addEventListener('change', () => { data[key] = Number(i.value) || 0; });
				return h('div.set-row', h('div.l', h('div.n', label)), h('div.r', i, h('span.muted', unit)));
			};
			const ignore = h('input', { type: 'checkbox' });
			ignore.checked = data.ignoreGroupsWithCheckedItems;
			ignore.addEventListener('change', () => { data.ignoreGroupsWithCheckedItems = ignore.checked; });
			form.append(
				h('div.set-row', h('div.l', h('div.n', 'Skip groups that already have checked items')), h('div.r', h('label.switch', ignore, h('span.track')))),
				segRow('File type', 'fileTypeSelection', [[0, 'All'], [1, 'Videos'], [2, 'Images']]),
				segRow('Identical', 'identicalSelection', [[0, 'Any'], [1, 'Identical'], [2, 'Identical but size'], [3, 'Not identical']]),
				segRow('Date', 'dateTimeSelection', [[0, 'Ignore'], [1, 'Check newest (keep oldest)'], [2, 'Check oldest (keep newest)']]),
				num('Minimum file size', 'minimumFileSize', 'MB'),
				num('Maximum file size', 'maximumFileSize', 'MB'),
				num('Similarity from', 'similarityFrom', '%'),
				num('Similarity to', 'similarityTo', '%'),
				listEdit('Path must contain (Eagle folder path or file path)', 'pathContains'),
				listEdit('Path must not contain', 'pathNotContains'));
		};
		render();
		const presets = s().customSelectionPresets || [];
		const presetSel = h('select.select', h('option', { value: '' }, 'Presets…'), presets.map((p, i) => h('option', { value: i }, p.name)));
		presetSel.addEventListener('change', () => { const p = presets[Number(presetSel.value)]; if (p) { data = { ...sel.DEFAULT_CUSTOM, ...p.data }; render(); } });
		const savePreset = h('button.btn.ghost', { onclick: async () => {
			const name = await kit.promptDialog({ title: 'Save preset', label: 'Preset name', validate: (v) => (v.trim() ? null : 'Enter a name') });
			if (!name) return;
			const next = presets.filter((p) => p.name !== name).concat([{ name, data: JSON.parse(JSON.stringify(data)) }]);
			app.setSettings({ customSelectionPresets: next });
			kit.toast('Preset saved.', { kind: 'good' });
		} }, 'Save preset');
		const ok = h('button.btn.primary', 'Select');
		const m = kit.modal({ title: 'Custom selection', width: 'wide', icon: 'filter', body: form, foot: [h('div.row.left', presetSel, savePreset), h('button.btn', { onclick: () => m.close(null) }, 'Cancel'), ok] });
		ok.onclick = () => {
			// a pattern typed but not yet added with Enter/Add still counts
			for (const i of form.querySelectorAll('input[data-list]')) { const v = i.value.trim(); if (v && !data[i.dataset.list].includes(v)) data[i.dataset.list] = [...data[i.dataset.list], v]; }
			m.close(sel.computeCustomSelection(visibleItems, data, dateOf, pathsOf));
		};
		return m.result;
	}

	// ── Expression builder ──
	async function expressionBuilder() {
		const ta = h('textarea.input', { rows: 4, style: { width: '100%' } });
		ta.value = s().lastCustomSelectExpression || '';
		const status = h('div.small', { style: { minHeight: '18px', marginTop: '6px' } });
		const check = () => {
			try { expr.compile(ta.value); status.style.color = 'var(--good)'; status.textContent = ta.value.trim() ? 'Expression is valid.' : ''; }
			catch (err) { status.style.color = 'var(--bad)'; status.textContent = err.message; }
		};
		ta.addEventListener('input', check);
		const hist = s().expressionHistory || [];
		const presets = s().expressionPresets || [];
		const histSel = h('select.select', h('option', { value: '' }, `History (${hist.length})`), hist.map((x, i) => h('option', { value: i }, x.length > 60 ? x.slice(0, 60) + '…' : x)));
		histSel.addEventListener('change', () => { if (histSel.value !== '') { ta.value = hist[Number(histSel.value)]; check(); } });
		const presetSel = h('select.select', h('option', { value: '' }, `Presets (${presets.length})`), presets.map((p, i) => h('option', { value: i }, p.name)));
		presetSel.addEventListener('change', () => { if (presetSel.value !== '') { ta.value = presets[Number(presetSel.value)].expression; check(); } });
		const help = h('div.small.faint', { style: { columns: 3, marginTop: '10px' } }, expr.HELP_PROPERTIES.map((p) => h('div.mono', `item.${p}`)));
		const examples = h('div.small', { style: { marginTop: '10px' } },
			h('div.faint', 'Examples (C#-style, like VDF):'),
			['item.IsImage && item.SizeLong > 3000', 'item.Path.Contains("Downloads")', 'item.Duration.Minutes > 15', 'Regex.IsMatch(item.Name, "S\\\\d+E\\\\d+")', 'item.Tags.Contains("keep") == false && item.FrameSizeInt < 2000']
				.map((x) => h('div.mono', { style: { cursor: 'pointer', color: 'var(--accent)' }, onclick: () => { ta.value = x; check(); } }, x)));
		const savePreset = h('button.btn.ghost', { onclick: async () => {
			const name = await kit.promptDialog({ title: 'Save preset', label: 'Preset name', validate: (v) => (v.trim() ? null : 'Enter a name') });
			if (!name) return;
			app.setSettings({ expressionPresets: presets.filter((p) => p.name !== name).concat([{ name, expression: ta.value }]) });
			kit.toast('Preset saved.', { kind: 'good' });
		} }, 'Save preset');
		const delPreset = h('button.btn.ghost', { onclick: () => {
			if (presetSel.value === '') return;
			const p = presets[Number(presetSel.value)];
			app.setSettings({ expressionPresets: presets.filter((x) => x !== p) });
			presetSel.querySelector(`option[value="${presetSel.value}"]`).remove();
			presetSel.value = '';
		} }, 'Delete preset');
		const ok = h('button.btn.primary', 'Check matching items');
		const m = kit.modal({
			title: 'Select by expression', width: 'wide', icon: 'wand',
			body: [h('div.muted', { style: { marginBottom: '8px' } }, 'Items for which the expression is true get checked. Nothing is ever executed as code — the expression is parsed and evaluated safely.'),
				h('div.row', { style: { marginBottom: '8px' } }, histSel, presetSel, savePreset, delPreset), ta, status, examples, h('details', { style: { marginTop: '10px' } }, h('summary.muted', 'Available properties'), help)],
			foot: [h('button.btn', { onclick: () => m.close(null) }, 'Cancel'), ok],
		});
		ok.onclick = () => { try { expr.compile(ta.value); m.close(ta.value); } catch (err) { status.style.color = 'var(--bad)'; status.textContent = err.message; } };
		check();
		setTimeout(() => ta.focus(), 0);
		return m.result;
	}

	// ── Folder picker (for add/move) ──
	/**
	 * Choose a destination folder. Choosing never changes anything by itself: the caller shows
	 * its confirmation next (`confirmNext`), or, with that turned off, the button says what runs.
	 * A click selects a folder; only the button commits (no double-click shortcut).
	 */
	async function pickFolder({ title, count, mode, confirmNext }) {
		await app.eagleData.loadFolders();
		const move = mode === 'move';
		let chosen = null;
		let q = '';
		const tree = h('div.tree', { style: { maxHeight: '420px' } });
		const search = h('input.input', { placeholder: 'Filter folders', style: { width: '100%', marginBottom: '8px' } });
		const ok = h('button.btn.primary', { disabled: true }, confirmNext ? 'Continue' : `${move ? 'Move' : 'Add'} ${number(count)} item(s) here`);
		const render = () => {
			clear(tree);
			const folders = app.eagleData.folders;
			const ql = q.toLowerCase();
			const matches = new Set();
			if (ql) for (const f of folders.values()) if (f.name.toLowerCase().includes(ql)) { let p = f; while (p) { matches.add(p.id); p = p.parent ? folders.get(p.parent) : null; } }
			const node = (id) => {
				const f = folders.get(id);
				if (ql && !matches.has(id)) return;
				tree.appendChild(h('div.tree-row', { style: { paddingLeft: `${6 + f.depth * 16}px`, background: chosen === id ? 'var(--accent-soft)' : '' }, onclick: () => { chosen = id; render(); } }, icon('folder', 15), h('span.name', f.name)));
				for (const c of f.children) node(c);
			};
			for (const r of app.eagleData.roots) node(r);
			ok.disabled = !chosen;
		};
		search.addEventListener('input', () => { q = search.value; render(); });
		render();
		const scope = h('div.callout.info.picker-scope', icon('info', 18), h('div',
			move ? `${number(count)} checked item(s) will be moved to the folder you choose. Moving replaces their current folders, so afterwards they are only in that folder.`
				: `${number(count)} checked item(s) will be added to the folder you choose. They stay in their current folders as well.`,
			confirmNext ? ' Nothing changes until you confirm on the next step.' : ''));
		const newBtn = h('button.btn.ghost.left', { onclick: async () => {
			const name = await kit.promptDialog({ title: 'New folder', label: chosen ? `Inside "${app.eagleData.folders.get(chosen).name}"` : 'At the top level', validate: (v) => (v.trim() ? null : 'Enter a name') });
			if (!name) return;
			const f = await app.eagleData.createFolder(name.trim(), chosen);
			chosen = f.id;
			render();
		} }, icon('plus', 14), 'New folder');
		const m = kit.modal({ title, icon: 'folder', body: [scope, search, tree], foot: [newBtn, h('button.btn', { onclick: () => m.close(null) }, 'Cancel'), ok] });
		ok.onclick = () => { if (chosen) m.close(chosen); };
		search.focus();
		return m.result;
	}

	return { comparer, metadataCompare, diagnose, qualityOrder, customSelection, expressionBuilder, pickFolder };
}

module.exports = { bind };
