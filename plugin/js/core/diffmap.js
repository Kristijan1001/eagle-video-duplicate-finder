'use strict';
// Port of VDF.GUI/Data/DifferenceMap.cs: the comparer's "Highlight differences". Turns two
// frames into a mask of regions that differ STRUCTURALLY (logos, subtitles, crop bars) while
// staying blind to global brightness/contrast/colour-grade shifts and codec noise: each
// image is reduced to luma, normalised to zero mean / unit variance (an affine brightness or
// contrast change cancels exactly), blurred, differenced and thresholded; the mask is then
// grouped into at most MAX_REGIONS rectangles.

const MAX_ANALYSIS_SIZE = 384;
const MAX_REGIONS = 12;
const REGION_MERGE_GAP = 3;
const MIN_REGION_PIXELS = 4;
const REGION_PADDING = 2;

/** Analysis grid for a source frame: fit within max, never upscale. */
function analysisSize(srcWidth, srcHeight, max = MAX_ANALYSIS_SIZE) {
	if (srcWidth <= 0 || srcHeight <= 0) return [0, 0];
	const scale = Math.min(1, max / Math.max(srcWidth, srcHeight));
	return [Math.max(1, Math.round(srcWidth * scale)), Math.max(1, Math.round(srcHeight * scale))];
}

/**
 * LumaDownscaler: box-average an RGBA buffer (canvas ImageData layout) down to the analysis
 * grid. Source pixels map to cells by integer projection; every pixel lands in one cell.
 */
function downscaleLuma(rgba, srcWidth, srcHeight, dstWidth, dstHeight) {
	const sums = new Float32Array(dstWidth * dstHeight);
	const counts = new Int32Array(dstWidth * dstHeight);
	const colOf = new Int32Array(srcWidth);
	for (let x = 0; x < srcWidth; x++) colOf[x] = Math.min(dstWidth - 1, Math.floor(x * dstWidth / srcWidth));
	for (let y = 0; y < srcHeight; y++) {
		const rowBase = Math.min(dstHeight - 1, Math.floor(y * dstHeight / srcHeight)) * dstWidth;
		let o = y * srcWidth * 4;
		for (let x = 0; x < srcWidth; x++, o += 4) {
			const c = rowBase + colOf[x];
			sums[c] += 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
			counts[c]++;
		}
	}
	const out = new Float32Array(sums.length);
	for (let i = 0; i < sums.length; i++) out[i] = counts[i] > 0 ? sums[i] / counts[i] : 0;
	return out;
}

/** Zero-mean / unit-variance; a flat image has no structure and maps to all zeros. */
function normalize(luma) {
	const out = new Float32Array(luma.length);
	if (!luma.length) return out;
	let sum = 0;
	for (let i = 0; i < luma.length; i++) sum += luma[i];
	const mean = sum / luma.length;
	let v = 0;
	for (let i = 0; i < luma.length; i++) { const d = luma[i] - mean; v += d * d; }
	const std = Math.sqrt(v / luma.length);
	if (std < 1e-4) return out;
	for (let i = 0; i < luma.length; i++) out[i] = (luma[i] - mean) / std;
	return out;
}

/** 3x3 box blur with clamped edges, separable passes. */
function boxBlur3(src, width, height) {
	const tmp = new Float32Array(src.length);
	const dst = new Float32Array(src.length);
	for (let y = 0; y < height; y++) {
		const r = y * width;
		for (let x = 0; x < width; x++) tmp[r + x] = (src[r + Math.max(0, x - 1)] + src[r + x] + src[r + Math.min(width - 1, x + 1)]) / 3;
	}
	for (let y = 0; y < height; y++) {
		const up = Math.max(0, y - 1) * width, mid = y * width, down = Math.min(height - 1, y + 1) * width;
		for (let x = 0; x < width; x++) dst[mid + x] = (tmp[up + x] + tmp[mid + x] + tmp[down + x]) / 3;
	}
	return dst;
}

/** Slider (0..1, higher = more sensitive) → threshold in normalised luma units. */
function thresholdFor(sensitivity) {
	return 1.8 - 1.55 * Math.min(1, Math.max(0, Number(sensitivity) || 0));
}

/** Threshold plus speck removal: a passing pixel needs at least two passing 8-neighbours. */
function thresholdMask(diff, width, height, threshold) {
	const pass = new Uint8Array(width * height);
	for (let i = 0; i < pass.length; i++) pass[i] = diff[i] >= threshold ? 1 : 0;
	const mask = new Uint8Array(width * height);
	const scale = Math.max(threshold, 1e-3);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = y * width + x;
			if (!pass[i]) continue;
			let n = 0;
			for (let dy = -1; dy <= 1; dy++) {
				const ny = y + dy;
				if (ny < 0 || ny >= height) continue;
				for (let dx = -1; dx <= 1; dx++) {
					if (!dx && !dy) continue;
					const nx = x + dx;
					if (nx >= 0 && nx < width && pass[ny * width + nx]) n++;
				}
			}
			if (n < 2) continue;
			const over = (diff[i] - threshold) / scale;
			mask[i] = 90 + Math.trunc(140 * Math.min(1, over * 0.5));
		}
	}
	return mask;
}

/** Full pipeline on two same-size luma grids → per-pixel alpha mask (0 = agree). */
function compute(lumaA, lumaB, width, height, sensitivity) {
	if (lumaA.length !== width * height || lumaB.length !== width * height) throw new Error('Luma arrays must match width * height');
	const a = boxBlur3(normalize(lumaA), width, height);
	const b = boxBlur3(normalize(lumaB), width, height);
	let diff = new Float32Array(width * height);
	for (let i = 0; i < diff.length; i++) diff[i] = Math.abs(a[i] - b[i]);
	diff = boxBlur3(diff, width, height);
	return thresholdMask(diff, width, height, thresholdFor(sensitivity));
}

/**
 * Rectangles around the mask: 8-way connected components, tiny ones dropped, neighbours
 * within REGION_MERGE_GAP fused, the largest maxRegions kept. Normalised to 0..1.
 */
function findRegions(mask, width, height, maxRegions = MAX_REGIONS) {
	let boxes = [];
	const visited = new Uint8Array(width * height);
	const stack = [];
	for (let start = 0; start < mask.length; start++) {
		if (!mask[start] || visited[start]) continue;
		let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, pixels = 0;
		visited[start] = 1;
		stack.push(start);
		while (stack.length) {
			const i = stack.pop();
			const x = i % width, y = (i - x) / width;
			pixels++;
			if (x < minX) minX = x; if (x > maxX) maxX = x;
			if (y < minY) minY = y; if (y > maxY) maxY = y;
			for (let dy = -1; dy <= 1; dy++) {
				const ny = y + dy;
				if (ny < 0 || ny >= height) continue;
				for (let dx = -1; dx <= 1; dx++) {
					const nx = x + dx;
					if (nx < 0 || nx >= width) continue;
					const ni = ny * width + nx;
					if (!mask[ni] || visited[ni]) continue;
					visited[ni] = 1;
					stack.push(ni);
				}
			}
		}
		if (pixels >= MIN_REGION_PIXELS) boxes.push({ minX, minY, maxX, maxY, pixels });
	}
	let merged = true;
	while (merged) {
		merged = false;
		outer: for (let i = 0; i < boxes.length; i++) {
			for (let j = i + 1; j < boxes.length; j++) {
				const a = boxes[i], b = boxes[j];
				const sepX = Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX) - 1;
				const sepY = Math.max(a.minY, b.minY) - Math.min(a.maxY, b.maxY) - 1;
				if (sepX <= REGION_MERGE_GAP && sepY <= REGION_MERGE_GAP) {
					boxes[i] = { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY), pixels: a.pixels + b.pixels };
					boxes.splice(j, 1);
					merged = true;
					break outer;
				}
			}
		}
	}
	boxes.sort((a, b) => b.pixels - a.pixels);
	if (boxes.length > maxRegions) boxes = boxes.slice(0, maxRegions);
	return boxes.map((b) => {
		const x0 = Math.max(0, b.minX - REGION_PADDING), y0 = Math.max(0, b.minY - REGION_PADDING);
		const x1 = Math.min(width - 1, b.maxX + REGION_PADDING), y1 = Math.min(height - 1, b.maxY + REGION_PADDING);
		return { x: x0 / width, y: y0 / height, width: (x1 - x0 + 1) / width, height: (y1 - y0 + 1) / height };
	});
}

/**
 * Convenience for the UI: two RGBA frames (canvas ImageData of any size; B is resampled
 * onto A's analysis grid by the caller drawing it at A's size) → { regions, coverage }.
 */
function diffFrames(a, b, sensitivity) {
	const [w, h] = analysisSize(a.width, a.height);
	if (!w || !h || b.width !== a.width || b.height !== a.height) return null;
	const mask = compute(downscaleLuma(a.data, a.width, a.height, w, h), downscaleLuma(b.data, b.width, b.height, w, h), w, h, sensitivity);
	let on = 0;
	for (let i = 0; i < mask.length; i++) if (mask[i]) on++;
	return { regions: findRegions(mask, w, h), coverage: on / mask.length };
}

module.exports = {
	MAX_ANALYSIS_SIZE, MAX_REGIONS,
	analysisSize, downscaleLuma, normalize, boxBlur3, thresholdFor, thresholdMask, compute, findRegions, diffFrames,
};
