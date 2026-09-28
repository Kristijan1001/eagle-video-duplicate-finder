'use strict';
// FFmpeg / FFprobe access, mirroring VDF's CLI code path (VDF.Core/FFTools/FfmpegEngine.cs,
// FFProbeEngine.cs, FFProbeJsonReader.cs, FfmpegErrorClassifier.cs; VideoDuplicateFinder,
// AGPL-3.0). The binaries come from Eagle's FFmpeg dependency plugin.

const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GRAY_BYTES = 32 * 32;
const AI_SIDE = 224;
const RGB_BYTES = AI_SIDE * AI_SIDE * 3;
const DEFAULT_TIMEOUT_MS = 30000;
const WINDOWS_MAX_PATH = 260;

// VDF.Core/Utils/FileUtils.cs extension lists
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff', 'webp', 'heic', 'heif', 'avif', 'jfif', 'tif'];
const VIDEO_EXTENSIONS = ['mp4', 'wmv', 'avi', 'mkv', 'flv', 'mov', 'mpg', 'mpeg', 'm4v', 'asf', 'f4v', 'webm', 'divx', 'm2t', 'm2ts', 'vob', 'ts', 'mts', '3gp', 'ogv', 'rm', 'rmvb', 'mxf', 'hevc', 'av1', 'vp8', 'vp9', '3g2', 'dv', 'qt', 'wtv'];

function isImageExt(ext) { return IMAGE_EXTENSIONS.includes(String(ext || '').toLowerCase()); }
function isVideoExt(ext) { return VIDEO_EXTENSIONS.includes(String(ext || '').toLowerCase()); }
function isHeifExt(ext) { ext = String(ext || '').toLowerCase(); return ext === 'heic' || ext === 'heif'; }

/** FFToolsUtils.LongPathFix */
function longPathFix(p) {
	if (process.platform !== 'win32') return p;
	if (p.startsWith('\\\\?\\')) return p;
	if (p.length < WINDOWS_MAX_PATH) return p;
	if (p.startsWith('\\')) return `\\\\?\\UNC\\${p.replace(/^\\+/, '')}`;
	return `\\\\?\\${p}`;
}

/** Split a custom-arguments string like a shell would (quotes group, no escapes). */
function tokenizeArgs(s) {
	const out = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let m;
	while ((m = re.exec(s || ''))) out.push(m[1] ?? m[2] ?? m[3]);
	return out;
}

// ── Error hints (FfmpegErrorClassifier) ──
const HINT_RULES = [
	['hw', ['lacking required capabilities', 'hwaccel initiali', 'failed setup for format', 'no device available for decoder', 'hwaccel transfer data failed', 'cannot load nvcuda', 'cannot load libcuda', 'cannot load cuda', 'hw_device_ctx', 'device creation failed']],
	['codec', ['decoder not found', 'unknown decoder', 'no decoder for', 'codec not currently supported']],
	['corrupt', ['moov atom not found', 'invalid data found when processing input', 'invalid nal unit size', 'error splitting the input into nal units', 'could not find codec parameters', 'non-existing pps', 'non-existing sps', 'error while decoding', 'partial file', 'truncat']],
	['access', ['permission denied', 'no such file or directory', 'operation not permitted', 'protocol not found']],
	['hw', ['generic error in an external library']],
];
const HINTS = {
	hw: 'This looks like a GPU/hardware-decoding problem. Set Settings → Performance → Hardware acceleration to "none".',
	corrupt: 'The file appears to be truncated or corrupt. Check whether it plays in a normal media player.',
	codec: 'This FFmpeg build has no decoder for the file\'s codec.',
	access: 'The file could not be read (permissions, a locked file, or an invalid/too-long path).',
};
function classifyError(text) {
	const t = String(text || '').toLowerCase();
	for (const [cat, needles] of HINT_RULES) if (needles.some((n) => t.includes(n))) return { category: cat, hint: HINTS[cat] };
	return { category: 'unknown', hint: null };
}

class FF {
	/**
	 * @param {{ffmpeg:string, ffprobe:string, log?:(level:string,msg:string)=>void}} opts
	 */
	constructor(opts) {
		this.ffmpeg = opts.ffmpeg;
		this.ffprobe = opts.ffprobe;
		this.log = opts.log || (() => {});
		this.children = new Set();
		this.hwaccel = 'none';
		this.customArgs = '';
		this.extendedLogging = false;
		this.tempDir = opts.tempDir || os.tmpdir();
	}

	configure({ hardwareAccelerationMode, customFFArguments, extendedFFToolsLogging }) {
		this.hwaccel = hardwareAccelerationMode || 'none';
		this.customArgs = customFFArguments || '';
		this.extendedLogging = !!extendedFFToolsLogging;
	}

	available() {
		return !!(this.ffmpeg && this.ffprobe && fs.existsSync(this.ffmpeg) && fs.existsSync(this.ffprobe));
	}

	/** Kill every running child (Stop). */
	killAll() {
		for (const c of this.children) { c.vdfKilled = true; try { c.kill('SIGKILL'); } catch { /* already gone */ } }
		this.children.clear();
	}

	/**
	 * Run a process and collect stdout (Buffer) + stderr (collapsed repeats).
	 * Resolves { code, stdout, stderr, timedOut }. Never rejects for exit codes.
	 */
	run(exe, args, { timeoutMs = DEFAULT_TIMEOUT_MS, stallMs = 0, maxBytes = 512 << 20, onData = null, lowPriority = true } = {}) {
		return new Promise((resolve) => {
			let child;
			try {
				child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: path.dirname(exe) });
			}
			catch (err) {
				resolve({ code: -1, stdout: Buffer.alloc(0), stderr: String(err && err.message || err), timedOut: false });
				return;
			}
			this.children.add(child);
			if (lowPriority) {
				try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not permitted */ }
			}
			const chunks = [];
			let size = 0;
			let stderr = '';
			let lastLine = '', repeat = 0;
			let timedOut = false;
			let stallTimer = null;
			const armStall = () => {
				if (!stallMs) return;
				clearTimeout(stallTimer);
				stallTimer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* ignore */ } }, stallMs);
			};
			armStall();
			const total = timeoutMs ? setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* ignore */ } }, timeoutMs) : null;
			child.stdout.on('data', (b) => {
				armStall();
				if (onData) { onData(b); return; }
				size += b.length;
				if (size > maxBytes) { try { child.kill('SIGKILL'); } catch { /* ignore */ } return; }
				chunks.push(b);
			});
			let errBuf = '';
			child.stderr.setEncoding('utf8');
			child.stderr.on('data', (s) => {
				errBuf += s;
				let nl;
				while ((nl = errBuf.indexOf('\n')) >= 0) {
					const line = errBuf.slice(0, nl).replace(/\r$/, '');
					errBuf = errBuf.slice(nl + 1);
					if (!line) continue;
					if (line === lastLine) { repeat++; continue; }
					if (repeat) { stderr += ` (repeated ${repeat} more time${repeat === 1 ? '' : 's'})`; repeat = 0; }
					if (stderr.length < 16000) stderr += '\n' + line;
					lastLine = line;
				}
			});
			const done = (code) => {
				clearTimeout(total); clearTimeout(stallTimer);
				this.children.delete(child);
				if (errBuf.trim()) stderr += '\n' + errBuf.trim();
				if (repeat) stderr += ` (repeated ${repeat} more time${repeat === 1 ? '' : 's'})`;
				resolve({ code, stdout: Buffer.concat(chunks), stderr: stderr.trim(), timedOut, killed: !!child.vdfKilled });
			};
			child.on('error', (err) => { stderr += '\n' + err.message; });
			child.on('close', (code) => done(code === null ? -1 : code));
		});
	}

	// ── ffprobe ──

	/** FFProbeEngine.GetMediaInfo → MediaInfo or null. */
	async probe(file) {
		const args = ['-hide_banner', '-loglevel', this.extendedLogging ? 'error' : 'quiet', '-print_format', 'json',
			'-sexagesimal', '-show_format', '-show_streams', longPathFix(file)];
		const r = await this.run(this.ffprobe, args, { timeoutMs: DEFAULT_TIMEOUT_MS });
		if (r.code !== 0 || !r.stdout.length) {
			if (r.killed) return null;
			this.log('warn', `Failed to retrieve media info from: ${file}${r.stderr ? '\n' + r.stderr : ''}${r.timedOut ? '\n(timed out)' : ''}`);
			return null;
		}
		try {
			return parseProbeJson(r.stdout.toString('utf8'));
		}
		catch (err) {
			this.log('warn', `Could not parse media info of ${file}: ${err.message}`);
			return null;
		}
	}

	/** Format/stream tags for the metadata comparison. */
	async tags(file) {
		const r = await this.run(this.ffprobe, ['-hide_banner', '-loglevel', 'quiet', '-show_entries',
			'format_tags:stream=index,codec_type:stream_tags', '-of', 'json', longPathFix(file)]);
		if (r.code !== 0) return null;
		try { return JSON.parse(r.stdout.toString('utf8')); } catch { return null; }
	}

	/** Container creation_time (videos, HEIC). */
	async creationTime(file) {
		const r = await this.run(this.ffprobe, ['-hide_banner', '-loglevel', 'quiet', '-show_entries', 'format_tags=creation_time',
			'-of', 'default=noprint_wrappers=1:nokey=1', longPathFix(file)]);
		if (r.code !== 0) return null;
		const t = Date.parse(r.stdout.toString('utf8').trim());
		return Number.isFinite(t) ? t : null;
	}

	// ── Frames ──

	_prefix(softwareOnly) {
		const a = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
		if (this.hwaccel && this.hwaccel !== 'none' && !softwareOnly) a.push('-hwaccel', this.hwaccel);
		return a;
	}

	_splitCustom() {
		const tokens = tokenizeArgs(this.customArgs);
		let userVf = null;
		const rest = [];
		for (let i = 0; i < tokens.length; i++) {
			if ((tokens[i] === '-vf' || tokens[i] === '-filter:v') && i + 1 < tokens.length) userVf = tokens[++i];
			else rest.push(tokens[i]);
		}
		return { userVf, rest };
	}

	/**
	 * FfmpegEngine.GetThumbnail(GrayScale=1): one 32x32 gray frame (1024 bytes) or null.
	 * `seconds` is ignored for still images (no input -ss, VDF #801).
	 */
	async grayFrame(file, seconds, { isImage = false, ext = '', softwareOnly = false } = {}) {
		const { userVf, rest } = this._splitCustom();
		let chain = 'scale=32:32:flags=bicubic,format=gray';
		if (userVf) chain = `${userVf},${chain}`;
		const build = (gridAssembly) => {
			const a = this._prefix(softwareOnly || isImage);
			if (!isImage) a.push('-ss', fmtSeconds(seconds));
			a.push('-i', longPathFix(file));
			if (gridAssembly) a.push('-filter_complex', `[0:g:0]${chain}[vdf]`, '-map', '[vdf]');
			else a.push('-vf', chain);
			a.push('-f', 'rawvideo', '-pix_fmt', 'gray', '-frames:v', '1', ...rest, 'pipe:1');
			return a;
		};
		let r = await this.run(this.ffmpeg, build(false));
		let bytes = checkRaw(r, GRAY_BYTES);
		let err = r.stderr;
		if (!bytes && isImage && isHeifExt(ext)) {
			r = await this.run(this.ffmpeg, build(true));
			bytes = checkRaw(r, GRAY_BYTES);
			err += '\nRetrying with HEIF tile-grid assembly ([0:g:0]):\n' + r.stderr;
		}
		if (!bytes) this._reportFailure('graybytes', file, err, r);
		return bytes;
	}

	/** 224x224 RGB24 frame (150528 bytes) for AI embeddings, or null. Never user-filtered (VDF). */
	async rgbFrame(file, seconds, { isImage = false, softwareOnly = false } = {}) {
		const a = this._prefix(softwareOnly || isImage);
		if (!isImage) a.push('-ss', fmtSeconds(seconds));
		a.push('-i', longPathFix(file), '-vf', `scale=${AI_SIDE}:${AI_SIDE}:flags=bicubic,format=rgb24`,
			'-f', 'rawvideo', '-pix_fmt', 'rgb24', '-frames:v', '1', 'pipe:1');
		const r = await this.run(this.ffmpeg, a);
		const bytes = checkRaw(r, RGB_BYTES);
		if (!bytes) this._reportFailure('AI frame', file, r.stderr, r);
		return bytes;
	}

	/**
	 * GetGrayAndRgb224Cli: gray + RGB from ONE seek/decode (split filter). Gray on stdout,
	 * RGB into a unique temp file. Only used when no custom FFmpeg arguments are set.
	 */
	async grayAndRgb(file, seconds, { isImage = false, ext = '', softwareOnly = false } = {}) {
		const rgbTemp = path.join(this.tempDir, `VDF.AiFrame.${crypto.randomBytes(16).toString('hex')}.rgb`);
		const labels = isImage && isHeifExt(ext) ? ['0:g:0', '0:v'] : ['0:v'];
		let gray = null, rgb = null, err = '';
		for (let attempt = 0; attempt < labels.length && !gray; attempt++) {
			const a = this._prefix(softwareOnly || isImage);
			if (!isImage) a.push('-ss', fmtSeconds(seconds));
			a.push('-i', longPathFix(file), '-filter_complex',
				`[${labels[attempt]}]split=2[g][r];[g]scale=32:32:flags=bicubic,format=gray[gout];[r]scale=${AI_SIDE}:${AI_SIDE}:flags=bicubic,format=rgb24[rout]`,
				'-map', '[gout]', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
				'-map', '[rout]', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-y', rgbTemp);
			const r = await this.run(this.ffmpeg, a);
			err += r.stderr;
			gray = checkRaw(r, GRAY_BYTES);
			try {
				const b = fs.readFileSync(rgbTemp);
				if (b.length === RGB_BYTES) rgb = new Uint8Array(b.buffer, b.byteOffset, b.length);
			}
			catch { /* no rgb */ }
			try { fs.unlinkSync(rgbTemp); } catch { /* not created */ }
		}
		if (!gray) this._reportFailure('graybytes+AI frame', file, err, { code: 1 });
		return { gray, rgb };
	}

	/** GetGrayFrames: gray frames at arbitrary times (partial-clip visual gate). */
	async grayFrames(file, times) {
		const out = [];
		for (const t of times) out.push(await this.grayFrame(file, t));
		return out;
	}

	/**
	 * Display thumbnail as JPEG bytes (VDF GetThumbnail with GrayScale=0): SAR-normalized,
	 * downscale-only fit into maxWidth, MJPEG quality 90 → qscale 3. maxWidth 0 = full size.
	 */
	async jpegFrame(file, seconds, { isImage = false, maxWidth = 160, quality = 90 } = {}) {
		const { userVf, rest } = this._splitCustom();
		const sar = isImage ? null : 'scale=if(gt(iw*if(eq(sar\\,0)\\,1\\,sar)\\,65536)\\,iw\\,trunc(iw*if(eq(sar\\,0)\\,1\\,sar))):ih,setsar=1';
		let chain;
		if (maxWidth > 0) {
			chain = `scale=min(${maxWidth}\\,iw):min(${maxWidth}\\,ih):force_original_aspect_ratio=decrease`;
			if (sar) chain = `${sar},${chain}`;
			if (userVf) chain = `${chain},${userVf}`;
		}
		else {
			chain = sar;
			if (userVf) chain = chain ? `${chain},${userVf}` : userVf;
		}
		const a = this._prefix(isImage);
		if (!isImage) a.push('-ss', fmtSeconds(seconds));
		a.push('-i', longPathFix(file));
		if (chain) a.push('-vf', chain);
		a.push('-f', 'mjpeg', '-q:v', String(Math.min(31, Math.max(2, 2 + Math.floor((100 - quality) / 10)))), '-frames:v', '1', ...rest, 'pipe:1');
		const r = await this.run(this.ffmpeg, a);
		if (r.code !== 0 || !r.stdout.length) return null;
		return r.stdout;
	}

	/** Full-size PNG frame for the thumbnail comparer (lossless so the diff view is honest). */
	async pngFrame(file, seconds, { isImage = false, maxSide = 0 } = {}) {
		const a = this._prefix(isImage);
		if (!isImage) a.push('-ss', fmtSeconds(seconds));
		a.push('-i', longPathFix(file));
		const vf = [];
		if (!isImage) vf.push('scale=if(gt(iw*if(eq(sar\\,0)\\,1\\,sar)\\,65536)\\,iw\\,trunc(iw*if(eq(sar\\,0)\\,1\\,sar))):ih,setsar=1');
		if (maxSide > 0) vf.push(`scale=min(${maxSide}\\,iw):min(${maxSide}\\,ih):force_original_aspect_ratio=decrease`);
		if (vf.length) a.push('-vf', vf.join(','));
		a.push('-f', 'image2pipe', '-vcodec', 'png', '-frames:v', '1', 'pipe:1');
		const r = await this.run(this.ffmpeg, a, { timeoutMs: 60000 });
		if (r.code !== 0 || !r.stdout.length) return null;
		return r.stdout;
	}

	/**
	 * Mono 11025 Hz s16le PCM streamed to `onPcm(Int16Array)`. Resolves
	 * { ok, samples, noAudio, error }. Used by the audio fingerprint.
	 */
	async pcm(file, onPcm) {
		let samples = 0;
		let carry = null;
		const r = await this.run(this.ffmpeg, ['-hide_banner', '-loglevel', this.extendedLogging ? 'error' : 'quiet', '-nostdin',
			'-i', longPathFix(file), '-vn', '-ac', '1', '-ar', '11025', '-f', 's16le', 'pipe:1'], {
			timeoutMs: 0, stallMs: 120000,
			onData: (b) => {
				if (carry) { b = Buffer.concat([carry, b]); carry = null; }
				const even = b.length & ~1;
				if (even < b.length) carry = b.subarray(even);
				if (!even) return;
				const copy = Buffer.from(b.subarray(0, even));
				const pcmData = new Int16Array(copy.buffer, copy.byteOffset, even / 2);
				samples += pcmData.length;
				onPcm(pcmData);
			},
		});
		const noAudio = /does not contain any stream|matches no streams|Output file #0 does not contain/i.test(r.stderr);
		return { ok: r.code === 0 && !r.timedOut, samples, noAudio, error: r.code !== 0 ? r.stderr : '' };
	}

	/**
	 * One-shot dense RGB sampling for AI partial detection: frames every `interval` seconds
	 * (fps=1/interval), up to maxFrames, each 224x224 RGB24. Returns array of Uint8Array.
	 */
	async denseRgbFrames(file, intervalSeconds, maxFrames) {
		const frames = [];
		let pending = Buffer.alloc(0);
		const r = await this.run(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', longPathFix(file),
			'-an', '-sn', '-dn', '-vf', `fps=1/${trimNum(intervalSeconds)}:round=up,scale=${AI_SIDE}:${AI_SIDE}:flags=bicubic,format=rgb24`,
			'-frames:v', String(maxFrames), '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], {
			timeoutMs: 0, stallMs: 15 * 60000,
			onData: (b) => {
				pending = pending.length ? Buffer.concat([pending, b]) : b;
				while (pending.length >= RGB_BYTES) {
					frames.push(Uint8Array.from(pending.subarray(0, RGB_BYTES)));
					pending = pending.subarray(RGB_BYTES);
				}
			},
		});
		if (r.code !== 0 && !frames.length) this._reportFailure('dense AI frames', file, r.stderr, r);
		return frames;
	}

	_reportFailure(what, file, err, r) {
		if (r && r.killed) return; // stopped by the user, not a broken file
		const { hint } = classifyError(err);
		this.log('warn', `Failed to retrieve ${what} from: ${file}${r && r.timedOut ? ' (timed out)' : ''}${err ? '\n' + err.trim() : ''}${hint ? '\nHint: ' + hint : ''}`);
	}
}

function checkRaw(r, expected) {
	if (r.code !== 0 || !r.stdout || r.stdout.length !== expected) return null;
	return new Uint8Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length);
}

/** C# double.ToString(InvariantCulture): shortest round-trip, no exponent for our range. */
function fmtSeconds(s) {
	if (!Number.isFinite(s) || s < 0) s = 0;
	return String(s);
}
function trimNum(n) { return Number(n.toFixed(3)).toString(); }

// ── ffprobe JSON → MediaInfo (FFProbeJsonReader) ──

/** Parse ffprobe's "-sexagesimal" duration "H:MM:SS.micro" (or plain seconds) → whole seconds (TrimMiliseconds). */
function parseDurationSeconds(str) {
	if (str == null) return 0;
	const s = String(str).trim();
	if (/^\d+(\.\d+)?$/.test(s)) return Math.floor(Number(s));
	const m = /^(-?\d+):(\d{1,2}):(\d{1,2})(?:\.(\d+))?$/.exec(s);
	if (!m) return 0;
	const h = Number(m[1]), mi = Number(m[2]), se = Number(m[3]);
	if (h < 0) return 0;
	return h * 3600 + mi * 60 + se;
}

function normalizeLanguageTag(tag) {
	tag = String(tag || '').trim().toLowerCase();
	return tag === 'und' ? '' : tag;
}

function computeHdrFormat(colorTransfer, sideDataTypes) {
	if (!colorTransfer) return '';
	const ct = colorTransfer.toLowerCase();
	if (ct === 'arib-std-b67') return 'HLG';
	if (ct === 'smpte2084') {
		if (sideDataTypes) {
			const sd = sideDataTypes.toLowerCase();
			if (sd.includes('dovi')) return 'Dolby Vision';
			if (sd.includes('smpte2094')) return 'HDR10+';
		}
		return 'HDR10';
	}
	return '';
}

function toInt(v) {
	if (typeof v === 'number') return Math.trunc(v);
	if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v);
	return 0;
}

function parseProbeJson(text) {
	const json = JSON.parse(text);
	const streams = Array.isArray(json.streams) ? json.streams : [];
	const format = json.format || {};
	const info = { duration: parseDurationSeconds(format.duration), streams: [] };
	let foundBitRate = false;
	for (const st of streams) {
		const s = {
			index: st.index != null ? String(st.index) : '',
			codecName: st.codec_name || '',
			codecLongName: st.codec_long_name || '',
			codecType: st.codec_type || '',
			pixelFormat: st.pix_fmt || '',
			width: toInt(st.width),
			height: toInt(st.height),
			sampleRate: toInt(st.sample_rate),
			channelLayout: st.channel_layout || '',
			bitRate: 0,
			frameRate: 0,
			channels: toInt(st.channels),
			hdrFormat: '',
			isAttachedPicture: !!(st.disposition && Number(st.disposition.attached_pic)),
			language: normalizeLanguageTag(st.tags && st.tags.language),
		};
		if (st.bit_rate != null && /^\d+$/.test(String(st.bit_rate))) { s.bitRate = Number(st.bit_rate); foundBitRate = true; }
		if (typeof st.r_frame_rate === 'string' && st.r_frame_rate.includes('/')) {
			const [a, b] = st.r_frame_rate.split('/').map((x) => Number(x));
			s.frameRate = (Number.isInteger(a) && Number.isInteger(b) && a > 0 && b > 0) ? Math.fround(a / Math.fround(b)) : -1;
		}
		const sdt = Array.isArray(st.side_data_list) ? st.side_data_list.map((x) => x && x.side_data_type).filter(Boolean).join('|') : '';
		s.hdrFormat = computeHdrFormat(st.color_transfer, sdt || null);
		info.streams.push(s);
	}
	if (!foundBitRate && info.streams.length > 0 && format.bit_rate != null && /^\d+$/.test(String(format.bit_rate)))
		info.streams[0].bitRate = Number(format.bit_rate);
	return info;
}

module.exports = {
	FF,
	GRAY_BYTES,
	RGB_BYTES,
	AI_SIDE,
	IMAGE_EXTENSIONS,
	VIDEO_EXTENSIONS,
	isImageExt,
	isVideoExt,
	longPathFix,
	tokenizeArgs,
	classifyError,
	parseProbeJson,
	parseDurationSeconds,
	computeHdrFormat,
	fmtSeconds,
};
