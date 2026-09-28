'use strict';
// Results page: virtualized duplicate groups with the sampled frames, VDF's metadata columns
// and "best" badges, filters, sorting, the full selection toolset, and Eagle actions
// (trash, merge-into-keeper, tag, folder, rename, open/select in Eagle) with undo.

const fs = require('fs');
const path = require('path');
const { h, icon, clear, bytes, duration, date, number, debounce, fileUrl } = require('./dom');
const results = require('../core/results');
const diffmap = require('../core/diffmap');
const { sameLibrary } = require('./store');
const sel = require('../core/selection');
const expr = require('../core/expression');

const GROUP_GAP = 12;
const HEAD_H = 42;

const SHOW_IN_FOLDER = process.platform === 'darwin' ? 'Show in Finder' : 'Show in Explorer';

function create(app) {
	const kit = app.kit;
	const dialogs = require('./dialogs').bind(app);
	const el = h('div.results');
	let items = [];
	let groups = new Map();         // groupId → members (all)
	let order = [];                 // visible group ids in display order
	let visibleMembers = new Map(); // groupId → members passing filter
	let eagleInfo = new Map();      // id → plain eagle item
	let thumbs = new Map();         // id → [paths]
	let pendingThumbs = new Set();
	let collapsed = new Set();
	let layout = [];                // [{gid, top, height}]
	let focus = { gid: null, idx: 0 };
	const selUndo = [];
	const actionUndo = [];
	let listEl, sizer, statsEl, toolbarEl, filterEl, colHead, undoBtn;
	let hoverDiffEl = null;
	const filter = { text: '', type: 'all', flipped: false, ai: false, partial: false, tombstone: false, missing: false, minSim: 0, checkedOnly: false };
	let offs = [];

	const s = () => app.settings;
	const dateOf = (d) => (s().resultsShowDateModified && d.dateModified ? d.dateModified : d.dateCreated);

	// ── data ──
	async function load() {
		const r = app.results;
		items = r ? r.items : [];
		for (const it of items) { if (it.checked == null) it.checked = false; }
		groups = new Map();
		for (const it of items) { if (!groups.has(it.groupId)) groups.set(it.groupId, []); groups.get(it.groupId).push(it); }
		results.highlightBest(items, prefersLargerSize());
		try {
			const all = await app.eagleData.allItems();
			eagleInfo = all;
			for (const it of items) {
				const e = all.get(it.id);
				it.gone = !e;
				if (e) { it.name = e.name; it.ext = e.ext; }
			}
		}
		catch (err) { app.log('warn', `Could not read Eagle item details: ${err.message}`); }
		applyFilter();
		if (r && r.freshScan) { delete r.freshScan; afterScanSelections(); }
	}

	// VDF's after-scan steps, in its order: auto-apply a custom selection preset, then check
	// live copies of content deleted before. Both only set check marks.
	function afterScanSelections() {
		const S = s();
		let changed = false;
		if (S.autoApplySelectionPresetEnabled && S.autoApplySelectionPreset) {
			const preset = (S.customSelectionPresets || []).find((p) => p.name === S.autoApplySelectionPreset);
			if (preset) {
				const plan = sel.computeCustomSelection(items.filter((m) => m.visible), { ...sel.DEFAULT_CUSTOM, ...preset.data }, dateOf, pathsOf);
				for (const m of plan.keepers) m.checked = false;
				for (const m of plan.toCheck) m.checked = true;
				changed = true;
				app.log('info', `Auto-applied selection preset "${preset.name}": ${plan.toCheck.length} item(s) checked.`);
			}
			else app.log('warn', `Selection preset "${S.autoApplySelectionPreset}" no longer exists; nothing was auto-checked.`);
		}
		if (S.rememberDeletedContent && S.autoCheckDeletedContentMatches) {
			let n = 0;
			for (const members of groups.values()) {
				if (!members.some((m) => m.tombstone || m.gone)) continue;
				for (const m of members) if (!m.tombstone && !m.gone && !m.missing && !m.checked) { m.checked = true; n++; }
			}
			if (n) { changed = true; app.log('info', `Auto-checked ${n} re-import(s) matching previously deleted content.`); }
		}
		if (changed) app.saveResults();
	}

	function prefersLargerSize() {
		const order = s().qualityCriteriaOrder, dis = s().qualityCriteriaDisabled;
		const iL = order.indexOf('SizeLarger'), iS = order.indexOf('Size');
		if (dis.includes('SizeLarger')) return false;
		return dis.includes('Size') || (iL >= 0 && (iS < 0 || iL < iS));
	}

	function passes(it) {
		const f = filter;
		if (f.type === 'videos' && it.isImage) return false;
		if (f.type === 'images' && !it.isImage) return false;
		if (f.checkedOnly && !it.checked) return false;
		if (f.text) {
			const e = eagleInfo.get(it.id);
			const hay = `${it.name}.${it.ext} ${e ? app.eagleData.folderPaths(e.folders).join(' ') + ' ' + e.tags.join(' ') : ''}`.toLowerCase();
			if (!hay.includes(f.text.toLowerCase())) return false;
		}
		return true;
	}

	function groupPasses(members) {
		const f = filter;
		if (f.flipped && !members.some((m) => m.flags & 1)) return false;
		if (f.ai && !members.some((m) => m.flags & 4)) return false;
		if (f.partial && !members.some((m) => m.flags & 2)) return false;
		if (f.tombstone && !members.some((m) => m.tombstone || m.gone)) return false;
		if (f.missing && !members.some((m) => m.missing)) return false;
		if (f.minSim > 0 && Math.max(...members.map((m) => m.similarity)) < f.minSim) return false;
		return true;
	}

	function applyFilter() {
		visibleMembers = new Map();
		order = [];
		for (const [gid, members] of groups) {
			for (const m of members) m.visible = false;
			if (!groupPasses(members)) continue;
			const vis = members.filter(passes);
			if (!vis.length) continue;
			for (const m of vis) m.visible = true;
			visibleMembers.set(gid, sortMembers(vis));
			order.push(gid);
		}
		const mode = s().resultsSortMode;
		const desc = s().resultsSortDescending;
		const keys = new Map(order.map((g) => [g, results.groupSortKey(mode, groups.get(g), dateOf)]));
		order.sort((a, b) => {
			const ka = keys.get(a), kb = keys.get(b);
			const c = ka < kb ? -1 : ka > kb ? 1 : 0;
			return (desc ? -c : c) || a - b;
		});
		relayout();
		renderStats();
	}

	function sortMembers(ms) {
		if (!s().resultsBestFirst) return ms;
		const crit = sel.resolveCriteria(s().qualityCriteriaOrder, s().qualityCriteriaDisabled);
		const { keeper } = sel.pickKeeper(ms, crit);
		return [keeper, ...ms.filter((m) => m !== keeper)];
	}

	function rowH() { return s().resultsCompactRows ? 50 : 82; }
	function groupHeight(gid) {
		if (collapsed.has(gid)) return HEAD_H + 2;
		return HEAD_H + 2 + visibleMembers.get(gid).length * rowH();
	}

	function relayout() {
		layout = [];
		let top = GROUP_GAP;
		for (const gid of order) {
			const hgt = groupHeight(gid);
			layout.push({ gid, top, height: hgt });
			top += hgt + GROUP_GAP;
		}
		if (sizer) {
			sizer.style.height = `${top}px`;
			const none = sizer.querySelector('.no-match');
			if (!order.length && !none) sizer.appendChild(h('div.empty.no-match', { style: { height: '260px' } }, icon('filter', 32), h('div', items.length ? 'No group matches the current filter.' : 'Every group has been resolved.')));
			else if (order.length && none) none.remove();
		}
		renderVisible(true);
	}

	// ── rendering ──
	function build() {
		clear(el);
		if (!app.results || !items.length) {
			el.appendChild(h('div.empty', icon('results', 44),
				h('h3', app.results ? 'No duplicates found' : 'No results yet'),
				h('div', app.results ? 'Nothing in the scanned scope matched at the current settings. Try a lower similarity threshold or the "Edited & altered" profile.' : 'Run a scan to find duplicate videos and images in this library.'),
				h('button.btn.primary', { onclick: () => app.navigate('scan') }, icon('scan', 15), app.results ? 'Change settings and scan again' : 'Go to Scan')));
			return;
		}
		statsEl = h('div.stats');
		undoBtn = h('button.btn', { title: 'Undo the last action (restores trashed items, reverts merges)', onclick: undoLastAction }, icon('undo', 14), 'Undo');
		toolbarEl = h('div.toolbar',
			statsEl,
			h('span.spacer'),
			h('div.search', icon('search', 14), h('input.input', { placeholder: 'Filter by name, folder or tag', value: filter.text, style: { width: '220px' }, oninput: debounce((e) => { filter.text = e.target.value; applyFilter(); }, 180) })),
			h('button.btn', { onclick: (e) => selectionMenu(e.currentTarget) }, icon('checkAll', 15), 'Select', icon('chevronDown', 13)),
			h('button.btn', { onclick: (e) => actionsMenu(e.currentTarget) }, icon('more', 15), 'Actions', icon('chevronDown', 13)),
			undoBtn,
			h('button.btn.danger', { onclick: () => trashChecked(false), title: 'Move checked items to Eagle\'s trash (Del)' }, icon('trash', 15), 'Trash checked'));
		const sortSel = h('select.select', { onchange: (e) => { app.setSettings({ resultsSortMode: e.target.value }); applyFilter(); } },
			[['WastedSpace', 'Wasted space'], ['TotalSize', 'Total size'], ['LargestFile', 'Largest file'], ['FileCount', 'Number of files'], ['Similarity', 'Similarity'], ['DateCreated', 'Date'], ['Duration', 'Duration'], ['Name', 'Name']]
				.map(([v, l]) => h('option', { value: v }, l)));
		sortSel.value = s().resultsSortMode;
		const chip = (key, label, ic) => h(`button.chip${filter[key] ? '.on' : ''}`, { onclick: (e) => { filter[key] = !filter[key]; e.currentTarget.classList.toggle('on', filter[key]); applyFilter(); } }, icon(ic, 13), label);
		const typeSeg = h('div.seg', [['all', 'All'], ['videos', 'Videos'], ['images', 'Images']].map(([k, l]) => h(`button${filter.type === k ? '.on' : ''}`, { onclick: (e) => { filter.type = k; [...e.currentTarget.parentNode.children].forEach((b) => b.classList.toggle('on', b === e.currentTarget)); applyFilter(); } }, l)));
		const minSim = h('input', { type: 'range', min: 0, max: 100, step: 1, value: filter.minSim, style: { width: '110px', accentColor: 'var(--accent)' } });
		const minSimVal = h('span.faint.small', filter.minSim ? `≥ ${filter.minSim}%` : 'any');
		minSim.addEventListener('input', () => { filter.minSim = Number(minSim.value); minSimVal.textContent = filter.minSim ? `≥ ${filter.minSim}%` : 'any'; });
		minSim.addEventListener('change', applyFilter);
		filterEl = h('div.filterbar',
			h('div.row.wrap', { style: { gap: '8px', flex: '1', minWidth: '0' } },
				typeSeg,
				chip('flipped', 'Mirrored', 'flip'), chip('ai', 'AI match', 'ai'), chip('partial', 'Partial clip', 'scissors'), chip('tombstone', 'Deleted before', 'ghost'), chip('missing', 'Missing file', 'unlink'), chip('checkedOnly', 'Checked only', 'check'),
				h('span.row', { style: { gap: '6px' } }, h('span.faint.small', 'Similarity'), minSim, minSimVal)),
			h('div.row', { style: { gap: '4px', flex: 'none' } },
				h('span.faint.small', 'Sort'), sortSel,
				h('button.icon-btn', { title: s().resultsSortDescending ? 'Descending' : 'Ascending', onclick: () => { app.setSettings({ resultsSortDescending: !s().resultsSortDescending }); build(); } }, icon(s().resultsSortDescending ? 'sortDesc' : 'sortAsc', 16)),
				h(`button.icon-btn${s().resultsBestFirst ? '.on' : ''}`, { title: 'Best copy first in every group', onclick: () => { app.setSettings({ resultsBestFirst: !s().resultsBestFirst }); build(); } }, icon('star', 16)),
				h(`button.icon-btn${s().resultsCompactRows ? '.on' : ''}`, { title: 'Compact rows', onclick: () => { app.setSettings({ resultsCompactRows: !s().resultsCompactRows }); build(); } }, icon('density', 16)),
				h('button.icon-btn', { title: 'Collapse all groups', onclick: () => { for (const g of order) collapsed.add(g); relayout(); } }, icon('collapse', 16)),
				h('button.icon-btn', { title: 'Expand all groups', onclick: () => { collapsed.clear(); relayout(); } }, icon('expand', 16))));
		colHead = h('div.col-head', h('span', { style: { width: '16px' } }), h('span.grow', 'File'), columnsHead(), h('span', { style: { width: '70px', textAlign: 'right' } }, 'Similar'), h('span', { style: { width: '76px' } }));
		listEl = h('div.list-wrap', { tabindex: 0 });
		sizer = h('div.list-sizer');
		listEl.appendChild(sizer);
		listEl.addEventListener('scroll', () => renderVisible(false), { passive: true });
		el.append(toolbarEl, filterEl, colHead, listEl);
		if (!s().resultsHintDismissed) {
			const hint = h('div.onboard', { style: { margin: '10px 14px 0' } }, icon('info', 18),
				h('div', 'Checked items are the ones to remove. Use ', h('b', 'Select'), ' to check copies automatically (e.g. lowest quality), review, then ', h('b', 'Trash checked'), '. Keys: ↑↓ move · Space check · K keep this one & next group · Enter open · Del trash · Ctrl+Z undo selection.'),
				h('button.icon-btn.small.x', { onclick: () => { app.setSettings({ resultsHintDismissed: true }); hint.remove(); } }, icon('close', 14)));
			el.insertBefore(hint, colHead);
		}
		relayout();
		renderStats();
		updateUndo();
	}

	function columnsHead() {
		const c = h('div.cols');
		const S = s();
		if (S.showDurationColumn) c.append(h('div', 'Duration'));
		c.append(h('div.w2', 'Resolution'));
		if (S.showFormatColumn) c.append(h('div.w2', 'Format'));
		if (S.showBitrateColumn) c.append(h('div', { title: 'Video bitrate over audio bitrate' }, 'Bitrate'));
		if (S.showLanguagesColumn) c.append(h('div', 'Languages'));
		if (S.showSizeDateColumn) c.append(h('div.w2', 'Size · Date'));
		return c;
	}

	function renderStats() {
		if (!statsEl) return;
		clear(statsEl);
		const checked = items.filter((i) => i.checked);
		const wasted = order.reduce((sum, g) => sum + results.wastedSpace(groups.get(g)), 0);
		statsEl.append(
			h('span', h('b', number(order.length)), ' groups'),
			h('span', h('b', number(order.reduce((n, g) => n + visibleMembers.get(g).length, 0))), ' files'),
			h('span', h('b', bytes(wasted)), ' reclaimable'),
			checked.length ? h('span', { style: { color: 'var(--bad)' } }, h('b', number(checked.length)), ` checked (${bytes(checked.reduce((a, b) => a + b.size, 0))})`) : null);
	}

	const rendered = new Map(); // gid → element
	function renderVisible(force) {
		if (!listEl) return;
		const top = listEl.scrollTop - 400;
		const bottom = listEl.scrollTop + listEl.clientHeight + 400;
		const want = new Set();
		// binary search first visible
		let lo = 0, hi = layout.length - 1, first = layout.length;
		while (lo <= hi) { const mid = (lo + hi) >> 1; if (layout[mid].top + layout[mid].height >= top) { first = mid; hi = mid - 1; } else lo = mid + 1; }
		for (let i = first; i < layout.length && layout[i].top <= bottom; i++) want.add(layout[i].gid);
		for (const [gid, node] of rendered) if (!want.has(gid) || force) { node.remove(); rendered.delete(gid); }
		const needThumbs = [];
		for (let i = first; i < layout.length && layout[i].top <= bottom; i++) {
			const L = layout[i];
			if (rendered.has(L.gid)) continue;
			const node = renderGroup(L.gid, i + 1, L);
			sizer.appendChild(node);
			rendered.set(L.gid, node);
			if (!collapsed.has(L.gid)) for (const m of visibleMembers.get(L.gid)) if (!thumbs.has(m.id) && !pendingThumbs.has(m.id)) needThumbs.push(m);
		}
		if (needThumbs.length) requestThumbs(needThumbs);
	}

	function renderGroup(gid, number_, L) {
		const all = groups.get(gid);
		const members = visibleMembers.get(gid);
		const flags = all.reduce((a, m) => a | m.flags, 0);
		const node = h(`div.group${focus.gid === gid ? '.focused' : ''}`, { style: { top: `${L.top}px`, height: `${L.height}px` } });
		const isColl = collapsed.has(gid);
		const head = h('div.g-head',
			h('button.icon-btn.small', { title: isColl ? 'Expand' : 'Collapse', onclick: () => { if (isColl) collapsed.delete(gid); else collapsed.add(gid); relayout(); } }, icon(isColl ? 'chevronRight' : 'chevronDown', 14)),
			h('span.gt', `Group ${number_}`),
			h('span.gm', h('span', `${all.length} files`), h('span', `${bytes(results.wastedSpace(all))} reclaimable`), h('span', `up to ${Math.max(...all.map((m) => m.similarity)).toFixed(1)}% similar`)),
			flags & 1 ? h('span.badge.accent', icon('flip', 11), 'Mirrored') : null,
			flags & 4 ? h('span.badge.violet', icon('ai', 11), 'AI') : null,
			flags & 2 ? h('span.badge.warn', icon('scissors', 11), 'Partial clip') : null,
			all.some((m) => m.tombstone || m.gone) ? h('span.badge.bad', icon('ghost', 11), 'Deleted before') : null,
			h('div.acts',
				h('button.icon-btn.small', { title: 'Keep the best copy, check the rest', onclick: () => applyChanges(sel.keepBestInGroup(all, criteria()), 'Keep best') }, icon('star', 15)),
				h('button.icon-btn.small', { title: 'Check all in group', onclick: () => applyChanges(all.filter((m) => m.visible).map((m) => [m, true]), 'Check group') }, icon('checkAll', 15)),
				h('button.icon-btn.small', { title: 'Compare frames', onclick: () => compare(gid) }, icon('compare', 15)),
				h('button.icon-btn.small', { title: 'Select this group in Eagle', onclick: () => app.eagleData.select(all.filter((m) => !m.gone).map((m) => m.id)) }, icon('target', 15)),
				h('button.icon-btn.small', { title: 'More', onclick: (e) => groupMenu(e.currentTarget, gid) }, icon('more', 15))));
		node.appendChild(head);
		if (!isColl) members.forEach((m, i) => node.appendChild(renderRow(m, gid, i)));
		return node;
	}

	function criteria() { return sel.resolveCriteria(s().qualityCriteriaOrder, s().qualityCriteriaDisabled); }

	// ── Compare window: what it needs from this page ──
	const keeperOf = (ms) => (ms.length ? sel.pickKeeper(ms, criteria()).keeper : null);
	const comparerNav = {
		order: (ms) => { const k = keeperOf(ms); return k ? [k, ...ms.filter((m) => m !== k)] : []; },
		best: (ms) => keeperOf(ms),
		position: (gid) => ({ index: Math.max(1, order.indexOf(gid) + 1), total: Math.max(1, order.length) }),
		neighbour: (gid, forward) => {
			const i = order.indexOf(gid);
			const j = i + (forward ? 1 : -1);
			return i < 0 || j < 0 || j >= order.length ? null : groups.get(order[j]);
		},
		check: (changes, label) => applyChanges(changes, label),
		notAMatch: (gid) => notAMatch([gid]),
		filePath: (m) => filePath(m),
		dateOf: (m) => dateOf(m),
		folderText: (m) => {
			const e = eagleInfo.get(m.id);
			if (!e) return 'Not in the library any more';
			const paths = app.eagleData.folderPaths(e.folders);
			return paths.length ? paths.join(' · ') : 'Unfiled';
		},
		open: (m) => { if (!m.gone) app.eagleData.open(m.id); },
		reveal: (m) => { if (!m.gone) app.eagleData.showInExplorer(filePath(m)); },
	};
	const compare = (gid, focusId) => dialogs.comparer(groups.get(gid), focusId, comparerNav);

	function renderRow(m, gid, idx) {
		const S = s();
		const compact = S.resultsCompactRows;
		const e = eagleInfo.get(m.id);
		const focused = focus.gid === gid && focus.idx === idx;
		const row = h(`div.g-row${m.checked ? '.checked' : ''}${focused ? '.focus' : ''}`, { style: { height: `${rowH()}px` } });
		const cb = h('input.cb', { type: 'checkbox', title: 'Check = remove this copy' });
		cb.checked = !!m.checked;
		cb.addEventListener('change', () => applyChanges([[m, cb.checked]], 'Check'));
		row.appendChild(cb);

		// thumbnails: Eagle thumbnail + the frames that were compared
		const tw = compact ? 56 : 100, th = compact ? 36 : 62;
		const tb = h('div.thumbs');
		const eagleThumb = e ? app.eagleData.thumbnailPath(e) : null;
		tb.appendChild(thumbBox(eagleThumb, tw, th, null, m, -1));
		if (S.generatePreviewThumbnails && !m.isImage && !m.gone) {
			const paths = thumbs.get(m.id) || [];
			const shown = compact ? Math.min(1, m.positions.length) : Math.min(4, m.positions.length);
			for (let k = 0; k < shown; k++) tb.appendChild(thumbBox(paths[k], tw, th, duration(m.positions[k]), m, k));
		}
		row.appendChild(tb);

		const flags = h('span.r-flags',
			m.flags & 1 ? h('span.badge.accent', icon('flip', 11), 'mirrored') : null,
			m.flags & 4 ? h('span.badge.violet', icon('ai', 11), 'AI') : null,
			m.flags & 8 ? h('span.badge', 'gray') : null,
			m.flags & 16 ? h('span.badge', 'pHash') : null,
			m.flags & 2 ? h('span.badge.warn', icon('scissors', 11), m.partialOffset ? `clip @ ${duration(m.partialOffset)}` : 'clip') : null,
			(m.tombstone || m.gone) ? h('span.badge.bad', icon('ghost', 11), 'deleted from library') : null,
			m.missing ? h('span.badge.bad', icon('unlink', 11), 'file missing') : null);
		const folderNames = e ? app.eagleData.folderPaths(e.folders) : [];
		const sub = h('div.r-sub',
			e ? h('span', icon('folder', 12), ' ', folderNames.length ? folderNames.join(' · ') : 'Unfiled') : h('span', 'Not in the library any more'),
			e && e.tags.length ? h('span', icon('tag', 12), ' ', e.tags.slice(0, 6).join(', ') + (e.tags.length > 6 ? ` +${e.tags.length - 6}` : '')) : null,
			e && e.star ? h('span', '★'.repeat(e.star)) : null);
		row.appendChild(h('div.r-main', h('div.r-name', { title: `${m.name}.${m.ext}` }, `${m.name}.${m.ext}`), compact ? flags : sub, compact ? null : flags));

		// Metric cells follow VDF's layout and hover zones: resting the pointer on one shows
		// every value of the group as its difference to the best (duration+resolution,
		// video+audio bitrate, fps and size each form one zone).
		const cols = h('div.cols');
		const best = (flag) => (m[flag] ? '.best' : '');
		const mv = (metric, text) => metricValue(gid, m, metric, text);
		const zone = (node, metrics) => { node.addEventListener('mouseenter', () => metricEnter(gid, metrics)); node.addEventListener('mouseleave', metricLeave); return node; };
		if (S.showDurationColumn) cols.append(zone(h(`div${m.isImage ? '' : best('isBestDuration')}`, m.isImage ? '—' : mv('duration', duration(m.duration))), 'duration,framesize'));
		cols.append(zone(h(`div.w2${best('isBestFrameSize')}`, mv('framesize', m.frameSize || '—'), !compact && m.hdrFormat ? h('span.l2', m.hdrFormat) : null), 'duration,framesize'));
		if (S.showFormatColumn) {
			const fps = !m.isImage && m.fps ? zone(h('span', ' · ', mv('fps', `${m.fps.toFixed(m.fps % 1 ? 2 : 0)} fps`)), 'fps') : null;
			cols.append(h('div.w2', (m.format || '—').toUpperCase(), fps, !compact && m.audioFormat ? h('span.l2', `${m.audioFormat} ${m.audioChannel || ''}`) : null));
		}
		if (S.showBitrateColumn) {
			cols.append(zone(h(`div${m.isImage ? '' : best('isBestBitRateKbs')}`, m.isImage ? '—' : mv('bitrate', `${number(m.bitRateKbs)} kb/s`),
				!compact && !m.isImage ? h('span.l2', !m.audioFormat ? 'no audio' : mv('audiobitrate', m.audioBitRateKbs ? `${number(m.audioBitRateKbs)} kb/s` : '—')) : null), 'bitrate,audiobitrate'));
		}
		if (S.showLanguagesColumn) cols.append(h('div', { title: `Audio: ${m.audioLanguages || '—'}\nSubtitles: ${m.subtitleLanguages || '—'}` }, m.audioLanguages || '—', !compact && m.subtitleLanguages ? h('span.l2', `sub ${m.subtitleLanguages}`) : null));
		if (S.showSizeDateColumn) cols.append(h(`div.w2${best('isBestSize')}`, zone(h('span', mv('size', bytes(m.size))), 'size'), !compact ? h('span.l2', date(dateOf(m))) : null));
		row.appendChild(cols);
		const simCls = m.similarity >= 98 ? 'hi' : m.similarity >= 92 ? 'mid' : 'lo';
		// The AI flag sits on one side of an AI pair (as in VDF); the partner carries the same
		// similarity, so it is labelled too.
		const aiMatch = !!(m.flags & 4) || (groups.get(gid) || []).some((x) => x !== m && (x.flags & 4) && Math.abs(x.similarity - m.similarity) < 0.005);
		const scanned = (app.results && app.results.settings) || {};
		row.appendChild(h(`div.sim.${simCls}`, {
			title: aiMatch ? `AI similarity: matched by the AI pass, which has its own threshold${scanned.aiPercent ? ` (${scanned.aiPercent}% in this scan)` : ''}, separate from the similarity threshold`
				: 'Similarity to the group',
		}, `${m.similarity.toFixed(1)}%`, aiMatch ? h('span.sim-ai', 'AI') : null));
		row.appendChild(h('div.r-acts',
			h('button.icon-btn.small', { title: 'Open in Eagle', disabled: m.gone, onclick: () => app.eagleData.open(m.id) }, icon('open', 15)),
			h('button.icon-btn.small', { title: SHOW_IN_FOLDER, disabled: m.gone, onclick: () => app.eagleData.showInExplorer(filePath(m)) }, icon('folderOpen', 15)),
			h('button.icon-btn.small', { title: 'More', onclick: (ev) => itemMenu(ev.currentTarget, m, gid) }, icon('more', 15))));
		row.addEventListener('click', (ev) => {
			if (ev.target.closest('button,input')) return;
			setFocus(gid, idx);
		});
		row.addEventListener('dblclick', (ev) => {
			if (ev.target.closest('button,input') || m.gone) return;
			if (s().thumbnailDoubleClickAction === 'OpenThumbnailComparer') compare(gid, m.id);
			else openItem(m);
		});
		row.addEventListener('contextmenu', (ev) => { ev.preventDefault(); setFocus(gid, idx); itemMenu({ x: ev.clientX, y: ev.clientY }, m, gid); });
		return row;
	}

	function thumbBox(file, w, hgt, ts, m, k) {
		const box = h('div.thumb', { style: { width: `${w}px`, height: `${hgt}px` } });
		if (file) {
			const img = h('img', { src: fileUrl(file), loading: 'lazy', draggable: !m.gone });
			img.onerror = () => { img.remove(); box.appendChild(icon(m.isImage ? 'image' : 'film', 18)); };
			if (!m.gone) img.addEventListener('dragstart', (ev) => { ev.preventDefault(); eagle.drag.startDrag([filePath(m)]).catch(() => {}); });
			box.appendChild(img);
		}
		else box.appendChild(icon(m.isImage ? 'image' : 'film', 18));
		if (ts) box.appendChild(h('span.ts', ts));
		if (k >= 0) {
			box.addEventListener('mouseenter', (ev) => { box.dataset.hover = '1'; showHoverDiff(ev, m, k); });
			box.addEventListener('mouseleave', () => { delete box.dataset.hover; hideHoverDiff(); });
		}
		return box;
	}

	function filePath(m) {
		const e = eagleInfo.get(m.id);
		return e ? app.eagleData.filePath(e) : m.path;
	}

	async function requestThumbs(list) {
		if (!s().generatePreviewThumbnails) return;
		const req = list.filter((m) => !m.isImage && !m.gone).map((m) => {
			pendingThumbs.add(m.id);
			return { id: m.id, file: filePath(m), isImage: false, positions: m.positions.slice(0, 4) };
		});
		if (!req.length) return;
		for (let i = 0; i < req.length; i += 12) {
			const chunk = req.slice(i, i + 12);
			try {
				const res = await app.engine.call('thumbs', { items: chunk, width: s().thumbnailMaxWidth || 160 });
				for (const [id, paths] of Object.entries(res)) { thumbs.set(id, paths); pendingThumbs.delete(id); }
				// re-render the affected groups
				const gids = new Set(chunk.map((c) => items.find((x) => x.id === c.id)).filter(Boolean).map((x) => x.groupId));
				for (const g of gids) { const n = rendered.get(g); if (n) { n.remove(); rendered.delete(g); } }
				renderVisible(false);
			}
			catch (err) { for (const c of chunk) pendingThumbs.delete(c.id); app.log('warn', `Thumbnails failed: ${err.message}`); }
		}
	}

	// ── metric hover diff (VDF MainWindowVM_HoverDiff + DuplicateResultsView timing) ──
	// hover: the zone the pointer rests on; pinned: "Compare values with the best" from the
	// row menu, which stays until toggled off (the pointer passing by does not end it).
	let metricHover = null;           // { gid, metrics: 'a,b' }
	let pinnedDiffGid = null;
	let hoverTimer = null, clearTimer = null;
	const BEST_LABEL = 'BEST';

	function diffLabel(gid, metric, id) {
		const on = (pinnedDiffGid === gid) || (metricHover && metricHover.gid === gid && metricHover.metrics.split(',').includes(metric));
		if (!on) return null;
		const d = results.hoverDiffs(groups.get(gid) || [], metric, BEST_LABEL);
		return d ? d.get(id) || null : null;
	}
	function metricValue(gid, m, metric, text) {
		const span = h('span.mv', { dataset: { metric, id: m.id, orig: text } }, text);
		paintValue(span, diffLabel(gid, metric, m.id));
		return span;
	}
	function paintValue(span, label) {
		span.textContent = label || span.dataset.orig;
		span.classList.toggle('diffing', !!label);
		span.classList.toggle('eq', label === '=');
		span.classList.toggle('bestlabel', label === BEST_LABEL);
	}
	function paintGroup(gid) {
		const node = rendered.get(gid);
		if (!node) return;
		for (const span of node.querySelectorAll('.mv[data-metric]')) paintValue(span, diffLabel(gid, span.dataset.metric, span.dataset.id));
	}
	function metricEnter(gid, metrics) {
		clearTimeout(hoverTimer);
		// same group and zone: what is shown is already right (moving between its rows)
		if (metricHover && metricHover.gid === gid && metricHover.metrics === metrics) { clearTimeout(clearTimer); return; }
		hoverTimer = setTimeout(() => {
			clearTimeout(clearTimer);
			const prev = metricHover;
			metricHover = { gid, metrics };
			if (prev && prev.gid !== gid) paintGroup(prev.gid);
			paintGroup(gid);
		}, 160);
	}
	function metricLeave() {
		clearTimeout(hoverTimer);
		if (!metricHover) return;
		clearTimeout(clearTimer);
		clearTimer = setTimeout(() => { const prev = metricHover; metricHover = null; if (prev) paintGroup(prev.gid); }, 120);
	}
	function toggleGroupDiffs(gid) {
		const prev = pinnedDiffGid;
		pinnedDiffGid = prev === gid ? null : gid;
		if (prev != null) paintGroup(prev);
		if (pinnedDiffGid != null) {
			paintGroup(pinnedDiffGid);
			const members = groups.get(gid) || [];
			if (!results.HOVER_METRICS.some((mt) => results.hoverDiffs(members, mt))) kit.toast('Every copy in this group has the same values.');
		}
	}

	// ── frame preview on hovering a sampled frame ──
	// A large view of the frame with VDF's difference boxes against the group's reference copy.
	// It opens at once from the small cached thumbnail and swaps to a sharp frame from the
	// engine after a short rest on it (both frames are cached for the next hover).
	const hiResFrames = new Map();   // "id@seconds" → Promise<file path | null>
	let hoverToken = 0;
	function hiResFrame(x, sec) {
		const key = `${x.id}@${sec}`;
		if (!hiResFrames.has(key)) hiResFrames.set(key, app.engine.call('frame', { id: x.id, file: filePath(x), seconds: sec, isImage: false, maxSide: 1280 }).catch(() => null));
		return hiResFrames.get(key);
	}
	function grabImage(img, w, hh, flip) {
		const c = document.createElement('canvas');
		c.width = w; c.height = hh;
		const x = c.getContext('2d', { willReadFrequently: true });
		if (flip) { x.translate(w, 0); x.scale(-1, 1); }
		x.drawImage(img, 0, 0, w, hh);
		return x.getImageData(0, 0, w, hh);
	}

	async function showHoverDiff(ev, m, k) {
		const group = groups.get(m.groupId);
		const ref = group.find((x) => x !== m && x.isBestFrameSize && !x.isImage) || group.find((x) => x !== m && !x.isImage);
		if (!ref || m.isImage || m.gone) return;
		const thumbA = (thumbs.get(m.id) || [])[k], thumbB = (thumbs.get(ref.id) || [])[k];
		if (!thumbA || !thumbB) return;
		const target = ev.currentTarget;
		hideHoverDiff(); // (bumps the token: take ours after it)
		const token = ++hoverToken;
		const alive = () => token === hoverToken && target.isConnected && target.dataset.hover === '1';
		// a mirrored match is compared against the mirrored reference, as the matcher did;
		// a clip's frames sit at other times than its source's, so it is shown, not compared
		const mirrored = !!((m.flags | ref.flags) & 1) && (m.flags & 1) !== (ref.flags & 1);
		const clip = !!((m.flags | ref.flags) & 2);
		const sens = Number.isFinite(s().thumbnailComparerDiffSensitivity) ? s().thumbnailComparerDiffSensitivity : 0.5;
		const W = Math.round(Math.min(640, Math.max(360, window.innerWidth * 0.34)));
		const t = m.positions[k] || 0;

		const draw = async (srcA, srcB) => {
			const [ia, ib] = await Promise.all([loadImg(srcA), clip ? null : loadImg(srcB)]).catch(() => []);
			if (!ia || (!clip && !ib) || !alive()) return false;
			const H = Math.round(W * ia.naturalHeight / ia.naturalWidth) || Math.round(W * 9 / 16);
			const dpr = window.devicePixelRatio || 1;
			const cw = Math.round(W * dpr), ch = Math.round(H * dpr);
			const canvas = h('canvas', { width: cw, height: ch, style: { width: `${W}px`, height: `${H}px` } });
			const x = canvas.getContext('2d');
			x.imageSmoothingQuality = 'high';
			x.drawImage(ia, 0, 0, cw, ch);
			let state = '', stateText = '';
			if (clip) { stateText = 'Clip: shown, not compared'; }
			else {
				const [dw, dh] = diffmap.analysisSize(ia.naturalWidth, ia.naturalHeight, 768);
				const r = diffmap.diffFrames(grabImage(ia, dw, dh, false), grabImage(ib, dw, dh, mirrored), sens);
				if (r && r.regions.length) {
					x.lineWidth = 1.5 * dpr;
					x.strokeStyle = 'rgba(255, 72, 72, 0.95)';
					x.fillStyle = 'rgba(255, 72, 72, 0.10)';
					for (const g of r.regions) {
						x.beginPath();
						x.roundRect(g.x * cw + 1, g.y * ch + 1, g.width * cw - 2, g.height * ch - 2, 3 * dpr);
						x.fill();
						x.stroke();
					}
				}
				state = !r ? '' : r.regions.length ? 'diff' : 'same';
				stateText = !r ? 'Compared' : r.regions.length ? `${r.regions.length} region${r.regions.length === 1 ? ' differs' : 's differ'}` : 'No structural difference';
			}
			const imgBox = h('div.hd-img', canvas, h('span.hd-time', duration(t)), mirrored ? h('span.hd-tag', 'mirrored') : null);
			const cap = h('div.hd-cap', h(`span.hd-state${state ? '.' + state : ''}`, stateText), h('span.hd-ref', { title: `${ref.name}.${ref.ext}` }, clip ? `${m.name}.${m.ext}` : `vs ${ref.name}.${ref.ext}`));
			if (!hoverDiffEl) { hoverDiffEl = h('div.hover-diff'); document.body.appendChild(hoverDiffEl); }
			hoverDiffEl.replaceChildren(imgBox, cap);
			// below the thumbnail, above it if there is no room, clamped to the window
			const rc = target.getBoundingClientRect();
			const boxW = hoverDiffEl.offsetWidth, boxH = hoverDiffEl.offsetHeight;
			const below = rc.bottom + 8 + boxH <= window.innerHeight - 8;
			hoverDiffEl.style.left = `${Math.max(8, Math.min(window.innerWidth - boxW - 8, rc.left))}px`;
			hoverDiffEl.style.top = `${below ? rc.bottom + 8 : Math.max(8, rc.top - boxH - 8)}px`;
			return true;
		};

		if (!(await draw(fileUrl(thumbA), fileUrl(thumbB)))) return;
		await new Promise((res) => setTimeout(res, 180));
		if (!alive()) return;
		const [fa, fb] = await Promise.all([hiResFrame(m, t), clip ? null : hiResFrame(ref, ref.positions[k] || 0)]);
		if (!alive() || !fa || (!clip && !fb)) return;
		await draw(fileUrl(fa), clip ? null : fileUrl(fb));
	}
	function hideHoverDiff() { hoverToken++; if (hoverDiffEl) { hoverDiffEl.remove(); hoverDiffEl = null; } }
	function loadImg(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; }); }

	// ── focus / keyboard ──
	function setFocus(gid, idx) {
		const prev = focus.gid;
		focus = { gid, idx };
		for (const g of new Set([prev, gid])) { const n = rendered.get(g); if (n) { n.remove(); rendered.delete(g); } }
		renderVisible(false);
		scrollIntoView(gid, idx);
	}

	function scrollIntoView(gid, idx) {
		const L = layout.find((x) => x.gid === gid);
		if (!L || !listEl) return;
		const y = L.top + HEAD_H + idx * rowH();
		if (y < listEl.scrollTop + 10) listEl.scrollTop = Math.max(0, L.top - 6);
		else if (y + rowH() > listEl.scrollTop + listEl.clientHeight) listEl.scrollTop = y + rowH() - listEl.clientHeight + 8;
	}

	function moveFocus(delta) {
		if (!order.length) return;
		let gi = Math.max(0, order.indexOf(focus.gid));
		if (focus.gid == null) { setFocus(order[0], 0); return; }
		let idx = focus.idx + delta;
		let members = visibleMembers.get(order[gi]);
		if (collapsed.has(order[gi])) idx = delta > 0 ? members.length : -1;
		while (idx >= members.length || idx < 0) {
			gi += delta > 0 ? 1 : -1;
			if (gi < 0 || gi >= order.length) return;
			members = visibleMembers.get(order[gi]);
			if (collapsed.has(order[gi])) { idx = delta > 0 ? members.length : -1; continue; }
			idx = delta > 0 ? 0 : members.length - 1;
		}
		setFocus(order[gi], idx);
	}

	function moveGroup(delta) {
		if (!order.length) return;
		const gi = focus.gid == null ? -1 : order.indexOf(focus.gid);
		const next = Math.min(order.length - 1, Math.max(0, gi + delta));
		setFocus(order[next], 0);
	}

	function focusedItem() {
		if (focus.gid == null || !visibleMembers.has(focus.gid)) return null;
		return visibleMembers.get(focus.gid)[focus.idx] || null;
	}

	/** VDF KeepHighlightedAndAdvance: keep the focused copy, check the rest of its group, go to the next group. */
	function keepFocusedAndAdvance() {
		const m = focusedItem();
		if (!m) return;
		const members = visibleMembers.get(focus.gid);
		applyChanges(members.map((x) => [x, x !== m]), 'Keep this copy');
		moveGroup(1);
	}

	// ── selection with undo ──
	function applyChanges(changes, label) {
		if (!changes.length) { kit.toast('Nothing to change.'); return; }
		const before = changes.map(([m]) => [m, m.checked]);
		let changed = 0;
		for (const [m, v] of changes) { if (m.checked !== v) changed++; m.checked = v; }
		selUndo.push({ label, before });
		if (selUndo.length > 100) selUndo.shift();
		refresh();
		if (label && changes.length > 1) kit.toast(`${label}: ${changed} item(s) changed.`, { action: { label: 'Undo', onClick: undoSelection } });
		persistSoon();
	}

	function undoSelection() {
		const u = selUndo.pop();
		if (!u) { kit.toast('Nothing to undo.'); return; }
		for (const [m, v] of u.before) m.checked = v;
		refresh();
		persistSoon();
	}

	function refresh() {
		for (const n of rendered.values()) n.remove();
		rendered.clear();
		if (filter.checkedOnly) applyFilter(); else { renderVisible(false); renderStats(); }
	}

	const persistSoon = debounce(() => { if (s().backupAfterListChanged) app.saveResults(); }, 1500);

	function selectionMenu(anchor) {
		const all = items;
		kit.menu(anchor, [
			{ header: 'Check automatically' },
			{ label: 'Lowest quality copies…', icon: 'star', onClick: async () => { const order = await dialogs.qualityOrder(); if (order) { rebest(); applyChanges(sel.checkLowestQuality(all, criteria()), 'Lowest quality'); } } },
			{ label: 'Identical copies', icon: 'copy', onClick: () => applyChanges(sel.checkWhenIdentical(all), 'Identical') },
			{ label: 'Identical except size (keep smallest)', icon: 'copy', onClick: () => applyChanges(sel.checkWhenIdenticalButSize(all), 'Identical except size') },
			{ label: 'Oldest copies (keep newest)', icon: 'calendar', onClick: () => applyChanges(sel.checkOldest(all, dateOf), 'Oldest') },
			{ label: 'Newest copies (keep oldest)', icon: 'calendar', onClick: () => applyChanges(sel.checkNewest(all, dateOf), 'Newest') },
			{ label: 'Live copies of previously deleted content', icon: 'ghost', onClick: checkDeletedMatches },
			'-',
			{ label: 'Custom selection…', icon: 'filter', onClick: async () => { const plan = await dialogs.customSelection(all.filter((m) => m.visible), dateOf, pathsOf); if (plan) applyChanges([...plan.keepers.map((k) => [k, false]), ...plan.toCheck.map((k) => [k, true])], 'Custom selection'); } },
			{ label: 'Expression…', icon: 'wand', onClick: () => runExpression() },
			...(s().expressionPresets || []).slice(0, 8).map((p) => ({ label: `Preset: ${p.name}`, icon: 'wand', onClick: () => runExpression(p.expression) })),
			'-',
			{ label: 'Invert', icon: 'refresh', onClick: () => applyChanges(sel.invert(all), 'Invert') },
			{ label: 'Clear all checks', icon: 'close', onClick: () => applyChanges(sel.clear(all), 'Clear') },
			{ label: 'Undo selection', icon: 'undo', key: 'Ctrl+Z', disabled: !selUndo.length, onClick: undoSelection },
		]);
	}

	function rebest() { results.highlightBest(items, prefersLargerSize()); applyFilter(); }

	function checkDeletedMatches() {
		const ch = [];
		for (const members of groups.values()) {
			if (!members.some((m) => m.tombstone || m.gone)) continue;
			for (const m of members) if (!m.tombstone && !m.gone && m.visible) ch.push([m, true]);
		}
		applyChanges(ch, 'Previously deleted content');
	}

	function pathsOf(m) {
		const e = eagleInfo.get(m.id);
		const folders = e ? app.eagleData.folderPaths(e.folders) : [];
		const name = `${m.name}.${m.ext}`;
		return [...(folders.length ? folders.map((f) => `${f}/${name}`) : [name]), filePath(m)];
	}

	async function runExpression(preset) {
		const text = preset != null ? preset : await dialogs.expressionBuilder();
		if (text == null) return;
		let fn;
		try { fn = expr.compile(text); }
		catch (err) { await kit.alertDialog('Expression error', err.message, 'error'); return; }
		const hist = [text, ...(s().expressionHistory || []).filter((x) => x !== text)].slice(0, 20);
		app.setSettings({ lastCustomSelectExpression: text, expressionHistory: hist });
		const pred = (d) => { const e = eagleInfo.get(d.id); return fn(d, e ? { ...e, folders: app.eagleData.folderPaths(e.folders), path: filePath(d) } : {}); };
		const { partial, full } = sel.partitionExpressionMatches(items, pred);
		let includeFull = false;
		if (full.length) {
			const r = await kit.choiceDialog({
				title: 'Whole groups match', icon: 'warning',
				message: `In ${full.length} group(s) every item matches your expression, for example "${full[0][0].name}".\n\nCheck all items in those groups, or none of them?`,
				options: [{ label: 'Check none of them', value: false }, { label: 'Check them all', value: true, danger: true }],
			});
			if (r === undefined) return;
			includeFull = r;
		}
		const ch = partial.map((m) => [m, true]);
		if (includeFull) for (const g of full) for (const m of g) ch.push([m, true]);
		applyChanges(ch, 'Expression');
	}

	// ── menus ──
	function groupMenu(anchor, gid) {
		const all = groups.get(gid);
		const live = all.filter((m) => !m.gone);
		kit.menu(anchor, [
			{ label: 'Keep best copy, check the rest', icon: 'star', onClick: () => applyChanges(sel.keepBestInGroup(all, criteria()), 'Keep best') },
			{ label: 'Check all', icon: 'checkAll', onClick: () => applyChanges(all.map((m) => [m, true]), 'Check group') },
			{ label: 'Uncheck all', icon: 'close', onClick: () => applyChanges(all.map((m) => [m, false]), 'Uncheck group') },
			'-',
			{ label: 'Compare…', icon: 'compare', onClick: () => compare(gid) },
			{ label: 'Compare metadata…', icon: 'info', onClick: () => dialogs.metadataCompare(all, eagleInfo, filePath) },
			{ label: 'Why do these match? (diagnostic)…', icon: 'cpu', disabled: live.length < 2, onClick: () => dialogs.diagnose(live[0], live[1], eagleInfo, filePath) },
			'-',
			{ label: 'Select group in Eagle', icon: 'target', onClick: () => app.eagleData.select(live.map((m) => m.id)) },
			{ label: 'Merge into best copy and trash the rest…', icon: 'merge', disabled: live.length < 2, onClick: () => mergeGroup(gid) },
			'-',
			{ label: 'Not a match (hide this group in future scans)', icon: 'notEqual', onClick: () => notAMatch([gid]) },
			{ label: 'Remove group from list', icon: 'eyeOff', onClick: () => removeFromList(all.map((m) => m.id)) },
		]);
	}

	function itemMenu(anchor, m, gid) {
		const live = !m.gone;
		const custom = s().customCommands || {};
		kit.menu(anchor, [
			{ label: 'Open in Eagle', icon: 'open', disabled: !live, onClick: () => app.eagleData.open(m.id) },
			{ label: 'Open in new Eagle window', icon: 'open', disabled: !live, onClick: () => app.eagleData.open(m.id, true) },
			{ label: 'Open with default app', icon: 'play', disabled: !live, onClick: () => app.eagleData.openWithDefault(filePath(m)) },
			custom.openItem ? { label: 'Open with custom command', icon: 'bolt', disabled: !live, onClick: () => runCustom(custom.openItem, [m]) } : null,
			{ label: SHOW_IN_FOLDER, icon: 'folderOpen', disabled: !live, onClick: () => app.eagleData.showInExplorer(filePath(m)) },
			custom.openItemInFolder ? { label: 'Show with custom command', icon: 'bolt', disabled: !live, onClick: () => runCustom(custom.openItemInFolder, [m]) } : null,
			{ label: 'Select in Eagle', icon: 'target', disabled: !live, onClick: () => app.eagleData.select([m.id]) },
			'-',
			{ label: m.checked ? 'Uncheck' : 'Check', icon: 'check', onClick: () => applyChanges([[m, !m.checked]], 'Check') },
			{ label: 'Keep this copy, check the rest of the group', icon: 'star', onClick: () => applyChanges(groups.get(gid).map((x) => [x, x !== m]), 'Keep this copy') },
			{ label: 'Compare…', icon: 'compare', onClick: () => compare(gid, m.id) },
			{ label: pinnedDiffGid === gid ? 'Stop comparing values with the best' : 'Compare values with the best', icon: 'scale', onClick: () => toggleGroupDiffs(gid) },
			'-',
			{ label: 'Rename…', icon: 'rename', disabled: !live, onClick: () => renameItem(m) },
			{ label: 'Copy file path', icon: 'copy', onClick: () => { eagle.clipboard.writeText(filePath(m)); kit.toast('Path copied.'); } },
			{ label: 'Copy name', icon: 'copy', onClick: () => { eagle.clipboard.writeText(`${m.name}.${m.ext}`); kit.toast('Name copied.'); } },
			{ label: 'Copy details', icon: 'copy', onClick: () => { eagle.clipboard.writeText(details(m)); kit.toast('Details copied.'); } },
			'-',
			{ label: 'Remove from list', icon: 'eyeOff', onClick: () => removeFromList([m.id]) },
			{ label: 'Remove and exclude from future scans', icon: 'ban', onClick: () => excludeItems([m.id]) },
		]);
	}

	function actionsMenu(anchor) {
		const checked = items.filter((m) => m.checked);
		const n = checked.length;
		kit.menu(anchor, [
			{ header: `${n} checked` },
			{ label: 'Move checked to Eagle trash…', icon: 'trash', key: 'Del', disabled: !n, danger: true, onClick: () => trashChecked(false) },
			{ label: 'Merge into kept copies, then trash checked…', icon: 'merge', disabled: !n, onClick: () => trashChecked(true) },
			{ label: `Tag checked as "${s().duplicateTag}"`, icon: 'tag', disabled: !n, onClick: () => tagItems(checked, s().duplicateTag) },
			{ label: 'Add tag to checked…', icon: 'tag', disabled: !n, onClick: async () => { const t = await kit.promptDialog({ title: 'Add tag', label: 'Tag to add to every checked item', validate: (v) => (v.trim() ? null : 'Enter a tag') }); if (t) tagItems(checked, t.trim()); } },
			{ label: 'Add checked to folder…', icon: 'folder', disabled: !n, onClick: () => folderAction(checked, 'add') },
			{ label: 'Move checked to folder…', icon: 'folderOpen', disabled: !n, onClick: () => folderAction(checked, 'move') },
			{ label: 'Select checked in Eagle', icon: 'target', disabled: !n, onClick: () => app.eagleData.select(checked.filter((m) => !m.gone).map((m) => m.id)) },
			{ label: 'Export copies of checked files to disk…', icon: 'download', disabled: !n, onClick: () => exportCopies(checked) },
			custom().openMultiple ? { label: 'Open checked with custom command', icon: 'bolt', disabled: !n, onClick: () => runCustom(custom().openMultiple, checked) } : null,
			custom().openMultipleInFolder ? { label: 'Show checked with custom command', icon: 'bolt', disabled: !n, onClick: () => runCustom(custom().openMultipleInFolder, checked) } : null,
			'-',
			{ label: 'Copy paths of checked', icon: 'copy', disabled: !n, onClick: () => { eagle.clipboard.writeText(checked.map(filePath).join('\n')); kit.toast(`${n} path(s) copied.`); } },
			{ label: 'Copy names of checked', icon: 'copy', disabled: !n, onClick: () => { eagle.clipboard.writeText(checked.map((m) => `${m.name}.${m.ext}`).join('\n')); kit.toast(`${n} name(s) copied.`); } },
			{ label: 'Remove checked from list', icon: 'eyeOff', disabled: !n, onClick: () => removeFromList(checked.map((m) => m.id)) },
			{ label: 'Remove checked and exclude from future scans', icon: 'ban', disabled: !n, onClick: () => excludeItems(checked.map((m) => m.id)) },
			{ label: 'Mark groups of checked as "not a match"', icon: 'notEqual', disabled: !n, onClick: () => notAMatch([...new Set(checked.map((m) => m.groupId))]) },
			'-',
			{ label: 'Cleanup dry-run report…', icon: 'log', disabled: !n, onClick: () => dryRunReport(checked) },
			{ label: 'Export results…', icon: 'upload', onClick: exportResults },
			{ label: 'Import results…', icon: 'download', onClick: importResults },
			{ label: 'Quality criteria order…', icon: 'sort', onClick: async () => { if (await dialogs.qualityOrder()) rebest(); } },
		]);
	}
	const custom = () => s().customCommands || {};

	function details(m) {
		const e = eagleInfo.get(m.id);
		return [
			`${m.name}.${m.ext}`, filePath(m),
			m.isImage ? `Image ${m.frameSize}` : `Video ${duration(m.duration)} · ${m.frameSize} · ${m.format} · ${number(m.bitRateKbs)} kb/s · ${m.fps} fps`,
			!m.isImage && m.audioFormat ? `Audio ${m.audioFormat} ${m.audioChannel} ${m.audioSampleRate} Hz ${number(m.audioBitRateKbs)} kb/s` : '',
			`Size ${bytes(m.size)} · Similarity ${m.similarity.toFixed(1)}%`,
			e ? `Folders: ${app.eagleData.folderPaths(e.folders).join(', ') || '—'} · Tags: ${e.tags.join(', ') || '—'}` : '',
		].filter(Boolean).join('\n');
	}

	function runCustom(template, list) {
		const { spawn } = require('child_process');
		const files = list.filter((m) => !m.gone).map(filePath);
		if (!files.length) return;
		// %1 = first file, %* = all files (each quoted), %d = folder of the first file
		const quoted = files.map((f) => `"${f}"`).join(' ');
		const cmd = template.replace(/%\*/g, quoted).replace(/%1/g, `"${files[0]}"`).replace(/%d/g, `"${path.dirname(files[0])}"`);
		const finalCmd = /%\*|%1|%d/.test(template) ? cmd : `${template} ${quoted}`;
		try {
			const child = spawn(finalCmd, { shell: true, detached: true, stdio: 'ignore', windowsHide: false });
			child.unref();
		}
		catch (err) { kit.alertDialog('Command failed', err.message, 'error'); }
	}

	async function renameItem(m) {
		const name = await kit.promptDialog({
			title: 'Rename', label: 'New name (the extension stays)', value: m.name,
			validate: (v) => (!v.trim() ? 'Enter a name' : /[\\/:*?"<>|]/.test(v) ? 'These characters are not allowed: \\ / : * ? " < > |' : null),
		});
		if (!name || name === m.name) return;
		try {
			const r = await app.eagleData.rename(m.id, name.trim());
			pushAction({ type: 'rename', label: `Rename "${r.prev}"`, item: r.item, prev: r.prev, resultItem: m });
			m.name = name.trim();
			refresh();
			kit.toast('Renamed.', { kind: 'good' });
		}
		catch (err) { kit.alertDialog('Rename failed', err.message, 'error'); }
	}

	// ── Eagle actions ──
	function pushAction(a) { actionUndo.push(a); if (actionUndo.length > 30) actionUndo.shift(); updateUndo(); }
	function updateUndo() {
		if (!undoBtn) return;
		const last = actionUndo[actionUndo.length - 1];
		undoBtn.disabled = !last;
		undoBtn.title = last ? `Undo: ${last.label}` : 'Nothing to undo';
	}

	async function trashChecked(mergeFirst) {
		const checked = items.filter((m) => m.checked && !m.gone);
		if (!checked.length) { kit.toast('Check the copies you want to remove first.'); return; }
		const byGroup = sel.groupsOf(checked);
		const wholeGroups = [...byGroup.keys()].filter((g) => groups.get(g).every((m) => m.checked || m.gone));
		const size = checked.reduce((a, m) => a + m.size, 0);
		const mergeCb = h('input', { type: 'checkbox' });
		mergeCb.checked = mergeFirst;
		const extra = h('div.col', { style: { marginTop: '12px', gap: '8px' } },
			wholeGroups.length ? h('div.callout.bad', icon('warning', 18), h('div', `${wholeGroups.length} group(s) have every copy checked — no copy of that content would remain in the library.`)) : null,
			h('label.check', mergeCb, h('span', 'First merge tags, folders, rating, notes and source URL into the copy that stays')),
			h('div.faint.small', 'Items go to Eagle\'s trash, where they can be restored until you empty it. Undo is available right after.'),
			h('div.faint.small', { style: { maxHeight: '120px', overflow: 'auto' } }, checked.slice(0, 12).map((m) => h('div', `${m.name}.${m.ext}`)), checked.length > 12 ? h('div', `…and ${checked.length - 12} more`) : null));
		const ok = await kit.confirmDialog({ title: 'Move to Eagle trash?', message: `Move ${number(checked.length)} checked item(s) (${bytes(size)}) to Eagle's trash?`, okLabel: 'Move to trash', danger: true, extra });
		if (!ok) return;
		const b = kit.busy('Moving to trash');
		const merges = [];
		try {
			if (mergeCb.checked) {
				let gi = 0;
				for (const [gid, ch] of byGroup) {
					gi++;
					const keeper = pickKeeperFor(gid);
					if (!keeper) continue;
					b.update(`Merging group ${gi} of ${byGroup.size}`, gi / byGroup.size / 2);
					try { merges.push(await app.eagleData.mergeInto(keeper.id, ch.map((m) => m.id), s())); }
					catch (err) { app.log('warn', `Merge into "${keeper.name}" failed: ${err.message}`); }
				}
			}
			const trashed = await app.eagleData.trash(checked.map((m) => m.id), (d, t) => b.update(`${d} of ${t}`, 0.5 + d / t / 2));
			const ids = trashed.map((i) => i.id);
			if (s().rememberDeletedContent) await app.engine.call('db.markDeleted', { ids, remember: true });
			pushAction({ type: 'trash', label: `Trash ${ids.length} item(s)`, trashed, merges, removed: removeItems(ids) });
			kit.toast(`${ids.length} item(s) moved to Eagle's trash${merges.length ? `, ${merges.length} keeper(s) updated` : ''}.`, { kind: 'good', action: { label: 'Undo', onClick: undoLastAction } });
		}
		catch (err) { kit.alertDialog('Trash failed', err.message, 'error'); }
		finally { b.close(); }
	}

	function pickKeeperFor(gid) {
		const survivors = groups.get(gid).filter((m) => !m.checked && !m.gone);
		if (!survivors.length) return null;
		return sel.pickKeeper(survivors, criteria()).keeper;
	}

	async function mergeGroup(gid) {
		const all = groups.get(gid).filter((m) => !m.gone);
		const keeper = sel.pickKeeper(all, criteria()).keeper;
		for (const m of all) m.checked = m !== keeper;
		refresh();
		await trashChecked(true);
	}

	/** Remove ids from the results; returns what was removed (for undo). */
	function removeItems(ids) {
		const set = new Set(ids);
		const removed = items.filter((m) => set.has(m.id));
		items = items.filter((m) => !set.has(m.id));
		// groups with fewer than 2 members left disappear
		const counts = new Map();
		for (const m of items) counts.set(m.groupId, (counts.get(m.groupId) || 0) + 1);
		const dropped = items.filter((m) => counts.get(m.groupId) < 2);
		items = items.filter((m) => counts.get(m.groupId) >= 2);
		app.results.items = items;
		reloadFromItems();
		return { removed, dropped };
	}

	function restoreItems(rec) {
		items = [...items, ...rec.removed, ...rec.dropped];
		app.results.items = items;
		reloadFromItems();
	}

	function reloadFromItems() {
		groups = new Map();
		for (const it of items) { if (!groups.has(it.groupId)) groups.set(it.groupId, []); groups.get(it.groupId).push(it); }
		results.highlightBest(items, prefersLargerSize());
		applyFilter();
		app.saveResults();
		app.updateEngineStatus();
	}

	async function undoLastAction() {
		const a = actionUndo.pop();
		updateUndo();
		if (!a) { kit.toast('Nothing to undo.'); return; }
		const b = kit.busy(`Undo: ${a.label}`);
		try {
			if (a.type === 'trash') {
				await app.eagleData.restore(a.trashed);
				for (const m of a.merges.reverse()) await app.eagleData.revertMerge(m.keeper, m.before);
				await app.engine.call('db.restoreDeleted', { ids: a.trashed.map((i) => i.id) }).catch(() => {});
				restoreItems(a.removed);
				for (const m of a.removed.removed) m.checked = true;
			}
			else if (a.type === 'tags') await app.eagleData.revertTags(a.changed);
			else if (a.type === 'folders') await app.eagleData.revertFolders(a.changed);
			else if (a.type === 'rename') { a.item.name = a.prev; await a.item.save(); a.resultItem.name = a.prev; }
			else if (a.type === 'remove') restoreItems(a.removed);
			else if (a.type === 'exclude') { await app.engine.call('db.exclude', { ids: a.ids, value: false }); restoreItems(a.removed); }
			else if (a.type === 'notAMatch') { await app.engine.call('lists.notAMatch.remove', { index: a.index }); restoreItems(a.removed); }
			app.eagleData.invalidateItems();
			eagleInfo = await app.eagleData.allItems(true);
			refresh();
			kit.toast(`Undone: ${a.label}.`, { kind: 'good' });
		}
		catch (err) { kit.alertDialog('Undo failed', err.message, 'error'); }
		finally { b.close(); }
	}

	async function tagItems(list, tag) {
		const live = list.filter((m) => !m.gone);
		const b = kit.busy('Tagging');
		try {
			const changed = await app.eagleData.addTag(live.map((m) => m.id), tag);
			pushAction({ type: 'tags', label: `Tag ${changed.length} item(s) "${tag}"`, changed });
			eagleInfo = await app.eagleData.allItems(true);
			refresh();
			kit.toast(`Tagged ${changed.length} item(s) "${tag}".`, { kind: 'good', action: { label: 'Undo', onClick: undoLastAction } });
		}
		catch (err) { kit.alertDialog('Tagging failed', err.message, 'error'); }
		finally { b.close(); }
	}

	async function folderAction(list, mode) {
		const folderId = await dialogs.pickFolder(mode === 'move' ? 'Move checked items to folder' : 'Add checked items to folder');
		if (!folderId) return;
		const live = list.filter((m) => !m.gone);
		const b = kit.busy(mode === 'move' ? 'Moving' : 'Adding to folder');
		try {
			const changed = await app.eagleData.setFolders(live.map((m) => m.id), folderId, mode);
			const fname = (app.eagleData.folders.get(folderId) || {}).name || 'folder';
			pushAction({ type: 'folders', label: `${mode === 'move' ? 'Move' : 'Add'} ${changed.length} item(s) to "${fname}"`, changed });
			eagleInfo = await app.eagleData.allItems(true);
			refresh();
			kit.toast(`${changed.length} item(s) ${mode === 'move' ? 'moved' : 'added'} to "${fname}".`, { kind: 'good', action: { label: 'Undo', onClick: undoLastAction } });
		}
		catch (err) { kit.alertDialog('Folder action failed', err.message, 'error'); }
		finally { b.close(); }
	}

	async function exportCopies(list) {
		const r = await eagle.dialog.showOpenDialog({ title: 'Copy files to…', properties: ['openDirectory', 'createDirectory'] });
		if (!r || r.canceled || !r.filePaths.length) return;
		const dest = r.filePaths[0];
		const b = kit.busy('Copying files');
		let n = 0;
		try {
			for (const m of list.filter((x) => !x.gone)) {
				const src = filePath(m);
				let target = path.join(dest, `${m.name}.${m.ext}`);
				let k = 1;
				while (fs.existsSync(target)) target = path.join(dest, `${m.name} (${k++}).${m.ext}`);
				await fs.promises.copyFile(src, target);
				n++;
				b.update(`${n} of ${list.length}`, n / list.length);
			}
			kit.toast(`${n} file(s) copied.`, { kind: 'good', action: { label: 'Show', onClick: () => eagle.shell.openPath(dest) } });
		}
		catch (err) { kit.alertDialog('Copy failed', err.message, 'error'); }
		finally { b.close(); }
	}

	function removeFromList(ids) {
		const removed = removeItems(ids);
		pushAction({ type: 'remove', label: `Remove ${ids.length} item(s) from the list`, removed });
		kit.toast(`${ids.length} item(s) removed from the list.`, { action: { label: 'Undo', onClick: undoLastAction } });
	}

	async function excludeItems(ids) {
		await app.engine.call('db.exclude', { ids, value: true });
		const removed = removeItems(ids);
		pushAction({ type: 'exclude', label: `Exclude ${ids.length} item(s)`, ids, removed });
		kit.toast(`${ids.length} item(s) excluded from future scans (Database → Excluded items to undo later).`, { action: { label: 'Undo', onClick: undoLastAction } });
	}

	async function notAMatch(gids) {
		for (const gid of gids) {
			const ids = groups.get(gid).map((m) => m.id);
			const n = await app.engine.call('lists.notAMatch.add', { ids });
			const removed = removeItems(ids);
			pushAction({ type: 'notAMatch', label: 'Mark group as not a match', index: n - 1, removed });
		}
		kit.toast(`${gids.length} group(s) marked as not a match — they will stay hidden in future scans.`, { action: { label: 'Undo', onClick: undoLastAction } });
	}

	async function dryRunReport(checked) {
		const byGroup = sel.groupsOf(checked);
		const lines = ['Cleanup dry-run report', `Generated ${new Date().toLocaleString()}`, `Library: ${app.eagleData.libraryName}`, ''];
		let total = 0;
		let gi = 0;
		for (const [gid, remove] of byGroup) {
			gi++;
			const keep = groups.get(gid).filter((m) => !m.checked);
			const saved = remove.reduce((a, m) => a + m.size, 0);
			total += saved;
			lines.push(`Group ${gi} — frees ${bytes(saved)}`);
			for (const m of keep) lines.push(`  KEEP    ${m.name}.${m.ext}  ${m.frameSize || ''}  ${bytes(m.size)}  ${date(dateOf(m))}`);
			for (const m of remove) lines.push(`  REMOVE  ${m.name}.${m.ext}  ${m.frameSize || ''}  ${bytes(m.size)}  ${date(dateOf(m))}`);
			if (!keep.length) lines.push('  WARNING: no copy of this content would remain');
			lines.push('');
		}
		lines.push(`Total: ${checked.length} file(s), ${bytes(total)} would be freed.`);
		const r = await eagle.dialog.showSaveDialog({ title: 'Save dry-run report', defaultPath: 'VDF cleanup dry-run.txt', filters: [{ name: 'Text', extensions: ['txt'] }] });
		if (!r || r.canceled || !r.filePath) return;
		fs.writeFileSync(r.filePath, lines.join('\r\n'), 'utf8');
		kit.toast('Report saved.', { kind: 'good', action: { label: 'Open', onClick: () => eagle.shell.openPath(r.filePath) } });
	}

	async function exportResults() {
		const r = await eagle.dialog.showSaveDialog({
			title: 'Export results', defaultPath: `VDF results ${new Date().toISOString().slice(0, 10)}`,
			filters: [{ name: 'JSON', extensions: ['json'] }, { name: 'CSV', extensions: ['csv'] }, { name: 'HTML report', extensions: ['html'] }],
		});
		if (!r || r.canceled || !r.filePath) return;
		const ext = path.extname(r.filePath).toLowerCase();
		const rowsOut = order.flatMap((gid, gi) => groups.get(gid).map((m) => ({ group: gi + 1, ...m, path: filePath(m), folders: (() => { const e = eagleInfo.get(m.id); return e ? app.eagleData.folderPaths(e.folders) : []; })() })));
		if (ext === '.csv') {
			const cols = ['group', 'name', 'ext', 'path', 'folders', 'similarity', 'checked', 'size', 'duration', 'frameSize', 'format', 'bitRateKbs', 'fps', 'audioFormat', 'audioBitRateKbs', 'dateCreated', 'flags', 'partialOffset'];
			const q = (v) => `"${String(Array.isArray(v) ? v.join('; ') : v == null ? '' : v).replace(/"/g, '""')}"`;
			fs.writeFileSync(r.filePath, '﻿' + [cols.join(','), ...rowsOut.map((x) => cols.map((c) => q(x[c])).join(','))].join('\r\n'), 'utf8');
		}
		else if (ext === '.html') fs.writeFileSync(r.filePath, htmlReport(rowsOut), 'utf8');
		else fs.writeFileSync(r.filePath, JSON.stringify({ format: 'vdf-eagle-results', version: 1, library: eagle.library.path, createdAt: app.results.createdAt, settings: app.results.settings, items }, null, 1), 'utf8');
		kit.toast('Results exported.', { kind: 'good', action: { label: 'Open', onClick: () => eagle.shell.openPath(r.filePath) } });
	}

	function htmlReport(rowsOut) {
		const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
		const byG = new Map();
		for (const r of rowsOut) { if (!byG.has(r.group)) byG.set(r.group, []); byG.get(r.group).push(r); }
		let body = '';
		for (const [g, rs] of byG) {
			body += `<h2>Group ${g}</h2><table><tr><th></th><th>Name</th><th>Folders</th><th>Resolution</th><th>Duration</th><th>Format</th><th>Bitrate</th><th>Size</th><th>Similarity</th></tr>`;
			for (const r of rs) {
				const thumb = (thumbs.get(r.id) || [])[0];
				body += `<tr class="${r.checked ? 'chk' : ''}"><td>${thumb ? `<img src="${esc(fileUrl(thumb))}">` : ''}</td><td>${esc(r.name)}.${esc(r.ext)}</td><td>${esc(r.folders.join(', '))}</td><td>${esc(r.frameSize)}</td><td>${r.isImage ? '' : esc(duration(r.duration))}</td><td>${esc(r.format)}</td><td>${r.isImage ? '' : esc(r.bitRateKbs) + ' kb/s'}</td><td>${esc(bytes(r.size))}</td><td>${r.similarity.toFixed(1)}%</td></tr>`;
			}
			body += '</table>';
		}
		return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Duplicate report</title><style>body{font:13px Segoe UI,Arial;background:#1e1f22;color:#e8e8e8;padding:20px}table{border-collapse:collapse;width:100%;margin-bottom:18px}td,th{padding:6px 8px;border-bottom:1px solid #333;text-align:left}th{color:#999;font-weight:500}img{width:96px;height:56px;object-fit:contain;background:#111}tr.chk td{background:rgba(255,80,70,.12);text-decoration:line-through}</style></head><body><h1>Duplicate report — ${esc(app.eagleData.libraryName)}</h1><p>${byG.size} groups · generated ${esc(new Date().toLocaleString())}</p>${body}</body></html>`;
	}

	async function importResults() {
		const r = await eagle.dialog.showOpenDialog({ title: 'Import results', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
		if (!r || r.canceled || !r.filePaths.length) return;
		try {
			const j = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
			if (j.format !== 'vdf-eagle-results' || !Array.isArray(j.items)) throw new Error('This is not a Video Duplicate Finder for Eagle results file.');
			if (j.library && !sameLibrary(j.library, eagle.library.path)) {
				if (!await kit.confirmDialog({ title: 'Different library', message: 'These results were made for another Eagle library. Items that do not exist here will show as deleted. Import anyway?' })) return;
			}
			app.results = { items: j.items, settings: j.settings, createdAt: j.createdAt };
			await app.saveResults();
			app.emit('results', app.results);
		}
		catch (err) { kit.alertDialog('Import failed', err.message, 'error'); }
	}

	async function openItem(m) {
		if (m.gone) return;
		const cmd = custom().openItem;
		if (cmd) runCustom(cmd, [m]);
		else app.eagleData.open(m.id);
	}

	return {
		el,
		async show() {
			offs.push(app.on('results', async () => { collapsed.clear(); focus = { gid: null, idx: 0 }; thumbs.clear(); selUndo.length = 0; await load(); build(); }));
			await load();
			build();
			if (listEl) listEl.focus();
		},
		hide() { offs.forEach((f) => f()); offs = []; hideHoverDiff(); },
		onKey(e) {
			if (!items.length) return false;
			const tag = (e.target && e.target.tagName) || '';
			if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
				if (e.key === 'Escape') { e.target.blur(); return true; }
				return false;
			}
			if (e.ctrlKey && e.key.toLowerCase() === 'z') { undoSelection(); return true; }
			if (e.ctrlKey && e.key.toLowerCase() === 'f') { const i = el.querySelector('.toolbar .search input'); if (i) i.focus(); return true; }
			switch (e.key) {
				case 'ArrowDown': moveFocus(1); return true;
				case 'ArrowUp': moveFocus(-1); return true;
				case 'ArrowRight': case 'n': case 'N': moveGroup(1); return true;
				case 'ArrowLeft': case 'p': case 'P': moveGroup(-1); return true;
				case ' ': { const m = focusedItem(); if (m) applyChanges([[m, !m.checked]], 'Check'); return true; }
				case 'k': case 'K': keepFocusedAndAdvance(); return true;
				case 'Enter': { const m = focusedItem(); if (m) openItem(m); return true; }
				case 'Delete': trashChecked(false); return true;
				case 'c': case 'C': if (focus.gid != null) compare(focus.gid, focusedItem() && focusedItem().id); return true;
				default: return false;
			}
		},
	};
}

module.exports = { create };
