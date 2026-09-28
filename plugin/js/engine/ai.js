'use strict';
// AI embeddings — port of VDF.Core/AI/OnnxEmbedder.cs + AiComponents.cs (VideoDuplicateFinder,
// AGPL-3.0). DINOv2-small (int8, Xenova export, Apache-2.0) via onnxruntime-node, running
// locally on the CPU. The model is the exact file VDF pins (same SHA-256), downloaded once
// after the user agrees; nothing is ever uploaded.

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const os = require('os');
const { quantizeUnitVector } = require('../core/ai/embedding-math');

const MODEL_FILE = 'dinov2-small-int8.onnx';
const MODEL_SHA256 = '3afdc8bc63b50558d6e5770f5b799bb82455c2311183a2de43803f343a29d917';
const MODEL_URLS = [
	'https://github.com/0x90d/videoduplicatefinder/releases/download/ai-models-v1/dinov2-small-int8.onnx',
	'https://huggingface.co/Xenova/dinov2-small/resolve/main/onnx/model_quantized.onnx',
];
const MODEL_BYTES_APPROX = 24451943;
const INPUT_SIDE = 224;
const PIXELS = INPUT_SIDE * INPUT_SIDE;
const MAX_BATCH = 16;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let ort = null;
function loadRuntime() {
	if (ort) return ort;
	ort = require(path.join(__dirname, '..', '..', 'node_modules', 'onnxruntime-node'));
	return ort;
}

function modelPath(aiDir) { return path.join(aiDir, MODEL_FILE); }

function sha256File(file) {
	return new Promise((resolve, reject) => {
		const h = crypto.createHash('sha256');
		fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
	});
}

/** { runtime: bool, model: bool, modelPath } — the model counts only when its hash matches. */
async function status(aiDir) {
	let runtime = false;
	try { loadRuntime(); runtime = true; } catch { runtime = false; }
	const mp = modelPath(aiDir);
	let model = false;
	if (fs.existsSync(mp)) {
		const marker = `${mp}.verified`;
		try {
			const st = fs.statSync(mp);
			const m = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : null;
			if (m && m.size === st.size && m.mtime === st.mtimeMs) model = true;
			else if ((await sha256File(mp)) === MODEL_SHA256) {
				fs.writeFileSync(marker, JSON.stringify({ size: st.size, mtime: st.mtimeMs }));
				model = true;
			}
		}
		catch { model = false; }
	}
	return { runtime, model, modelPath: mp, sizeBytes: MODEL_BYTES_APPROX };
}

function download(url, dest, onProgress, redirects = 0) {
	return new Promise((resolve, reject) => {
		const req = https.get(url, { headers: { 'User-Agent': 'VDF-for-Eagle' } }, (res) => {
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 8) {
				res.resume();
				resolve(download(new URL(res.headers.location, url).href, dest, onProgress, redirects + 1));
				return;
			}
			if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
			const total = Number(res.headers['content-length']) || MODEL_BYTES_APPROX;
			let got = 0;
			const out = fs.createWriteStream(dest);
			res.on('data', (d) => { got += d.length; onProgress && onProgress(got, total); });
			res.pipe(out);
			out.on('finish', () => out.close(() => resolve()));
			out.on('error', reject);
			res.on('error', reject);
		});
		req.on('error', reject);
		req.setTimeout(60000, () => req.destroy(new Error('Download timed out')));
	});
}

/** Download the model (primary, then fallback URL) and verify its SHA-256. */
async function downloadModel(aiDir, onProgress) {
	fs.mkdirSync(aiDir, { recursive: true });
	const final = modelPath(aiDir);
	const tmp = `${final}.part`;
	let lastErr = null;
	for (const url of MODEL_URLS) {
		try {
			await download(url, tmp, onProgress);
			const hash = await sha256File(tmp);
			if (hash !== MODEL_SHA256) throw new Error(`integrity check failed (SHA-256 ${hash})`);
			fs.renameSync(tmp, final);
			const st = fs.statSync(final);
			fs.writeFileSync(`${final}.verified`, JSON.stringify({ size: st.size, mtime: st.mtimeMs }));
			return final;
		}
		catch (err) {
			lastErr = err;
			try { fs.unlinkSync(tmp); } catch { /* none */ }
		}
	}
	throw new Error(`AI model download failed: ${lastErr && lastErr.message}`);
}

class Embedder {
	constructor(session, inputName, outputName, clsFromHiddenState) {
		this.session = session;
		this.inputName = inputName;
		this.outputName = outputName;
		this.cls = clsFromHiddenState;
	}

	static async create(modelFile, threads) {
		const rt = loadRuntime();
		const intra = threads || Math.min(8, Math.max(1, Math.floor(os.cpus().length / 2)));
		const session = await rt.InferenceSession.create(modelFile, {
			intraOpNumThreads: intra, interOpNumThreads: 1, graphOptimizationLevel: 'all', executionProviders: ['cpu'],
		});
		const inputName = session.inputNames[0];
		let outputName, cls = false;
		if (session.outputNames.includes('image_embeds')) outputName = 'image_embeds';
		else if (session.outputNames.includes('pooler_output')) outputName = 'pooler_output';
		else { outputName = session.outputNames[0]; cls = true; }
		return new Embedder(session, inputName, outputName, cls);
	}

	/** RGB24 224x224 frames (Uint8Array each) → quantized Int8Array(384) embeddings. */
	async embedQuantized(frames) {
		const out = [];
		for (let i = 0; i < frames.length; i += MAX_BATCH) {
			const chunk = frames.slice(i, i + MAX_BATCH);
			for (const v of await this.embedBatch(chunk)) out.push(quantizeUnitVector(v));
		}
		return out;
	}

	async embedBatch(frames) {
		const rt = loadRuntime();
		const batch = frames.length;
		if (!batch) return [];
		const data = new Float32Array(batch * 3 * PIXELS);
		for (let k = 0; k < batch; k++) {
			const img = frames[k];
			if (img.length !== PIXELS * 3) throw new Error(`Expected ${PIXELS * 3} bytes of RGB24, got ${img.length}`);
			const base = k * 3 * PIXELS;
			for (let c = 0; c < 3; c++) {
				const mean = Math.fround(Math.fround(MEAN[c]) * 255);
				const invStd = Math.fround(1 / Math.fround(Math.fround(STD[c]) * 255));
				const cb = base + c * PIXELS;
				for (let p = 0; p < PIXELS; p++) data[cb + p] = Math.fround(Math.fround(img[p * 3 + c] - mean) * invStd);
			}
		}
		const tensor = new rt.Tensor('float32', data, [batch, 3, INPUT_SIDE, INPUT_SIDE]);
		const result = await this.session.run({ [this.inputName]: tensor });
		const output = result[this.outputName];
		const dims = output.dims;
		const dim = dims[dims.length - 1];
		const stride = this.cls && dims.length === 3 ? dims[1] * dim : dim;
		const vecs = [];
		for (let k = 0; k < batch; k++) {
			const e = Float32Array.from(output.data.subarray(k * stride, k * stride + dim));
			let sum = 0;
			for (let i = 0; i < e.length; i++) sum += e[i] * e[i];
			const inv = Math.fround(1.0 / Math.sqrt(Math.max(sum, 1e-12)));
			for (let i = 0; i < e.length; i++) e[i] = Math.fround(e[i] * inv);
			vecs.push(e);
		}
		return vecs;
	}

	async release() {
		try { if (this.session && this.session.release) await this.session.release(); } catch { /* ignore */ }
	}
}

// ── AI partial detection (ScanEngine_AiPartial.cs) ──

const AI_PARTIAL_MIN_CONSISTENT_HITS = 4;
const AI_PARTIAL_OFFSET_TOLERANCE_SECONDS = 30;
const AI_PARTIAL_MAX_FRAMES_PER_FILE = 400;

function aiPartialIntervalSeconds(durationSeconds) {
	return Math.max(Math.min(Math.max(durationSeconds / 60, 5), 15), durationSeconds / AI_PARTIAL_MAX_FRAMES_PER_FILE);
}

module.exports = {
	MODEL_FILE,
	MODEL_SHA256,
	MODEL_URLS,
	MODEL_BYTES_APPROX,
	INPUT_SIDE,
	MAX_BATCH,
	Embedder,
	status,
	downloadModel,
	modelPath,
	loadRuntime,
	aiPartialIntervalSeconds,
	AI_PARTIAL_MIN_CONSISTENT_HITS,
	AI_PARTIAL_OFFSET_TOLERANCE_SECONDS,
	AI_PARTIAL_MAX_FRAMES_PER_FILE,
};
