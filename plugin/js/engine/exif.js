'use strict';
// Minimal EXIF reader — port of VDF.Core/Utils/ExifReader.cs (VideoDuplicateFinder, AGPL-3.0).
// Finds the TIFF blob in JPEG (APP1), raw TIFF, PNG (eXIf) or WebP (EXIF chunk) and reads
// DateTimeOriginal (falling back to IFD0 DateTime). Also lists readable tags for the
// metadata comparison view.

const fs = require('fs');

const TAG_DATETIME = 0x0132;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATETIME_ORIGINAL = 0x9003;
const MAX_BLOB = 1 << 20;

const TAG_NAMES = {
	0x010F: 'Make', 0x0110: 'Model', 0x0112: 'Orientation', 0x011A: 'XResolution', 0x011B: 'YResolution',
	0x0128: 'ResolutionUnit', 0x0131: 'Software', 0x0132: 'DateTime', 0x013B: 'Artist', 0x8298: 'Copyright',
	0x829A: 'ExposureTime', 0x829D: 'FNumber', 0x8822: 'ExposureProgram', 0x8827: 'ISOSpeedRatings',
	0x9000: 'ExifVersion', 0x9003: 'DateTimeOriginal', 0x9004: 'DateTimeDigitized', 0x9201: 'ShutterSpeedValue',
	0x9202: 'ApertureValue', 0x9204: 'ExposureBiasValue', 0x9207: 'MeteringMode', 0x9209: 'Flash',
	0x920A: 'FocalLength', 0xA002: 'PixelXDimension', 0xA003: 'PixelYDimension', 0xA405: 'FocalLengthIn35mmFilm',
	0xA433: 'LensMake', 0xA434: 'LensModel', 0x0001: 'GPSLatitudeRef', 0x0002: 'GPSLatitude', 0x0003: 'GPSLongitudeRef',
	0x0004: 'GPSLongitude', 0x0006: 'GPSAltitude',
};

function readHead(file, max = 4 << 20) {
	const fd = fs.openSync(file, 'r');
	try {
		const size = fs.fstatSync(fd).size;
		const buf = Buffer.alloc(Math.min(size, max));
		fs.readSync(fd, buf, 0, buf.length, 0);
		return buf;
	}
	finally { fs.closeSync(fd); }
}

function extractTiffBlob(buf) {
	if (buf.length < 12) return null;
	// JPEG
	if (buf[0] === 0xFF && buf[1] === 0xD8) {
		let p = 2;
		while (p + 4 <= buf.length) {
			if (buf[p] !== 0xFF) return null;
			const marker = buf[p + 1];
			if (marker === 0xD9 || marker === 0xDA) return null;
			const len = buf.readUInt16BE(p + 2);
			if (marker === 0xE1 && len >= 8 && buf.toString('latin1', p + 4, p + 10) === 'Exif\0\0')
				return buf.subarray(p + 10, Math.min(buf.length, p + 2 + len));
			p += 2 + len;
		}
		return null;
	}
	// raw TIFF
	if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2A && buf[3] === 0) || (buf[0] === 0x4D && buf[1] === 0x4D && buf[2] === 0 && buf[3] === 0x2A))
		return buf.subarray(0, Math.min(buf.length, MAX_BLOB));
	// PNG
	if (buf.readUInt32BE(0) === 0x89504E47) {
		let p = 8;
		while (p + 8 <= buf.length) {
			const len = buf.readUInt32BE(p);
			const type = buf.toString('latin1', p + 4, p + 8);
			if (type === 'eXIf') return buf.subarray(p + 8, Math.min(buf.length, p + 8 + len));
			if (type === 'IEND') return null;
			p += 12 + len;
		}
		return null;
	}
	// WebP
	if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
		let p = 12;
		while (p + 8 <= buf.length) {
			const type = buf.toString('latin1', p, p + 4);
			const len = buf.readUInt32LE(p + 4);
			if (type === 'EXIF') {
				let blob = buf.subarray(p + 8, Math.min(buf.length, p + 8 + len));
				if (blob.toString('latin1', 0, 6) === 'Exif\0\0') blob = blob.subarray(6);
				return blob;
			}
			p += 8 + len + (len & 1);
		}
	}
	return null;
}

function tiffReader(t) {
	if (t.length < 8) return null;
	const le = t[0] === 0x49;
	const u16 = (o) => (o + 2 <= t.length ? (le ? t.readUInt16LE(o) : t.readUInt16BE(o)) : 0);
	const u32 = (o) => (o + 4 <= t.length ? (le ? t.readUInt32LE(o) : t.readUInt32BE(o)) : 0);
	return { le, u16, u32 };
}

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function readIfd(t, r, offset, visit) {
	if (offset <= 0 || offset + 2 > t.length) return;
	const n = r.u16(offset);
	for (let i = 0; i < n; i++) {
		const e = offset + 2 + i * 12;
		if (e + 12 > t.length) return;
		const tag = r.u16(e), type = r.u16(e + 2), count = r.u32(e + 4);
		const size = (TYPE_SIZE[type] || 1) * count;
		const valueOffset = size <= 4 ? e + 8 : r.u32(e + 8);
		visit(tag, type, count, valueOffset, e + 8);
	}
}

function asciiAt(t, off, count) {
	if (off < 0 || off >= t.length) return null;
	return t.toString('latin1', off, Math.min(t.length, off + count)).replace(/\0+$/, '').trim();
}

function parseDate(raw) {
	const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw || '');
	if (!m) return null;
	const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
	if (y < 1800 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
	const t = new Date(y, mo - 1, d, h, mi, s).getTime();
	return Number.isFinite(t) ? t : null;
}

/** DateTimeOriginal (or DateTime) as epoch ms, or null. */
function dateTaken(file) {
	try {
		const t = extractTiffBlob(readHead(file));
		if (!t) return null;
		const r = tiffReader(t);
		if (!r) return null;
		let dt = null, dto = null, exifPtr = 0;
		readIfd(t, r, r.u32(4), (tag, type, count, vo) => {
			if (tag === TAG_DATETIME && type === 2) dt = asciiAt(t, vo, count);
			if (tag === TAG_EXIF_IFD) exifPtr = r.u32(vo);
		});
		if (exifPtr) readIfd(t, r, exifPtr, (tag, type, count, vo) => {
			if (tag === TAG_DATETIME_ORIGINAL && type === 2) dto = asciiAt(t, vo, count);
		});
		return parseDate(dto) ?? parseDate(dt);
	}
	catch { return null; }
}

/** Readable tags [{gps, name, value}] for the metadata comparison. */
function allTags(file) {
	const out = [];
	try {
		const t = extractTiffBlob(readHead(file));
		if (!t) return out;
		const r = tiffReader(t);
		if (!r) return out;
		const visit = (gps) => (tag, type, count, vo) => {
			if (tag === TAG_EXIF_IFD || tag === TAG_GPS_IFD || tag === 0x927C) return;
			const name = TAG_NAMES[tag];
			let value = null;
			if (type === 2) value = asciiAt(t, vo, count);
			else if (type === 3 && count === 1) value = String(r.u16(vo));
			else if ((type === 4 || type === 9) && count === 1) value = String(r.u32(vo));
			else if ((type === 5 || type === 10) && count >= 1) {
				const vals = [];
				for (let i = 0; i < Math.min(count, 3); i++) { const a = r.u32(vo + i * 8), b = r.u32(vo + i * 8 + 4); vals.push(b ? +(a / b).toFixed(4) : 0); }
				value = vals.join(', ');
			}
			if (value != null && (name || type === 2)) out.push({ gps, name: name || `0x${tag.toString(16)}`, value });
		};
		let exifPtr = 0, gpsPtr = 0;
		readIfd(t, r, r.u32(4), (tag, type, count, vo, raw) => {
			if (tag === TAG_EXIF_IFD) exifPtr = r.u32(vo);
			if (tag === TAG_GPS_IFD) gpsPtr = r.u32(vo);
			visit(false)(tag, type, count, vo, raw);
		});
		if (exifPtr) readIfd(t, r, exifPtr, visit(false));
		if (gpsPtr) readIfd(t, r, gpsPtr, visit(true));
	}
	catch { /* no exif */ }
	return out;
}

module.exports = { dateTaken, allTags, extractTiffBlob, parseDate };
