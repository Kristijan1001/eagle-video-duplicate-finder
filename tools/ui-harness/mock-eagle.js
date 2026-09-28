'use strict';
// Stand-in for Eagle's plugin preload (app/js/plugin/api.js) over the fixture library.
// Mirrors the real API's shapes: Item/Folder instances with getters/setters and save(),
// moveToTrash() = isDeleted + save, fields-limited item.get, folder trees, events.
// State lives in memory (and in window.__mock for tests to inspect).

const path = require('path');
const fs = require('fs');
const os = require('os');
const { ipcRenderer } = require('electron');

const root = path.resolve(__dirname, '..', '..');

// Eagle's preload replaces the page's global require (app/js/plugin/api.js, Eagle 4.0 b23):
// 'electron' yields {}, bare names try the plugin's node_modules first.
global.require = (args) => {
	if (args === 'electron') return {};
	if (args === 'fs' || args === 'original-fs') return fs;
	const pluginModulePath = `${window.eagle && window.eagle.plugin && window.eagle.plugin.path}/node_modules/${args}`;
	if (window.eagle && window.eagle.plugin && window.eagle.plugin.path && fs.existsSync(pluginModulePath)) return require(pluginModulePath);
	return require(args);
};

const libraryPath = path.join(root, 'test', 'fixtures', 'library');
const itemsFile = path.join(root, 'test', 'fixtures', 'items.json');

// Folder tree used by the mock library.
const FOLDERS = [
	{ id: 'F_ANIME', name: 'Anime', parent: null, iconColor: 'blue' },
	{ id: 'F_CLIPS', name: 'Clips', parent: 'F_ANIME' },
	{ id: 'F_EDITS', name: 'Edits', parent: 'F_ANIME', iconColor: 'purple' },
	{ id: 'F_GAMES', name: 'Games', parent: null },
	{ id: 'F_PHOTOS', name: 'Photos', parent: null, iconColor: 'green' },
];
function folderFor(name) {
	if (/^A_(zoom|box|flip)/.test(name)) return ['F_EDITS'];
	if (/^A/.test(name)) return ['F_ANIME'];
	if (/^L/.test(name)) return ['F_CLIPS'];
	if (/^[BC]$/.test(name)) return ['F_GAMES'];
	if (/^img/.test(name)) return ['F_PHOTOS'];
	return [];
}

const state = { items: new Map(), selected: [], selectedFolders: [], log: [] };
for (const it of JSON.parse(fs.readFileSync(itemsFile, 'utf8'))) {
	const isImg = /png|jpg/.test(it.ext);
	state.items.set(it.id, {
		id: it.id, name: it.name, ext: it.ext, size: it.size, width: isImg ? 800 : 640, height: isImg ? 600 : 360,
		folders: folderFor(it.name), tags: it.name.startsWith('A') ? ['Anime', 'Favourite'] : [], star: it.name === 'A' ? 5 : 0,
		annotation: '', url: '', isDeleted: false, modificationTime: Date.now() - 86400000 * (it.name.length), lastModified: Date.now(),
		noThumbnail: !fs.existsSync(path.join(libraryPath, 'images', `${it.id}.info`, `${it.name}_thumbnail.png`)),
	});
}
window.__mock = state;

const callbacks = { create: [], run: [], show: [], hide: [], exit: [], theme: [], library: [] };

class Item {
	#o; #dirty = false;
	constructor(o) { this.#o = { ...o }; }
	get id() { return this.#o.id; }
	get name() { return this.#o.name; } set name(v) { if (typeof v !== 'string' || !v) throw new Error('value must be a string.'); this.#o.name = v; }
	get ext() { return this.#o.ext; }
	get width() { return this.#o.width; }
	get height() { return this.#o.height; }
	get url() { return this.#o.url; } set url(v) { this.#o.url = v; }
	get isDeleted() { return this.#o.isDeleted; } set isDeleted(v) { this.#o.isDeleted = v; }
	get annotation() { return this.#o.annotation; } set annotation(v) { this.#o.annotation = v; }
	get tags() { return this.#o.tags; } set tags(v) { if (Array.isArray(v)) this.#o.tags = v; }
	get folders() { return this.#o.folders; } set folders(v) { if (Array.isArray(v)) this.#o.folders = v; }
	get size() { return this.#o.size; }
	get star() { return this.#o.star; } set star(v) { this.#o.star = v; }
	get importedAt() { return this.#o.modificationTime; }
	get modifiedAt() { return this.#o.lastModified; }
	get noThumbnail() { return this.#o.noThumbnail; }
	get filePath() { return path.normalize(`${libraryPath}/images/${this.id}.info/${this.name}.${this.ext}`); }
	get thumbnailPath() { return this.noThumbnail ? this.filePath : path.normalize(`${libraryPath}/images/${this.id}.info/${this.name}_thumbnail.png`); }
	get thumbnailURL() { return require('url').pathToFileURL(this.thumbnailPath).href; }
	async save() {
		// same validation as Eagle's item.save handler
		if (typeof this.#o.name === 'string' && this.#o.name.length > 10000) throw new Error('name too long (max 10000)');
		if (typeof this.#o.annotation === 'string' && this.#o.annotation.length > 10000) throw new Error('annotation too long (max 10000)');
		const cur = state.items.get(this.id);
		const oldFile = path.join(libraryPath, 'images', `${this.id}.info`, `${cur.name}.${cur.ext}`);
		if (cur.name !== this.#o.name) {
			const newFile = path.join(libraryPath, 'images', `${this.id}.info`, `${this.#o.name}.${cur.ext}`);
			if (fs.existsSync(oldFile)) fs.renameSync(oldFile, newFile);
		}
		state.items.set(this.id, { ...cur, name: this.#o.name, tags: [...this.#o.tags], folders: [...this.#o.folders], star: this.#o.star, annotation: this.#o.annotation, url: this.#o.url, isDeleted: this.#o.isDeleted, lastModified: Date.now() });
		state.log.push(['save', this.id, { isDeleted: this.#o.isDeleted, tags: this.#o.tags, folders: this.#o.folders, star: this.#o.star, name: this.#o.name }]);
		await new Promise((r) => setTimeout(r, 5));
		return true;
	}
	async moveToTrash() { if (this.isDeleted) return; this.isDeleted = true; await this.save(); }
	async open() { state.log.push(['open', this.id]); }
}

function itemGet(options = {}) {
	let list = [...state.items.values()].filter((o) => !o.isDeleted);
	if (options.id) list = list.filter((o) => o.id === options.id);
	if (options.ids) list = list.filter((o) => options.ids.includes(o.id));
	if (options.isSelected) list = list.filter((o) => state.selected.includes(o.id));
	return list.map((o) => new Item(o));
}

class Folder {
	constructor(f) { Object.assign(this, f); this.children = FOLDERS.filter((c) => c.parent === f.id).map((c) => new Folder(c)); }
	async open() { state.log.push(['folder.open', this.id]); }
}

window.eagle = {
	onPluginCreate: (cb) => callbacks.create.push(cb),
	onPluginRun: (cb) => callbacks.run.push(cb),
	onPluginShow: (cb) => callbacks.show.push(cb),
	onPluginHide: (cb) => callbacks.hide.push(cb),
	onPluginBeforeExit: (cb) => callbacks.exit.push(cb),
	onThemeChanged: (cb) => callbacks.theme.push(cb),
	onLibraryChanged: (cb) => callbacks.library.push(cb),
	app: { theme: 'GRAY', version: '4.0.0', build: 23, locale: 'en', platform: process.platform, isWindows: process.platform === 'win32', execPath: process.execPath, userDataPath: path.join(os.tmpdir(), 'mock-eagle') },
	library: { path: libraryPath, name: 'Fixtures', info: async () => ({}) },
	plugin: { path: path.join(root, 'plugin') },
	window: {
		minimize: () => ipcRenderer.invoke('harness.window', 'minimize'),
		maximize: () => ipcRenderer.invoke('harness.window', 'maximize'),
		unmaximize: () => ipcRenderer.invoke('harness.window', 'unmaximize'),
		isMaximized: () => ipcRenderer.invoke('harness.window', 'isMaximized'),
		show: () => ipcRenderer.invoke('harness.window', 'show'),
		hide: () => ipcRenderer.invoke('harness.window', 'hide'),
		showInactive: () => ipcRenderer.invoke('harness.window', 'showInactive'),
		setOpacity: (v) => ipcRenderer.invoke('harness.window', 'setOpacity', v),
		isMinimized: () => ipcRenderer.invoke('harness.window', 'isMinimized'),
		isVisible: () => ipcRenderer.invoke('harness.window', 'isVisible'),
		keepAliveTimer: () => ipcRenderer.invoke('harness.window', 'keepAliveTimer'),
		setSize: (w, h) => ipcRenderer.invoke('harness.window', 'setSize', w, h),
	},
	item: {
		get: async (o) => itemGet(o),
		getAll: async () => itemGet({}),
		getById: async (id) => itemGet({ id })[0],
		getByIds: async (ids) => itemGet({ ids }),
		getSelected: async () => itemGet({ isSelected: true }),
		select: async (ids) => { state.selected = [...ids]; state.log.push(['select', ids]); return true; },
		open: async (id, opts) => { state.log.push(['open', id, opts]); return true; },
	},
	folder: {
		getAll: async () => FOLDERS.filter((f) => !f.parent).map((f) => new Folder(f)),
		getSelected: async () => FOLDERS.filter((f) => state.selectedFolders.includes(f.id)).map((f) => new Folder(f)),
		create: async ({ name }) => { const f = { id: `F_${Date.now()}`, name, parent: null }; FOLDERS.push(f); return new Folder(f); },
		createSubfolder: async (parent, { name }) => { const f = { id: `F_${Date.now()}`, name, parent }; FOLDERS.push(f); return new Folder(f); },
		open: async (id) => state.log.push(['folder.open', id]),
	},
	smartFolder: {
		getAll: async () => [{ id: 'SF_VIDEOS', name: 'All MP4', imageCount: 3, children: [], getItems: async () => itemGet({}).filter((i) => i.ext === 'mp4') }],
	},
	tag: {
		get: async () => {
			const counts = new Map();
			for (const o of state.items.values()) for (const t of o.tags) counts.set(t, (counts.get(t) || 0) + 1);
			return [...counts].map(([name, count]) => ({ name, count }));
		},
	},
	extraModule: {
		ffmpeg: {
			// localStorage 'mock.noFFmpeg' = '1' simulates Eagle without its FFmpeg module (survives reloads)
			isInstalled: async () => localStorage.getItem('mock.noFFmpeg') !== '1',
			install: async () => { localStorage.removeItem('mock.noFFmpeg'); state.log.push(['ffmpeg.install']); return true; },
			getPaths: async () => {
				if (localStorage.getItem('mock.noFFmpeg') === '1') return null;
				const d = path.join(process.env.APPDATA || '', 'Eagle', 'Plugins', 'ffmpeg-win-x64');
				return { ffmpeg: path.join(d, 'ffmpeg.exe'), ffprobe: path.join(d, 'ffprobe.exe') };
			},
		},
	},
	dialog: {
		showOpenDialog: async (o) => (window.__dialogAnswers && window.__dialogAnswers.length ? window.__dialogAnswers.shift() : { canceled: true, filePaths: [] }),
		showSaveDialog: async (o) => (window.__dialogAnswers && window.__dialogAnswers.length ? window.__dialogAnswers.shift() : { canceled: true }),
		showMessageBox: async () => ({ response: 0 }),
	},
	shell: {
		openPath: async (p) => state.log.push(['openPath', p]),
		openExternal: async (u) => state.log.push(['openExternal', u]),
		showItemInFolder: async (p) => state.log.push(['showItemInFolder', p]),
		beep: async () => {},
	},
	clipboard: { writeText: (t) => { state.clipboard = t; }, readText: () => state.clipboard || '' },
	notification: { show: async (o) => state.log.push(['notification', o.title, o.body]) },
	drag: { startDrag: async (p) => state.log.push(['drag', p]) },
	log: { debug: console.debug, info: console.info, warn: console.warn, error: console.error },
	contextMenu: { open: () => {} },
};

window.__mockEvents = {
	theme: (t) => { window.eagle.app.theme = t; callbacks.theme.forEach((f) => f(t)); },
	library: (p) => callbacks.library.forEach((f) => f(p)),
};
ipcRenderer.on('plugin-hide', () => callbacks.hide.forEach((f) => f()));
ipcRenderer.on('plugin-show', () => callbacks.show.forEach((f) => f()));

window.addEventListener('DOMContentLoaded', () => {
	setTimeout(() => {
		const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin', 'manifest.json'), 'utf8'));
		callbacks.create.forEach((f) => f({ manifest, path: path.join(root, 'plugin') }));
		callbacks.run.forEach((f) => f());
	}, 100);
});
