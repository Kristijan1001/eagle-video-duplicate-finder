'use strict';
// Ported from VDF.Core.Tests/DaisyChainSplitterTests.cs (oracle = VDF's pre-#901 algorithm)
// plus MergeDuplicate representative-gating coverage.
const test = require('node:test');
const assert = require('node:assert');
const { core, rng } = require('../lib/helpers');
const { daisySplit, GroupBuilder, PairBitMatrix } = core('core/grouping.js');

function referenceSplit(similar) {
	const n = similar.length;
	const groups = [], removed = new Set();
	let active = [...Array(n).keys()];
	const pruned = [];
	let changed = true;
	while (changed && active.length >= 2) {
		changed = false;
		let worstIdx = -1, worst = Infinity;
		for (let ai = 0; ai < active.length; ai++) {
			let c = 0;
			for (let aj = 0; aj < active.length; aj++) if (ai !== aj && similar[active[ai]][active[aj]]) c++;
			if (c < worst) { worst = c; worstIdx = ai; }
		}
		if (worst < Math.floor(active.length / 2)) { pruned.push(active[worstIdx]); active.splice(worstIdx, 1); changed = true; }
	}
	if (pruned.length === 0) return { groups: [new Set(active.length === n ? active : [...Array(n).keys()])], removed, changed: false };
	if (active.length >= 2) groups.push(new Set(active)); else active.forEach((i) => removed.add(i));
	const visited = new Set();
	for (const seed of pruned) {
		if (visited.has(seed)) continue;
		const comp = [], q = [seed]; visited.add(seed);
		while (q.length) { const cur = q.shift(); comp.push(cur); for (const o of pruned) if (!visited.has(o) && similar[cur][o]) { visited.add(o); q.push(o); } }
		if (comp.length >= 2) {
			let sub = [...comp], ch = true;
			while (ch && sub.length >= 2) {
				ch = false;
				let wi = -1, wc = Infinity;
				for (let ai = 0; ai < sub.length; ai++) { let c = 0; for (let aj = 0; aj < sub.length; aj++) if (ai !== aj && similar[sub[ai]][sub[aj]]) c++; if (c < wc) { wc = c; wi = ai; } }
				if (wc < Math.floor(sub.length / 2)) { removed.add(sub[wi]); sub.splice(wi, 1); ch = true; }
			}
			if (sub.length >= 2) groups.push(new Set(sub)); else sub.forEach((i) => removed.add(i));
		} else removed.add(comp[0]);
	}
	return { groups, removed, changed: true };
}

function randomGraph(r, n, density) {
	const m = Array.from({ length: n }, () => new Array(n).fill(false));
	for (let i = 0; i < n; i++) { m[i][i] = true; for (let j = i + 1; j < n; j++) m[i][j] = m[j][i] = r.next() < density; }
	return m;
}
function structuredGraph(r, n) {
	const m = Array.from({ length: n }, () => new Array(n).fill(false));
	const cliques = Math.max(1, r.int(1, 5));
	const size = Math.max(1, Math.floor(n / cliques));
	for (let i = 0; i < n; i++) {
		m[i][i] = true;
		for (let j = i + 1; j < n; j++) {
			const same = Math.floor(i / size) === Math.floor(j / size);
			const bridge = j === i + 1 && !same && r.next() < 0.7;
			const noise = r.next() < 0.03;
			m[i][j] = m[j][i] = (same && r.next() < 0.9) || bridge || noise;
		}
	}
	return m;
}
function assertSame(similar) {
	const n = similar.length;
	const ref = referenceSplit(similar);
	const res = daisySplit(n, (i, j) => similar[i][j], Infinity);
	assert.strictEqual(res.skipped, false);
	assert.strictEqual(res.changed, ref.changed);
	assert.deepStrictEqual(new Set(res.removed), ref.removed);
	assert.strictEqual(res.groups.length, ref.groups.length);
	for (const g of ref.groups) assert.ok(res.groups.some((a) => a.length === g.size && a.every((x) => g.has(x))));
	const all = [...res.groups.flat(), ...res.removed];
	assert.strictEqual(all.length, n);
	assert.strictEqual(new Set(all).size, n);
}

test('daisy split matches VDF reference on random graphs', () => {
	for (const [base, density] of [[1, 0.1], [2, 0.3], [3, 0.5], [4, 0.7], [5, 0.9]])
		for (let seed = 0; seed < 60; seed++) {
			const r = rng(base * 1000 + seed);
			assertSame(randomGraph(r, r.int(3, 48), density));
		}
});

test('daisy split matches reference on clique chains and across word boundaries', () => {
	for (let seed = 0; seed < 150; seed++) { const r = rng(7000 + seed); assertSame(structuredGraph(r, r.int(3, 90))); }
	for (let seed = 0; seed < 10; seed++) { const r = rng(9000 + seed); assertSame(randomGraph(r, 64 + r.int(0, 140), 0.5)); }
});

test('star prunes a leaf and keeps a core of three', () => {
	const n = 4;
	const m = Array.from({ length: n }, () => new Array(n).fill(false));
	for (let i = 0; i < n; i++) { m[i][i] = true; m[0][i] = m[i][0] = true; }
	const r = daisySplit(n, (i, j) => m[i][j], Infinity);
	assert.ok(r.changed);
	assert.deepStrictEqual(r.groups, [[0, 2, 3]]);
	assert.deepStrictEqual(r.removed, [1]);
});

test('full clique unchanged; tiny groups unchanged; over budget skipped', () => {
	const r = daisySplit(5, () => true, Infinity);
	assert.strictEqual(r.changed, false);
	assert.deepStrictEqual(r.groups, [[0, 1, 2, 3, 4]]);
	for (const n of [0, 1]) assert.strictEqual(daisySplit(n, () => false, Infinity).changed, false);
	let calls = 0;
	const s = daisySplit(10, () => { calls++; return false; }, 0);
	assert.ok(s.skipped); assert.strictEqual(calls, 0);
});

test('pair bit matrix stores every pair once; degrees right', () => {
	const n = 203;
	const exp = randomGraph(rng(42), n, 0.4);
	const m = new PairBitMatrix(n);
	for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (exp[i][j]) m.set(i, j);
	for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) assert.strictEqual(m.get(i, j), i !== j && exp[i][j]);
	const deg = m.degrees();
	for (let i = 0; i < n; i++) assert.strictEqual(deg[i], exp[i].filter((v, j) => j !== i && v).length);
});

test('group builder: representative gating blocks daisy merges', () => {
	// 0~1, 1~2, but 0 !~ 2 -> 2 must not join 0's group via 1
	const sim = (a, b) => Math.abs(a - b) <= 1;
	const gb = new GroupBuilder(sim);
	gb.add(0, 1, 0.01, 0);
	gb.add(1, 2, 0.02, 0);
	const groups = gb.groups();
	assert.strictEqual(groups.length, 1);
	assert.deepStrictEqual(groups[0].map((x) => x.index).sort(), [0, 1]);
	assert.strictEqual(gb.mergesBlocked, 1);
});

test('group builder: merges two groups when representatives match', () => {
	const sim = () => true;
	const gb = new GroupBuilder(sim);
	gb.add(0, 1, 0.1, 0);
	gb.add(2, 3, 0.1, 1);
	gb.add(1, 3, 0.1, 0);
	const groups = gb.groups();
	assert.strictEqual(groups.length, 1);
	assert.deepStrictEqual(groups[0].map((x) => x.index).sort(), [0, 1, 2, 3]);
	// the comp item of a new pair carries the pair flags, the entry item carries none
	const three = groups[0].find((x) => x.index === 3);
	assert.strictEqual(three.flags, 1);
});
