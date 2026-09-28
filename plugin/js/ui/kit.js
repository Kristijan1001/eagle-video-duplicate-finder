'use strict';
// Popover menus, modal dialogs, confirm/prompt/alert and toasts.

const { h, icon, clear } = require('./dom');

let openMenuEl = null;

function closeMenu() {
	if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; }
	document.removeEventListener('mousedown', outsideMenu, true);
	document.removeEventListener('keydown', escMenu, true);
}
function outsideMenu(e) { if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu(); }
function escMenu(e) { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } }

/**
 * Show a menu near an anchor element (or at {x, y}).
 * items: [{label, icon, key, danger, disabled, onClick} | '-' | {header}]
 */
function menu(anchor, items, { align = 'left' } = {}) {
	closeMenu();
	const el = h('div.menu', { role: 'menu' });
	for (const it of items) {
		if (!it) continue;
		if (it === '-') { el.appendChild(h('div.msep')); continue; }
		if (it.header) { el.appendChild(h('div.mhead', it.header)); continue; }
		const row = h(`div.mi${it.danger ? '.danger' : ''}${it.disabled ? '.disabled' : ''}`, { role: 'menuitem' },
			it.icon ? icon(it.icon, 15) : h('span', { style: { width: '15px' } }),
			h('span', it.label),
			it.key ? h('span.k', it.key) : null);
		row.addEventListener('click', () => { closeMenu(); it.onClick && it.onClick(); });
		el.appendChild(row);
	}
	document.body.appendChild(el);
	let x, y;
	if (anchor && anchor.getBoundingClientRect) {
		const r = anchor.getBoundingClientRect();
		x = align === 'right' ? r.right - el.offsetWidth : r.left;
		y = r.bottom + 4;
	}
	else { x = anchor.x; y = anchor.y; }
	x = Math.max(6, Math.min(x, window.innerWidth - el.offsetWidth - 6));
	if (y + el.offsetHeight > window.innerHeight - 6) y = Math.max(6, (anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect().top : y) - el.offsetHeight - 4);
	el.style.left = `${x}px`;
	el.style.top = `${y}px`;
	openMenuEl = el;
	setTimeout(() => {
		document.addEventListener('mousedown', outsideMenu, true);
		document.addEventListener('keydown', escMenu, true);
	}, 0);
	return el;
}

const modalStack = [];

/**
 * Open a modal. Returns { el, body, foot, close(result), result: Promise }.
 */
function modal({ title, width = '', body, foot, onClose, closeOnBackdrop = true, icon: ic }) {
	let resolve;
	const result = new Promise((r) => { resolve = r; });
	const back = h('div.modal-back');
	const box = h(`div.modal${width ? '.' + width : ''}`, { role: 'dialog', 'aria-modal': 'true' });
	const head = h('div.modal-head', ic ? icon(ic, 18) : null, h('h2', title || ''),
		h('button.icon-btn', { title: 'Close', onclick: () => api.close(undefined) }, icon('close', 16)));
	const bodyEl = h('div.modal-body');
	const footEl = h('div.modal-foot');
	box.append(head, bodyEl, footEl);
	back.appendChild(box);
	if (closeOnBackdrop) back.addEventListener('mousedown', (e) => { if (e.target === back) api.close(undefined); });
	const onKey = (e) => {
		if (modalStack[modalStack.length - 1] !== api) return;
		if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); api.close(undefined); }
	};
	document.addEventListener('keydown', onKey, true);
	const api = {
		el: box, body: bodyEl, foot: footEl, result,
		close(r) {
			document.removeEventListener('keydown', onKey, true);
			back.remove();
			const i = modalStack.indexOf(api);
			if (i >= 0) modalStack.splice(i, 1);
			if (onClose) onClose(r);
			resolve(r);
		},
	};
	if (body) (body instanceof Node ? bodyEl.appendChild(body) : bodyEl.append(...[].concat(body)));
	if (foot) footEl.append(...[].concat(foot));
	else footEl.remove();
	document.getElementById('overlay-root').appendChild(back);
	modalStack.push(api);
	return api;
}

function confirmDialog({ title, message, detail, okLabel = 'OK', cancelLabel = 'Cancel', danger = false, icon: ic = danger ? 'warning' : 'info', extra = null }) {
	const ok = h(`button.btn.${danger ? 'danger' : 'primary'}`, okLabel);
	const cancel = h('button.btn', cancelLabel);
	const m = modal({
		title, icon: ic,
		body: [h('div', { style: { whiteSpace: 'pre-wrap' } }, message || ''), detail ? h('div.faint.small', { style: { marginTop: '10px', whiteSpace: 'pre-wrap' } }, detail) : null, extra].filter(Boolean),
		foot: [cancel, ok],
	});
	ok.onclick = () => m.close(true);
	cancel.onclick = () => m.close(false);
	setTimeout(() => ok.focus(), 0);
	return m.result.then((r) => !!r);
}

function alertDialog(title, message, ic = 'info') {
	const ok = h('button.btn.primary', 'OK');
	const m = modal({ title, icon: ic, body: h('div', { style: { whiteSpace: 'pre-wrap' } }, message), foot: [ok] });
	ok.onclick = () => m.close(true);
	setTimeout(() => ok.focus(), 0);
	return m.result;
}

function promptDialog({ title, label, value = '', okLabel = 'OK', placeholder = '', validate }) {
	const input = h('input.input', { value, placeholder, style: { width: '100%' } });
	const err = h('div.small', { style: { color: 'var(--bad)', minHeight: '18px', marginTop: '6px' } });
	const ok = h('button.btn.primary', okLabel);
	const cancel = h('button.btn', 'Cancel');
	const m = modal({ title, body: [label ? h('div.muted', { style: { marginBottom: '8px' } }, label) : null, input, err].filter(Boolean), foot: [cancel, ok] });
	const submit = () => {
		const v = input.value;
		const problem = validate ? validate(v) : null;
		if (problem) { err.textContent = problem; return; }
		m.close(v);
	};
	ok.onclick = submit;
	cancel.onclick = () => m.close(null);
	input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
	setTimeout(() => { input.focus(); input.select(); }, 0);
	return m.result.then((r) => (r == null ? null : r));
}

/** Three-way choice. options: [{label, value, primary, danger}] */
function choiceDialog({ title, message, options, icon: ic = 'info' }) {
	const btns = options.map((o) => h(`button.btn${o.primary ? '.primary' : ''}${o.danger ? '.danger' : ''}`, o.label));
	const m = modal({ title, icon: ic, body: h('div', { style: { whiteSpace: 'pre-wrap' } }, message), foot: btns });
	btns.forEach((b, i) => { b.onclick = () => m.close(options[i].value); });
	return m.result;
}

function toast(message, { kind = 'info', timeout = 4500, action = null } = {}) {
	const root = document.getElementById('toast-root');
	const el = h(`div.toast.${kind}`, icon(kind === 'good' ? 'check' : kind === 'bad' ? 'error' : 'info', 16), h('div', message));
	if (action) el.appendChild(h('button.btn.small.act', { onclick: () => { action.onClick(); el.remove(); } }, action.label));
	root.appendChild(el);
	setTimeout(() => el.remove(), timeout);
	return el;
}

/** Busy overlay with a progress line; returns { update(text, frac), close() }. */
function busy(title) {
	const text = h('div.muted', { style: { marginTop: '8px' } }, '');
	const bar = h('div.bar', h('div', { style: { width: '0%' } }));
	const m = modal({ title, body: [bar, text], closeOnBackdrop: false });
	m.el.querySelector('.modal-head .icon-btn').style.display = 'none';
	return {
		update(t, frac) {
			text.textContent = t || '';
			if (frac == null) bar.classList.add('indet');
			else { bar.classList.remove('indet'); bar.firstChild.style.width = `${Math.round(frac * 100)}%`; }
		},
		close() { m.close(); },
	};
}

module.exports = { menu, closeMenu, modal, confirmDialog, alertDialog, promptDialog, choiceDialog, toast, busy, clear };
