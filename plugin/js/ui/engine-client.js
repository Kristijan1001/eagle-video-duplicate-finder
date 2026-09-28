'use strict';
// Starts the background engine (Eagle's runtime as Node, see engine/main.js) and talks to it
// over the fork IPC channel. Restarts it transparently if it ever dies.

const path = require('path');
const { fork } = require('child_process');

class EngineClient {
	constructor(pluginRoot) {
		this.script = path.join(pluginRoot, 'js', 'engine', 'main.js');
		this.child = null;
		this.nextId = 1;
		this.pending = new Map();
		this.listeners = new Map();
		this.initArgs = null;
		this.exitCount = 0;
	}

	on(event, fn) {
		if (!this.listeners.has(event)) this.listeners.set(event, new Set());
		this.listeners.get(event).add(fn);
		return () => this.listeners.get(event).delete(fn);
	}
	emit(event, data) { for (const fn of this.listeners.get(event) || []) { try { fn(data); } catch (err) { console.error(err); } } }

	start() {
		if (this.child) return;
		this.child = fork(this.script, [], {
			execPath: process.execPath,
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
			stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
			windowsHide: true,
		});
		this.child.stdout.on('data', (d) => this.emit('log', { t: Date.now(), level: 'debug', message: String(d).trim() }));
		this.child.stderr.on('data', (d) => this.emit('log', { t: Date.now(), level: 'error', message: String(d).trim() }));
		this.child.on('message', (m) => this.onMessage(m));
		this.child.on('exit', (code) => {
			const was = this.child;
			this.child = null;
			for (const [, p] of this.pending) p.reject(new Error('The engine stopped unexpectedly.'));
			this.pending.clear();
			if (was && !this.stopping) {
				this.exitCount++;
				this.emit('log', { t: Date.now(), level: 'error', message: `Engine exited (code ${code}).` });
				this.emit('exit', { code });
			}
		});
	}

	onMessage(m) {
		if (!m) return;
		if (m.event) { this.emit(m.event, m.data); return; }
		const p = this.pending.get(m.id);
		if (!p) return;
		this.pending.delete(m.id);
		if (m.ok) p.resolve(m.result);
		else { const e = new Error(m.error); e.engineStack = m.stack; p.reject(e); }
	}

	async init(args) {
		this.initArgs = args;
		return this.call('init', args);
	}

	/** Call an engine command; starts (and re-initialises) the engine when needed. */
	async call(cmd, args = {}) {
		if (!this.child) {
			this.start();
			if (this.initArgs && cmd !== 'init') await this.raw('init', this.initArgs);
		}
		return this.raw(cmd, args);
	}

	raw(cmd, args) {
		return new Promise((resolve, reject) => {
			const id = this.nextId++;
			this.pending.set(id, { resolve, reject });
			try { this.child.send({ id, cmd, args }); }
			catch (err) { this.pending.delete(id); reject(err); }
		});
	}

	get running() { return !!this.child; }

	async stop() {
		if (!this.child) return;
		this.stopping = true;
		try { await Promise.race([this.raw('shutdown', {}), new Promise((r) => setTimeout(r, 1500))]); } catch { /* ignore */ }
		try { this.child && this.child.kill(); } catch { /* ignore */ }
		this.child = null;
		this.stopping = false;
	}
}

module.exports = { EngineClient };
