'use strict';
// Selection tools — port of VDF.GUI MainWindowVM_Selection.cs (ForEachGroupCluster, Check
// identical / identical-but-size / oldest / newest / lowest quality, custom selection
// planner) and Utils/QualityRanker.cs (VideoDuplicateFinder, AGPL-3.0).
//
// Items are result display objects (see core/results.describe) with a `checked` flag and
// `visible` (passes the current filter). `dateOf(item)` returns the date the results show.

// ── Quality ranking ──

function durationTies(a, b) { const d = Math.abs(a - b); return d <= 1 || d <= Math.max(a, b) * 0.01; }
function fpsTies(a, b) { return Math.abs(a - b) <= 0.5; }
function bitrateTies(a, b) { return Math.abs(a - b) <= Math.max(a, b) * 0.05; }

/** #848 bits per pixel = bitrate / (w*h*fps); 0 when anything is unknown. */
function bitsPerPixel(d) {
	if (d.bitRateKbs <= 0 || d.fps <= 0 || !d.frameSize) return 0;
	const m = /^(\d+)x(\d+)$/.exec(d.frameSize);
	if (!m) return 0;
	const w = Number(m[1]), h = Number(m[2]);
	if (w <= 0 || h <= 0) return 0;
	return d.bitRateKbs * 1000 / (w * h * d.fps);
}

const CRITERIA = {
	Duration: { name: 'Duration', get: (d) => d.duration, videoOnly: true, ties: durationTies },
	Resolution: { name: 'Resolution', get: (d) => d.frameSizeInt, videoOnly: false },
	Bitrate: { name: 'Bitrate', get: (d) => d.bitRateKbs, videoOnly: true, ties: bitrateTies },
	FPS: { name: 'FPS', get: (d) => d.fps, videoOnly: true, ties: fpsTies },
	'Bits per pixel': { name: 'Bits per pixel', get: bitsPerPixel, videoOnly: true, ties: bitrateTies },
	'Audio Bitrate': { name: 'Audio Bitrate', get: (d) => d.audioBitRateKbs, videoOnly: true, ties: bitrateTies },
	Size: { name: 'Size', get: (d) => d.size, videoOnly: false, ascending: true },
	SizeLarger: { name: 'SizeLarger', get: (d) => d.size, videoOnly: false },
};
const CRITERIA_LABELS = {
	Duration: 'Duration (longer wins)', Resolution: 'Resolution', Bitrate: 'Video bitrate', FPS: 'Frame rate',
	'Bits per pixel': 'Bits per pixel', 'Audio Bitrate': 'Audio bitrate', Size: 'File size (smaller wins)', SizeLarger: 'File size (larger wins)',
};

/** User order minus disabled criteria, then any criteria the saved order lacks. */
function resolveCriteria(order, disabled) {
	const seen = new Set();
	const out = [];
	for (const n of order || []) if (CRITERIA[n] && !seen.has(n)) { seen.add(n); if (!(disabled || []).includes(n)) out.push(CRITERIA[n]); }
	for (const n of Object.keys(CRITERIA)) if (!seen.has(n) && !(disabled || []).includes(n)) out.push(CRITERIA[n]);
	return out;
}

/** QualityRanker.PickKeeperWithReason. */
function pickKeeper(items, criteria) {
	if (!items.length) throw new Error('empty');
	let candidates = items;
	let keep = candidates[0];
	for (const c of criteria) {
		if (candidates.length <= 1) break;
		if (c.videoOnly && keep.isImage) continue;
		const sorted = [...candidates].sort((a, b) => c.ascending ? cmp(c.get(a), c.get(b)) : cmp(c.get(b), c.get(a)));
		keep = sorted[0];
		const kv = c.get(keep);
		const tied = candidates.filter((d) => c.ties ? c.ties(c.get(d), kv) : c.get(d) === kv);
		if (tied.length <= 1) return { keeper: keep, decidedBy: c.name };
		candidates = tied;
	}
	return { keeper: keep, decidedBy: null };
}
function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

// ── identity helpers (DuplicateItemVM) ──

function equalsFull(a, b) {
	return a.size === b.size && a.groupId === b.groupId && a.duration === b.duration && a.frameSizeInt === b.frameSizeInt
		&& a.format === b.format && a.audioFormat === b.audioFormat && a.audioChannel === b.audioChannel
		&& a.audioSampleRate === b.audioSampleRate && a.bitRateKbs === b.bitRateKbs && a.fps === b.fps;
}
function equalsButSize(a, b) {
	return a.groupId === b.groupId && a.duration === b.duration && a.frameSizeInt === b.frameSizeInt
		&& a.format === b.format && a.audioFormat === b.audioFormat && a.audioChannel === b.audioChannel
		&& a.audioSampleRate === b.audioSampleRate && a.bitRateKbs === b.bitRateKbs && a.fps === b.fps;
}
function equalsButQuality(a, b) { return a.groupId === b.groupId; }

function groupsOf(items) {
	const map = new Map();
	for (const it of items) {
		if (!map.has(it.groupId)) map.set(it.groupId, []);
		map.get(it.groupId).push(it);
	}
	return map;
}

/** ForEachGroupCluster: first member with a non-empty cluster in each group. */
function forEachGroupCluster(items, belongs, apply) {
	for (const members of groupsOf(items).values()) {
		for (const first of members) {
			const cluster = members.filter((d) => d.visible !== false && belongs(d, first) && d.id !== first.id);
			if (!cluster.length) continue;
			apply(first, cluster);
			break;
		}
	}
}

// Every command returns the list of changes [{item, checked}] so the caller can apply them
// as one undoable batch.

function checkWhenIdentical(items) {
	const ch = [];
	forEachGroupCluster(items, equalsFull, (first, cluster) => {
		for (const d of cluster) ch.push([d, true]);
		ch.push([first, false]);
	});
	return ch;
}

function checkWhenIdenticalButSize(items) {
	const ch = [];
	forEachGroupCluster(items, equalsButSize, (first, cluster) => {
		const all = [...cluster, first].sort((a, b) => a.size - b.size);
		ch.push([all[0], false]);
		for (let i = 1; i < all.length; i++) ch.push([all[i], true]);
	});
	return ch;
}

/** VDF "Check oldest": keeps the newest member, checks the rest. */
function checkOldest(items, dateOf) {
	const ch = [];
	forEachGroupCluster(items, equalsButQuality, (first, cluster) => {
		const all = [...cluster, first].sort((a, b) => dateOf(b) - dateOf(a));
		ch.push([all[0], false]);
		for (let i = 1; i < all.length; i++) ch.push([all[i], true]);
	});
	return ch;
}

/** VDF "Check newest": keeps the oldest member, checks the rest. */
function checkNewest(items, dateOf) {
	const ch = [];
	forEachGroupCluster(items, equalsButQuality, (first, cluster) => {
		const all = [...cluster, first].sort((a, b) => dateOf(a) - dateOf(b));
		ch.push([all[0], false]);
		for (let i = 1; i < all.length; i++) ch.push([all[i], true]);
	});
	return ch;
}

/** Check lowest quality: keeper chosen by the quality criteria order, everything else checked. */
function checkLowestQuality(items, criteria) {
	const ch = [];
	forEachGroupCluster(items, equalsButQuality, (first, cluster) => {
		const all = [first, ...cluster];
		const { keeper } = pickKeeper(all, criteria);
		for (const d of all) ch.push([d, d !== keeper]);
	});
	return ch;
}

function keepBestInGroup(members, criteria) {
	const visible = members.filter((m) => m.visible !== false);
	if (visible.length < 2) return [];
	const { keeper } = pickKeeper(visible, criteria);
	return visible.map((d) => [d, d !== keeper]);
}

function invert(items) { return items.filter((d) => d.visible !== false).map((d) => [d, !d.checked]); }
function clear(items) { return items.filter((d) => d.checked).map((d) => [d, false]); }

// ── Custom selection (ComputeCustomSelection) ──

const DEFAULT_CUSTOM = Object.freeze({
	ignoreGroupsWithCheckedItems: true,
	fileTypeSelection: 0,     // 0 all, 1 videos only, 2 images only
	identicalSelection: 0,    // 0 any, 1 identical, 2 identical but size, 3 not identical
	dateTimeSelection: 0,     // 0 none, 1 check newest (keep oldest), 2 check oldest (keep newest)
	minimumFileSize: 0,
	maximumFileSize: 999999999,
	pathContains: [],
	pathNotContains: [],
	similarityFrom: 0,
	similarityTo: 100,
});

function wildcard(pattern, text) {
	const re = new RegExp('^' + String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'is');
	return re.test(text);
}

function megaBytes(n) { return Math.trunc(Math.fround(Math.fround(n / 1024) / 1024)); }

/**
 * @param items visible items
 * @param data custom selection data
 * @param pathsOf item → array of path strings to match wildcards against
 */
function computeCustomSelection(items, data, dateOf, pathsOf) {
	data = { ...DEFAULT_CUSTOM, ...data };
	const groupsWithChecked = new Set();
	if (data.ignoreGroupsWithCheckedItems) for (const it of items) if (it.checked) groupsWithChecked.add(it.groupId);
	const visibleSize = new Map();
	for (const it of items) visibleSize.set(it.groupId, (visibleSize.get(it.groupId) || 0) + 1);
	const matchesCriteria = (it) => {
		if (data.fileTypeSelection === 1 && it.isImage) return false;
		if (data.fileTypeSelection === 2 && !it.isImage) return false;
		const mb = megaBytes(it.size);
		if (mb < data.minimumFileSize || mb > data.maximumFileSize) return false;
		const paths = pathsOf(it);
		for (const p of data.pathContains) if (!paths.some((x) => wildcard(p, x))) return false;
		for (const p of data.pathNotContains) if (paths.some((x) => wildcard(p, x))) return false;
		if (it.similarity < data.similarityFrom || it.similarity > data.similarityTo) return false;
		return true;
	};
	const matched = new Map();
	const order = [];
	for (const it of items) {
		if (groupsWithChecked.has(it.groupId)) continue;
		if (!matchesCriteria(it)) continue;
		if (!matched.has(it.groupId)) { matched.set(it.groupId, []); order.push(it.groupId); }
		matched.get(it.groupId).push(it);
	}
	const keepers = [], toCheck = [];
	for (const gid of order) {
		const members = matched.get(gid);
		const first = members[0];
		let cluster;
		switch (data.identicalSelection) {
			case 1: cluster = members.filter((m) => m === first || equalsFull(m, first)); break;
			case 2: cluster = members.filter((m) => m === first || equalsButSize(m, first)); break;
			case 3: cluster = members.filter((m) => m === first || !equalsFull(m, first)); break;
			default: cluster = members;
		}
		if (data.dateTimeSelection === 1) cluster = [...cluster].sort((a, b) => dateOf(a) - dateOf(b));
		else if (data.dateTimeSelection === 2) cluster = [...cluster].sort((a, b) => dateOf(b) - dateOf(a));
		else if (data.identicalSelection === 0 && cluster.length < visibleSize.get(gid)) { toCheck.push(...cluster); continue; }
		keepers.push(cluster[0]);
		for (let i = 1; i < cluster.length; i++) toCheck.push(cluster[i]);
	}
	return { keepers, toCheck };
}

/**
 * Expression selection (ApplySelectionExpression): items matching the predicate are
 * checked; groups where EVERY visible member matches are returned separately so the UI can
 * ask whether to check them all or none.
 */
function partitionExpressionMatches(items, predicate) {
	const partial = [], full = [];
	for (const members of groupsOf(items.filter((d) => d.visible !== false)).values()) {
		const m = members.filter((d) => { try { return !!predicate(d); } catch { return false; } });
		if (!m.length) continue;
		if (m.length === members.length) full.push(members); else partial.push(...m);
	}
	return { partial, full };
}

module.exports = {
	CRITERIA,
	CRITERIA_LABELS,
	resolveCriteria,
	pickKeeper,
	bitsPerPixel,
	equalsFull,
	equalsButSize,
	checkWhenIdentical,
	checkWhenIdenticalButSize,
	checkOldest,
	checkNewest,
	checkLowestQuality,
	keepBestInGroup,
	invert,
	clear,
	DEFAULT_CUSTOM,
	computeCustomSelection,
	partitionExpressionMatches,
	wildcard,
	groupsOf,
};
