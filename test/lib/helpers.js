'use strict';
const path = require('path');

const PLUGIN = path.resolve(__dirname, '..', '..', 'plugin');

/** require() a plugin module by its path under plugin/js. */
function core(rel) {
	return require(path.join(PLUGIN, 'js', rel));
}

/** Deterministic PRNG (mulberry32) for reproducible random test vectors. */
function rng(seed) {
	let a = seed >>> 0;
	const next = () => {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return {
		next,
		int: (lo, hi) => lo + Math.floor(next() * (hi - lo)), // [lo, hi)
		bytes: (n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = Math.floor(next() * 256); return b; },
	};
}

function blur(src, radius) {
	const dst = new Uint8Array(1024);
	for (let y = 0; y < 32; y++)
		for (let x = 0; x < 32; x++) {
			let sum = 0, cnt = 0;
			for (let dy = -radius; dy <= radius; dy++)
				for (let dx = -radius; dx <= radius; dx++) {
					const yy = y + dy, xx = x + dx;
					if (yy < 0 || yy >= 32 || xx < 0 || xx >= 32) continue;
					sum += src[yy * 32 + xx];
					cnt++;
				}
			dst[y * 32 + x] = Math.floor(sum / cnt);
		}
	return dst;
}

module.exports = { PLUGIN, core, rng, blur };
