'use strict';
// Plugin window bootstrap. Eagle's preload replaces `require` with a resolver rooted in
// Eagle's own folder, so every plugin module is required by absolute path from here.

(function () {
	const path = require('path');
	const ROOT = (() => {
		// Windows pages load from eagleplugin://<id>/C:/..., whose pathname can start with
		// one or two slashes before the drive letter; macOS pages are plain file:// paths.
		let p = decodeURIComponent(location.pathname);
		p = p.replace(/^\/+(?=[A-Za-z]:)/, '');
		return path.dirname(path.normalize(p));
	})();
	const req = (rel) => require(path.join(ROOT, 'js', rel));

	const { h, icon, clear, span, number } = req('ui/dom.js');
	const kit = req('ui/kit.js');
	const { Store, libraryKey, normalizeLibraryPath, sameLibrary } = req('ui/store.js');
	const { EngineClient } = req('ui/engine-client.js');
	const { EagleData } = req('ui/eagle-data.js');
	const settingsMod = req('core/settings.js');

	const app = {
		ROOT, req, kit,
		store: null,
		engine: null,
		eagleData: null,
		views: {},
		current: null,
		logs: [],
		scan: { running: false, progress: null, phasesSeen: [], lastResult: null, startedAt: 0 },
		results: null,           // { items, settings, createdAt, library }
		listeners: new Map(),
		on(ev, fn) { if (!this.listeners.has(ev)) this.listeners.set(ev, new Set()); this.listeners.get(ev).add(fn); return () => this.listeners.get(ev).delete(fn); },
		emit(ev, data) { for (const fn of this.listeners.get(ev) || []) { try { fn(data); } catch (err) { console.error(err); } } },
		log(level, message) {
			const entry = { t: Date.now(), level, message: String(message) };
			this.logs.push(entry);
			if (this.logs.length > 6000) this.logs.splice(0, 1000);
			this.emit('log', entry);
			// Only errors go to Eagle's own log: a big library produces thousands of per-file
			// warnings ("too dark", excluded files), which stay on the plugin's Log page.
			try { if (level === 'error') eagle.log.error(message); } catch { /* ignore */ }
		},
		get settings() { return this.store.settings; },
		setSettings(patch) { this.store.set(patch); },
	};
	window.vdf = app;

	// ── theme ──
	function applyTheme(theme) {
		document.body.dataset.theme = theme || eagle.app.theme || 'GRAY';
	}
	function applyAccessibility() {
		const s = app.settings;
		document.body.classList.toggle('reduce-motion', !!s.alwaysReduceMotion);
		document.body.classList.toggle('high-contrast', !!s.alwaysHighContrast);
		document.body.style.zoom = String((s.uiScalePercent || 100) / 100);
	}

	// ── shell ──
	const NAV = [
		{ key: 'scan', label: 'Scan', icon: 'scan' },
		{ key: 'results', label: 'Results', icon: 'results' },
		{ key: 'settings', label: 'Settings', icon: 'settings' },
		{ key: 'database', label: 'Database', icon: 'database' },
		{ key: 'log', label: 'Log', icon: 'log' },
	];
	const navEls = {};
	let engineStatusEl, titleLibEl, titleStatusEl;

	function buildShell() {
		const root = document.getElementById('app');
		clear(root);
		const maxBtn = h('button', { title: 'Maximize', onclick: async () => {
			if (await eagle.window.isMaximized()) await eagle.window.unmaximize(); else await eagle.window.maximize();
			updateMaxIcon();
		} }, icon('maximize', 14));
		async function updateMaxIcon() {
			const m = await eagle.window.isMaximized();
			clear(maxBtn).appendChild(icon(m ? 'restore' : 'maximize', 14));
			maxBtn.title = m ? 'Restore' : 'Maximize';
		}
		app.updateMaxIcon = updateMaxIcon;
		titleLibEl = h('span.lib');
		titleStatusEl = h('span.status');
		const titlebar = h('header.titlebar',
			h('img.logo', { src: 'logo.png', alt: '' }),
			h('span.title', 'Video Duplicate Finder'),
			titleLibEl,
			h('span.spacer'),
			titleStatusEl,
			h('div.win-btns',
				h('button', { title: 'Minimize', onclick: () => eagle.window.minimize() }, icon('minimize', 14)),
				maxBtn,
				h('button.close', { title: 'Close (scans keep running)', onclick: () => window.close() }, icon('close', 14))));
		titlebar.addEventListener('dblclick', (e) => { if (e.target === titlebar || e.target.classList.contains('spacer')) maxBtn.click(); });

		const sidebar = h('nav.sidebar');
		for (const n of NAV) {
			const badge = h('span.badge', { style: { display: 'none' } });
			const el = h('div.nav-item', { tabindex: 0, onclick: () => navigate(n.key) }, icon(n.icon, 17), h('span', n.label), badge);
			el.badge = badge;
			navEls[n.key] = el;
			sidebar.appendChild(el);
		}
		sidebar.appendChild(h('div.grow'));
		engineStatusEl = h('div.engine');
		sidebar.appendChild(engineStatusEl);

		const view = h('main#view');
		root.append(titlebar, h('div.body', sidebar, view));
		app.viewRoot = view;
		updateTitle();
		updateEngineStatus();
		updateMaxIcon();
	}

	function updateTitle() {
		clear(titleLibEl);
		titleLibEl.append(icon('library', 14), app.eagleData ? app.eagleData.libraryName : '');
	}

	function updateEngineStatus(extra) {
		if (!engineStatusEl) return;
		clear(engineStatusEl);
		const running = app.scan.running;
		const cls = !app.ffmpegOk ? 'bad' : running ? 'busy' : app.engine && app.engine.running ? 'ok' : '';
		engineStatusEl.append(
			h('div.row', h('span.dotmark.' + (cls || 'x')), h('span', !app.ffmpegOk ? 'FFmpeg missing' : running ? (app.scan.progress ? app.scan.progress.label : 'Scanning') : 'Ready')),
			extra ? h('div', extra) : null,
			app.cacheStats ? h('div', `${number(app.cacheStats.fingerprinted)} file(s) fingerprinted`) : null);
		clear(titleStatusEl);
		if (running && app.scan.progress) {
			const p = app.scan.progress;
			titleStatusEl.append(h('span.badge.accent', `${p.label} ${p.total ? Math.floor(100 * p.done / p.total) + '%' : ''}`));
		}
		const rn = app.results ? new Set(app.results.items.map((i) => i.groupId)).size : 0;
		const b = navEls.results && navEls.results.badge;
		if (b) { b.style.display = rn ? '' : 'none'; b.textContent = number(rn); }
	}
	app.updateEngineStatus = updateEngineStatus;

	function navigate(key) {
		if (app.current === key) return;
		const prev = app.views[app.current];
		if (prev && prev.hide) prev.hide();
		app.current = key;
		for (const [k, el] of Object.entries(navEls)) el.classList.toggle('active', k === key);
		const v = app.views[key];
		clear(app.viewRoot);
		app.viewRoot.appendChild(v.el);
		if (v.show) v.show();
	}
	app.navigate = navigate;

	// ── engine ──
	async function ensureFFmpeg() {
		try {
			const ok = await eagle.extraModule.ffmpeg.isInstalled();
			if (!ok) {
				app.ffmpegOk = false;
				updateEngineStatus();
				const go = await kit.confirmDialog({
					title: 'FFmpeg is needed',
					message: 'Video Duplicate Finder reads frames and audio with Eagle\'s official FFmpeg plugin, which is not installed yet.',
					okLabel: 'Install FFmpeg plugin', icon: 'download',
				});
				if (!go) return null;
				await eagle.extraModule.ffmpeg.install();
				if (!await eagle.extraModule.ffmpeg.isInstalled()) return null;
			}
			const paths = await eagle.extraModule.ffmpeg.getPaths();
			app.ffmpegOk = !!(paths && paths.ffmpeg && paths.ffprobe);
			return paths;
		}
		catch (err) {
			app.ffmpegOk = false;
			app.log('error', `FFmpeg check failed: ${err.message}`);
			return null;
		}
	}

	async function initEngine() {
		const paths = await ensureFFmpeg();
		if (!app.engine) {
			app.engine = new EngineClient(ROOT);
			app.engine.on('log', (e) => app.log(e.level, e.message));
			app.engine.on('progress', (p) => {
				app.scan.progress = p;
				if (!app.scan.phasesSeen.includes(p.phase)) app.scan.phasesSeen.push(p.phase);
				app.emit('progress', p);
				updateEngineStatus();
			});
			app.engine.on('aiDownload', (d) => app.emit('aiDownload', d));
			app.engine.on('exit', () => {
				if (app.scan.running) {
					app.scan.running = false;
					app.emit('scanEnded', { error: 'The engine stopped unexpectedly. Your fingerprint cache is safe; start the scan again to continue where it left off.' });
				}
				updateEngineStatus();
			});
		}
		app.engine.start();
		const libPath = eagle.library.path;
		const r = await app.engine.init({
			cacheDir: app.store.cacheDir(libPath),
			aiDir: app.store.aiDir(),
			tempDir: app.store.tempDir(),
			ffmpeg: paths ? paths.ffmpeg : '',
			ffprobe: paths ? paths.ffprobe : '',
		});
		app.log('info', `Engine ready (Node ${r.node}); ${r.entries} cached fingerprint(s) for "${app.eagleData.libraryName}".`);
		refreshCacheStats();
		updateEngineStatus();
		return r;
	}
	app.initEngine = initEngine;

	async function refreshCacheStats() {
		try { app.cacheStats = await app.engine.call('db.stats'); } catch { app.cacheStats = null; }
		updateEngineStatus();
	}
	app.refreshCacheStats = refreshCacheStats;

	// ── results persistence ──
	app.saveResults = async function saveResults() {
		if (!app.results) return;
		const data = {
			version: 1, library: eagle.library.path, createdAt: app.results.createdAt, settings: app.results.settings,
			items: app.results.items.map((i) => ({ ...i, thumbs: undefined })),
		};
		try { await app.engine.call('results.save', { name: 'last', data }); }
		catch (err) { app.log('warn', `Saving results failed: ${err.message}`); }
	};
	async function loadResults() {
		try {
			const data = await app.engine.call('results.load', { name: 'last' });
			if (data && data.items && sameLibrary(data.library, eagle.library.path)) {
				app.results = { items: data.items, settings: data.settings, createdAt: data.createdAt };
				app.emit('results', app.results);
			}
			else { app.results = null; app.emit('results', null); }
		}
		catch { app.results = null; }
		updateEngineStatus();
	}

	// ── scanning ──
	app.startScan = async function startScan({ compareOnly = false, scheduled = false } = {}) {
		if (app.scan.running) return;
		// FFmpeg missing at start-up: once it is there, the engine needs its paths (re-init)
		if (!app.ffmpegOk) { try { await initEngine(); } catch { /* reported below */ } if (!app.ffmpegOk) return; }
		const s = app.settings;
		if (s.filterByFileSize && s.maximumFileSize <= s.minimumFileSize) { await kit.alertDialog('Invalid file size filter', 'The maximum file size must be larger than the minimum.', 'warning'); return; }
		if (s.scopeMode === 'folders' && !(s.scopeFolderIds || []).length) { await kit.alertDialog('No folders selected', 'Pick at least one folder to scan, or choose another scope.', 'warning'); return; }
		if (s.scopeMode === 'smartFolders' && !(s.scopeSmartFolderIds || []).length) { await kit.alertDialog('No smart folders selected', 'Pick at least one smart folder to scan.', 'warning'); return; }
		if (s.scopeMode === 'tags' && !(s.scopeTags || []).length) { await kit.alertDialog('No tags selected', 'Pick at least one tag to scan.', 'warning'); return; }
		if ((s.useAiMatching || s.enableAiPartialDetection) && !(await app.ensureAiModel())) return;

		const scanLibrary = eagle.library.path;
		app.scan = { running: true, progress: { phase: 'enumerate', label: 'Reading library', done: 0, total: 0 }, phasesSeen: ['enumerate'], startedAt: Date.now() };
		app.emit('scanStarted', {});
		app.emit('progress', app.scan.progress);
		updateEngineStatus();
		navigate('scan');
		let scope;
		try {
			scope = await app.eagleData.buildScope(s);
		}
		catch (err) {
			app.scan.running = false;
			app.emit('scanEnded', { error: `Reading the Eagle library failed: ${err.message}` });
			updateEngineStatus();
			return;
		}
		if (!scope.scopeCount) {
			app.scan.running = false;
			app.emit('scanEnded', { error: `Nothing to scan: the scope (${scope.description}) contains no items.` });
			updateEngineStatus();
			return;
		}
		app.log('info', `Scope: ${scope.description} → ${number(scope.scopeCount)} item(s)${s.scanAgainstEntireDatabase ? `, compared against ${number(scope.items.length)} library item(s)` : ''}.`);
		let res;
		try {
			if (!sameLibrary(eagle.library.path, scanLibrary)) throw Object.assign(new Error('library switched'), { switched: true });
			res = await app.engine.call('scan', { settings: s, libraryPath: scanLibrary, items: scope.items, allIds: scope.allIds, compareOnly });
		}
		catch (err) {
			app.scan.running = false;
			app.emit('scanEnded', err.switched ? { aborted: true } : { error: err.message });
			updateEngineStatus();
			return;
		}
		app.scan.running = false;
		refreshCacheStats();
		// a result computed for a library that is no longer open must not land in the new one
		if (res.aborted || !sameLibrary(eagle.library.path, scanLibrary)) { app.emit('scanEnded', { aborted: true }); updateEngineStatus(); return; }
		// freshScan: the Results page runs the after-scan selections (preset, deleted content) once
		app.results = { items: res.items.map((i) => ({ ...i, checked: false })), settings: res.settings, createdAt: Date.now(), freshScan: true };
		await app.saveResults();
		app.emit('results', app.results);
		app.emit('scanEnded', { ok: true, groups: res.groups, items: res.items.length, elapsedMs: res.elapsedMs });
		updateEngineStatus();
		const notify = scheduled ? s.notifyOnScheduledScanComplete : s.notifyOnScanComplete;
		if (notify) {
			try { await eagle.notification.show({ title: 'Duplicate scan finished', body: `${number(res.groups)} group(s) of duplicates found in ${span(res.elapsedMs)}.`, mute: false, duration: 6000 }); } catch { /* ignore */ }
		}
		navigate('results');
	};

	app.stopScan = async () => { try { await app.engine.call('stop'); } catch { /* ignore */ } };
	app.pauseScan = async () => { try { await app.engine.call('pause'); } catch { /* ignore */ } };
	app.resumeScan = async () => { try { await app.engine.call('resume'); } catch { /* ignore */ } };

	// ── AI model consent + download ──
	app.ensureAiModel = async function ensureAiModel() {
		let st;
		try { st = await app.engine.call('ai.status'); } catch (err) { await kit.alertDialog('AI unavailable', err.message, 'error'); return false; }
		if (!st.runtime) { await kit.alertDialog('AI unavailable', 'The AI runtime could not be loaded on this system, so AI matching is not available.', 'error'); return false; }
		if (st.model) return true;
		const ok = await kit.confirmDialog({
			title: 'Download the AI model?',
			icon: 'ai',
			message: 'AI matching compares videos with a DINOv2 vision model that runs entirely on this computer.\n\nThe model (about 23 MB) is downloaded once from the Video Duplicate Finder project on GitHub (fallback: Hugging Face) and verified against a fixed SHA-256 checksum. Nothing from your library is ever uploaded.',
			okLabel: 'Download',
		});
		if (!ok) return false;
		const b = kit.busy('Downloading AI model');
		const off = app.on('aiDownload', (d) => b.update(`${(d.got / 1048576).toFixed(1)} / ${(d.total / 1048576).toFixed(1)} MB`, d.total ? d.got / d.total : null));
		try {
			await app.engine.call('ai.download');
			kit.toast('AI model installed and verified.', { kind: 'good' });
			return true;
		}
		catch (err) {
			await kit.alertDialog('Download failed', err.message, 'error');
			return false;
		}
		finally { off(); b.close(); }
	};

	// ── scheduled scan ──
	let lastScheduledDay = '';
	setInterval(() => {
		const s = app.store && app.settings;
		if (!s || !s.enableScheduledScan || app.scan.running) return;
		const now = new Date();
		const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
		const day = now.toDateString();
		if (hhmm === s.scheduledScanTime && lastScheduledDay !== day) {
			lastScheduledDay = day;
			app.log('info', 'Scheduled scan starting.');
			app.startScan({ scheduled: true });
		}
	}, 20000);

	// ── keyboard ──
	document.addEventListener('keydown', (e) => {
		if (document.querySelector('.modal-back')) return;
		const v = app.views[app.current];
		if (v && v.onKey && v.onKey(e)) { e.preventDefault(); return; }
		if (e.ctrlKey && !e.shiftKey && e.key >= '1' && e.key <= '5') { navigate(NAV[Number(e.key) - 1].key); e.preventDefault(); }
	});

	// ── lifecycle ──
	/** Park the previous library's scan scope and bring back this library's. */
	function syncLibraryScope() {
		const patch = settingsMod.scopeForLibrary(app.settings, libraryKey(eagle.library.path));
		if (patch) app.setSettings(patch);
	}

	async function boot() {
		app.store = new Store();
		eagle.library.path = normalizeLibraryPath(eagle.library.path);
		syncLibraryScope();
		app.eagleData = new EagleData((l, m) => app.log(l, m));
		applyTheme(eagle.app.theme);
		applyAccessibility();
		app.store.onChange(() => applyAccessibility());

		app.views.scan = req('ui/view-scan.js').create(app);
		app.views.results = req('ui/view-results.js').create(app);
		app.views.settings = req('ui/view-settings.js').create(app);
		app.views.database = req('ui/view-database.js').create(app);
		app.views.log = req('ui/view-log.js').create(app);
		buildShell();
		navigate('scan');
		try {
			await app.eagleData.loadFolders();
			app.emit('library', {});
		}
		catch (err) { app.log('warn', `Could not read folders: ${err.message}`); }
		try {
			await initEngine();
			await loadResults();
		}
		catch (err) {
			app.log('error', `Engine start failed: ${err.message}`);
			kit.alertDialog('Engine could not start', `${err.message}\n\nSee the Log page for details.`, 'error');
		}
		updateEngineStatus();
	}

	let created = false;
	eagle.onPluginCreate(() => {
		if (created) return;
		created = true;
		boot().catch((err) => {
			console.error(err);
			document.getElementById('app').textContent = `Video Duplicate Finder failed to start: ${err.message}`;
		});
	});

	eagle.onPluginShow(() => { if (app.updateMaxIcon) app.updateMaxIcon(); });

	// Eagle destroys a hidden keepAlive window five minutes after it was closed, taking the
	// engine (and a running scan) with it. While a scan runs, or a daily scan is scheduled, a
	// closed window therefore comes straight back minimised to the taskbar instead: shown
	// inactive at zero opacity (the 'show' cancels Eagle's timer), then minimised.
	let parking = false;
	let parkedHintShown = false;
	async function parkMinimized() {
		if (parking) return;
		parking = true;
		try {
			await eagle.window.setOpacity(0);
			await eagle.window.showInactive();
			await eagle.window.minimize();
		}
		catch (err) { app.log('warn', `Could not keep the window alive: ${err.message}`); }
		finally {
			try { await eagle.window.setOpacity(1); } catch { /* ignore */ }
			parking = false;
		}
		if (!parkedHintShown) {
			parkedHintShown = true;
			const body = app.scan.running ? 'The scan keeps running, minimised to the taskbar.' : 'Minimised to the taskbar so the daily scan can run.';
			try { await eagle.notification.show({ title: 'Video Duplicate Finder', body, mute: true, duration: 5000 }); } catch { /* ignore */ }
		}
	}
	app.needsToStayAlive = () => !!(app.scan.running || (app.store && app.settings.enableScheduledScan));
	eagle.onPluginHide(() => { if (app.needsToStayAlive()) parkMinimized(); });

	eagle.onThemeChanged((theme) => applyTheme(theme));

	eagle.onLibraryChanged(async () => {
		eagle.library.path = normalizeLibraryPath(eagle.library.path);
		if (!app.store) return;
		if (app.scan.running) {
			await app.stopScan();
			// let the stopped scan unwind before the engine is pointed at the other library
			for (let i = 0; i < 300 && app.scan.running; i++) await new Promise((r) => setTimeout(r, 50));
		}
		syncLibraryScope();
		app.eagleData.invalidateItems();
		updateTitle();
		app.results = null;
		app.emit('results', null);
		try {
			await app.eagleData.loadFolders();
			app.emit('library', {});
			await initEngine();
			await loadResults();
		}
		catch (err) { app.log('error', `Switching library failed: ${err.message}`); }
		updateTitle();
		updateEngineStatus();
	});

	eagle.onPluginBeforeExit(() => {
		try { if (app.store) app.store.save(); } catch { /* ignore */ }
		try { if (app.engine) app.engine.stop(); } catch { /* ignore */ }
	});
})();
