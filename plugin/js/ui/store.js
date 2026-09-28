'use strict';
// Where the plugin keeps its data, and the persisted settings.
//
// Data lives outside both the plugin folder (wiped on updates) and the Eagle library (Eagle
// asks plugins not to write there): %LOCALAPPDATA%\VDF for Eagle on Windows,
// ~/Library/Application Support/VDF for Eagle on macOS. Settings are global; fingerprint
// caches are per library. "Custom database folder" moves the caches elsewhere.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const settingsMod = require('../core/settings');

function dataRoot() {
	if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'VDF for Eagle');
	if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'VDF for Eagle');
	return path.join(os.homedir(), '.vdf-for-eagle');
}

// Eagle hands the library path over normalised at start-up but raw on library-changed
// (forward slashes possible), so every key and comparison goes through this.
function normalizeLibraryPath(p) {
	return p ? path.normalize(String(p)).replace(/(.)[\\/]+$/, '$1') : '';
}
function sameLibrary(a, b) {
	return normalizeLibraryPath(a).toLowerCase() === normalizeLibraryPath(b).toLowerCase();
}

function libraryKey(libraryPath) {
	const p = normalizeLibraryPath(libraryPath);
	const base = path.basename(p || 'library').replace(/\.library$/i, '').replace(/[^\w\- ]+/g, '_').slice(0, 40) || 'library';
	const hash = crypto.createHash('sha1').update(p.toLowerCase()).digest('hex').slice(0, 8);
	return `${base}-${hash}`;
}

class Store {
	constructor() {
		this.root = dataRoot();
		fs.mkdirSync(this.root, { recursive: true });
		this.file = path.join(this.root, 'settings.json');
		this.settings = this.load();
		this.saveTimer = null;
		this.listeners = new Set();
	}

	load() {
		try {
			if (fs.existsSync(this.file)) return settingsMod.normalize(JSON.parse(fs.readFileSync(this.file, 'utf8')));
		}
		catch (err) {
			try { fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
		}
		return settingsMod.normalize({});
	}

	save() {
		clearTimeout(this.saveTimer);
		const tmp = `${this.file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(this.settings, null, 1));
		fs.renameSync(tmp, this.file);
	}

	/** Merge a patch into the settings; persisted shortly after. */
	set(patch) {
		this.settings = settingsMod.normalize({ ...this.settings, ...patch });
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => { try { this.save(); } catch { /* disk full etc. */ } }, 400);
		for (const fn of this.listeners) fn(this.settings, patch);
	}

	onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

	cacheRoot() {
		const custom = this.settings.customDatabaseFolder;
		return custom && custom.trim() ? custom.trim() : path.join(this.root, 'libraries');
	}
	cacheDir(libraryPath) { return path.join(this.cacheRoot(), libraryKey(libraryPath)); }
	aiDir() { return path.join(this.root, 'ai'); }
	tempDir() { const d = path.join(os.tmpdir(), 'vdf-for-eagle'); fs.mkdirSync(d, { recursive: true }); return d; }
	undoFile(libraryPath) { return path.join(this.cacheDir(libraryPath), 'undo.json'); }
}

module.exports = { Store, dataRoot, libraryKey, normalizeLibraryPath, sameLibrary };
