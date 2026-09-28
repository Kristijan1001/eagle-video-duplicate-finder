'use strict';
// Settings page: every VDF setting (plus the Eagle-specific ones), grouped and searchable.

const { h, icon, clear, bytes } = require('./dom');
const settingsMod = require('../core/settings');

function create(app) {
	const kit = app.kit;
	const el = h('div.settings');
	let query = '';
	let aiStatus = null;
	const s = () => app.settings;
	const set = (patch) => app.setSettings(patch);

	const HW = [['none', 'None (CPU)'], ['auto', 'Automatic'], ['cuda', 'NVIDIA CUDA'], ['d3d11va', 'Direct3D 11'], ['dxva2', 'DXVA2'], ['qsv', 'Intel Quick Sync'], ['vulkan', 'Vulkan'], ['videotoolbox', 'VideoToolbox (macOS)']];

	const SECTIONS = [
		{ id: 'scope', title: 'Scope & files', icon: 'folder', rows: [
			{ key: 'includeSubDirectories', label: 'Include subfolders', desc: 'Scanning a folder also scans its subfolders; excluding one also excludes its subfolders.', type: 'switch' },
			{ key: 'includeVideos', label: 'Scan videos', type: 'switch' },
			{ key: 'includeImages', label: 'Scan images', type: 'switch' },
			{ key: 'includeOtherFormatsViaThumbnail', label: 'Other formats by Eagle thumbnail', desc: 'Compare PSD, PDF, 3D and other items through the thumbnail Eagle made for them.', type: 'switch' },
			{ key: 'scanAgainstEntireDatabase', label: 'Compare against the rest of the library', desc: 'Find duplicates of the scoped items anywhere in the library.', type: 'switch' },
			{ key: 'folderMatchMode', label: 'Folder match', desc: 'Only pair items in the same Eagle folder, or only in different folders. Items in several folders count as the same when any folder matches.', type: 'select', options: [['none', 'Any folders'], ['same', 'Same folder only'], ['different', 'Different folders only']] },
			{ key: 'sameFolderDepth', label: 'Folder match depth', desc: 'How many trailing levels of the folder path must be equal (1 = the folder name itself).', type: 'number', min: 1, max: 20 },
			{ key: 'filterByFileSize', label: 'Filter by file size', type: 'switch' },
			{ key: 'minimumFileSize', label: 'Minimum size (MB)', type: 'number', min: 0, max: 999999999, dependsOn: 'filterByFileSize' },
			{ key: 'maximumFileSize', label: 'Maximum size (MB)', type: 'number', min: 0, max: 999999999, dependsOn: 'filterByFileSize' },
			{ key: 'filterByFilePathContains', label: 'Path must contain', desc: 'Wildcards (* ?) matched against "Eagle folder path/name.ext" and the file path.', type: 'switch' },
			{ key: 'filePathContainsTexts', label: 'Required patterns', type: 'list', dependsOn: 'filterByFilePathContains', placeholder: '*Anime*' },
			{ key: 'filterByFilePathNotContains', label: 'Path must not contain', type: 'switch' },
			{ key: 'filePathNotContainsTexts', label: 'Excluded patterns', type: 'list', dependsOn: 'filterByFilePathNotContains', placeholder: '*trailer*' },
			{ key: 'excludeHardLinks', label: 'Exclude hard links', desc: 'Two names for the same data on disk are not reported as duplicates.', type: 'switch' },
			{ key: 'ignoreReparsePoints', label: 'Ignore symbolic links / junctions', type: 'switch' },
			{ key: 'ignoreReadOnlyFolders', label: 'Ignore read-only files', type: 'switch' },
			{ key: 'includeNonExistingFiles', label: 'Include items whose file is missing', desc: 'Compare them using their cached fingerprints.', type: 'switch' },
			{ key: 'rememberDeletedContent', label: 'Remember deleted content', desc: 'Keep the fingerprint of items you trash, so a later re-import of the same content is recognised as "deleted before".', type: 'switch' },
			{ key: 'autoCheckDeletedContentMatches', label: 'Auto-check re-imports of deleted content', type: 'switch', dependsOn: 'rememberDeletedContent' },
			{ key: 'useExifCreationDate', label: 'Use capture date (EXIF / creation_time)', desc: 'Oldest/newest selection and the date column use the date a photo or video was taken.', type: 'switch' },
		] },
		{ id: 'matching', title: 'Matching', icon: 'scan', rows: [
			{ key: '_profile', label: 'Profile', type: 'custom', render: renderProfile },
			{ key: 'percent', label: 'Similarity threshold', desc: 'Minimum similarity for two files to count as duplicates.', type: 'range', min: 50, max: 100, step: 0.5, unit: '%' },
			{ key: '_algo', label: 'Algorithm', desc: 'Grayscale compares pixels, pHash compares frequency patterns. "Both" reports a pair when either matches. Images always use grayscale.', type: 'custom', render: renderAlgo },
			{ key: 'pHashSampleRatioPercent', label: 'pHash: frames that must match', desc: 'Share of the sampled frames that must individually pass (pHash modes).', type: 'range', min: 1, max: 100, step: 1, unit: '%' },
			{ key: 'thumbnails', label: 'Frames sampled per video', desc: 'Evenly spaced, never the first or last frame. Changing it samples the new positions on the next scan; frames already taken are reused.', type: 'number', min: 1, max: 64 },
			{ key: 'maxSamplingDurationSeconds', label: 'Only sample the first … seconds', desc: '0 = the whole video. Useful when copies have different endings.', type: 'number', min: 0, max: 360000 },
			{ key: 'compareHorizontallyFlipped', label: 'Compare mirrored copies', type: 'switch' },
			{ key: 'ignoreBlackPixels', label: 'Ignore black pixels', desc: 'Black borders and letterboxing do not count against a match.', type: 'switch' },
			{ key: 'ignoreWhitePixels', label: 'Ignore white pixels', type: 'switch' },
			{ key: 'percentDurationDifference', label: 'Max duration difference', desc: 'Videos whose durations differ more than this are never compared. 0 = use the seconds bounds as a flat tolerance.', type: 'number', min: 0, max: 100, unit: '%' },
			{ key: 'durationDifferenceMinSeconds', label: 'Duration tolerance at least (s)', type: 'number', min: 0, max: 36000 },
			{ key: 'durationDifferenceMaxSeconds', label: 'Duration tolerance at most (s)', desc: '0 = no cap.', type: 'number', min: 0, max: 36000 },
		] },
		{ id: 'partial', title: 'Partial clips', icon: 'scissors', rows: [
			{ key: 'enablePartialClipDetection', label: 'Find partial clips by audio', desc: 'Finds shorter clips cut out of longer videos. Needs audio in both files; reads each file\'s whole audio track once.', type: 'switch' },
			{ key: 'partialClipMinRatioPercent', label: 'Minimum clip length', desc: 'Clip duration as a share of the source.', type: 'range', min: 1, max: 94, step: 1, unit: '%' },
			{ key: 'partialClipSimilarityThresholdPercent', label: 'Minimum audio similarity', type: 'range', min: 50, max: 100, step: 1, unit: '%' },
			{ key: 'partialClipRequireVisualMatch', label: 'Require visual confirmation', desc: 'Frames at the matched offset must also look alike (drops videos that only share music).', type: 'switch' },
			{ key: 'partialClipVisualThresholdPercent', label: 'Minimum visual similarity', type: 'range', min: 50, max: 100, step: 1, unit: '%', dependsOn: 'partialClipRequireVisualMatch' },
		] },
		{ id: 'ai', title: 'AI matching', icon: 'ai', rows: [
			{ key: '_aimodel', label: 'AI model', type: 'custom', render: renderAiModel },
			{ key: 'useAiMatching', label: 'AI matching (additional pass)', desc: 'Adds pairs the classic comparison misses: cropped, zoomed, colour-graded, heavily edited copies. Never hides classic results.', type: 'switch' },
			{ key: 'aiPercent', label: 'AI similarity threshold', desc: 'Lower to ~92% for more aggressive edits (slightly more false positives).', type: 'range', min: 50, max: 100, step: 0.5, unit: '%' },
			{ key: 'enableAiPartialDetection', label: 'Find partial clips visually (AI)', desc: 'Trimmed or embedded clips without needing audio; keyframes are cached per file.', type: 'switch' },
			{ key: 'aiPartialHitPercent', label: 'AI frame hit threshold', desc: 'At least 4 keyframe hits must agree on one time offset.', type: 'range', min: 70, max: 99, step: 1, unit: '%' },
		] },
		{ id: 'performance', title: 'Performance & FFmpeg', icon: 'cpu', rows: [
			{ key: 'maxDegreeOfParallelism', label: 'Files read at once', desc: '-1 = automatic (hard drives are capped below), 1 = strictly one file at a time.', type: 'number', min: -1, max: 64 },
			{ key: 'hddMaxDegreeOfParallelism', label: 'Cap for hard drives', desc: 'Spinning disks slow down badly when many files are read at once.', type: 'number', min: 1, max: 16 },
			{ key: 'driveTypeOverride', label: 'Library drive type', desc: 'Detected automatically; override if it is wrong.', type: 'select', options: [['auto', 'Detect automatically'], ['ssd', 'SSD / fast'], ['hdd', 'Hard drive / slow']] },
			{ key: 'matchingMaxDegreeOfParallelism', label: 'CPU threads for comparing', desc: '0 = automatic (most cores, leaving some for Eagle).', type: 'number', min: 0, max: 128 },
			{ key: 'hardwareAccelerationMode', label: 'Hardware decoding', desc: 'For a handful of frames per file the CPU is usually fastest.', type: 'select', options: HW },
			{ key: 'customFFArguments', label: 'Custom FFmpeg arguments', desc: 'Advanced. A -vf filter is applied before scaling to 32×32 (e.g. -vf crop=iw*0.8:ih*0.8). Changing it does not re-sample cached frames — clear the cache to apply it everywhere.', type: 'text', placeholder: '-vf crop=iw*0.9:ih*0.9' },
			{ key: 'alwaysRetryFailedSampling', label: 'Always retry files that failed before', type: 'switch' },
			{ key: 'extendedFFToolsLogging', label: 'Detailed FFmpeg logging', type: 'switch' },
			{ key: 'logExcludedFiles', label: 'Log excluded files', type: 'switch' },
		] },
		{ id: 'results', title: 'Results', icon: 'results', rows: [
			{ key: 'generatePreviewThumbnails', label: 'Show the sampled frames', desc: 'Frames are extracted when you view the results and cached.', type: 'switch' },
			{ key: 'thumbnailMaxWidth', label: 'Frame thumbnail width (px)', type: 'number', min: 64, max: 640 },
			{ key: 'showDurationColumn', label: 'Duration column', type: 'switch' },
			{ key: 'showFormatColumn', label: 'Format column', type: 'switch' },
			{ key: 'showBitrateColumn', label: 'Bitrate column', type: 'switch' },
			{ key: 'showLanguagesColumn', label: 'Languages column', type: 'switch' },
			{ key: 'showSizeDateColumn', label: 'Size · date column', type: 'switch' },
			{ key: 'resultsShowDateModified', label: 'Show file modified date', desc: 'Instead of the import (or capture) date. Also drives oldest/newest selection.', type: 'switch' },
			{ key: 'thumbnailDoubleClickAction', label: 'Double-click on a result', type: 'select', options: [['OpenFile', 'Open in Eagle'], ['OpenThumbnailComparer', 'Open Compare']] },
			{ key: 'autoApplySelectionPreset', label: 'After each scan, apply a custom selection preset', desc: 'Checks copies automatically with a preset saved in Select → Custom selection. Nothing is trashed until you press Trash checked.', type: 'select',
				options: () => [['', 'Off'], ...(s().customSelectionPresets || []).map((p) => [p.name, p.name])], alsoSet: (v) => ({ autoApplySelectionPresetEnabled: !!v }) },
			{ key: 'backupAfterListChanged', label: 'Save the list after every change', desc: 'Results and check marks survive closing the plugin.', type: 'switch' },
			{ key: 'duplicateTag', label: 'Tag used by "Tag checked"', type: 'text', placeholder: 'Duplicate' },
		] },
		{ id: 'eagle', title: 'Merge into keeper', icon: 'merge', rows: [
			{ key: 'mergeTags', label: 'Merge tags', desc: 'When trashing duplicates with "merge first", the copy that stays receives these from the trashed copies.', type: 'switch' },
			{ key: 'mergeFolders', label: 'Merge folders', type: 'switch' },
			{ key: 'mergeRating', label: 'Keep the highest rating', type: 'switch' },
			{ key: 'mergeAnnotation', label: 'Join annotations', type: 'switch' },
			{ key: 'mergeUrl', label: 'Take a source URL when the keeper has none', type: 'switch' },
		] },
		{ id: 'commands', title: 'Custom commands', icon: 'bolt', rows: [
			{ key: '_cmd', label: 'Open with a custom program', desc: 'Templates: %1 = the file, %* = all files (quoted), %d = folder of the first file. Example: "C:\\Tools\\mpv\\mpv.exe" %1', type: 'custom', render: renderCommands },
		] },
		{ id: 'automation', title: 'Automation', icon: 'clock', rows: [
			{ key: 'enableScheduledScan', label: 'Daily scheduled scan', desc: 'Runs while Eagle is open. With this on, closing the plugin window minimises it to the taskbar instead, so the schedule can run.', type: 'switch' },
			{ key: 'scheduledScanTime', label: 'Time', type: 'time', dependsOn: 'enableScheduledScan' },
			{ key: 'notifyOnScheduledScanComplete', label: 'Notify when a scheduled scan finishes', type: 'switch' },
			{ key: 'notifyOnScanComplete', label: 'Notify when any scan finishes', type: 'switch' },
		] },
		{ id: 'storage', title: 'Storage', icon: 'database', rows: [
			{ key: '_storage', label: 'Data folder', type: 'custom', render: renderStorage },
			{ key: 'customDatabaseFolder', label: 'Custom cache folder', desc: 'Where fingerprint caches are kept (one subfolder per library). Empty = the data folder above.', type: 'folder' },
			{ key: 'databaseCheckpointIntervalMinutes', label: 'Save progress every … minutes', desc: 'During long scans. 0 = only at the end of each phase.', type: 'number', min: 0, max: 240 },
		] },
		{ id: 'appearance', title: 'Appearance', icon: 'eye', rows: [
			{ key: 'uiScalePercent', label: 'Interface scale', type: 'range', min: 80, max: 150, step: 5, unit: '%' },
			{ key: 'alwaysReduceMotion', label: 'Reduce motion', type: 'switch' },
			{ key: 'alwaysHighContrast', label: 'High contrast', type: 'switch' },
			{ key: '_keys', label: 'Keyboard shortcuts', type: 'custom', render: renderKeys },
		] },
		{ id: 'about', title: 'About', icon: 'info', rows: [
			{ key: '_about', label: 'Video Duplicate Finder for Eagle', type: 'custom', render: renderAbout },
		] },
	];

	let renderedQuery = null;
	function render() {
		// Changing a setting re-renders the page: stay where the user was (a new search starts at the top).
		const prevMain = el.querySelector('.settings-main');
		const keepTop = prevMain && renderedQuery === query ? prevMain.scrollTop : 0;
		renderedQuery = query;
		renderPage();
		const main = el.querySelector('.settings-main');
		if (main && keepTop) main.scrollTop = keepTop;
	}

	function renderPage() {
		clear(el);
		const nav = h('div.settings-nav',
			h('div.search', { style: { margin: '0 4px 10px' } }, icon('search', 14), h('input.input', {
				placeholder: 'Search settings', value: query, style: { width: '100%' },
				oninput: (e) => { query = e.target.value; const pos = e.target.selectionStart; render(); const i = el.querySelector('.settings-nav input'); i.focus(); i.setSelectionRange(pos, pos); },
			})),
			SECTIONS.map((sec) => h('div.nav-item', { onclick: () => { const t = el.querySelector(`#set-${sec.id}`); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, icon(sec.icon, 15), sec.title)),
			h('div', { style: { height: '12px' } }),
			h('div.nav-item', { onclick: resetAll }, icon('refresh', 15), 'Reset to defaults'));
		const main = h('div.settings-main');
		const q = query.trim().toLowerCase();
		for (const sec of SECTIONS) {
			const rows = sec.rows.filter((r) => !q || `${r.label} ${r.desc || ''} ${sec.title}`.toLowerCase().includes(q));
			if (!rows.length) continue;
			const secEl = h('div.set-section', { id: `set-${sec.id}` }, h('h2', sec.title));
			for (const r of rows) secEl.appendChild(renderRow(r));
			main.appendChild(secEl);
		}
		if (!main.childNodes.length) main.appendChild(h('div.empty', icon('search', 36), h('div', 'No setting matches your search.')));
		el.append(nav, main);
	}

	function renderRow(r) {
		const S = s();
		const disabled = r.dependsOn && !S[r.dependsOn];
		const row = h('div.set-row', { style: disabled ? { opacity: 0.5 } : null }, h('div.l', h('div.n', r.label), r.desc ? h('div.d', r.desc) : null));
		const right = h('div.r');
		switch (r.type) {
			case 'switch': {
				const cb = h('input', { type: 'checkbox' });
				cb.checked = !!S[r.key];
				cb.addEventListener('change', () => { set({ [r.key]: cb.checked }); render(); });
				right.appendChild(h('label.switch', cb, h('span.track')));
				break;
			}
			case 'number': {
				const i = h('input.input.num', { type: 'number', min: r.min, max: r.max, value: S[r.key] });
				i.addEventListener('change', () => { let v = Number(i.value); if (!Number.isFinite(v)) v = settingsMod.DEFAULTS[r.key]; v = Math.min(r.max, Math.max(r.min, v)); set({ [r.key]: v }); i.value = v; });
				right.append(i, r.unit ? h('span.muted', r.unit) : null);
				break;
			}
			case 'range': {
				const val = h('span.val', `${S[r.key]}${r.unit || ''}`);
				const i = h('input', { type: 'range', min: r.min, max: r.max, step: r.step, value: S[r.key], style: { width: '200px', accentColor: 'var(--accent)' } });
				i.addEventListener('input', () => { val.textContent = `${i.value}${r.unit || ''}`; });
				i.addEventListener('change', () => set({ [r.key]: Number(i.value) }));
				right.append(h('div.range', i, val));
				break;
			}
			case 'select': {
				const opts = typeof r.options === 'function' ? r.options() : r.options;
				const sl = h('select.select', opts.map(([v, l]) => h('option', { value: v }, l)));
				sl.value = S[r.key];
				sl.addEventListener('change', () => { set({ [r.key]: sl.value, ...(r.alsoSet ? r.alsoSet(sl.value) : {}) }); render(); });
				right.appendChild(sl);
				break;
			}
			case 'text': {
				const i = h('input.input', { value: S[r.key] || '', placeholder: r.placeholder || '', style: { width: '320px' } });
				i.addEventListener('change', () => set({ [r.key]: i.value }));
				right.appendChild(i);
				break;
			}
			case 'time': {
				const i = h('input.input', { type: 'time', value: S[r.key] });
				i.addEventListener('change', () => set({ [r.key]: i.value || '02:00' }));
				right.appendChild(i);
				break;
			}
			case 'folder': {
				const i = h('input.input', { value: S[r.key] || '', placeholder: 'Default', style: { width: '300px' }, readonly: true });
				right.append(i,
					h('button.btn', { onclick: async () => {
						const res = await eagle.dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
						if (res && !res.canceled && res.filePaths[0]) { set({ [r.key]: res.filePaths[0] }); await reinit(); render(); }
					} }, 'Browse'),
					S[r.key] ? h('button.btn.ghost', { onclick: async () => { set({ [r.key]: '' }); await reinit(); render(); } }, 'Reset') : null);
				break;
			}
			case 'list': {
				const list = S[r.key] || [];
				const input = h('input.input', { placeholder: r.placeholder || '', style: { width: '200px' } });
				const add = () => { const v = input.value.trim(); if (v && !list.includes(v)) { set({ [r.key]: [...list, v] }); render(); } };
				input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
				row.querySelector('.l').appendChild(h('div.tags-edit', { style: { marginTop: '6px' } }, list.map((p) => h('span.tg', p, h('button', { onclick: () => { set({ [r.key]: list.filter((x) => x !== p) }); render(); } }, icon('close', 11))))));
				right.append(input, h('button.btn', { onclick: add }, 'Add'));
				break;
			}
			case 'custom':
				right.appendChild(r.render(row));
				break;
			default: break;
		}
		row.appendChild(right);
		return row;
	}

	function renderProfile() {
		const active = settingsMod.activeProfile(s());
		const sl = h('select.select', [['ExactAndNear', 'Exact & near copies'], ['EditedAndAltered', 'Edited & altered'], ['AiScan', 'AI scan'], ['DeepClean', 'Deep clean'], ['Custom', 'Custom']].map(([v, l]) => h('option', { value: v }, l)));
		sl.value = active;
		sl.addEventListener('change', () => { set(settingsMod.applyProfile(s(), sl.value)); render(); });
		return sl;
	}
	function renderAlgo() {
		const v = s().combineGrayPHash ? 'both' : s().usePHash ? 'phash' : 'gray';
		return h('div.seg', [['gray', 'Grayscale'], ['phash', 'pHash'], ['both', 'Both']].map(([k, l]) => h(`button${k === v ? '.on' : ''}`, { onclick: () => { set({ usePHash: k === 'phash', combineGrayPHash: k === 'both' }); render(); } }, l)));
	}
	function renderAiModel() {
		const box = h('div.row');
		if (!aiStatus) {
			box.appendChild(h('span.muted', 'Checking…'));
			app.engine.call('ai.status').then((st) => { aiStatus = st; render(); }).catch((err) => { aiStatus = { error: err.message }; render(); });
			return box;
		}
		if (aiStatus.error || !aiStatus.runtime) { box.appendChild(h('span.badge.bad', 'AI runtime unavailable')); return box; }
		if (aiStatus.model) {
			box.append(h('span.badge.good', icon('check', 11), 'Installed and verified'),
				h('button.btn.small.ghost', { onclick: async () => { if (await kit.confirmDialog({ title: 'Remove the AI model?', message: 'AI matching will ask to download it again when needed.', okLabel: 'Remove' })) { await app.engine.call('ai.remove'); aiStatus = null; render(); } } }, 'Remove'));
		}
		else {
			box.append(h('span.badge', 'Not installed (~23 MB)'),
				h('button.btn.small.primary', { onclick: async () => { if (await app.ensureAiModel()) { aiStatus = null; render(); } } }, icon('download', 13), 'Download'));
		}
		return box;
	}
	function renderCommands() {
		const c = s().customCommands || {};
		const field = (k, label) => {
			const i = h('input.input', { value: c[k] || '', placeholder: label, style: { width: '420px' } });
			i.addEventListener('change', () => set({ customCommands: { ...s().customCommands, [k]: i.value } }));
			return h('div.col', { style: { gap: '2px' } }, h('span.faint.small', label), i);
		};
		return h('div.col', field('openItem', 'Open one item'), field('openMultiple', 'Open several items'), field('openItemInFolder', 'Show one item'), field('openMultipleInFolder', 'Show several items'));
	}
	function renderStorage() {
		const root = app.store.root;
		const size = app.cacheStats ? bytes(app.cacheStats.bytes) : '…';
		return h('div.row', h('span.mono.small.faint', { title: root }, root), h('span.badge', `this library: ${size}`),
			h('button.btn.small', { onclick: () => eagle.shell.openPath(root) }, icon('folderOpen', 13), 'Open'));
	}
	function renderKeys() {
		const keys = [['↑ / ↓', 'Move between files'], ['← / → or P / N', 'Previous / next group'], ['Space', 'Check / uncheck'], ['K', 'Keep this copy, check the rest, next group'], ['Enter', 'Open (or custom command)'], ['C', 'Compare the group (play, step frames, keep/check)'], ['Del', 'Trash checked (asks first)'], ['Ctrl+Z', 'Undo selection'], ['Ctrl+F', 'Filter'], ['Ctrl+1…5', 'Switch page'], ['Ctrl+Enter', 'Start scan (Scan page)']];
		return h('div.kv', { style: { gridTemplateColumns: '130px 1fr' } }, keys.flatMap(([k, d]) => [h('div.mono.small', k), h('div.small.muted', d)]));
	}
	function renderAbout() {
		let version = '';
		try { version = require(require('path').join(app.ROOT, 'manifest.json')).version; } catch { /* ignore */ }
		return h('div.col', { style: { maxWidth: '520px', gap: '6px' } },
			h('div', `Version ${version} · by Kristijan1001`),
			h('div.muted.small', 'A port of Video Duplicate Finder by 0x90d (github.com/0x90d/videoduplicatefinder), licensed AGPL-3.0 like the original. Its matching engine (gray-frame and pHash comparison, group validation, audio partial-clip detection and DINOv2 AI matching) is ported from VDF and runs on Eagle\'s own runtime.'),
			h('div.muted.small', 'Everything runs on this computer. The only network access is the one-time AI model download, which you are asked about first.'),
			h('div.row', { style: { gap: '8px' } },
				h('button.btn.small', { onclick: () => eagle.shell.openExternal('https://github.com/Kristijan1001/eagle-video-duplicate-finder') }, icon('link', 13), 'Source & support'),
				h('button.btn.small', { onclick: () => eagle.shell.openExternal('https://github.com/0x90d/videoduplicatefinder') }, icon('link', 13), 'VDF on GitHub')));
	}

	async function reinit() {
		try { await app.initEngine(); } catch (err) { kit.alertDialog('Cache folder', err.message, 'error'); }
	}

	async function resetAll() {
		if (!await kit.confirmDialog({ title: 'Reset all settings?', message: 'Every setting returns to its default. Your scan scopes, presets, expression history, results and fingerprint caches are kept.', okLabel: 'Reset', danger: true })) return;
		const KEEP = [...settingsMod.LIBRARY_SCOPED_KEYS, 'scopeLibraryKey', 'libraryScopes', 'customDatabaseFolder',
			'expressionHistory', 'expressionPresets', 'customSelectionPresets', 'lastCustomSelectExpression'];
		const cur = s();
		const defaults = settingsMod.normalize({});
		app.setSettings({ ...defaults, ...Object.fromEntries(KEEP.map((k) => [k, cur[k]])) });
		app.store.save();
		render();
	}

	return { el, show() { aiStatus = null; render(); }, hide() {} };
}

module.exports = { create };
