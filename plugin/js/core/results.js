'use strict';
// Result model — port of VDF.Core/ViewModels/DuplicateItem.cs (stream selection, languages,
// display fields), ScanEngine.HighlightBestMatches, and the GUI's sort modes
// (VideoDuplicateFinder, AGPL-3.0).

const { f } = require('./f32');

const STILL_CODECS = new Set(['mjpeg', 'png', 'bmp', 'gif', 'webp', 'tiff']);
const TERM_TO_BIB = {
	sqi: 'alb', hye: 'arm', eus: 'baq', mya: 'bur', zho: 'chi', ces: 'cze', nld: 'dut', fra: 'fre', kat: 'geo', deu: 'ger',
	ell: 'gre', isl: 'ice', mkd: 'mac', mri: 'mao', msa: 'may', fas: 'per', ron: 'rum', slk: 'slo', bod: 'tib', cym: 'wel',
};

function isVideoStream(s) { return String(s.codecType || '').toLowerCase() === 'video'; }
function isStill(codec) { return !!codec && STILL_CODECS.has(String(codec).toLowerCase()); }

/** DuplicateItem.SelectVideoStream: highest resolution, never cover art when real video exists. */
function selectVideoStream(streams) {
	const hasMoving = streams.some((s) => isVideoStream(s) && !s.isAttachedPicture && !isStill(s.codecName));
	const isCover = (s) => s.isAttachedPicture || (hasMoving && isStill(s.codecName));
	let best = -1, bestCover = -1, bestPixels = -1, bestCoverPixels = -1;
	streams.forEach((s, i) => {
		if (!isVideoStream(s)) return;
		const px = (s.width || 0) * (s.height || 0);
		if (isCover(s)) { if (px > bestCoverPixels) { bestCover = i; bestCoverPixels = px; } }
		else if (px > bestPixels) { best = i; bestPixels = px; }
	});
	return best >= 0 ? best : bestCover;
}

function displayLanguage(tag) {
	if (!tag || !String(tag).trim()) return '';
	tag = String(tag).trim().toLowerCase();
	if (tag === 'und') return '';
	return (TERM_TO_BIB[tag] || tag).toUpperCase();
}

function joinLanguages(streams, type, listUntaggedOnly) {
	const codes = [];
	let anyTagged = false;
	for (const s of streams) {
		if (String(s.codecType || '').toLowerCase() !== type) continue;
		const code = displayLanguage(s.language);
		anyTagged = anyTagged || code.length > 0;
		codes.push(code.length ? code : '?');
	}
	return anyTagged || listUntaggedOnly ? codes.join(', ') : '';
}

/** C# Math.Round((decimal)x / 1000): banker's rounding. */
function roundKbs(bits) {
	const x = (bits || 0) / 1000;
	const r = Math.round(x);
	return Math.abs(x - Math.trunc(x)) === 0.5 ? 2 * Math.round(x / 2) : r;
}

/**
 * Build the display fields of one result item (DuplicateItem ctor).
 * entry: cache entry; difference: float; groupId; flags; extra: {offset, name, ext, ...}
 */
function describe(entry, difference, groupId, flags, extra = {}) {
	const isImage = !!(entry.flags & 1);
	const d = {
		id: entry.id,
		groupId,
		difference,
		similarity: f(f(1 - f(difference)) * 100),
		flags,
		partialOffset: extra.offset || 0,
		isImage,
		duration: 0,
		format: '',
		fps: 0,
		bitRateKbs: 0,
		frameSize: '',
		frameSizeInt: 0,
		hdrFormat: '',
		audioFormat: '',
		audioChannel: '',
		audioSampleRate: 0,
		audioBitRateKbs: 0,
		audioLanguages: '',
		subtitleLanguages: '',
		size: entry.size || 0,
		dateCreated: entry.dateCreated || 0,
		dateModified: entry.dateModified || 0,
		missing: !!(entry.flags & (1 << 17)),
		tombstone: !!(entry.flags & (1 << 16)),
		name: entry.name,
		ext: entry.ext,
		path: entry.path,
		positions: extra.positions || [],
	};
	const streams = (entry.mi && entry.mi.streams) || [];
	if (!isImage && streams.length) {
		d.duration = entry.mi.duration || 0;
		let selAudio = -1, selCh = 0;
		for (let i = streams.length - 1; i >= 0; i--) {
			if (String(streams[i].codecType || '').toLowerCase() === 'audio' && (streams[i].channels || 0) >= selCh) {
				selAudio = i; selCh = streams[i].channels || 0;
			}
		}
		const v = selectVideoStream(streams);
		if (v >= 0) {
			const s = streams[v];
			d.format = s.codecName || '<Unknown>';
			d.fps = s.frameRate || 0;
			d.bitRateKbs = roundKbs(s.bitRate);
			d.frameSize = `${s.width || 0}x${s.height || 0}`;
			d.frameSizeInt = (s.width || 0) + (s.height || 0);
			d.hdrFormat = s.hdrFormat || '';
		}
		if (selAudio >= 0) {
			const s = streams[selAudio];
			d.audioFormat = s.codecName || '<Unknown>';
			d.audioChannel = s.channelLayout || '<Unknown>';
			d.audioSampleRate = s.sampleRate || 0;
			d.audioBitRateKbs = roundKbs(s.bitRate);
		}
		d.audioLanguages = joinLanguages(streams, 'audio', false);
		d.subtitleLanguages = joinLanguages(streams, 'subtitle', true);
	}
	else if (streams.length) {
		d.frameSize = `${streams[0].width || 0}x${streams[0].height || 0}`;
		d.frameSizeInt = (streams[0].width || 0) + (streams[0].height || 0);
	}
	if (isImage) d.format = String(entry.ext || '').toLowerCase();
	return d;
}

function hdrRank(h) {
	switch (h) { case 'Dolby Vision': return 4; case 'HDR10+': return 3; case 'HDR10': return 2; case 'HLG': return 1; default: return 0; }
}

/** HighlightBestMatches: marks every member that ties the group's best value per metric. */
function highlightBest(items, prefersLargerSize = false) {
	const byGroup = new Map();
	for (const it of items) {
		if (!byGroup.has(it.groupId)) byGroup.set(it.groupId, []);
		byGroup.get(it.groupId).push(it);
	}
	for (const group of byGroup.values()) {
		const isImage = group[0].isImage;
		const mark = (key, value, flag) => { for (const d of group) d[flag] = d[key] === value; };
		for (const d of group) {
			d.isBestDuration = d.isBestSize = d.isBestFps = d.isBestBitRateKbs = d.isBestAudioSampleRate = false;
			d.isBestAudioBitRateKbs = d.isBestHdrFormat = d.isBestFrameSize = false;
		}
		if (!isImage) mark('duration', Math.max(...group.map((d) => d.duration)), 'isBestDuration');
		mark('size', prefersLargerSize ? Math.max(...group.map((d) => d.size)) : Math.min(...group.map((d) => d.size)), 'isBestSize');
		if (!isImage) {
			mark('fps', Math.max(...group.map((d) => d.fps)), 'isBestFps');
			mark('bitRateKbs', Math.max(...group.map((d) => d.bitRateKbs)), 'isBestBitRateKbs');
			mark('audioSampleRate', Math.max(...group.map((d) => d.audioSampleRate)), 'isBestAudioSampleRate');
			mark('audioBitRateKbs', Math.max(...group.map((d) => d.audioBitRateKbs)), 'isBestAudioBitRateKbs');
			const best = Math.max(...group.map((d) => hdrRank(d.hdrFormat)));
			for (const d of group) d.isBestHdrFormat = hdrRank(d.hdrFormat) === best;
		}
		mark('frameSizeInt', Math.max(...group.map((d) => d.frameSizeInt)), 'isBestFrameSize');
	}
	return items;
}

// ── hover diff (MainWindowVM_HoverDiff.cs): every value of a group as its difference to the best ──

const HOVER_METRICS = ['duration', 'framesize', 'size', 'fps', 'bitrate', 'audiobitrate'];
const METRIC_FIELDS = {
	duration: ['duration', 'isBestDuration'],
	framesize: ['frameSizeInt', 'isBestFrameSize'],
	size: ['size', 'isBestSize'],
	fps: ['fps', 'isBestFps'],
	bitrate: ['bitRateKbs', 'isBestBitRateKbs'],
	audiobitrate: ['audioBitRateKbs', 'isBestAudioBitRateKbs'],
};

/** FormatPercentDiff: "=" under half a percent, else a signed whole percentage. */
function formatPercentDiff(pct) {
	if (Math.abs(pct) < 0.5) return '=';
	return `${pct < 0 ? '-' : '+'}${Math.round(Math.abs(pct))}%`;
}

/** FormatDurationDiff (TimeSpan components, truncated). diff in seconds. */
function formatDurationDiff(diff) {
	if (diff === 0) return '=';
	const sign = diff < 0 ? '-' : '+';
	const abs = Math.abs(diff);
	const hours = Math.trunc(abs / 3600), minutes = Math.trunc(abs / 60) % 60, seconds = Math.trunc(abs) % 60;
	const pad = (n) => String(n).padStart(2, '0');
	if (abs >= 3600) return `${sign}${hours}h${pad(minutes)}m${pad(seconds)}s`;
	if (abs >= 60) return `${sign}${Math.trunc(abs / 60)}m${pad(seconds)}s`;
	return `${sign}${seconds}s`;
}

/**
 * ApplyHoverDiffs for one metric over one group's members. Returns Map(id → label), or null
 * when every member has the same value (a tie would print BEST everywhere, VDF #849).
 */
function hoverDiffs(group, metric, bestLabel = 'BEST') {
	const f = METRIC_FIELDS[metric];
	if (!f) return null;
	const [key, bestFlag] = f;
	const val = (m) => Number(m[key]) || 0;
	if (new Set(group.map(val)).size <= 1) return null;
	const flagged = group.find((m) => m[bestFlag]);
	const best = flagged ? val(flagged) : Math.max(...group.map(val));
	const out = new Map();
	for (const m of group) {
		if (m[bestFlag]) { out.set(m.id, bestLabel); continue; }
		if (metric === 'duration') { out.set(m.id, formatDurationDiff(val(m) - best)); continue; }
		const threshold = metric === 'fps' ? 0.01 : 0;
		if (best > threshold) out.set(m.id, formatPercentDiff((val(m) - best) / best * 100));
	}
	return out;
}

const SORT_MODES = ['WastedSpace', 'TotalSize', 'LargestFile', 'FileCount', 'Similarity', 'DateCreated', 'Duration', 'Name'];

/** Group sort key per VDF ResultsSortMode. members: display items of one group. */
function groupSortKey(mode, members, dateOf) {
	const sizes = members.map((m) => m.size || 0);
	switch (mode) {
		case 'TotalSize': return sizes.reduce((a, b) => a + b, 0);
		case 'LargestFile': return Math.max(...sizes);
		case 'FileCount': return members.length;
		case 'Similarity': return Math.max(...members.map((m) => m.similarity));
		case 'DateCreated': return Math.max(...members.map((m) => (dateOf ? dateOf(m) : m.dateCreated) || 0));
		case 'Duration': return Math.max(...members.map((m) => m.duration || 0));
		case 'Name': return (members[0].name || '').toLowerCase();
		case 'WastedSpace':
		default: return sizes.reduce((a, b) => a + b, 0) - Math.max(...sizes);
	}
}

/** Wasted space = bytes freed if only the largest member were kept. */
function wastedSpace(members) {
	const sizes = members.map((m) => m.size || 0);
	return sizes.reduce((a, b) => a + b, 0) - Math.max(0, ...sizes);
}

/** VDF GroupBlacklistFilter: groups whose every member id is inside one "not a match" set. */
function blacklistedGroups(groups, notAMatch) {
	const sets = (notAMatch || []).map((ids) => new Set(ids));
	const out = new Set();
	if (!sets.length) return out;
	for (const [gid, ids] of groups) {
		if (sets.some((s) => ids.every((id) => s.has(id)))) out.add(gid);
	}
	return out;
}

module.exports = {
	selectVideoStream,
	displayLanguage,
	describe,
	highlightBest,
	hoverDiffs,
	formatPercentDiff,
	formatDurationDiff,
	HOVER_METRICS,
	hdrRank,
	groupSortKey,
	wastedSpace,
	blacklistedGroups,
	SORT_MODES,
	roundKbs,
};
