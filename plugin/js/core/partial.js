'use strict';
// Partial-clip detection helpers — port of ScanEngine.CollectPartialMatchCandidates,
// AssignPartialClipGroups, PartialClipVisualSampleTimes, TryMatchDenseFrames
// (VideoDuplicateFinder, AGPL-3.0).

const { cosineSimilarity, signSignature, hammingDistance, signatureHammingBound, DIMENSIONS } = require('./ai/embedding-math');

const MIN_CONSISTENT_HITS = 4;
const OFFSET_TOLERANCE_SECONDS = 30;

/**
 * Upper-triangular sweep over duration-DESCENDING videos with VDF's duration prefilters:
 * clip < 95% of source, clip >= minRatio of source (break: the list is sorted, so the
 * ratio only shrinks along a row). `gate(i, j)` = folder gate; `prefilter(i, j)`, then
 * `tryMatch(i, j)` → {sim, offset} | null. Returns { matches, pairsChecked }.
 */
function collectCandidates(durations, minRatio, gate, prefilter, tryMatch, onRow, isCancelled) {
	const matches = [];
	let pairsChecked = 0;
	const n = durations.length;
	for (let i = 0; i < n - 1; i++) {
		if (isCancelled && isCancelled()) break;
		const sourceSec = durations[i];
		if (sourceSec >= 1.0) {
			for (let j = i + 1; j < n; j++) {
				const ratio = durations[j] / sourceSec;
				if (ratio >= 0.95) continue;
				if (ratio < minRatio) break;
				if (gate && !gate(i, j)) continue;
				if (prefilter && !prefilter(i, j)) continue;
				pairsChecked++;
				const m = tryMatch(i, j);
				if (m) matches.push({ source: i, clip: j, sim: m.sim, offset: m.offset });
			}
		}
		if (onRow) onRow(i);
	}
	return { matches, pairsChecked };
}

/** AssignPartialClipGroups: each clip bound to its longest source; group id per source. */
function assignGroups(matches) {
	const sorted = [...matches].sort((a, b) => a.source - b.source || a.clip - b.clip);
	const sourceGroup = new Map();
	const assigned = new Set();
	const out = [];
	let next = 1;
	for (const m of sorted) {
		if (assigned.has(m.clip)) continue;
		assigned.add(m.clip);
		let g = sourceGroup.get(m.source);
		if (g === undefined) { g = next++; sourceGroup.set(m.source, g); }
		out.push({ ...m, group: g });
	}
	return out;
}

/**
 * AssignAndVerifyPartialClips: assign, verify only what is assigned, give rejected clips
 * their next candidate source, repeat until every assigned pair has passed.
 * `verify(a)` → Promise<{pass, visualSim}>.
 */
async function assignAndVerify(matches, verify, isCancelled) {
	const passed = new Set();
	const rejected = new Set();
	const key = (a) => `${a.source}:${a.clip}`;
	for (;;) {
		const assignments = assignGroups(matches.filter((m) => !rejected.has(key(m))));
		const unverified = assignments.filter((a) => !passed.has(key(a)));
		if (!unverified.length) return assignments;
		for (const a of unverified) {
			if (isCancelled && isCancelled()) return assignments.filter((x) => passed.has(key(x)));
			const r = await verify(a);
			if (r.pass) passed.add(key(a)); else rejected.add(key(a));
		}
	}
}

/** Clip-local sample times for the visual confirmation of a partial match. */
function visualSampleTimes(sourceSec, clipSec, clipFingerprintSeconds, offsetSec) {
	let window = Math.min(clipSec, sourceSec - offsetSec);
	if (clipFingerprintSeconds > 0) window = Math.min(window, clipFingerprintSeconds);
	const times = [];
	if (window <= 0) return times;
	const fractions = window >= 9.0 ? [0.25, 0.50, 0.75] : window >= 3.0 ? [0.33, 0.66] : [0.5];
	for (const fr of fractions) {
		const t = window * fr;
		if (t >= clipSec - 0.1 || offsetSec + t >= sourceSec - 0.1) continue;
		times.push(t);
	}
	return times;
}

/**
 * Dense timeline: { interval, count, emb: Int8Array(count*384), valid: Uint8Array(count),
 * sig: Uint32Array(count*12) }. Invalid slots (dark / duplicate frames) stay on the timeline.
 */
function buildSignatures(dense) {
	const sig = new Uint32Array(dense.count * 12);
	for (let i = 0; i < dense.count; i++) {
		if (!dense.valid[i]) continue;
		sig.set(signSignature(dense.emb.subarray(i * DIMENSIONS, (i + 1) * DIMENSIONS)), i * 12);
	}
	dense.sig = sig;
	return dense;
}

/** TryMatchDenseFrames: >= 4 frame hits agreeing on one offset (±30 s). */
function matchDenseFrames(source, clip, hitThreshold, hammingBound) {
	const f = Math.fround;
	const hits = [];
	for (let c = 0; c < clip.count; c++) {
		if (!clip.valid[c]) continue;
		const clipTime = c * clip.interval;
		const cv = clip.emb.subarray(c * DIMENSIONS, (c + 1) * DIMENSIONS);
		for (let s = 0; s < source.count; s++) {
			if (!source.valid[s]) continue;
			if (hammingDistance(clip.sig, source.sig, c * 12, s * 12, 12) > hammingBound) continue;
			const cos = cosineSimilarity(cv, source.emb.subarray(s * DIMENSIONS, (s + 1) * DIMENSIONS));
			if (cos < hitThreshold) continue;
			hits.push([s * source.interval - clipTime, cos]);
		}
	}
	if (hits.length < MIN_CONSISTENT_HITS) return null;
	hits.sort((a, b) => a[0] - b[0]);
	const median = hits[hits.length >> 1][0];
	let sum = 0, consistent = 0;
	for (const [offset, cos] of hits) {
		if (Math.abs(offset - median) > OFFSET_TOLERANCE_SECONDS) continue;
		sum = f(sum + cos);
		consistent++;
	}
	if (consistent < MIN_CONSISTENT_HITS) return null;
	return { sim: f(sum / consistent), offset: Math.max(0, roundHalfEven(median)) };
}

function roundHalfEven(x) {
	if (Math.abs(x - Math.trunc(x)) === 0.5) return 2 * Math.round(x / 2);
	return Math.round(x);
}

/** DenseFrameFilter: a frame is usable when not dark and not identical to the previous raw frame. */
class DenseFrameFilter {
	constructor(verifyRgb) { this.previous = null; this.verifyRgb = verifyRgb; }
	isUsable(frame) {
		let usable = this.verifyRgb(frame);
		if (usable && this.previous && this.previous.length === frame.length) {
			let same = true;
			for (let i = 0; i < frame.length; i++) if (frame[i] !== this.previous[i]) { same = false; break; }
			if (same) usable = false;
		}
		this.previous = Uint8Array.from(frame);
		return usable;
	}
}

module.exports = {
	collectCandidates,
	assignGroups,
	assignAndVerify,
	visualSampleTimes,
	buildSignatures,
	matchDenseFrames,
	signatureHammingBound,
	DenseFrameFilter,
	MIN_CONSISTENT_HITS,
	OFFSET_TOLERANCE_SECONDS,
};
