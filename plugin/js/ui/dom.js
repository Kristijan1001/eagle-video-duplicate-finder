'use strict';
// Small DOM + formatting helpers shared by the views.

const { ico } = require('./icons');

// The views build trees with conditional children (`cond ? el : null`). Native append()
// would render those as the text "null"/"false", so skip empty values — in this plugin
// window only, where every caller expects that.
for (const proto of [Element.prototype, DocumentFragment.prototype]) {
	if (proto.__vdfAppend) continue;
	const native = proto.append;
	proto.append = function (...nodes) { return native.apply(this, nodes.flat(Infinity).filter((n) => n != null && n !== false)); };
	proto.__vdfAppend = true;
}

/** h('div.cls#id', {attrs/on*}, ...children) */
function h(tag, props, ...children) {
	const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(tag) || [];
	const el = document.createElement(m[1] || 'div');
	for (const part of (m[2] || '').match(/[.#][\w-]+/g) || []) {
		if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
	}
	if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) { children.unshift(props); props = null; }
	if (props) {
		for (const [k, v] of Object.entries(props)) {
			if (v == null || v === false) continue;
			if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
			else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
			else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
			else if (k === 'html') el.innerHTML = v;
			else if (k === 'dataset') Object.assign(el.dataset, v);
			else if (k in el && typeof v !== 'string' && k !== 'list') el[k] = v;
			else el.setAttribute(k, v === true ? '' : v);
		}
	}
	append(el, children);
	return el;
}

function append(el, children) {
	for (const c of children.flat(Infinity)) {
		if (c == null || c === false) continue;
		el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
	}
	return el;
}

/** Element from an icon name (parsed once per name/size/class, then cloned). */
const iconCache = new Map();
function icon(name, size = 16, cls = '') {
	const key = `${name}|${size}|${cls}`;
	let proto = iconCache.get(key);
	if (!proto) {
		const t = document.createElement('template');
		t.innerHTML = ico(name, size, cls);
		proto = t.content.firstChild;
		iconCache.set(key, proto);
	}
	return proto.cloneNode(true);
}

function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

function esc(s) {
	return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

// ── formatting (VDF Extensions.BytesToString / TimeSpan.Format) ──

const SIZE_SUFFIX = [' B', ' KB', ' MB', ' GB', ' TB', ' PB'];
function bytes(n) {
	n = Number(n) || 0;
	if (n === 0) return '0 B';
	let i = 0, v = n;
	while (v >= 1024 && i < SIZE_SUFFIX.length - 1) { v /= 1024; i++; }
	return `${v.toFixed(1)}${SIZE_SUFFIX[i]}`;
}

function duration(sec) {
	sec = Math.max(0, Math.floor(Number(sec) || 0));
	const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
	return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function span(ms) {
	let s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
	const d = Math.floor(s / 86400); s %= 86400;
	const hh = Math.floor(s / 3600); s %= 3600;
	const mm = Math.floor(s / 60); const ss = s % 60;
	if (d) return hh ? `${d}d ${hh}h` : `${d}d`;
	if (hh) return mm ? `${hh}h ${mm}m` : `${hh}h`;
	if (mm) return `${mm}m ${ss}s`;
	return `${ss}s`;
}

function date(ms) {
	if (!ms) return '—';
	const d = new Date(ms);
	return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function dateTime(ms) {
	if (!ms) return '—';
	return new Date(ms).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function number(n) { return (Number(n) || 0).toLocaleString(); }

function debounce(fn, ms) {
	let t = null;
	return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function fileUrl(p) {
	if (!p) return '';
	return require('url').pathToFileURL(p).href;
}

module.exports = { h, append, icon, clear, esc, bytes, duration, span, date, dateTime, number, debounce, fileUrl, ico };
