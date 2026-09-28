'use strict';
// Compare window: VDF's ThumbnailComparer (Single / Swipe / Side by side / Stacked, frame
// stepping per side and together, structural difference boxes, winner-stays culling with
// keep-left / keep-right / not-a-match and group navigation) plus synced playback of both
// files. Videos play in the page's own <video> player; a file whose codec that player cannot
// decode falls back to frames extracted by the engine's FFmpeg (everything but playback works).

const { h, icon, clear, bytes, date, number, fileUrl } = require('./dom');
const diffmap = require('../core/diffmap');
const { CullingPairFlow, buildChips } = require('../core/comparer-logic');

const MODES = [['Single', 'single', 'Single'], ['Swipe', 'swipe', 'Swipe'], ['SideBySide', 'compare', 'Side by side'], ['Stacked', 'stacked', 'Stacked']];
const SPEEDS = [0.25, 0.5, 1, 1.5, 2];
const SVG_NS = 'http://www.w3.org/2000/svg';
let sessionAudio = 'A';
let sessionSpeed = 1;

/** 0:26.03 / 1:02:03.40 */
function fmtTime(t) {
	t = Math.max(0, Number(t) || 0);
	const hh = Math.floor(t / 3600), mm = Math.floor(t / 60) % 60, ss = Math.floor(t % 60), cs = Math.floor((t % 1) * 100);
	const p = (n) => String(n).padStart(2, '0');
	return `${hh ? `${hh}:${p(mm)}` : mm}:${p(ss)}.${p(cs)}`;
}

// ── one file on screen: <video>, an FFmpeg-extracted still, or an image ──
function createSurface(app, m, file) {
	const s = { m, file, kind: m.isImage ? 'image' : 'video', el: null, natW: 0, natH: 0, error: null, duration: m.duration || 0, token: 0, onFallback: null };
	s.fps = m.fps > 1 ? m.fps : 25;

	if (m.isImage) {
		s.el = h('img', { draggable: false, alt: '' });
		s.ready = new Promise((res) => {
			s.el.onload = () => { s.natW = s.el.naturalWidth; s.natH = s.el.naturalHeight; res(); };
			s.el.onerror = () => { s.error = 'The image could not be loaded.'; res(); };
			s.el.src = fileUrl(file);
		});
		s.seek = async () => {};
		s.release = () => { s.el.removeAttribute('src'); };
		return s;
	}

	const frames = new Map();
	const still = h('img', { draggable: false, alt: '' });
	async function stillAt(t) {
		const token = ++s.token;
		const key = Math.max(0, t).toFixed(3);
		let f = frames.get(key);
		if (f === undefined) {
			try { f = await app.engine.call('frame', { id: m.id, file, seconds: Number(key), isImage: false, maxSide: 1920 }); }
			catch { f = null; }
			frames.set(key, f);
		}
		if (token !== s.token) return;
		if (!f) { s.error = 'This frame could not be read.'; return; }
		s.error = null;
		await new Promise((res) => { still.onload = res; still.onerror = res; still.src = fileUrl(f); });
		if (still.naturalWidth) { s.natW = still.naturalWidth; s.natH = still.naturalHeight; }
	}

	const v = document.createElement('video');
	v.preload = 'auto';
	v.muted = true;
	v.playsInline = true;
	v.disablePictureInPicture = true;
	s.el = v;
	let released = false;
	function toStill() {
		if (s.kind !== 'video') return;
		s.kind = 'still';
		const parent = v.parentNode;
		if (parent) parent.replaceChild(still, v);
		s.el = still;
		v.pause();
		v.removeAttribute('src');
		v.load();
	}
	s.ready = new Promise((res) => {
		let done = false;
		const finish = (ok) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			if (ok) { s.natW = v.videoWidth; s.natH = v.videoHeight; if (Number.isFinite(v.duration) && v.duration > 0) s.duration = v.duration; }
			else toStill();
			res();
		};
		const timer = setTimeout(() => finish(false), 8000);
		v.addEventListener('loadeddata', () => finish(v.videoWidth > 0), { once: true });
		v.addEventListener('error', () => finish(false), { once: true });
		v.src = fileUrl(file);
	});
	// some streams load but fail to decode later: switch to FFmpeg frames then
	v.addEventListener('error', () => { if (!released && s.kind === 'video') { toStill(); if (s.onFallback) s.onFallback(s); } });

	s.seek = (t) => {
		t = Math.max(0, Math.min(t, Math.max(0, s.duration - 0.001)));
		if (s.kind === 'still') return stillAt(t);
		return new Promise((res) => {
			if (Math.abs(v.currentTime - t) < 0.0005 && v.readyState >= 2) { res(); return; }
			const done = () => { v.removeEventListener('seeked', done); clearTimeout(to); res(); };
			const to = setTimeout(done, 6000);
			v.addEventListener('seeked', done);
			v.currentTime = t;
		});
	};
	s.release = () => {
		released = true;
		v.pause();
		v.removeAttribute('src');
		v.load(); // lets go of the file handle, so Eagle can move it to the trash later
		still.removeAttribute('src');
	};
	return s;
}

/**
 * nav (from the Results page): order(members), best(members), position(gid) → {index,total},
 * neighbour(gid, forward) → members | null, check(changes, label), notAMatch(gid) → Promise,
 * filePath(m), dateOf(m), folderText(m), open(m), reveal(m)
 */
function openComparer(app, { members, focusId, nav }) {
	const kit = app.kit;
	const S = () => app.settings;

	let list = [];
	let gid = null;
	let flow = null;
	let best = null;
	let a = null, b = null;
	const surfaces = new Map();          // item id → surface
	let sA = null, sB = null;
	let mode = S().thumbnailComparerMode || 'SideBySide';
	let highlight = !!S().thumbnailComparerHighlightDifferences;
	let sensitivity = Number.isFinite(S().thumbnailComparerDiffSensitivity) ? S().thumbnailComparerDiffSensitivity : 0.5;
	let mirror = false;
	let T = 0;                           // master time on A's timeline (seconds)
	let stepA = 0, stepB = 0;            // per-side frame offsets (VDF StepA / StepB)
	let playing = false;
	let raf = 0;
	let showB = false;                   // Single mode: which file is on screen
	let swipeFrac = 0.5;
	let zoom = 1, panX = 0, panY = 0;
	let applyToken = 0, diffToken = 0;
	let lastRegions = null;
	let msgTimer = null;
	const fits = {};                     // 'A' | 'B' → { fit, inner, overlay, pane, cap }

	// ── chrome ──
	const groupInfo = h('span.cmp-ginfo');
	const simBadge = h('span.badge.good');
	const pairFlags = h('span.cmp-flags');
	const msg = h('span.cmp-msg');
	const modeSeg = h('div.seg');
	const hlBtn = h('button.btn.small', { title: 'Draw boxes around regions that differ (brightness and colour shifts are ignored)' }, icon('eye', 14), 'Highlight differences');
	const sens = h('input.cmp-sens', { type: 'range', min: 0.05, max: 1, step: 0.05, value: sensitivity, title: 'Sensitivity' });
	const mirrorBtn = h('button.btn.small', { title: 'Show B mirrored (for copies matched as mirrored)' }, icon('flip', 14), 'Mirror B');
	const zoomLabel = h('span.cmp-zoom', '100%');
	const top = h('div.cmp-top',
		h('div.cmp-top-l', groupInfo, simBadge, pairFlags, msg),
		h('div.cmp-top-r', hlBtn, h('span.faint.small', 'Sensitivity'), sens, h('span.sep'), mirrorBtn, h('span.sep'), modeSeg, h('span.sep'),
			h('button.icon-btn', { title: 'Fit (Z toggles 100% / 200%)', onclick: () => setZoom(1, true) }, icon('fit', 16)),
			h('button.icon-btn', { title: 'Zoom out', onclick: () => setZoom(zoom / 1.25) }, icon('zoomOut', 16)),
			zoomLabel,
			h('button.icon-btn', { title: 'Zoom in', onclick: () => setZoom(zoom * 1.25) }, icon('zoomIn', 16))));
	const stage = h('div.cmp-stage');
	const handleEl = h('div.swipe-handle');

	// transport
	const playBtn = h('button.icon-btn.cmp-play', { title: 'Play / pause (Space)' }, icon('play', 20));
	const timeLabel = h('span.cmp-time', '0:00.00');
	const range = h('input.cmp-range', { type: 'range', min: 0, max: 1, step: 'any', value: 0 });
	const ticks = h('div.cmp-ticks');
	const speedSel = h('select.select.small', { title: 'Playback speed' }, SPEEDS.map((x) => h('option', { value: x }, `${x}×`)));
	speedSel.value = String(sessionSpeed);
	const audioSeg = h('div.seg.small', { title: 'Which file you hear' });
	const tbtn = (ic, title, fn) => h('button.icon-btn', { title, onclick: fn }, icon(ic, 16));
	const transport = h('div.cmp-transport',
		tbtn('skipBack', 'Previous sampled frame (Shift+←)', () => jumpSample(-1)),
		tbtn('rewind', '1 second back (Ctrl+←)', () => nudge(-1)),
		tbtn('frameBack', 'One frame back, both files (←)', () => stepBoth(-1)),
		playBtn,
		tbtn('frameForward', 'One frame forward, both files (→)', () => stepBoth(1)),
		tbtn('fastForward', '1 second forward (Ctrl+→)', () => nudge(1)),
		tbtn('skipForward', 'Next sampled frame (Shift+→)', () => jumpSample(1)),
		timeLabel,
		h('div.cmp-range-wrap', range, ticks),
		speedSel, audioSeg);

	// per-file panels
	const sideA = h('div.cmp-side');
	const sideB = h('div.cmp-side');
	const sides = h('div.cmp-sides', sideA, sideB);

	const body = h('div.cmp2', top, stage, transport, sides);
	const keepL = h('button.btn', { onclick: () => decide('keepLeft') }, 'Keep left, check right', h('kbd', 'A'));
	const keepR = h('button.btn', { onclick: () => decide('keepRight') }, 'Keep right, check left', h('kbd', 'D'));
	const notMatch = h('button.btn', { onclick: () => markNotAMatch() }, 'Not a match', h('kbd', 'N'));
	const skipBtn = h('button.btn.ghost', { onclick: () => decide('skip') }, 'Skip pair', h('kbd', 'S'));
	const prevGroupBtn = h('button.btn.ghost', { onclick: () => switchGroup(false) }, icon('chevronLeft', 14), 'Previous group');
	const nextGroupBtn = h('button.btn.primary', { onclick: () => switchGroup(true) }, 'Next group', icon('chevronRight', 14));
	const keysHint = h('span.cmp-keys', 'Space play · ← → frame · Shift sample · Ctrl second · [ ] offset B · Z zoom · X switch (Single)');
	const m = kit.modal({
		title: 'Compare', width: 'full', icon: 'compare', body,
		foot: [h('div.row.left', keepL, keepR, notMatch, skipBtn), keysHint, prevGroupBtn, nextGroupBtn],
		onClose: cleanup,
	});
	m.body.style.padding = '0';

	// ── toolbar wiring ──
	function renderToolbar() {
		clear(modeSeg);
		for (const [k, ic, l] of MODES) modeSeg.appendChild(h(`button${mode === k ? '.on' : ''}`, { title: l, onclick: () => { mode = k; app.setSettings({ thumbnailComparerMode: k }); renderToolbar(); layout(); } }, icon(ic, 14), l));
		hlBtn.classList.toggle('on', highlight);
		mirrorBtn.classList.toggle('on', mirror);
		sens.disabled = !highlight;
		clear(audioSeg);
		for (const [k, l, ic] of [['A', 'A', 'audio'], ['B', 'B', 'audio'], ['off', '', 'mute']]) {
			audioSeg.appendChild(h(`button${sessionAudio === k ? '.on' : ''}`, { title: k === 'off' ? 'Mute' : `Hear ${k}`, onclick: () => { sessionAudio = k; applyAudio(); renderToolbar(); } }, icon(ic, 13), l));
		}
	}
	hlBtn.onclick = () => { highlight = !highlight; app.setSettings({ thumbnailComparerHighlightDifferences: highlight }); renderToolbar(); updateDiff(); };
	sens.addEventListener('input', () => { sensitivity = Number(sens.value); updateDiff(); });
	sens.addEventListener('change', () => app.setSettings({ thumbnailComparerDiffSensitivity: sensitivity }));
	mirrorBtn.onclick = () => { mirror = !mirror; renderToolbar(); applyMirror(); updateDiff(); };
	speedSel.addEventListener('change', () => { sessionSpeed = Number(speedSel.value); for (const s of [sA, sB]) if (s && s.kind === 'video') s.el.playbackRate = sessionSpeed; });
	playBtn.onclick = () => togglePlay();
	range.addEventListener('input', () => { pause(false); T = Number(range.value); scheduleApply(); });

	function say(text, ms = 0) {
		clearTimeout(msgTimer);
		msg.textContent = text || '';
		if (ms) msgTimer = setTimeout(() => { msg.textContent = ''; }, ms);
	}

	// ── time model ──
	const isVideoPair = () => !!(a && b && !a.isImage && !b.isImage);
	const aIsClipOfB = () => !!(a.flags & 2) && !(b.flags & 2);
	const bIsClipOfA = () => !!(b.flags & 2) && !(a.flags & 2);
	function mapToB(t) {
		if (bIsClipOfA()) return t - (b.partialOffset || 0);
		if (aIsClipOfB()) return t + (a.partialOffset || 0);
		return t;
	}
	const timeA = () => T + stepA / sA.fps;
	const timeB = () => mapToB(T) + stepB / sB.fps;
	const durA = () => (sA ? sA.duration : 0) || 0;
	function basePositions() {
		if (!isVideoPair()) return [0];
		// a clip compared with its source: the source's matching stretch, from the clip's samples
		if (bIsClipOfA()) return (b.positions || [0]).map((p) => p + (b.partialOffset || 0));
		return (a.positions && a.positions.length ? a.positions : [0]).slice();
	}
	function clampT() { T = Math.max(0, Math.min(T, Math.max(0, durA() - 1 / Math.max(1, sA.fps)))); }

	// ── group / pair ──
	function loadGroup(ms, focus) {
		const live = ms.filter((x) => !x.gone);
		list = nav.order(live);
		gid = list.length ? list[0].groupId : null;
		best = list.length ? nav.best(list) : null;
		flow = new CullingPairFlow(list.length);
		const fi = focus ? list.findIndex((x) => x.id === focus) : -1;
		if (fi > 0) flow.setPair(0, fi);
		showPair();
	}

	let pairToken = 0;
	async function showPair() {
		pause(false);
		const token = ++pairToken;
		if (list.length === 0) { m.close(); return; }
		a = list[flow.leftIndex];
		b = list[Math.min(flow.rightIndex, list.length - 1)];
		if (list.length === 1) b = a;
		// keep the surfaces of files that stay on screen, release the rest
		for (const [id, s] of surfaces) if (id !== a.id && id !== b.id) { s.release(); surfaces.delete(id); }
		const surf = (x) => {
			if (!surfaces.has(x.id)) {
				const s = createSurface(app, x, nav.filePath(x));
				s.onFallback = () => { pause(false); layout(); renderTransport(); say(playbackNote()); apply(); };
				surfaces.set(x.id, s);
			}
			return surfaces.get(x.id);
		};
		sA = surf(a);
		sB = b === a ? sA : surf(b);
		mirror = !!((a.flags ^ b.flags) & 1);
		stepA = 0; stepB = 0;
		showB = false;
		zoom = 1; panX = 0; panY = 0;
		renderHeader();
		renderToolbar();
		renderSides();
		layout();
		say(isVideoPair() ? 'Loading…' : '');
		await Promise.all([sA.ready, sB.ready]);
		if (token !== pairToken || !m.el.isConnected) return; // another pair was picked meanwhile, or closed
		T = basePositions()[0] || 0;
		clampT();
		range.max = String(Math.max(0.01, durA()));
		renderTicks();
		renderTransport();
		layout();
		say(playbackNote());
		await apply();
	}

	function playbackNote() {
		if (!isVideoPair()) return '';
		const bad = [...new Set([sA, sB])].filter((s) => s.kind === 'still');
		if (!bad.length) return '';
		return `Playback off: ${bad.map((s) => `${s.m.name}.${s.m.ext} (${String(s.m.format || 'codec').toUpperCase()})`).join(' and ')} can't be decoded by the built-in player, so frames come from FFmpeg instead.`;
	}

	function renderHeader() {
		const pos = nav.position(gid) || { index: 1, total: 1 };
		groupInfo.textContent = `Group ${pos.index} of ${pos.total} · pair ${flow.pairNumber} / ${Math.max(1, flow.pairCount)} · ${list.length} file${list.length === 1 ? '' : 's'} in group`;
		const sim = Math.round(Math.min(a.similarity || 100, b.similarity || 100));
		simBadge.textContent = `${sim} %`;
		simBadge.className = `badge ${sim >= 98 ? 'good' : sim >= 92 ? 'accent' : 'warn'}`;
		clear(pairFlags);
		const flags = a.flags | b.flags;
		if (flags & 1) pairFlags.appendChild(h('span.badge.accent', icon('flip', 11), 'mirrored'));
		if (flags & 4) pairFlags.appendChild(h('span.badge.violet', icon('ai', 11), 'AI'));
		const clip = bIsClipOfA() ? b : aIsClipOfB() ? a : null;
		if (clip) pairFlags.appendChild(h('span.badge.warn', icon('scissors', 11), `clip @ ${fmtTime(clip.partialOffset || 0)}`));
		const two = list.length >= 2;
		for (const el of [keepL, keepR, skipBtn]) el.disabled = !two;
		prevGroupBtn.disabled = !nav.neighbour(gid, false);
		nextGroupBtn.disabled = !nav.neighbour(gid, true);
	}

	function renderSides() {
		for (const [el, x, other, side] of [[sideA, a, b, 'A'], [sideB, b, a, 'B']]) {
			clear(el);
			const sel = h('select.select', { title: `File shown as ${side}` }, list.map((it, i) => h('option', { value: i }, `${it.name}.${it.ext}`)));
			sel.value = String(list.indexOf(x));
			sel.addEventListener('change', () => pickFile(side, Number(sel.value)));
			const chips = buildChips(x, other === x ? null : other, { bytes, number, date: (it) => (nav.dateOf(it) ? date(nav.dateOf(it)) : '') });
			const stepCtl = isVideoPair() ? h('div.cmp-step', { title: `Offset ${side} by single frames against the other file` },
				h('span.faint.small', 'Offset'),
				h('button.icon-btn.small', { onclick: () => offset(side, -1) }, icon('frameBack', 14)),
				h('span.n', { dataset: { stepFor: side } }, '0'),
				h('button.icon-btn.small', { onclick: () => offset(side, 1) }, icon('frameForward', 14))) : null;
			el.append(
				h('div.cmp-side-head', h('span.cmp-tag', side), sel, x === best ? h('span.badge.good', 'BEST') : null, x.checked ? h('span.badge.bad', 'checked') : null, h('span.spacer'), stepCtl,
					h('button.icon-btn.small', { title: 'Open in Eagle', onclick: () => nav.open(x) }, icon('open', 14)),
					h('button.icon-btn.small', { title: 'Show the file', onclick: () => nav.reveal(x) }, icon('folderOpen', 14))),
				h('div.cmp-path', { title: nav.filePath(x) }, icon('folder', 12), ' ', nav.folderText(x)),
				h('div.cmp-chips', chips.map((c) => h(`span.mchip.${c.state}`, c.text))));
		}
	}

	function renderTicks() {
		clear(ticks);
		const d = durA();
		if (!isVideoPair() || !d) return;
		for (const p of basePositions()) {
			if (p < 0 || p > d) continue;
			ticks.appendChild(h('span.tick', { style: { left: `${(p / d) * 100}%` }, title: `Sampled frame at ${fmtTime(p)}`, onclick: () => { pause(false); T = p; clampT(); apply(); } }));
		}
	}

	function renderTransport() {
		const video = isVideoPair();
		transport.style.display = video ? '' : 'none';
		const canPlay = video && sA.kind === 'video' && sB.kind === 'video';
		playBtn.disabled = !canPlay;
		playBtn.title = canPlay ? 'Play / pause (Space)' : 'Playback needs both files to be playable in the built-in player';
		speedSel.disabled = !canPlay;
		for (const bt of audioSeg.querySelectorAll('button')) bt.disabled = !canPlay;
	}

	function pickFile(side, idx) {
		let li = flow.leftIndex, ri = flow.rightIndex;
		if (side === 'A') { if (idx === ri) ri = li; li = idx; }
		else { if (idx === li) li = ri; ri = idx; }
		flow.setPair(li, ri);
		showPair();
	}

	function decide(decision) {
		if (list.length < 2) return;
		const loserName = decision === 'keepLeft' ? b.name : decision === 'keepRight' ? a.name : '';
		const step = flow.advance(decision);
		const changes = [];
		if (step.checkIndex >= 0) changes.push([list[step.checkIndex], true]);
		if (step.keepIndex >= 0) changes.push([list[step.keepIndex], false]);
		if (changes.length) nav.check(changes, decision === 'keepLeft' ? 'Keep left' : 'Keep right');
		if (step.groupFinished) {
			if (!switchGroup(true, true)) { say(loserName ? `Checked ${loserName}. No more groups.` : 'No more groups.'); renderSides(); renderHeader(); }
			return;
		}
		showPair().then(() => { if (loserName) say(`Checked ${loserName}.`, 1800); });
	}

	function switchGroup(forward, quiet) {
		const next = nav.neighbour(gid, forward);
		if (!next) { if (!quiet) say(forward ? 'This is the last group.' : 'This is the first group.', 2000); return false; }
		loadGroup(next);
		return true;
	}

	async function markNotAMatch() {
		if (!gid) return;
		const next = nav.neighbour(gid, true) || nav.neighbour(gid, false);
		await nav.notAMatch(gid);
		if (next) loadGroup(next);
		else m.close();
	}

	// ── stage layout ──
	function makeFit(s, side) {
		const overlay = document.createElementNS(SVG_NS, 'svg');
		overlay.setAttribute('class', 'cmp-boxes');
		overlay.setAttribute('viewBox', '0 0 1 1');
		overlay.setAttribute('preserveAspectRatio', 'none');
		const inner = h('div.cmp-inner', s.el, overlay);
		const fit = h('div.cmp-fit', inner);
		return { fit, inner, overlay, s, side };
	}

	function layout() {
		if (!sA || !sB) return;
		clear(stage);
		stage.className = `cmp-stage m-${mode}`;
		fits.A = makeFit(sA, 'A');
		fits.B = sB === sA ? null : makeFit(sB, 'B');
		const pane = (children, cap) => h('div.cmp-pane', children, cap);
		const cap = (side) => h('div.cap', { dataset: { capFor: side } });
		if (!fits.B || mode === 'SideBySide' || mode === 'Stacked') {
			stage.append(pane(fits.A.fit, cap('A')));
			if (fits.B) stage.append(pane(fits.B.fit, cap('B')));
		}
		else if (mode === 'Single') {
			const p = pane([fits.A.fit, fits.B.fit], cap('single'));
			p.title = 'Click or press X to switch between A and B';
			p.addEventListener('click', () => { if (!dragMoved) { showB = !showB; applySingle(); } });
			stage.append(p);
			applySingle();
		}
		else { // Swipe: B underneath, A on top clipped at the divider
			const p = pane([fits.B.fit, fits.A.fit, handleEl], cap('swipe'));
			p.addEventListener('mousemove', (e) => { if (!dragging) { const r = p.getBoundingClientRect(); swipeFrac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); applySwipe(); } });
			stage.append(p);
		}
		applyMirror();
		placeFits();
		updateCaptions();
		drawBoxes(lastRegions);
	}

	function applySingle() {
		if (mode !== 'Single' || !fits.B) return;
		fits.A.fit.style.visibility = showB ? 'hidden' : '';
		fits.B.fit.style.visibility = showB ? '' : 'hidden';
		updateCaptions();
	}

	function applySwipe() {
		if (mode !== 'Swipe' || !fits.B) return;
		const p = fits.A.fit.parentElement;
		const pr = p.getBoundingClientRect();
		const x = pr.left + swipeFrac * pr.width;
		handleEl.style.left = `${swipeFrac * 100}%`;
		const fr = fits.A.fit.getBoundingClientRect();
		const local = fr.width ? Math.min(1, Math.max(0, (x - fr.left) / fr.width)) : swipeFrac;
		fits.A.fit.style.clipPath = `inset(0 ${(1 - local) * 100}% 0 0)`;
	}

	function applyMirror() {
		if (fits.B) fits.B.inner.style.transform = mirror ? 'scaleX(-1)' : '';
	}

	function placeFits() {
		for (const f of [fits.A, fits.B]) {
			if (!f) continue;
			const pane = f.fit.parentElement;
			if (!pane) continue;
			const pw = pane.clientWidth, ph = pane.clientHeight;
			const nw = f.s.natW || 16, nh = f.s.natH || 9;
			const k = Math.min(pw / nw, ph / nh) || 0;
			const w = nw * k, hh = nh * k;
			Object.assign(f.fit.style, { width: `${w}px`, height: `${hh}px`, left: `${(pw - w) / 2}px`, top: `${(ph - hh) / 2}px`, transform: `translate(${panX}px, ${panY}px) scale(${zoom})` });
		}
		zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
		applySwipe();
	}

	// ── zoom & pan (shared by both panes) ──
	function setZoom(z, reset) {
		zoom = Math.min(8, Math.max(1, z));
		if (reset || zoom === 1) { panX = 0; panY = 0; }
		placeFits();
	}
	let dragging = false, dragMoved = false, dragX = 0, dragY = 0;
	stage.addEventListener('wheel', (e) => {
		e.preventDefault();
		const pane = e.target.closest('.cmp-pane');
		if (!pane) return;
		const r = pane.getBoundingClientRect();
		const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
		const z2 = Math.min(8, Math.max(1, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
		const dx = (e.clientX - cx - panX) / zoom, dy = (e.clientY - cy - panY) / zoom;
		panX = e.clientX - cx - dx * z2;
		panY = e.clientY - cy - dy * z2;
		zoom = z2;
		if (zoom === 1) { panX = 0; panY = 0; }
		placeFits();
	}, { passive: false });
	stage.addEventListener('mousedown', (e) => {
		if (e.button !== 0) return;
		dragging = zoom > 1; dragMoved = false; dragX = e.clientX; dragY = e.clientY;
	});
	const onMove = (e) => {
		if (!dragging) return;
		const dx = e.clientX - dragX, dy = e.clientY - dragY;
		if (Math.abs(dx) + Math.abs(dy) > 2) dragMoved = true;
		panX += dx; panY += dy; dragX = e.clientX; dragY = e.clientY;
		placeFits();
	};
	const onUp = () => { dragging = false; setTimeout(() => { dragMoved = false; }, 0); };
	window.addEventListener('mousemove', onMove);
	window.addEventListener('mouseup', onUp);
	const ro = new ResizeObserver(() => placeFits());
	ro.observe(stage);

	// ── seeking & captions ──
	let applyTimer = null;
	function scheduleApply() {
		updateCaptions();
		clearTimeout(applyTimer);
		const still = [sA, sB].some((s) => s && s.kind === 'still');
		applyTimer = setTimeout(() => apply(), still ? 180 : 0);
	}

	async function apply() {
		if (!sA || !sB) return;
		const token = ++applyToken;
		updateCaptions();
		drawBoxes(null);
		await Promise.all([sA.seek(timeA()), sB === sA ? null : sB.seek(timeB())]);
		if (token !== applyToken) return;
		placeFits();
		updateCaptions();
		const err = [sA, sB].map((s) => s.error).find(Boolean);
		if (err) say(err);
		updateDiff();
	}

	function updateCaptions() {
		if (!sA || !sB) return;
		const line = (s, t, step) => {
			const x = s.m;
			if (x.isImage) return `${x.name}.${x.ext} · ${x.frameSize || ''}`;
			return `${x.name}.${x.ext}  |  ~Frame ${Math.round(t * s.fps)}  |  ${fmtTime(t)}${step ? `  (step ${step > 0 ? '+' : ''}${step})` : ''}`;
		};
		const ta = sA.m.isImage ? 0 : Math.max(0, timeA()), tb = sB.m.isImage ? 0 : Math.max(0, timeB());
		for (const el of stage.querySelectorAll('.cap')) {
			const f = el.dataset.capFor;
			if (f === 'A') el.textContent = `A · ${line(sA, ta, stepA)}`;
			else if (f === 'B') el.textContent = `B · ${line(sB, tb, stepB)}`;
			else if (f === 'single') el.textContent = showB ? `B · ${line(sB, tb, stepB)}` : `A · ${line(sA, ta, stepA)}`;
			else el.textContent = `A (left of the line) ${sA.m.name}  |  B ${sB.m.name}  |  ${fmtTime(ta)}`;
		}
		for (const el of sides.querySelectorAll('[data-step-for]')) el.textContent = String(el.dataset.stepFor === 'A' ? stepA : stepB);
		if (isVideoPair()) {
			timeLabel.textContent = `${fmtTime(ta)} / ${fmtTime(durA())}`;
			if (document.activeElement !== range) range.value = String(T);
		}
	}

	function stepBoth(n) { pause(false); T += n / sA.fps; clampT(); scheduleApply(); }
	function nudge(sec) { pause(false); T += sec; clampT(); scheduleApply(); }
	function offset(side, n) { pause(false); if (side === 'A') stepA += n; else stepB += n; scheduleApply(); }
	function jumpSample(dir) {
		pause(false);
		const ps = basePositions().filter((p) => p >= 0 && p <= durA()).sort((x, y) => x - y);
		if (!ps.length) return;
		const eps = 0.01;
		const next = dir > 0 ? ps.find((p) => p > T + eps) : [...ps].reverse().find((p) => p < T - eps);
		T = next != null ? next : (dir > 0 ? ps[ps.length - 1] : ps[0]);
		stepA = 0; stepB = 0;
		clampT();
		apply();
	}

	// ── playback ──
	function applyAudio() {
		for (const [s, k] of [[sA, 'A'], [sB, 'B']]) if (s && s.kind === 'video') s.el.muted = sessionAudio !== k || (k === 'B' && sB === sA);
	}
	function togglePlay() { if (playing) pause(true); else play(); }
	function play() {
		if (playing || !isVideoPair() || sA.kind !== 'video' || sB.kind !== 'video') return;
		const vA = sA.el, vB = sB.el;
		if (timeA() >= durA() - 0.05) { T = 0; stepA = 0; }
		playing = true;
		drawBoxes(null);
		playBtn.replaceChildren(icon('pause', 20));
		for (const v of [vA, vB]) v.playbackRate = sessionSpeed;
		applyAudio();
		vA.currentTime = Math.max(0, timeA());
		const tb = timeB();
		if (tb >= 0 && tb < sB.duration) { vB.currentTime = tb; vB.play().catch(() => {}); }
		vA.play().catch(() => pause(false));
		const loop = () => {
			if (!playing) return;
			T = vA.currentTime - stepA / sA.fps;
			const target = timeB();
			const inB = target >= 0 && target < sB.duration - 0.02;
			if (inB) {
				if (Math.abs(vB.currentTime - target) > 0.12) vB.currentTime = target;
				if (vB.paused && !vA.paused) vB.play().catch(() => {});
			}
			else if (!vB.paused) vB.pause();
			updateCaptions();
			if (vA.ended || vA.paused) { pause(true); return; }
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
	}
	function pause(settle) {
		if (!playing) return;
		playing = false;
		cancelAnimationFrame(raf);
		playBtn.replaceChildren(icon('play', 20));
		if (sA && sA.kind === 'video') { sA.el.pause(); T = sA.el.currentTime - stepA / sA.fps; }
		if (sB && sB.kind === 'video') sB.el.pause();
		clampT();
		if (settle) apply(); // line B up exactly and redraw the difference boxes
	}

	// ── difference boxes (VDF DifferenceMap) ──
	function grab(s, w, hh, flip) {
		const c = document.createElement('canvas');
		c.width = w; c.height = hh;
		const x = c.getContext('2d', { willReadFrequently: true });
		if (flip) { x.translate(w, 0); x.scale(-1, 1); }
		x.drawImage(s.el, 0, 0, w, hh);
		return x.getImageData(0, 0, w, hh);
	}
	function updateDiff() {
		const token = ++diffToken;
		if (!highlight || playing || !sA || !sB || sA === sB || !sA.natW || !sB.natW) { lastRegions = null; drawBoxes(null); return; }
		// analyse on a canvas no bigger than needed (the grid itself is at most 384 px)
		const [w, hh] = diffmap.analysisSize(sA.natW, sA.natH, 1152);
		let result = null;
		try { result = diffmap.diffFrames(grab(sA, w, hh, false), grab(sB, w, hh, mirror), sensitivity); }
		catch { result = null; }
		if (token !== diffToken) return;
		lastRegions = result ? result.regions : null;
		drawBoxes(lastRegions);
		if (!result) say('The difference view is not available for this pair.', 3000);
		else if (!msg.textContent || /region|difference/i.test(msg.textContent)) say(result.regions.length ? `${result.regions.length} region${result.regions.length === 1 ? ' differs' : 's differ'}` : 'No structural difference');
	}
	function drawBoxes(regions) {
		for (const f of [fits.A, fits.B]) {
			if (!f) continue;
			while (f.overlay.firstChild) f.overlay.removeChild(f.overlay.firstChild);
			if (!regions) continue;
			for (const r of regions) {
				const rect = document.createElementNS(SVG_NS, 'rect');
				// B's box sits in a mirrored container when "Mirror B" is on: pre-flip it
				const x = f.side === 'B' && mirror ? 1 - r.x - r.width : r.x;
				rect.setAttribute('x', x); rect.setAttribute('y', r.y);
				rect.setAttribute('width', r.width); rect.setAttribute('height', r.height);
				f.overlay.appendChild(rect);
			}
		}
	}

	// ── keyboard ──
	function onKey(e) {
		if (!m.el.isConnected) return;
		const topBack = document.querySelector('#overlay-root > .modal-back:last-child');
		if (!topBack || !topBack.contains(m.el)) return;
		const tag = (e.target && e.target.tagName) || '';
		if (tag === 'INPUT' && e.target.type !== 'range') return;
		if (tag === 'SELECT' || tag === 'TEXTAREA') return;
		const k = e.key;
		let handled = true;
		if (k === ' ') togglePlay();
		else if (k === 'ArrowLeft' || k === 'ArrowRight') {
			const dir = k === 'ArrowLeft' ? -1 : 1;
			if (e.shiftKey) jumpSample(dir); else if (e.ctrlKey) nudge(dir); else stepBoth(dir);
		}
		else if (k === '[') offset('B', -1);
		else if (k === ']') offset('B', 1);
		else if (k === 'a' || k === 'A') decide('keepLeft');
		else if (k === 'd' || k === 'D') decide('keepRight');
		else if (k === 'n' || k === 'N') markNotAMatch();
		else if (k === 's' || k === 'S') decide('skip');
		else if (k === 'z' || k === 'Z') setZoom(zoom > 1 ? 1 : 2, true);
		else if ((k === 'x' || k === 'X') && mode === 'Single') { showB = !showB; applySingle(); }
		else if (k === 'PageDown') switchGroup(true);
		else if (k === 'PageUp') switchGroup(false);
		else handled = false;
		if (handled) { e.preventDefault(); e.stopPropagation(); }
	}
	document.addEventListener('keydown', onKey, true);

	function cleanup() {
		playing = false;
		cancelAnimationFrame(raf);
		clearTimeout(applyTimer);
		clearTimeout(msgTimer);
		document.removeEventListener('keydown', onKey, true);
		window.removeEventListener('mousemove', onMove);
		window.removeEventListener('mouseup', onUp);
		ro.disconnect();
		for (const s of surfaces.values()) s.release();
		surfaces.clear();
	}

	loadGroup(members, focusId);
	return m;
}

module.exports = { openComparer, fmtTime };
