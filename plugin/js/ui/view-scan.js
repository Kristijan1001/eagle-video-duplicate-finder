'use strict';
// Scan page: scope (library / selection / folders / smart folders / tags + exclusions),
// scan profiles, the most important options, and live progress while a scan runs.

const { h, icon, clear, span, number } = require('./dom');
const settingsMod = require('../core/settings');

const SCOPES = [
	{ key: 'library', label: 'Whole library', icon: 'library' },
	{ key: 'selection', label: 'Selected items', icon: 'selection' },
	{ key: 'folders', label: 'Folders', icon: 'folder' },
	{ key: 'smartFolders', label: 'Smart folders', icon: 'smartFolder' },
	{ key: 'tags', label: 'Tags', icon: 'tag' },
];
const PROFILES = [
	{ key: 'ExactAndNear', label: 'Exact & near copies', icon: 'copy', desc: 'Copies, renames and re-encodes. Fastest, strictest (98%).' },
	{ key: 'EditedAndAltered', label: 'Edited & altered', icon: 'wand', desc: 'Also crops, watermarks, flips and quality changes (92%). Default.' },
	{ key: 'AiScan', label: 'AI scan', icon: 'ai', desc: 'Adds AI matching for heavy edits and clips cut out of longer videos.' },
	{ key: 'DeepClean', label: 'Deep clean', icon: 'layers', desc: 'Everything, plus audio-fingerprint clip matching. Slowest first scan.' },
];
const PHASE_LABELS = [['enumerate', 'Library'], ['prepare', 'Prepare'], ['analyse', 'Analyse'], ['compare', 'Compare'], ['partial', 'Audio clips'], ['partialVerify', 'Verify clips'], ['aiDense', 'AI keyframes'], ['aiPartial', 'AI clips']];

function create(app) {
	const el = h('div.page');
	const kit = app.kit;
	let folderFilter = '';
	let exFilter = '';
	const expandedBy = new Map(); // picker key → expanded folder ids
	const expandedFor = (key) => { if (!expandedBy.has(key)) expandedBy.set(key, new Set()); return expandedBy.get(key); };
	let exclusionsOpen = null; // null = decide from the saved exclusions on first render
	let tags = null;
	let smart = null;
	let selectedCount = null;
	let lastEnd = null;
	let liveLog = null;
	let offs = [];

	const set = (patch) => { app.setSettings(patch); render(); };

	// Folder filters redraw after a short pause (big libraries have hundreds of folders), and
	// the input being typed in keeps focus and caret across the redraw.
	let filterTimer = null;
	const renderFilterSoon = () => {
		clearTimeout(filterTimer);
		filterTimer = setTimeout(() => {
			const a = document.activeElement;
			const key = a && a.dataset ? a.dataset.fsearch : null;
			const pos = key ? a.selectionStart : 0;
			render();
			const again = key ? el.querySelector(`[data-fsearch="${key}"]`) : null;
			if (again) { again.focus(); again.setSelectionRange(pos, pos); }
		}, 140);
	};

	// Re-rendering rebuilds the page: keep the page's and each folder tree's scroll position,
	// or checking a folder deep in a long tree would jump back to the top.
	function render() {
		const pageTop = el.scrollTop;
		const treeTops = {};
		for (const t of el.querySelectorAll('.tree[data-tree-key]')) treeTops[t.dataset.treeKey] = t.scrollTop;
		renderPage();
		for (const t of el.querySelectorAll('.tree[data-tree-key]')) if (treeTops[t.dataset.treeKey]) t.scrollTop = treeTops[t.dataset.treeKey];
		el.scrollTop = pageTop;
	}

	function renderPage() {
		const s = app.settings;
		clear(el);
		if (app.scan.running) { el.appendChild(renderProgress()); return; }
		const head = h('div.page-head', h('h1', 'Find duplicates'), h('span.sub', app.eagleData.libraryName));
		el.appendChild(head);
		if (!s.welcomeStripDismissed) {
			el.appendChild(h('div.onboard', icon('info', 18),
				h('div', h('b', 'How it works. '), 'Pick what to scan, choose a profile and press Start. The first scan reads every file once (on a hard drive this takes a while); every scan after that only reads new or changed files. Nothing in your library is changed until you choose an action in Results.'),
				h('button.icon-btn.small.x', { title: 'Dismiss', onclick: () => set({ welcomeStripDismissed: true }) }, icon('close', 14))));
		}
		if (lastEnd && lastEnd.error) el.appendChild(h('div.callout.bad', { style: { marginBottom: '14px' } }, icon('error', 18), h('div', lastEnd.error)));
		if (lastEnd && lastEnd.aborted) el.appendChild(h('div.callout.warn', { style: { marginBottom: '14px' } }, icon('warning', 18), h('div', 'The scan was stopped. Everything analysed so far is saved — the next scan continues from there.')));

		const grid = h('div.scan-grid', h('div.col', scopeCard(s), exclusionsCard(s)), h('div.col', profileCard(s), optionsCard(s)));
		el.appendChild(grid);
		el.appendChild(h('div.card', { style: { marginTop: '16px' } }, startBar(s)));
	}

	// ── scope ──
	function scopeCard(s) {
		const modes = h('div.scope-modes', SCOPES.map((m) => h(`div.scope-mode${s.scopeMode === m.key ? '.on' : ''}`, {
			tabindex: 0, onclick: () => set({ scopeMode: m.key }), role: 'radio', 'aria-checked': String(s.scopeMode === m.key),
		}, icon(m.icon, 20), h('span', m.label))));
		const body = h('div.card-body', modes);
		if (s.scopeMode === 'folders') body.append(h('div', { style: { marginTop: '12px' } }, folderPicker(s, 'scopeFolderIds', folderFilter, (v) => { folderFilter = v; })),
			h('div.row', { style: { marginTop: '10px' } }, toggle('Include subfolders', s.includeSubDirectories, (v) => set({ includeSubDirectories: v })),
				h('span.spacer'),
				h('button.btn.small', { onclick: useEagleSelection }, icon('target', 14), 'Use folders selected in Eagle')));
		else if (s.scopeMode === 'selection') body.append(selectionInfo());
		else if (s.scopeMode === 'smartFolders') body.append(smartFolderPicker(s));
		else if (s.scopeMode === 'tags') body.append(tagPicker(s, 'scopeTags', true));
		else body.append(h('div.muted', { style: { marginTop: '12px' } }, 'Every video and image in the library is compared with every other.'));
		body.append(h('div.hr'),
			toggle('Also compare against the rest of the library', s.scanAgainstEntireDatabase, (v) => set({ scanAgainstEntireDatabase: v }),
				'Finds duplicates of the scoped items anywhere in the library. Items outside the scope are analysed too (cached after the first time).'));
		return h('div.card', h('div.card-head', h('h2', 'What to scan'), h('span.hint', 'scope')), body);
	}

	async function useEagleSelection() {
		const ids = await app.eagleData.selectedFolderIds();
		if (!ids.length) { kit.toast('No folder is selected in Eagle.'); return; }
		set({ scopeFolderIds: ids });
		kit.toast(`${ids.length} folder(s) taken from Eagle's selection.`, { kind: 'good' });
	}

	function selectionInfo() {
		const box = h('div.muted', { style: { marginTop: '12px' } }, 'Uses whatever is selected in Eagle when the scan starts.');
		if (selectedCount == null) {
			selectedCount = -1;
			app.eagleData.selectedIds().then((ids) => { selectedCount = ids.length; if (app.current === 'scan') render(); }).catch(() => {});
		}
		else if (selectedCount >= 0) box.append(h('div', { style: { marginTop: '6px' } }, h('span.badge.accent', `${number(selectedCount)} item(s) selected right now`), ' ',
			h('button.btn.small.ghost', { onclick: () => { selectedCount = null; render(); } }, icon('refresh', 13), 'Refresh')));
		return box;
	}

	function folderPicker(s, key, filter, setFilter, mode = 'include') {
		const folders = app.eagleData.folders;
		const expanded = expandedFor(key);
		const chosen = new Set(s[key] || []);
		const tree = h('div.tree', { role: 'tree', dataset: { treeKey: key } });
		const q = filter.trim().toLowerCase();
		const matches = new Set();
		if (q) {
			for (const f of folders.values()) {
				if (f.name.toLowerCase().includes(q)) {
					let p = f;
					while (p) { matches.add(p.id); p = p.parent ? folders.get(p.parent) : null; }
				}
			}
		}
		const toggleFolder = (id, on) => {
			const next = new Set(chosen);
			if (on) next.add(id); else next.delete(id);
			set({ [key]: [...next] });
		};
		// Three states: checked (chosen, or inside a chosen folder), partly (something below it
		// is chosen — shown even while collapsed) and unchecked.
		const partly = new Set();
		for (const id of chosen) {
			const f = folders.get(id);
			let p = f && f.parent ? folders.get(f.parent) : null;
			while (p) { partly.add(p.id); p = p.parent ? folders.get(p.parent) : null; }
		}
		const renderNode = (id) => {
			const f = folders.get(id);
			if (!f) return;
			if (q && !matches.has(id)) return;
			const hasKids = f.children.length > 0;
			const open = q ? true : expanded.has(id);
			const ancestorChosen = (() => { let p = f.parent ? folders.get(f.parent) : null; while (p) { if (chosen.has(p.id)) return true; p = p.parent ? folders.get(p.parent) : null; } return false; })();
			const implied = s.includeSubDirectories && ancestorChosen && !chosen.has(id);
			const cb = h('input', { type: 'checkbox' });
			cb.checked = chosen.has(id) || implied;
			cb.indeterminate = !cb.checked && partly.has(id);
			cb.disabled = implied;
			if (cb.indeterminate) cb.title = 'Some folders inside are chosen';
			cb.addEventListener('click', (e) => e.stopPropagation());
			cb.addEventListener('change', () => toggleFolder(id, cb.checked));
			const tw = h(`span.tw${hasKids ? '' : '.leaf'}`, { onclick: (e) => { e.stopPropagation(); if (expanded.has(id)) expanded.delete(id); else expanded.add(id); render(); } }, icon(open ? 'chevronDown' : 'chevronRight', 14));
			const row = h(`div.tree-row${mode === 'exclude' && (chosen.has(id) || implied) ? '.excluded' : ''}`, {
				style: { paddingLeft: `${4 + f.depth * 16}px` }, role: 'treeitem',
				onclick: () => { if (!implied) { cb.checked = !cb.checked; toggleFolder(id, cb.checked); } },
			}, tw, cb, f.iconColor ? h('span.fcolor', { style: { background: colorOf(f.iconColor) } }) : null, icon(open && hasKids ? 'folderOpen' : 'folder', 15), h('span.name', { title: f.path }, f.name));
			tree.appendChild(row);
			if (open) for (const c of f.children) renderNode(c);
		};
		for (const id of app.eagleData.roots) renderNode(id);
		if (!tree.childNodes.length) tree.appendChild(h('div.tree-empty', folders.size ? 'No folder matches the filter.' : 'This library has no folders.'));
		const search = h('div.search', icon('search', 14), h('input.input', {
			placeholder: 'Filter folders', value: filter, style: { width: '100%' },
			oninput: (e) => { setFilter(e.target.value); renderFilterSoon(); },
		}));
		search.querySelector('input').dataset.fsearch = key;
		const info = h('div.row.small.faint', { style: { marginTop: '6px' } },
			h('span', `${chosen.size} folder(s) chosen`),
			h('span.spacer'),
			h('button.btn.small.ghost', { onclick: () => { for (const id of folders.keys()) expanded.add(id); render(); } }, 'Expand all'),
			h('button.btn.small.ghost', { onclick: () => { expanded.clear(); render(); } }, 'Collapse all'),
			chosen.size ? h('button.btn.small.ghost', { onclick: () => set({ [key]: [] }) }, 'Clear') : null);
		return h('div.col', { style: { gap: '8px' } }, search, tree, info);
	}

	function smartFolderPicker(s) {
		const box = h('div', { style: { marginTop: '12px' } });
		if (!smart) {
			box.appendChild(h('div.muted', 'Loading smart folders…'));
			app.eagleData.loadSmartFolders().then((list) => { smart = list; if (app.current === 'scan') render(); });
			return box;
		}
		if (!smart.length) { box.appendChild(h('div.muted', 'This library has no smart folders.')); return box; }
		const chosen = new Set(s.scopeSmartFolderIds || []);
		const tree = h('div.tree');
		for (const sf of smart) {
			const cb = h('input', { type: 'checkbox' });
			cb.checked = chosen.has(sf.id);
			cb.addEventListener('click', (e) => e.stopPropagation());
			const toggleIt = () => { const n = new Set(chosen); if (n.has(sf.id)) n.delete(sf.id); else n.add(sf.id); set({ scopeSmartFolderIds: [...n] }); };
			cb.addEventListener('change', toggleIt);
			tree.appendChild(h('div.tree-row', { style: { paddingLeft: `${8 + sf.depth * 16}px` }, onclick: toggleIt }, cb, icon('smartFolder', 15), h('span.name', sf.name), h('span.cnt', number(sf.count))));
		}
		box.appendChild(tree);
		return box;
	}

	function tagPicker(s, key, withMatchAll) {
		const box = h('div', { style: { marginTop: '12px' } });
		if (!tags) {
			box.appendChild(h('div.muted', 'Loading tags…'));
			app.eagleData.loadTags().then((list) => { tags = list; if (app.current === 'scan') render(); });
			return box;
		}
		const chosen = s[key] || [];
		const list = h('datalist', { id: `dl-${key}` }, tags.slice(0, 3000).map((t) => h('option', { value: t.name })));
		const input = h('input.input', { list: `dl-${key}`, placeholder: 'Type a tag and press Enter', style: { flex: '1' } });
		const add = () => { const v = input.value.trim(); if (v && !chosen.includes(v)) set({ [key]: [...chosen, v] }); input.value = ''; };
		input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
		box.append(list, h('div.row', input, h('button.btn', { onclick: add }, icon('plus', 14), 'Add')),
			h('div.tags-edit', { style: { marginTop: '8px' } }, chosen.map((t) => h('span.tg', t, h('button', { title: 'Remove', onclick: () => set({ [key]: chosen.filter((x) => x !== t) }) }, icon('close', 12))))));
		if (withMatchAll) box.append(h('div', { style: { marginTop: '8px' } }, toggle('Item must have all of these tags', s.scopeTagsMatchAll, (v) => set({ scopeTagsMatchAll: v }))));
		return box;
	}

	function exclusionsCard(s) {
		const body = h('div.card-body');
		// Open/closed survives re-renders; the tree is only built while the section is open.
		if (exclusionsOpen === null) exclusionsOpen = (s.excludeFolderIds || []).length > 0;
		const fold = h('details', h('summary.muted', { style: { cursor: 'pointer' } }, `Excluded folders (${(s.excludeFolderIds || []).length})`),
			exclusionsOpen ? h('div', { style: { marginTop: '8px' } }, folderPicker(s, 'excludeFolderIds', exFilter, (v) => { exFilter = v; }, 'exclude')) : null);
		fold.open = exclusionsOpen;
		fold.addEventListener('toggle', () => { if (fold.open !== exclusionsOpen) { exclusionsOpen = fold.open; render(); } });
		body.append(fold, h('div.hr'), h('div.muted.small', 'Excluded tags'), tagPicker(s, 'excludeTags', false), h('div.hr'),
			h('div.row.wrap', { style: { gap: '18px' } },
				toggle('Videos', s.includeVideos, (v) => set({ includeVideos: v })),
				toggle('Images', s.includeImages, (v) => set({ includeImages: v })),
				toggle('Other formats (by Eagle thumbnail)', s.includeOtherFormatsViaThumbnail, (v) => set({ includeOtherFormatsViaThumbnail: v }))));
		return h('div.card', h('div.card-head', h('h2', 'Leave out'), h('span.hint', 'exclusions and file types')), body);
	}

	// ── profile + options ──
	function profileCard(s) {
		const active = settingsMod.activeProfile(s);
		const grid = h('div.profiles', PROFILES.map((p) => h(`div.profile${active === p.key ? '.on' : ''}`, {
			tabindex: 0, onclick: () => set(settingsMod.applyProfile(app.settings, p.key)),
		}, h('div.t', icon(p.icon, 15), p.label), h('div.d', p.desc))));
		const custom = h(`div.profile${active === 'Custom' ? '.on' : ''}`, { style: { gridColumn: '1 / -1' }, onclick: () => set(settingsMod.applyProfile(app.settings, 'Custom')) },
			h('div.t', icon('settings', 15), 'Custom'), h('div.d', active === 'Custom' ? 'Your own settings are in effect.' : 'Restores the settings you had before picking a profile.'));
		grid.appendChild(custom);
		return h('div.card', h('div.card-head', h('h2', 'Profile')), h('div.card-body', grid));
	}

	function optionsCard(s) {
		const body = h('div.card-body');
		body.append(
			opt('Similarity threshold', 'How alike two files must be to count as duplicates.',
				rangeInput(s.percent, 50, 100, 0.5, (v) => set({ percent: v }), '%')),
			opt('Frames per video', 'More frames = fewer false matches, slower first scan.',
				h('input.input.num', { type: 'number', min: 1, max: 64, value: s.thumbnails, onchange: (e) => set({ thumbnails: Number(e.target.value) || 1 }) })),
			opt('Algorithm', 'Grayscale compares pixels; pHash compares frequency patterns; both = either may match.',
				segmented([['gray', 'Grayscale'], ['phash', 'pHash'], ['both', 'Both']], s.combineGrayPHash ? 'both' : s.usePHash ? 'phash' : 'gray',
					(v) => set({ usePHash: v === 'phash', combineGrayPHash: v === 'both' }))),
			opt('Compare mirrored copies', 'Also match horizontally flipped videos and images.', switchEl(s.compareHorizontallyFlipped, (v) => set({ compareHorizontallyFlipped: v }))),
			opt('Ignore black / white borders', 'Letterboxing and white bars do not count against a match.',
				h('div.row', toggle('Black', s.ignoreBlackPixels, (v) => set({ ignoreBlackPixels: v })), toggle('White', s.ignoreWhitePixels, (v) => set({ ignoreWhitePixels: v })))),
			opt('Duration difference', 'Videos whose lengths differ more than this are never compared.',
				h('div.row', h('input.input.num', { type: 'number', min: 0, max: 100, value: s.percentDurationDifference, onchange: (e) => set({ percentDurationDifference: Number(e.target.value) || 0 }) }), h('span.muted', '%'))),
			opt('AI matching', 'Neural image embeddings find heavily edited copies (local only).', switchEl(s.useAiMatching, (v) => set({ useAiMatching: v }))),
			// The AI pass has its own threshold (VDF AiPercent): a pair that fails the similarity
			// threshold above is still reported when its AI similarity reaches this one.
			s.useAiMatching ? opt('AI similarity threshold', `AI matches are judged by this, not by the ${s.percent}% above: a pair that fails the pixel check still counts when AI finds it this similar.`,
				rangeInput(s.aiPercent, 50, 100, 0.5, (v) => set({ aiPercent: v }), '%')) : null,
			opt('Partial clips (audio)', 'Find shorter clips cut out of longer videos by their audio.', switchEl(s.enablePartialClipDetection, (v) => set({ enablePartialClipDetection: v }))),
			opt('Partial clips (AI, no audio needed)', 'Find trimmed clips visually.', switchEl(s.enableAiPartialDetection, (v) => set({ enableAiPartialDetection: v }))),
			s.enableAiPartialDetection ? opt('AI clip threshold', 'How alike a clip\'s keyframes must be to the source; at least 4 must agree on one time offset.',
				rangeInput(s.aiPartialHitPercent, 70, 99, 1, (v) => set({ aiPartialHitPercent: v }), '%')) : null,
			h('div', { style: { marginTop: '8px' } }, h('button.btn.small.ghost', { onclick: () => app.navigate('settings') }, icon('settings', 14), 'All settings')));
		return h('div.card', h('div.card-head', h('h2', 'Matching')), body);
	}

	function startBar(s) {
		const summary = h('div.summary', scopeSummary(s));
		return h('div.start-bar', summary,
			h('button.btn', { title: 'Compare using only fingerprints already in the cache (no file reading)', onclick: () => app.startScan({ compareOnly: true }) }, icon('refresh', 15), 'Compare cached only'),
			h('button.btn.primary.big', { onclick: () => app.startScan() }, icon('play', 16), 'Start scan'));
	}

	function scopeSummary(s) {
		const bits = [];
		switch (s.scopeMode) {
			case 'library': bits.push('Whole library'); break;
			case 'selection': bits.push('Items selected in Eagle'); break;
			case 'folders': bits.push(`${(s.scopeFolderIds || []).length} folder(s)${s.includeSubDirectories ? ' with subfolders' : ''}`); break;
			case 'smartFolders': bits.push(`${(s.scopeSmartFolderIds || []).length} smart folder(s)`); break;
			case 'tags': bits.push(`${(s.scopeTags || []).length} tag(s)`); break;
			default: break;
		}
		const types = [s.includeVideos && 'videos', s.includeImages && 'images'].filter(Boolean).join(' + ') || 'nothing';
		bits.push(types);
		bits.push(`${s.percent}% similar`);
		if (s.useAiMatching) bits.push(`AI matches from ${s.aiPercent}%`);
		if (s.scanAgainstEntireDatabase) bits.push('vs. whole library');
		return bits.join(' · ');
	}

	// ── progress ──
	function renderProgress() {
		const p = app.scan.progress || {};
		const frac = p.total ? Math.min(1, p.done / p.total) : null;
		const bar = h(`div.bar${frac == null ? '.indet' : ''}`, h('div', { style: { width: `${Math.round((frac || 0) * 100)}%` } }));
		const phases = h('div.phases', PHASE_LABELS
			.filter(([k]) => ['enumerate', 'prepare', 'analyse', 'compare'].includes(k) || app.scan.phasesSeen.includes(k) || relevantPhase(k))
			.map(([k, l]) => {
				const idx = app.scan.phasesSeen.indexOf(k);
				const cur = p.phase === k;
				return h(`span.ph${cur ? '.now' : idx >= 0 ? '.done' : ''}`, l);
			}));
		const pauseBtn = p.paused
			? h('button.btn', { onclick: () => app.resumeScan() }, icon('play', 14), 'Resume')
			: h('button.btn', { onclick: () => app.pauseScan() }, icon('pause', 14), 'Pause');
		liveLog = h('div.live-log');
		for (const l of app.logs.slice(-60)) liveLog.appendChild(logLine(l));
		setTimeout(() => { liveLog.scrollTop = liveLog.scrollHeight; }, 0);
		return h('div',
			h('div.page-head', h('h1', 'Scanning'), h('span.sub', app.eagleData.libraryName), h('span.spacer'), pauseBtn,
				h('button.btn.danger', { onclick: async () => { if (await kit.confirmDialog({ title: 'Stop the scan?', message: 'Everything analysed so far stays cached; the next scan continues from there.', okLabel: 'Stop', danger: true })) app.stopScan(); } }, icon('stop', 14), 'Stop')),
			h('div.card.progress-card',
				h('div.progress-phase', h('span.label', p.label || 'Starting'), h('span.nums', p.total ? `${number(Math.min(p.done, p.total))} / ${number(p.total)}` : ''),
					p.paused ? h('span.badge.warn', 'Paused') : null),
				bar,
				h('div.progress-meta',
					h('span', icon('clock', 13), `Elapsed ${span(Date.now() - app.scan.startedAt)}`),
					p.etaMs >= 1000 ? h('span', 'About ', span(p.etaMs), ' left in this phase') : null,
					p.sub ? h('span', p.sub) : null),
				p.file ? h('div.progress-file', p.file) : null,
				phases,
				liveLog),
			h('div.callout.info', { style: { marginTop: '14px' } }, icon('info', 18),
				h('div', 'You can close this window: it drops to the taskbar and the scan keeps running. Click it there (or reopen the plugin) to see the progress.')));
	}

	function relevantPhase(k) {
		const s = app.settings;
		if (k === 'partial' || k === 'partialVerify') return s.enablePartialClipDetection;
		if (k === 'aiDense' || k === 'aiPartial') return s.enableAiPartialDetection;
		return false;
	}

	function logLine(l) {
		const t = new Date(l.t);
		return h(`div${l.level === 'warn' ? '.warn' : l.level === 'error' ? '.error' : ''}`, `${t.toLocaleTimeString()}  ${l.message}`);
	}

	// ── small controls ──
	function toggle(label, value, onChange, desc) {
		const cb = h('input', { type: 'checkbox' });
		cb.checked = !!value;
		cb.addEventListener('change', () => onChange(cb.checked));
		const lab = h('label.switch', cb, h('span.track'), h('span', label));
		if (!desc) return lab;
		return h('div', lab, h('div.faint.small', { style: { marginLeft: '42px' } }, desc));
	}
	function switchEl(value, onChange) {
		const cb = h('input', { type: 'checkbox' });
		cb.checked = !!value;
		cb.addEventListener('change', () => onChange(cb.checked));
		return h('label.switch', cb, h('span.track'));
	}
	function opt(name, desc, control) {
		return h('div.opt', h('div.l', h('div.n', name), h('div.d', desc)), control);
	}
	function rangeInput(value, min, max, step, onChange, unit) {
		const val = h('span.val', `${value}${unit}`);
		const r = h('input', { type: 'range', min, max, step, value });
		r.addEventListener('input', () => { val.textContent = `${r.value}${unit}`; });
		r.addEventListener('change', () => onChange(Number(r.value)));
		return h('div.range', { style: { width: '220px' } }, r, val);
	}
	function segmented(options, value, onChange) {
		return h('div.seg', options.map(([k, l]) => h(`button${k === value ? '.on' : ''}`, { onclick: () => onChange(k) }, l)));
	}

	function colorOf(c) {
		return { red: '#ff5b52', orange: '#ff9f0a', yellow: '#ffd60a', green: '#34c77b', aqua: '#40c8e0', blue: '#3d8bfd', purple: '#a68bff', pink: '#ff6fae' }[c] || 'var(--text-3)';
	}

	let progressTimer = null;
	function onProgress() {
		if (app.current !== 'scan' || !app.scan.running) return;
		if (progressTimer) return;
		progressTimer = setTimeout(() => { progressTimer = null; if (app.current === 'scan') render(); }, 250);
	}

	return {
		el,
		show() {
			selectedCount = null;
			offs.push(app.on('progress', onProgress));
			offs.push(app.on('scanStarted', () => { lastEnd = null; render(); }));
			offs.push(app.on('scanEnded', (e) => { lastEnd = e; render(); }));
			offs.push(app.on('library', () => { tags = null; smart = null; render(); }));
			offs.push(app.on('log', (l) => { if (liveLog && app.scan.running) { liveLog.appendChild(logLine(l)); while (liveLog.childNodes.length > 200) liveLog.removeChild(liveLog.firstChild); liveLog.scrollTop = liveLog.scrollHeight; } }));
			render();
		},
		hide() { offs.forEach((f) => f()); offs = []; },
		onKey(e) {
			if (e.key === 'Enter' && e.ctrlKey && !app.scan.running) { app.startScan(); return true; }
			return false;
		},
	};
}

module.exports = { create };
