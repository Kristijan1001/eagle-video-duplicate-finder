'use strict';
// Pure logic behind the Compare window (VDF.GUI/Data/ComparerCulling.cs): the winner-stays
// pair walk over a group and the metadata chips under each pane.

/**
 * Winner-stays pair walk: the current keeper sits LEFT (A), challengers walk through the
 * remaining files in order. Keep-left checks the challenger; keep-right crowns the challenger
 * and checks the old keeper; skip decides nothing. N files = N-1 pairs.
 */
class CullingPairFlow {
	constructor(count) {
		this.count = Math.max(0, count | 0);
		this.leftIndex = 0;
		this.rightIndex = this.count >= 2 ? 1 : this.count;
	}
	get pairCount() { return Math.max(this.count - 1, 0); }
	/** 1-based position of the walk (the challenger cursor). */
	get pairNumber() { return Math.min(Math.max(this.leftIndex, this.rightIndex), Math.max(this.pairCount, 1)); }
	get hasPair() { return this.count >= 2 && this.rightIndex < this.count; }

	/** decision: 'keepLeft' | 'keepRight' | 'skip' → { checkIndex, keepIndex, groupFinished } */
	advance(decision) {
		if (!this.hasPair) return { checkIndex: -1, keepIndex: -1, groupFinished: true };
		let check = -1, keep = -1;
		if (decision === 'keepLeft') { check = this.rightIndex; keep = this.leftIndex; }
		else if (decision === 'keepRight') { check = this.leftIndex; keep = this.rightIndex; this.leftIndex = this.rightIndex; }
		this.rightIndex = Math.max(this.leftIndex, this.rightIndex) + 1;
		return { checkIndex: check, keepIndex: keep, groupFinished: this.rightIndex >= this.count };
	}

	/** Manually picking files re-anchors the walk at that pair; invalid picks are ignored. */
	setPair(left, right) {
		if (left < 0 || right < 0 || left >= this.count || right >= this.count || left === right) return;
		this.leftIndex = left;
		this.rightIndex = right;
	}
}

/** "20:26" / "1:02:03" (ComparerChips.FormatDuration). */
function formatChipDuration(seconds) {
	const s = Math.max(0, Math.trunc(seconds || 0));
	const hh = Math.trunc(s / 3600), mm = Math.trunc(s / 60) % 60, ss = s % 60;
	const pad = (n) => String(n).padStart(2, '0');
	return hh >= 1 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

const HDR_RANK = { 'Dolby Vision': 4, 'HDR10+': 3, HDR10: 2, HLG: 1 };

/**
 * ComparerChips.Build: chips for one pane. Strictly better values than the OTHER pane are
 * 'better', strictly worse 'worse', equal 'neutral'. VDF judges resolution, size and HDR;
 * this port adds the video bitrate (higher = better), which VDF's chips leave out.
 * Duration/codec/audio/date have no objective better.
 * fmt: { bytes(n) → text, date(item) → text | '', number(n) → text (optional) }
 */
function buildChips(item, other, fmt) {
	const judge = (v, o) => (o == null || v === o ? 'neutral' : v > o ? 'better' : 'worse');
	const num = fmt.number || ((n) => String(Math.round(n)));
	const chips = [];
	if (item.frameSize) chips.push({ text: item.frameSize, state: judge(item.frameSizeInt || 0, other ? other.frameSizeInt || 0 : null) });
	chips.push({ text: fmt.bytes(item.size || 0), state: judge(item.size || 0, other ? other.size || 0 : null) });
	if (!item.isImage) {
		chips.push({ text: formatChipDuration(item.duration), state: 'neutral' });
		let codec = item.format ? String(item.format).toUpperCase() : '';
		if (item.fps > 0) {
			const fps = `${Number(item.fps.toFixed(2))} fps`;
			codec = codec ? `${codec} · ${fps}` : fps;
		}
		if (codec) chips.push({ text: codec, state: 'neutral' });
		if (item.bitRateKbs > 0) chips.push({ text: `${num(item.bitRateKbs)} kb/s`, state: judge(item.bitRateKbs, other && other.bitRateKbs > 0 ? other.bitRateKbs : null), kind: 'bitrate' });
		if (item.audioFormat) {
			let audio = item.audioFormat;
			if (item.audioChannel) audio += ` ${item.audioChannel}`;
			if (item.audioSampleRate > 0) audio += ` · ${Number((item.audioSampleRate / 1000).toFixed(1))} kHz`;
			if (item.audioBitRateKbs > 0) audio += ` · ${num(item.audioBitRateKbs)} kb/s`;
			chips.push({ text: audio, state: 'neutral' });
		}
		if (item.hdrFormat) chips.push({ text: item.hdrFormat, state: judge(HDR_RANK[item.hdrFormat] || 0, other ? HDR_RANK[other.hdrFormat] || 0 : null) });
	}
	const d = fmt.date ? fmt.date(item) : '';
	if (d) chips.push({ text: d, state: 'neutral' });
	return chips;
}

module.exports = { CullingPairFlow, buildChips, formatChipDuration };
