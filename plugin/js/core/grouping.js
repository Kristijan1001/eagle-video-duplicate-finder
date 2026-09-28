'use strict';
// Port of VDF's group building (ScanEngine.ScanForDuplicates → MergeDuplicate) and the
// daisy-chain validation (ScanEngine.SplitDaisyChainGroups + Utils/DaisyChainSplitter.cs),
// VideoDuplicateFinder, AGPL-3.0.

/**
 * Builds duplicate groups from pairs, exactly like VDF's MergeDuplicate: a new item may
 * only join a group when it also matches that group's representative, and two groups only
 * merge when their representatives match. This stops one bridging pair from chaining
 * unrelated groups together.
 *
 * Pairs must be fed in a deterministic order; the engine feeds them sorted by
 * (entry index, candidate index), which is VDF's sequential compare order.
 */
class GroupBuilder {
	/** @param {(repIdx:number, idx:number) => boolean} isSimilar  CheckIfDuplicate(rep, x) */
	constructor(isSimilar) {
		this.isSimilar = isSimilar;
		this.byIndex = new Map();        // entry index -> item {index, groupId, difference, flags}
		this.members = new Map();        // groupId -> item[]
		this.representative = new Map(); // groupId -> entry index
		this.nextGroupId = 1;
		this.mergesBlocked = 0;
	}

	/** MergeDuplicate(entry, compItem, difference, flags). */
	add(entry, comp, difference, flags) {
		const base = this.byIndex.get(entry);
		const other = this.byIndex.get(comp);
		if (base && other) {
			if (base.groupId === other.groupId) return;
			const repBase = this.representative.get(base.groupId);
			const repComp = this.representative.get(other.groupId);
			if (repBase !== undefined && repComp !== undefined && !this.isSimilar(repBase, repComp)) {
				this.mergesBlocked++;
				return;
			}
			const absorbed = other.groupId;
			const target = this.members.get(base.groupId);
			for (const it of this.members.get(absorbed)) {
				it.groupId = base.groupId;
				target.push(it);
			}
			this.members.delete(absorbed);
			this.representative.delete(absorbed);
			return;
		}
		if (base) {
			const rep = this.representative.get(base.groupId);
			if (rep !== undefined && !this.isSimilar(rep, comp)) { this.mergesBlocked++; return; }
			const item = { index: comp, groupId: base.groupId, difference, flags };
			this.byIndex.set(comp, item);
			this.members.get(base.groupId).push(item);
			return;
		}
		if (other) {
			const rep = this.representative.get(other.groupId);
			if (rep !== undefined && !this.isSimilar(rep, entry)) { this.mergesBlocked++; return; }
			const item = { index: entry, groupId: other.groupId, difference, flags };
			this.byIndex.set(entry, item);
			this.members.get(other.groupId).push(item);
			return;
		}
		const groupId = this.nextGroupId++;
		const compItem = { index: comp, groupId, difference, flags };
		const entryItem = { index: entry, groupId, difference, flags: 0 };
		this.byIndex.set(comp, compItem);
		this.byIndex.set(entry, entryItem);
		this.members.set(groupId, [compItem, entryItem]);
		this.representative.set(groupId, entry);
	}

	/** All groups as arrays of items (each with >= 2 members). */
	groups() {
		return [...this.members.values()];
	}
}

// ── Daisy-chain validation ──

/**
 * Upper triangle of an n×n bit matrix; pair (i, j), i < j, lives in row i at bit j-i-1.
 * Rows start on their own 32-bit word.
 */
class PairBitMatrix {
	constructor(n) {
		this.n = n;
		this.rowStart = new Float64Array(Math.max(0, n - 1));
		let total = 0;
		for (let i = 0; i < n - 1; i++) {
			this.rowStart[i] = total;
			total += Math.ceil((n - 1 - i) / 32);
		}
		this.words = new Uint32Array(total);
	}
	static estimateBytes(n) {
		let total = 0;
		for (let i = 0; i < n - 1; i++) total += Math.ceil((n - 1 - i) / 32);
		return total * 4;
	}
	set(i, j) {
		const bit = j - i - 1;
		this.words[this.rowStart[i] + (bit >>> 5)] |= (1 << (bit & 31));
	}
	get(a, b) {
		if (a === b) return false;
		if (a > b) { const t = a; a = b; b = t; }
		const bit = b - a - 1;
		return (this.words[this.rowStart[a] + (bit >>> 5)] & (1 << (bit & 31))) !== 0;
	}
	degrees() {
		const n = this.n;
		const deg = new Int32Array(n);
		for (let i = 0; i < n; i++)
			for (let j = i + 1; j < n; j++)
				if (this.get(i, j)) { deg[i]++; deg[j]++; }
		return deg;
	}
}

/** Repeatedly drop the least-connected node while it matches fewer than half of the others. */
function pruneByMajority(nodes, degrees, matrix) {
	const count = nodes.length;
	const alive = new Uint8Array(count).fill(1);
	let aliveCount = count;
	const pruned = [];
	while (aliveCount >= 2) {
		let worst = -1, worstDegree = Infinity;
		for (let k = 0; k < count; k++)
			if (alive[k] && degrees[k] < worstDegree) { worstDegree = degrees[k]; worst = k; }
		const required = aliveCount >> 1;
		if (worstDegree >= required) break;
		alive[worst] = 0;
		aliveCount--;
		const removed = nodes[worst];
		pruned.push(removed);
		for (let k = 0; k < count; k++)
			if (alive[k] && matrix.get(removed, nodes[k])) degrees[k]--;
	}
	const kept = [];
	for (let k = 0; k < count; k++) if (alive[k]) kept.push(nodes[k]);
	return { kept, pruned };
}

/**
 * DaisyChainSplitter.Split. isSimilar(i, j) over member indices 0..n-1.
 * Returns { skipped, changed, groups: number[][], removed: number[] }.
 */
function daisySplit(n, isSimilar, budgetBytes = 1 << 30) {
	if (PairBitMatrix.estimateBytes(n) > budgetBytes)
		return { skipped: true, changed: false, groups: [range(n)], removed: [] };
	const matrix = new PairBitMatrix(n);
	for (let i = 0; i < n - 1; i++)
		for (let j = i + 1; j < n; j++)
			if (isSimilar(i, j)) matrix.set(i, j);
	return splitWithMatrix(n, matrix);
}

function splitWithMatrix(n, matrix) {
	const degrees = matrix.degrees();
	const all = range(n);
	const { kept: core, pruned } = pruneByMajority(all, Array.from(degrees), matrix);
	if (pruned.length === 0) return { skipped: false, changed: false, groups: [all], removed: [] };

	const result = { skipped: false, changed: true, groups: [], removed: [] };
	if (core.length >= 2) result.groups.push(core);
	else result.removed.push(...core);

	const visited = new Uint8Array(n);
	for (const seed of pruned) {
		if (visited[seed]) continue;
		const component = [];
		const queue = [seed];
		visited[seed] = 1;
		while (queue.length) {
			const cur = queue.shift();
			component.push(cur);
			for (const other of pruned)
				if (!visited[other] && matrix.get(cur, other)) { visited[other] = 1; queue.push(other); }
		}
		if (component.length < 2) { result.removed.push(component[0]); continue; }
		const sub = new Array(component.length).fill(0);
		for (let a = 0; a < component.length; a++)
			for (let b = a + 1; b < component.length; b++)
				if (matrix.get(component[a], component[b])) { sub[a]++; sub[b]++; }
		const { kept, pruned: dropped } = pruneByMajority(component, sub, matrix);
		result.removed.push(...dropped);
		if (kept.length >= 2) result.groups.push(kept);
		else result.removed.push(...kept);
	}
	return result;
}

function range(n) { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = i; return a; }

module.exports = {
	GroupBuilder,
	PairBitMatrix,
	pruneByMajority,
	daisySplit,
	splitWithMatrix,
};
