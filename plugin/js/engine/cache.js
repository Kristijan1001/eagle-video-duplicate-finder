'use strict';
// Per-library fingerprint database — the Eagle counterpart of VDF's ScanDatabase.db.
// Entries are keyed by Eagle item id (stable across renames and library moves), validated
// against the file's size + mtime, and hold everything derived from the file's content:
// media info, gray frames keyed by sample position in seconds, pHashes, the audio
// fingerprint and AI embeddings.
//
// Storage: 64 shard files, each rewritten atomically (temp file + rename) only when dirty.
// A crash mid-save leaves the previous shard intact.

const fs = require('fs');
const path = require('path');
const { isItemId, fileFor } = require('../core/ids');

const MAGIC = 0x43464456; // 'VDFC' little-endian
const VERSION = 2;
const SHARDS = 64;
const GRAY = 1024;
const EMB = 384;

// VDF EntryFlags (+ Eagle extras from bit 16 up)
const EntryFlags = Object.freeze({
	IsImage: 1,
	ManuallyExcluded: 2,
	ThumbnailError: 4,
	MetadataError: 8,
	TooDark: 16,
	NoAudioTrack: 32,
	AudioFingerprintError: 64,
	SilentAudioTrack: 128,
	ReparsePoint: 256,
	ReparsePointChecked: 512,
	Tombstone: 1 << 16,       // item left the library; fingerprint kept (RememberDeletedContent)
	Missing: 1 << 17,         // item exists in Eagle but its file is gone
	ReadOnly: 1 << 18,
	AllErrors: 4 | 8 | 16,
});

function shardOf(id) {
	let h = 0x811C9DC5;
	for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193); }
	return (h >>> 0) % SHARDS;
}

function newEntry(id) {
	return {
		id,
		name: '', ext: '', path: '',
		size: 0, mtime: 0, dateCreated: 0, dateModified: 0,
		flags: 0,
		mi: null,             // MediaInfo
		gray: new Map(),      // posSeconds -> Uint8Array(1024) | null (sampled and failed)
		ph: new Map(),        // posSeconds -> [lo, hi]
		audio: null,          // null = not extracted, Uint32Array (may be empty)
		emb: new Map(),       // posSeconds -> Int8Array(384)
		osHash: null,
		exifDate: 0,
		dev: '', ino: '',
		lastSeen: 0,
	};
}

// ── binary encode/decode ──

function encodeEntry(e) {
	const blobs = [];
	let off = 0;
	const push = (u8) => { blobs.push(u8); const o = off; off += u8.byteLength; return o; };
	const g = [];
	for (const [pos, buf] of e.gray) g.push([pos, buf ? push(buf) : -1]);
	const p = [];
	for (const [pos, h] of e.ph) p.push([pos, h[0], h[1]]);
	let a = null;
	if (e.audio) a = e.audio.length ? [push(new Uint8Array(e.audio.buffer, e.audio.byteOffset, e.audio.byteLength)), e.audio.length] : [];
	const em = [];
	for (const [pos, v] of e.emb) em.push([pos, push(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))]);
	const meta = {
		n: e.name, x: e.ext, pa: e.path, s: e.size, m: e.mtime, dc: e.dateCreated, dm: e.dateModified,
		f: e.flags, mi: e.mi, g, p, a, e: em, o: e.osHash, ex: e.exifDate, dv: e.dev, in: e.ino, ls: e.lastSeen,
	};
	const metaBuf = Buffer.from(JSON.stringify(meta), 'utf8');
	const idBuf = Buffer.from(e.id, 'utf8');
	const head = Buffer.alloc(2 + idBuf.length + 4);
	head.writeUInt16LE(idBuf.length, 0);
	idBuf.copy(head, 2);
	head.writeUInt32LE(metaBuf.length, 2 + idBuf.length);
	const blobLen = Buffer.alloc(4);
	blobLen.writeUInt32LE(off, 0);
	return Buffer.concat([head, metaBuf, blobLen, ...blobs.map((b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength))]);
}

function decodeEntry(buf, pos) {
	const idLen = buf.readUInt16LE(pos); pos += 2;
	const id = buf.toString('utf8', pos, pos + idLen); pos += idLen;
	const metaLen = buf.readUInt32LE(pos); pos += 4;
	const meta = JSON.parse(buf.toString('utf8', pos, pos + metaLen)); pos += metaLen;
	const blobLen = buf.readUInt32LE(pos); pos += 4;
	const blob = buf.subarray(pos, pos + blobLen); pos += blobLen;
	const e = newEntry(id);
	e.name = meta.n || ''; e.ext = meta.x || ''; e.path = meta.pa || '';
	e.size = meta.s || 0; e.mtime = meta.m || 0; e.dateCreated = meta.dc || 0; e.dateModified = meta.dm || 0;
	e.flags = meta.f || 0; e.mi = meta.mi || null; e.osHash = meta.o || null; e.exifDate = meta.ex || 0;
	e.dev = meta.dv || ''; e.ino = meta.in || ''; e.lastSeen = meta.ls || 0;
	for (const [p, o] of meta.g || []) e.gray.set(p, o < 0 ? null : Uint8Array.from(blob.subarray(o, o + GRAY)));
	for (const [p, lo, hi] of meta.p || []) e.ph.set(p, [lo >>> 0, hi >>> 0]);
	if (Array.isArray(meta.a)) {
		if (meta.a.length === 2) {
			const [o, n] = meta.a;
			const copy = Buffer.from(blob.subarray(o, o + n * 4));
			e.audio = new Uint32Array(copy.buffer, copy.byteOffset, n);
		}
		else e.audio = new Uint32Array(0);
	}
	for (const [p, o] of meta.e || []) {
		const copy = Buffer.from(blob.subarray(o, o + EMB));
		e.emb.set(p, new Int8Array(copy.buffer, copy.byteOffset, EMB));
	}
	return { entry: e, pos };
}

function writeAtomic(file, data) {
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, data);
	fs.renameSync(tmp, file);
}

class Cache {
	/** @param {string} dir per-library cache folder */
	constructor(dir, log = () => {}) {
		this.dir = dir;
		this.log = log;
		this.entries = new Map();
		this.dirty = new Set();
		this.lists = { notAMatch: [], version: 1 };
		this.loaded = false;
	}

	get shardDir() { return path.join(this.dir, 'db'); }
	get denseDir() { return path.join(this.dir, 'dense'); }
	get thumbDir() { return path.join(this.dir, 'thumbs'); }
	get resultsDir() { return path.join(this.dir, 'results'); }

	load() {
		fs.mkdirSync(this.shardDir, { recursive: true });
		this.entries.clear();
		let corrupt = 0;
		for (let s = 0; s < SHARDS; s++) {
			const file = path.join(this.shardDir, `${String(s).padStart(2, '0')}.bin`);
			if (!fs.existsSync(file)) continue;
			try {
				const buf = fs.readFileSync(file);
				if (buf.length < 12 || buf.readUInt32LE(0) !== MAGIC) throw new Error('bad header');
				const version = buf.readUInt32LE(4);
				if (version !== VERSION) throw new Error(`unsupported version ${version}`);
				const count = buf.readUInt32LE(8);
				let pos = 12;
				let invalid = 0;
				for (let i = 0; i < count; i++) {
					const r = decodeEntry(buf, pos);
					pos = r.pos;
					if (!isItemId(r.entry.id)) { invalid++; continue; } // never let a bad id near a file path
					this.entries.set(r.entry.id, r.entry);
				}
				if (invalid) {
					this.dirty.add(s); // rewritten without them on the next save
					this.log('warn', `Cache shard ${s}: ${invalid} entr${invalid === 1 ? 'y' : 'ies'} with an invalid item id dropped.`);
				}
			}
			catch (err) {
				corrupt++;
				try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
				this.log('warn', `Cache shard ${s} was unreadable (${err.message}); it was set aside and its files will be re-analysed.`);
			}
		}
		this.loadLists();
		this.loaded = true;
		return { entries: this.entries.size, corrupt };
	}

	loadLists() {
		const file = path.join(this.dir, 'lists.json');
		try {
			if (fs.existsSync(file)) {
				const j = JSON.parse(fs.readFileSync(file, 'utf8'));
				this.lists.notAMatch = Array.isArray(j.notAMatch) ? j.notAMatch.filter(Array.isArray) : [];
			}
		}
		catch (err) {
			this.log('warn', `The "not a match" list could not be read (${err.message}); starting empty.`);
			try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
		}
	}

	saveLists() {
		fs.mkdirSync(this.dir, { recursive: true });
		writeAtomic(path.join(this.dir, 'lists.json'), JSON.stringify(this.lists));
	}

	get(id) { return this.entries.get(id); }

	getOrCreate(id) {
		let e = this.entries.get(id);
		if (!e) {
			if (!isItemId(id)) throw new Error(`Not an Eagle item id: ${JSON.stringify(String(id)).slice(0, 80)}`);
			e = newEntry(id); this.entries.set(id, e); this.markDirty(id);
		}
		return e;
	}

	markDirty(id) { this.dirty.add(shardOf(id)); }

	/** dense/<id>.bin, or null for anything that is not an item id (see core/ids). */
	denseFile(id) { return fileFor(this.denseDir, id, '.bin'); }

	delete(id) {
		if (this.entries.delete(id)) this.markDirty(id);
		const dense = this.denseFile(id);
		if (dense) { try { fs.unlinkSync(dense); } catch { /* none */ } }
	}

	/** Drop everything derived from content (VDF ClearCachedMediaData); identity stays. */
	clearDerived(e) {
		e.mi = null;
		e.gray.clear();
		e.ph.clear();
		e.audio = null;
		e.emb.clear();
		e.flags &= ~(EntryFlags.ThumbnailError | EntryFlags.MetadataError | EntryFlags.TooDark |
			EntryFlags.NoAudioTrack | EntryFlags.AudioFingerprintError | EntryFlags.SilentAudioTrack);
		const dense = this.denseFile(e.id);
		if (dense) { try { fs.unlinkSync(dense); } catch { /* none */ } }
		this.markDirty(e.id);
	}

	/** Write every dirty shard. Returns the number of shards written. */
	save() {
		if (!this.dirty.size) return 0;
		fs.mkdirSync(this.shardDir, { recursive: true });
		const byShard = new Map();
		for (const s of this.dirty) byShard.set(s, []);
		for (const e of this.entries.values()) {
			const s = shardOf(e.id);
			if (byShard.has(s)) byShard.get(s).push(e);
		}
		let written = 0;
		for (const [s, list] of byShard) {
			const parts = [];
			const head = Buffer.alloc(12);
			head.writeUInt32LE(MAGIC, 0);
			head.writeUInt32LE(VERSION, 4);
			head.writeUInt32LE(list.length, 8);
			parts.push(head);
			for (const e of list) parts.push(encodeEntry(e));
			const file = path.join(this.shardDir, `${String(s).padStart(2, '0')}.bin`);
			if (list.length === 0) { try { fs.unlinkSync(file); } catch { /* none */ } }
			else writeAtomic(file, Buffer.concat(parts));
			written++;
		}
		this.dirty.clear();
		return written;
	}

	// ── dense AI keyframes sidecar (VDF DenseEmbeddings.db equivalent) ──

	/**
	 * Dense keyframe record for AI partial detection, valid only for the same file size+mtime.
	 * Returns { failed, interval, count, emb: Int8Array(count*384), valid: Uint8Array(count) } | null.
	 */
	readDense(id, size, mtime) {
		const file = this.denseFile(id);
		if (!file) return null;
		try {
			const buf = fs.readFileSync(file);
			const headerLen = buf.readUInt32LE(0);
			const header = JSON.parse(buf.toString('utf8', 4, 4 + headerLen));
			if (header.size !== size || header.mtime !== mtime) return null;
			if (header.failed) return { failed: true, interval: 0, count: 0, emb: new Int8Array(0), valid: new Uint8Array(0) };
			const count = header.count;
			let p = 4 + headerLen;
			const embBytes = Buffer.from(buf.subarray(p, p + count * EMB)); p += count * EMB;
			const valid = Uint8Array.from(buf.subarray(p, p + count));
			if (embBytes.length !== count * EMB || valid.length !== count) return null;
			return { failed: false, interval: header.interval, count, emb: new Int8Array(embBytes.buffer, embBytes.byteOffset, count * EMB), valid };
		}
		catch { return null; }
	}

	writeDense(id, size, mtime, rec) {
		const file = this.denseFile(id);
		if (!file) throw new Error(`Not an Eagle item id: ${JSON.stringify(String(id)).slice(0, 80)}`);
		fs.mkdirSync(this.denseDir, { recursive: true });
		const header = Buffer.from(JSON.stringify({ size, mtime, failed: !!rec.failed, interval: rec.interval || 0, count: rec.count || 0 }), 'utf8');
		const len = Buffer.alloc(4); len.writeUInt32LE(header.length, 0);
		const parts = [len, header];
		if (!rec.failed) {
			parts.push(Buffer.from(rec.emb.buffer, rec.emb.byteOffset, rec.count * EMB));
			parts.push(Buffer.from(rec.valid.buffer, rec.valid.byteOffset, rec.count));
		}
		writeAtomic(file, Buffer.concat(parts));
	}

	stats() {
		let videos = 0, images = 0, errors = 0, tombstones = 0, excluded = 0, frames = 0, audio = 0, emb = 0, fingerprinted = 0;
		for (const e of this.entries.values()) {
			if (e.flags & EntryFlags.IsImage) images++; else videos++;
			if (e.gray.size) fingerprinted++;
			if (e.flags & EntryFlags.AllErrors) errors++;
			if (e.flags & EntryFlags.Tombstone) tombstones++;
			if (e.flags & EntryFlags.ManuallyExcluded) excluded++;
			frames += e.gray.size;
			if (e.audio && e.audio.length) audio++;
			emb += e.emb.size;
		}
		return { entries: this.entries.size, fingerprinted, videos, images, errors, tombstones, excluded, frames, audio, emb, bytes: this.diskBytes() };
	}

	diskBytes() {
		let total = 0;
		const walk = (d) => {
			let list = [];
			try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
			for (const x of list) {
				const p = path.join(d, x.name);
				if (x.isDirectory()) walk(p);
				else { try { total += fs.statSync(p).size; } catch { /* ignore */ } }
			}
		};
		walk(this.dir);
		return total;
	}

	/** Remove every cached entry and sidecar (Clear database). */
	clearAll() {
		this.entries.clear();
		this.dirty.clear();
		for (const d of [this.shardDir, this.denseDir, this.thumbDir]) {
			try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
		}
		fs.mkdirSync(this.shardDir, { recursive: true });
	}

	/** JSON export (VDF ExportDataBaseToJson). Binary frames as base64. */
	exportJson(file) {
		const out = [];
		for (const e of this.entries.values()) {
			out.push({
				id: e.id, name: e.name, ext: e.ext, path: e.path, size: e.size, mtime: e.mtime,
				dateCreated: e.dateCreated, dateModified: e.dateModified, flags: e.flags, mediaInfo: e.mi,
				osHash: e.osHash, exifDate: e.exifDate,
				gray: [...e.gray].map(([p, b]) => [p, b ? Buffer.from(b).toString('base64') : null]),
				pHash: [...e.ph],
				audio: e.audio ? Buffer.from(e.audio.buffer, e.audio.byteOffset, e.audio.byteLength).toString('base64') : null,
				emb: [...e.emb].map(([p, v]) => [p, Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')]),
			});
		}
		writeAtomic(file, JSON.stringify({ format: 'vdf-eagle-cache', version: VERSION, entries: out }));
		return out.length;
	}

	/**
	 * JSON import. Every record is validated: the id must be an Eagle item id (so it can never
	 * name a file outside the cache) and every field must have the shape the exporter writes.
	 * Records that fail are skipped, never partly imported. Returns { imported, rejected }.
	 */
	importJson(file) {
		const j = JSON.parse(fs.readFileSync(file, 'utf8'));
		if (!j || j.format !== 'vdf-eagle-cache' || !Array.isArray(j.entries)) throw new Error('Not a VDF for Eagle cache export');
		let imported = 0, rejected = 0;
		for (const x of j.entries) {
			const e = entryFromJson(x);
			if (!e) { rejected++; continue; }
			this.entries.set(e.id, e);
			this.markDirty(e.id);
			imported++;
		}
		if (rejected) this.log('warn', `Cache import: ${rejected} record(s) skipped (invalid item id or data).`);
		return { imported, rejected };
	}
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v) => (typeof v === 'string' ? v : '');
const isPos = (p) => typeof p === 'number' && Number.isFinite(p) && p >= 0;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
function b64Bytes(v, len) {
	if (typeof v !== 'string' || !B64.test(v)) return null;
	const b = Buffer.from(v, 'base64');
	return len == null || b.length === len ? b : null;
}

/** One exported record → cache entry, or null when anything about it is not as exported. */
function entryFromJson(x) {
	if (!x || typeof x !== 'object' || !isItemId(x.id)) return null;
	const e = newEntry(x.id);
	e.name = str(x.name); e.ext = str(x.ext); e.path = str(x.path); e.size = num(x.size); e.mtime = num(x.mtime);
	e.dateCreated = num(x.dateCreated); e.dateModified = num(x.dateModified); e.flags = num(x.flags) >>> 0;
	e.mi = x.mediaInfo && typeof x.mediaInfo === 'object' && !Array.isArray(x.mediaInfo) ? x.mediaInfo : null;
	e.osHash = typeof x.osHash === 'string' && /^[0-9a-f]{16}$/.test(x.osHash) ? x.osHash : null;
	e.exifDate = num(x.exifDate);
	for (const [key, list] of [['gray', x.gray], ['pHash', x.pHash], ['emb', x.emb]]) {
		if (list != null && !Array.isArray(list)) return null;
		for (const item of list || []) if (!Array.isArray(item) || !isPos(item[0])) return null;
		if (key === 'gray') for (const [p, b64] of list || []) {
			if (b64 == null) { e.gray.set(p, null); continue; }
			const b = b64Bytes(b64, GRAY);
			if (!b) return null;
			e.gray.set(p, Uint8Array.from(b));
		}
		if (key === 'pHash') for (const [p, h] of list || []) {
			if (!Array.isArray(h) || h.length !== 2 || !h.every((v) => Number.isInteger(v))) return null;
			e.ph.set(p, [h[0] >>> 0, h[1] >>> 0]);
		}
		if (key === 'emb') for (const [p, b64] of list || []) {
			const b = b64Bytes(b64, EMB);
			if (!b) return null;
			e.emb.set(p, new Int8Array(Uint8Array.from(b).buffer));
		}
	}
	if (x.audio != null) {
		const b = b64Bytes(x.audio);
		if (!b || b.length % 4) return null;
		e.audio = new Uint32Array(Uint8Array.from(b).buffer);
	}
	return e;
}

/** OpenSubtitles-style content hash (VDF OsHashUtils): size + LE-u64 sums of first/last 64 KiB. */
function osHash(file) {
	const CHUNK = 64 * 1024;
	let fd;
	try {
		fd = fs.openSync(file, 'r');
		const size = fs.fstatSync(fd).size;
		if (size < CHUNK) return null;
		const buf = Buffer.alloc(CHUNK);
		let sum = BigInt(size);
		fs.readSync(fd, buf, 0, CHUNK, 0);
		for (let i = 0; i + 8 <= CHUNK; i += 8) sum += buf.readBigUInt64LE(i);
		fs.readSync(fd, buf, 0, CHUNK, size - CHUNK);
		for (let i = 0; i + 8 <= CHUNK; i += 8) sum += buf.readBigUInt64LE(i);
		return BigInt.asUintN(64, sum).toString(16).padStart(16, '0');
	}
	catch { return null; }
	finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

module.exports = { Cache, EntryFlags, newEntry, shardOf, osHash, encodeEntry, decodeEntry };
