'use strict';
// Port of VDF.Core/Utils/GrayBytesUtils.cs (VideoDuplicateFinder, AGPL-3.0).
// A "gray frame" is a 32x32 8-bit grayscale thumbnail (1024 bytes) produced by FFmpeg.

const { f } = require('./f32');

const SIDE = 32;
const OLD_SIDE = 16;
const GRAY_LENGTH = SIDE * SIDE; // 1024
const BLACK_PIXEL_LIMIT = 0x20;
const WHITE_PIXEL_LIMIT = 0xF0;
const BRIGHTNESS_SCALE = 256;

function assertSameLength(a, b) {
	if (a.length !== b.length)
		throw new Error(`Gray frame length mismatch: ${a.length} vs ${b.length} bytes.`);
}

/**
 * False when at least `darkPercent` % of the pixels are dark (<= 0x20).
 * C#: `100d / data.Length * darkPixels < darkProcent` (double arithmetic).
 */
function verifyGrayScaleValues(data, darkPercent = 80) {
	let dark = 0;
	for (let i = 0; i < data.length; i++)
		if (data[i] <= BLACK_PIXEL_LIMIT) dark++;
	return 100 / data.length * dark < darkPercent;
}

/** RGB24 variant: a pixel is dark when every channel is <= 0x20. */
function verifyRgbFrameValues(rgb, darkPercent = 80) {
	const pixels = Math.floor(rgb.length / 3);
	if (pixels === 0) return false;
	let dark = 0;
	for (let i = 0; i + 2 < rgb.length; i += 3)
		if (rgb[i] <= BLACK_PIXEL_LIMIT && rgb[i + 1] <= BLACK_PIXEL_LIMIT && rgb[i + 2] <= BLACK_PIXEL_LIMIT)
			dark++;
	return 100 / pixels * dark < darkPercent;
}

/**
 * Mean absolute difference of two gray frames, scaled to 0..~1.
 * C#: `(float)diff / img1.Length / brightnessScalePerPixel`.
 */
function percentageDifference(a, b) {
	assertSameLength(a, b);
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		const d = a[i] - b[i];
		diff += d < 0 ? -d : d;
	}
	return f(f(f(diff) / a.length) / BRIGHTNESS_SCALE);
}

/**
 * Like percentageDifference, but pixels that are black (<= 0x20) or white (>= 0xF0) in
 * EITHER frame are left out of the mean. All pixels excluded -> NaN (0/0), exactly like C#,
 * and the matcher treats NaN as "not a duplicate".
 */
function percentageDifferenceWithoutSpecificPixels(a, b, ignoreBlack, ignoreWhite) {
	assertSameLength(a, b);
	if (!ignoreBlack && !ignoreWhite)
		return percentageDifference(a, b);
	let diff = 0;
	let counter = 0;
	for (let i = 0; i < a.length; i++) {
		const x = a[i], y = b[i];
		if (ignoreBlack && (x <= BLACK_PIXEL_LIMIT || y <= BLACK_PIXEL_LIMIT)) continue;
		if (ignoreWhite && (x >= WHITE_PIXEL_LIMIT || y >= WHITE_PIXEL_LIMIT)) continue;
		const d = x - y;
		diff += d < 0 ? -d : d;
		counter++;
	}
	return f(f(f(diff) / f(counter)) / BRIGHTNESS_SCALE);
}

/** Mirror a square gray frame horizontally (each row reversed). Side derived from length. */
function flipGrayScale(img) {
	const side = Math.round(Math.sqrt(img.length));
	if (side * side !== img.length) throw new Error('Invalid gray frame length');
	const dst = new Uint8Array(img.length);
	for (let y = 0; y < side; y++) {
		const base = y * side;
		for (let x = 0; x < side; x++)
			dst[base + x] = img[base + side - 1 - x];
	}
	return dst;
}

module.exports = {
	SIDE,
	OLD_SIDE,
	GRAY_LENGTH,
	BLACK_PIXEL_LIMIT,
	WHITE_PIXEL_LIMIT,
	verifyGrayScaleValues,
	verifyRgbFrameValues,
	percentageDifference,
	percentageDifferenceWithoutSpecificPixels,
	flipGrayScale,
};
