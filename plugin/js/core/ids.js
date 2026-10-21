'use strict';
// Eagle item ids name files in the plugin's cache (dense/<id>.bin, thumbnails, compare frames).
// Ids can arrive from imported JSON, so every file name built from one goes through here: the id
// must look like an Eagle item id, and the resulting path must stay directly inside its folder.

const path = require('path');

/** Eagle 4 item ids are 13 upper-case letters and digits; allow any short alphanumeric id. */
const ITEM_ID = /^[A-Za-z0-9]{1,64}$/;

function isItemId(id) {
	return typeof id === 'string' && ITEM_ID.test(id);
}

/** A file-name tail such as ".bin" or "-12.5-160.jpg": no separators, drive colons or "..". */
function isSafeSuffix(suffix) {
	return typeof suffix === 'string' && !/[\\/:\0]/.test(suffix) && !suffix.includes('..');
}

/**
 * `<dir>/<id><suffix>` as an absolute path, or null when the id is not an item id, the suffix is
 * not a plain file-name tail, or the result would not be a direct child of `dir`.
 */
function fileFor(dir, id, suffix = '') {
	if (!isItemId(id) || !isSafeSuffix(suffix)) return null;
	const base = path.resolve(dir);
	const file = path.resolve(base, `${id}${suffix}`);
	const rel = path.relative(base, file);
	if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || /[\\/]/.test(rel)) return null;
	return file;
}

/** Eagle item names become file names: no path separators or traversal; extensions are short and alphanumeric. */
function isItemName(name) {
	return typeof name === 'string' && name.length > 0 && name.length <= 1024 && !/[\\/\0]/.test(name) && name !== '.' && name !== '..';
}
function isItemExt(ext) {
	return typeof ext === 'string' && /^[A-Za-z0-9]{1,16}$/.test(ext);
}

module.exports = { ITEM_ID, isItemId, isSafeSuffix, fileFor, isItemName, isItemExt };
