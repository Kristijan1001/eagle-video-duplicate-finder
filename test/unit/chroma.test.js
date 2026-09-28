'use strict';
// Ported from VDF.Core.Tests: Chromaprint, SilentFingerprintTests, SlidingWindowCompareTests,
// PartialClipGroupingTests (AssignPartialClipGroups), PartialClipVisualGateTests (sample times).
const test = require('node:test');
const assert = require('node:assert');
const { core, rng } = require('../lib/helpers');
const C = core('core/chroma.js');
const P = core('core/partial.js');

function tone(seconds, freqAt) {
	const n = Math.floor(seconds * 11025);
	const pcm = new Int16Array(n);
	let phase = 0;
	for (let i = 0; i < n; i++) {
		phase += 2 * Math.PI * freqAt(i / 11025) / 11025;
		pcm[i] = Math.round(12000 * Math.sin(phase));
	}
	return pcm;
}
// Non-repeating note sequence (hashed step index), so only the true offset lines up.
const melody = (t) => {
	let h = Math.imul(Math.floor(t * 3) + 1, 0x9E3779B1) >>> 0;
	h ^= h >>> 15;
	return 220 * Math.pow(2, (h % 24) / 12);
};

function fingerprint(pcm, chunk = 4000) {
	const ctx = new C.ChromaContext();
	for (let i = 0; i < pcm.length; i += chunk) ctx.feed(pcm.subarray(i, i + chunk));
	ctx.finish();
	return ctx.fingerprint();
}

test('about one block per second, independent of feed chunking', () => {
	const pcm = tone(20, melody);
	const a = fingerprint(pcm, 4000), b = fingerprint(pcm, 777);
	assert.deepStrictEqual(a, b);
	assert.ok(Math.abs(a.length - 20) <= 1, `blocks ${a.length}`);
});

test('silence gives an all-zero (silent) fingerprint', () => {
	const fp = fingerprint(new Int16Array(11025 * 5));
	assert.ok(C.isSilentFingerprint(fp));
	assert.strictEqual(C.isSilentFingerprint(new Uint32Array(0)), false);
});

test('sliding window finds an embedded clip at its offset', () => {
	const full = fingerprint(tone(60, melody));
	const clipPcm = tone(60, melody).subarray(20 * 11025, 35 * 11025);
	const clip = fingerprint(clipPcm);
	const r = C.slidingWindowCompare(clip, full, 0.8);
	assert.ok(r.similarity >= 0.8, `sim ${r.similarity}`);
	assert.ok(Math.abs(r.offset - 20) <= 1, `offset ${r.offset}`);
});

test('sliding window: identical → 1, random → low, minSim early exit keeps result', () => {
	const r = rng(3);
	const a = Uint32Array.from({ length: 30 }, () => (r.next() * 2 ** 32) >>> 0);
	assert.strictEqual(C.slidingWindowCompare(a, a).similarity, 1);
	const b = Uint32Array.from({ length: 60 }, () => (r.next() * 2 ** 32) >>> 0);
	assert.ok(C.slidingWindowCompare(a, b).similarity < 0.7);
	assert.ok(C.slidingWindowCompare(a, b, 0.9).similarity < 0.9);
});

test('assign groups: clip bound to its longest source; no singleton sources', () => {
	const m = [{ source: 1, clip: 3, sim: 0.9, offset: 5 }, { source: 0, clip: 3, sim: 0.85, offset: 7 }, { source: 1, clip: 4, sim: 0.9, offset: 1 }];
	const a = P.assignGroups(m);
	assert.deepStrictEqual(a.map((x) => [x.source, x.clip]), [[0, 3], [1, 4]]);
	assert.notStrictEqual(a[0].group, a[1].group);
});

test('assign and verify: a rejected clip moves to its next source', async () => {
	const m = [{ source: 0, clip: 2, sim: 0.9, offset: 5 }, { source: 1, clip: 2, sim: 0.85, offset: 7 }];
	const a = await P.assignAndVerify(m, async (x) => ({ pass: x.source === 1 }));
	assert.deepStrictEqual(a.map((x) => [x.source, x.clip]), [[1, 2]]);
});

test('visual sample times stay inside the matched window', () => {
	assert.deepStrictEqual(P.visualSampleTimes(60, 15, 15, 20), [3.75, 7.5, 11.25]);
	assert.deepStrictEqual(P.visualSampleTimes(60, 5, 5, 20).map((x) => +x.toFixed(2)), [1.65, 3.3]);
	assert.deepStrictEqual(P.visualSampleTimes(10, 20, 0, 12), []);
});

test('dense matching: >= 4 consistent hits at one offset', () => {
	const mk = (count, fn) => {
		const emb = new Int8Array(count * 384), valid = new Uint8Array(count).fill(1);
		for (let i = 0; i < count; i++) fn(emb.subarray(i * 384, (i + 1) * 384), i);
		return P.buildSignatures({ interval: 5, count, emb, valid });
	};
	const r = rng(9);
	const basis = Array.from({ length: 40 }, () => Int8Array.from({ length: 384 }, () => Math.round((r.next() * 2 - 1) * 20)));
	const source = mk(40, (v, i) => v.set(basis[i]));
	const clip = mk(8, (v, i) => v.set(basis[i + 10]));
	const m = P.matchDenseFrames(source, clip, 0.89, P.signatureHammingBound(0.89));
	assert.ok(m);
	assert.strictEqual(m.offset, 50);
	const other = mk(8, (v) => v.set(Int8Array.from({ length: 384 }, () => Math.round((r.next() * 2 - 1) * 20))));
	assert.strictEqual(P.matchDenseFrames(source, other, 0.89, P.signatureHammingBound(0.89)), null);
});
