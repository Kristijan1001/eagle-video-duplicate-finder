'use strict';
// Storage classification for read concurrency — port of VDF.Core/Utils/DriveScanPlanner.cs
// (VideoDuplicateFinder, AGPL-3.0). Every Eagle file lives under the library folder, so there
// is exactly one drive to classify: override > OS seek-penalty query > seek-latency probe.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const SEEK_LATENCY_THRESHOLD_MS = 3.0;
const cache = new Map();

/** Windows: MediaType of the physical disk behind a drive letter via PowerShell (HDD/SSD/null). */
function queryWindowsMediaType(libraryPath) {
	return new Promise((resolve) => {
		const m = /^([A-Za-z]):/.exec(libraryPath || '');
		if (process.platform !== 'win32' || !m) { resolve(null); return; }
		const script = `$p = Get-Partition -DriveLetter '${m[1]}' -ErrorAction SilentlyContinue; if ($p) { $d = Get-PhysicalDisk | Where-Object DeviceId -eq $p.DiskNumber; if ($d) { "$($d.MediaType)|$($d.BusType)" } }`;
		execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
			if (err) { resolve(null); return; }
			const [media, bus] = String(stdout || '').trim().split('|');
			if (/^HDD$/i.test(media)) resolve({ fast: false, source: `OS reports HDD${bus ? ' (' + bus + ')' : ''}` });
			else if (/^SSD$/i.test(media)) resolve({ fast: true, source: `OS reports SSD${bus ? ' (' + bus + ')' : ''}` });
			else resolve(null);
		});
	});
}

/** Median latency of 6 random 64 KB reads from one file > 1 MB (fixed-seed offsets). */
function probeSeekLatencyMs(candidatePaths) {
	const block = 64 * 1024;
	let file = null;
	for (const p of candidatePaths) {
		try { if (fs.statSync(p).size > (1 << 20)) { file = p; break; } } catch { /* next */ }
	}
	if (!file) return null;
	let fd;
	try {
		fd = fs.openSync(file, 'r');
		const size = fs.fstatSync(fd).size;
		if (size <= block) return null;
		const buf = Buffer.alloc(block);
		let seed = 0x5eed;
		const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
		const times = [];
		for (let i = 0; i < 6; i++) {
			const offset = Math.floor(rnd() * (size - block)) & ~4095;
			const t0 = process.hrtime.bigint();
			const n = fs.readSync(fd, buf, 0, block, offset);
			const t1 = process.hrtime.bigint();
			if (n > 0) times.push(Number(t1 - t0) / 1e6);
		}
		if (!times.length) return null;
		times.sort((a, b) => a - b);
		return times[times.length >> 1];
	}
	catch { return null; }
	finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

/**
 * Classify the library drive. Returns { fast: boolean, source: string }.
 * override: 'auto' | 'ssd' | 'hdd'.
 */
async function classify(libraryPath, override, samplePaths) {
	if (override === 'ssd') return { fast: true, source: 'override (SSD)' };
	if (override === 'hdd') return { fast: false, source: 'override (HDD)' };
	const key = path.parse(libraryPath || '').root.toLowerCase();
	if (cache.has(key)) return cache.get(key);
	let result = null;
	if ((libraryPath || '').startsWith('\\\\')) result = { fast: false, source: 'network share' };
	if (!result) result = await queryWindowsMediaType(libraryPath);
	if (!result) {
		const ms = probeSeekLatencyMs(samplePaths || []);
		if (ms != null) result = { fast: ms < SEEK_LATENCY_THRESHOLD_MS, source: `seek probe ${ms.toFixed(1)} ms` };
	}
	if (!result) result = { fast: false, source: 'unknown (treated as slow)' };
	cache.set(key, result);
	return result;
}

/** DriveScanPlanner.AssignParallelism for a single drive. */
function readParallelism(fast, maxDegree, hddMax) {
	if (maxDegree === 1) return 1;
	const budget = Math.max(1, maxDegree <= 0 ? os.cpus().length : maxDegree);
	const hddCap = hddMax > 0 ? hddMax : 2;
	return fast ? budget : Math.min(hddCap, budget);
}

/** ScanEngine.CalculateMatchingParallelism (MatchingMaxDegreeOfParallelism; 0 = automatic). */
function matchingParallelism(configured, processorCount = os.cpus().length) {
	processorCount = Math.max(1, processorCount);
	if (configured > 0) return Math.min(configured, processorCount);
	const reserved = processorCount >= 8 ? 2 : processorCount >= 2 ? 1 : 0;
	const reserveCap = Math.max(1, processorCount - reserved);
	const percentageCap = Math.max(1, Math.ceil(processorCount * 0.80));
	return Math.min(reserveCap, percentageCap);
}

module.exports = { classify, readParallelism, matchingParallelism, probeSeekLatencyMs, SEEK_LATENCY_THRESHOLD_MS };
