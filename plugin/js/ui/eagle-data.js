'use strict';
// Everything that talks to Eagle's plugin API: library structure for the scope picker, item
// enumeration for a scan, and the actions on results. All changes go through the API's own
// save()/moveToTrash() — metadata.json and library files are never touched directly.

const path = require('path');

const ITEM_FIELDS = ['id', 'name', 'ext', 'width', 'height', 'size', 'folders', 'tags', 'star', 'modificationTime', 'lastModified', 'url', 'annotation', 'noThumbnail'];
const MAX_ANNOTATION = 10000; // item.save limit in Eagle 4 (MAX_STRING_LENGTH)

class EagleData {
	constructor(log) {
		this.log = log || (() => {});
		this.folders = new Map();     // id → {id, name, parent, children:[ids], path, depth, iconColor}
		this.roots = [];
		this.smartFolders = [];
		this.itemCache = null;        // Map id → plain item
		this.itemCacheTime = 0;
	}

	get libraryPath() { return eagle.library.path; }
	get libraryName() {
		const p = eagle.library.path || '';
		return path.basename(p).replace(/\.library$/i, '') || 'Library';
	}

	// ── folders ──
	async loadFolders() {
		const all = await eagle.folder.getAll();
		this.folders.clear();
		this.roots = [];
		const visit = (f, parent, depth, parentPath) => {
			if (!f || !f.id || this.folders.has(f.id)) return;
			const node = {
				id: f.id, name: f.name || '(unnamed)', parent, depth, children: [],
				path: parentPath ? `${parentPath}/${f.name}` : f.name, iconColor: f.iconColor || '',
			};
			this.folders.set(f.id, node);
			if (parent && this.folders.has(parent)) this.folders.get(parent).children.push(f.id);
			else this.roots.push(f.id);
			for (const c of f.children || []) visit(c, f.id, depth + 1, node.path);
		};
		// getAll may return a tree or a flat list: visit roots first, then anything left.
		for (const f of all) if (!f.parent) visit(f, null, 0, '');
		for (const f of all) if (!this.folders.has(f.id)) {
			const parent = f.parent && this.folders.has(f.parent) ? f.parent : null;
			visit(f, parent, parent ? this.folders.get(parent).depth + 1 : 0, parent ? this.folders.get(parent).path : '');
		}
		return this.folders;
	}

	/** Folder ids plus (optionally) all their descendants. */
	expandFolders(ids, withSubfolders) {
		const out = new Set();
		const walk = (id) => {
			if (out.has(id)) return;
			out.add(id);
			if (!withSubfolders) return;
			const n = this.folders.get(id);
			if (n) for (const c of n.children) walk(c);
		};
		for (const id of ids || []) walk(id);
		return out;
	}

	folderPaths(folderIds) {
		return (folderIds || []).map((id) => (this.folders.get(id) || {}).path).filter(Boolean);
	}

	async loadSmartFolders() {
		try {
			const list = eagle.smartFolder ? await eagle.smartFolder.getAll() : [];
			const flat = [];
			const visit = (sf, depth) => { flat.push({ id: sf.id, name: sf.name, depth, count: sf.imageCount || 0, ref: sf }); for (const c of sf.children || []) visit(c, depth + 1); };
			for (const sf of list) visit(sf, 0);
			this.smartFolders = flat;
		}
		catch (err) {
			this.log('warn', `Smart folders are unavailable: ${err.message}`);
			this.smartFolders = [];
		}
		return this.smartFolders;
	}

	async loadTags() {
		try {
			const tags = await eagle.tag.get();
			return tags.map((t) => ({ name: t.name, count: t.count || 0 })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
		}
		catch { return []; }
	}

	// ── items ──

	static plain(it) {
		return {
			id: it.id, name: it.name, ext: it.ext, width: it.width || 0, height: it.height || 0, size: it.size || 0,
			folders: it.folders || [], tags: it.tags || [], star: it.star || 0, importedAt: it.importedAt || 0,
			modifiedAt: it.modifiedAt || 0, url: it.url || '', annotation: it.annotation || '', noThumbnail: !!it.noThumbnail,
		};
	}

	/** Every item of the library as plain objects (fields-limited query, cached briefly). */
	async allItems(force = false) {
		if (!force && this.itemCache && Date.now() - this.itemCacheTime < 5000) return this.itemCache;
		const items = await eagle.item.get({ fields: ITEM_FIELDS });
		const map = new Map();
		for (const it of items) map.set(it.id, EagleData.plain(it));
		this.itemCache = map;
		this.itemCacheTime = Date.now();
		return map;
	}

	invalidateItems() { this.itemCache = null; }

	async selectedIds() {
		const sel = await eagle.item.get({ isSelected: true, fields: ['id'] });
		return sel.map((i) => i.id);
	}

	async selectedFolderIds() {
		try { return (await eagle.folder.getSelected()).map((f) => f.id); } catch { return []; }
	}

	/**
	 * Build the scan request item list for the current scope settings.
	 * Returns { items: [...with inScope + folders(paths)], allIds, scopeCount, description }.
	 */
	async buildScope(s) {
		await this.loadFolders();
		const all = await this.allItems(true);
		const allIds = [...all.keys()];
		const excludedFolders = this.expandFolders(s.excludeFolderIds, s.includeSubDirectories);
		const excludedTags = new Set((s.excludeTags || []).map((t) => t.toLowerCase()));
		const isExcluded = (it) => it.folders.some((f) => excludedFolders.has(f)) || it.tags.some((t) => excludedTags.has(String(t).toLowerCase()));

		let inScope;
		let description;
		switch (s.scopeMode) {
			case 'selection': {
				const ids = new Set(await this.selectedIds());
				inScope = (it) => ids.has(it.id);
				description = `${ids.size} selected item(s)`;
				break;
			}
			case 'folders': {
				const set = this.expandFolders(s.scopeFolderIds, s.includeSubDirectories);
				inScope = (it) => it.folders.some((f) => set.has(f));
				description = `${(s.scopeFolderIds || []).length} folder(s)${s.includeSubDirectories ? ' incl. subfolders' : ''}`;
				break;
			}
			case 'smartFolders': {
				const ids = new Set();
				if (!this.smartFolders.length) await this.loadSmartFolders();
				for (const sfId of s.scopeSmartFolderIds || []) {
					const sf = this.smartFolders.find((x) => x.id === sfId);
					if (!sf) continue;
					try { for (const it of await sf.ref.getItems({ fields: ['id'] })) ids.add(it.id); }
					catch (err) { this.log('warn', `Smart folder "${sf.name}" could not be read: ${err.message}`); }
				}
				inScope = (it) => ids.has(it.id);
				description = `${(s.scopeSmartFolderIds || []).length} smart folder(s)`;
				break;
			}
			case 'tags': {
				const tags = (s.scopeTags || []).map((t) => t.toLowerCase());
				inScope = s.scopeTagsMatchAll
					? (it) => tags.length && tags.every((t) => it.tags.some((x) => String(x).toLowerCase() === t))
					: (it) => it.tags.some((x) => tags.includes(String(x).toLowerCase()));
				description = `tag(s): ${(s.scopeTags || []).join(', ')}`;
				break;
			}
			default:
				inScope = () => true;
				description = 'whole library';
		}

		const items = [];
		let scopeCount = 0;
		for (const it of all.values()) {
			if (isExcluded(it)) continue;
			const scoped = !!inScope(it);
			if (!scoped && !s.scanAgainstEntireDatabase) continue;
			if (scoped) scopeCount++;
			items.push({
				id: it.id, name: it.name, ext: it.ext, size: it.size, width: it.width, height: it.height,
				folders: this.folderPaths(it.folders), importedAt: it.importedAt, inScope: scoped,
			});
		}
		return { items, allIds, scopeCount, description };
	}

	filePath(it) { return path.join(this.libraryPath, 'images', `${it.id}.info`, `${it.name}.${it.ext}`); }
	thumbnailPath(it) {
		if (it.noThumbnail) return this.filePath(it);
		return path.join(this.libraryPath, 'images', `${it.id}.info`, `${it.name}_thumbnail.png`);
	}

	// ── actions ──

	async itemsByIds(ids) {
		const out = [];
		for (let i = 0; i < ids.length; i += 400) out.push(...await eagle.item.getByIds(ids.slice(i, i + 400)));
		return out;
	}

	/** Move to Eagle's trash. Returns the Item instances (kept for undo). */
	async trash(ids, onProgress) {
		const items = await this.itemsByIds(ids);
		const done = [];
		for (const it of items) {
			try { await it.moveToTrash(); done.push(it); }
			catch (err) { this.log('error', `Could not move "${it.name}" to the trash: ${err && err.message || err}`); }
			onProgress && onProgress(done.length, items.length);
		}
		this.invalidateItems();
		return done;
	}

	/** Undo a trash: clear the deleted flag on the same items. */
	async restore(itemInstances) {
		let n = 0;
		for (const it of itemInstances) {
			try { it.isDeleted = false; await it.save(); n++; }
			catch (err) { this.log('error', `Could not restore "${it.name}": ${err && err.message || err}`); }
		}
		this.invalidateItems();
		return n;
	}

	/**
	 * Merge duplicates' organisation into the keeper: tags ∪, folders ∪, highest rating,
	 * annotations joined, URL kept (or taken from a duplicate). Returns the keeper's previous
	 * values for undo.
	 */
	async mergeInto(keeperId, otherIds, opts) {
		const [keeper] = await this.itemsByIds([keeperId]);
		const others = await this.itemsByIds(otherIds);
		if (!keeper) throw new Error('The item to keep no longer exists.');
		const before = { tags: [...(keeper.tags || [])], folders: [...(keeper.folders || [])], star: keeper.star || 0, annotation: keeper.annotation || '', url: keeper.url || '' };
		if (opts.mergeTags) keeper.tags = unique([...(keeper.tags || []), ...others.flatMap((o) => o.tags || [])]);
		if (opts.mergeFolders) keeper.folders = unique([...(keeper.folders || []), ...others.flatMap((o) => o.folders || [])]);
		if (opts.mergeRating) {
			const best = Math.max(keeper.star || 0, ...others.map((o) => o.star || 0));
			if (best !== (keeper.star || 0)) keeper.star = best;
		}
		if (opts.mergeAnnotation) {
			const notes = unique([keeper.annotation || '', ...others.map((o) => o.annotation || '')].map((x) => x.trim()).filter(Boolean));
			// Eagle's item.save rejects annotations over 10,000 characters: keep whole notes that fit
			let joined = '';
			let kept = 0;
			for (const n of notes) {
				const next = joined ? `${joined}\n\n${n}` : n;
				if (next.length > MAX_ANNOTATION) break;
				joined = next;
				kept++;
			}
			if (kept < notes.length) this.log('warn', `"${keeper.name}": ${notes.length - kept} annotation(s) not merged — Eagle allows ${MAX_ANNOTATION} characters per note.`);
			if (joined !== (keeper.annotation || '')) keeper.annotation = joined;
		}
		if (opts.mergeUrl && !keeper.url) {
			const u = others.map((o) => o.url).find(Boolean);
			if (u) { try { keeper.url = u; } catch { /* invalid url format */ } }
		}
		await keeper.save();
		this.invalidateItems();
		return { keeper, before };
	}

	async revertMerge(keeper, before) {
		keeper.tags = before.tags;
		keeper.folders = before.folders;
		keeper.star = before.star;
		keeper.annotation = before.annotation;
		try { keeper.url = before.url; } catch { /* ignore */ }
		await keeper.save();
		this.invalidateItems();
	}

	async addTag(ids, tag) {
		const items = await this.itemsByIds(ids);
		const changed = [];
		for (const it of items) {
			if ((it.tags || []).includes(tag)) continue;
			const prev = [...(it.tags || [])];
			it.tags = [...prev, tag];
			await it.save();
			changed.push({ item: it, prev });
		}
		this.invalidateItems();
		return changed;
	}

	/** 'move' replaces each item's folders with [folderId]; 'add' keeps them. Only `ids` are touched. */
	async setFolders(ids, folderId, mode) {
		const items = await this.itemsByIds(ids);
		const changed = [];
		for (const it of items) {
			const prev = [...(it.folders || [])];
			const next = mode === 'move' ? [folderId] : unique([...prev, folderId]);
			if (next.length === prev.length && next.every((f, i) => f === prev[i])) continue; // already there
			it.folders = next;
			await it.save();
			changed.push({ item: it, prev });
		}
		this.invalidateItems();
		return changed;
	}

	async revertFolders(changed) { for (const c of changed) { c.item.folders = c.prev; await c.item.save(); } this.invalidateItems(); }
	async revertTags(changed) { for (const c of changed) { c.item.tags = c.prev; await c.item.save(); } this.invalidateItems(); }

	async rename(id, name) {
		const [it] = await this.itemsByIds([id]);
		if (!it) throw new Error('Item not found');
		const prev = it.name;
		it.name = name;
		await it.save();
		this.invalidateItems();
		return { item: it, prev };
	}

	async createFolder(name, parentId) {
		const f = parentId ? await eagle.folder.createSubfolder(parentId, { name }) : await eagle.folder.create({ name });
		await this.loadFolders();
		return f;
	}

	async select(ids) { try { await eagle.item.select(ids); } catch (err) { this.log('warn', `Selecting in Eagle failed: ${err.message}`); } }
	async open(id, newWindow = false) { try { await eagle.item.open(id, newWindow ? { window: true } : {}); } catch (err) { this.log('warn', `Opening in Eagle failed: ${err.message}`); } }
	async showInExplorer(file) { await eagle.shell.showItemInFolder(file); }
	async openWithDefault(file) { await eagle.shell.openPath(file); }
	async openFolder(folderId) { try { await eagle.folder.open(folderId); } catch { /* ignore */ } }
}

function unique(a) { return [...new Set(a)]; }

module.exports = { EagleData, ITEM_FIELDS };
