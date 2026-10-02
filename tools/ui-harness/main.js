'use strict';
// Development harness: runs the plugin UI in Electron 22 (the runtime Eagle 4 uses) with a
// stand-in `eagle` API (mock-eagle.js) over the fixture library, so the UI can be exercised
// and screenshotted without touching a real Eagle library.
//
//   electron tools/ui-harness/main.js [--port 47611] [--eagle-url]
//
// --eagle-url loads the page the way Eagle does on Windows: through the eagleplugin://
// scheme with the file URL spliced in (eagleplugin://<id>//C:/.../index.html?theme=&locale=).
//
// Control endpoint (127.0.0.1 only):
//   POST /eval      body = JS expression/statements, returns JSON result
//   GET  /shot?file=path.png   capture the window
//   GET  /console   collected console messages (and clears them)
//   GET  /reload    reload the page
//   GET  /size?w=&h=  resize the window
//   GET  /key?code=Enter   send a real key press to the page

const { app, BrowserWindow, ipcMain, dialog, clipboard, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { pathToFileURL } = require('url');

const eagleUrl = process.argv.includes('--eagle-url');
if (eagleUrl) protocol.registerSchemesAsPrivileged([{ scheme: 'eagleplugin', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

const root = path.resolve(__dirname, '..', '..');
const pluginDir = path.join(root, 'plugin');
const port = Number((process.argv.find((a) => a.startsWith('--port=')) || '').split('=')[1]) || 47611;
const consoleLog = [];
let quitting = false;
let win;

app.whenReady().then(() => {
	win = new BrowserWindow({
		width: 1320, height: 860, frame: false, show: true, backgroundColor: '#2a2b2f',
		webPreferences: {
			nodeIntegration: true, contextIsolation: false, webSecurity: false, sandbox: false, backgroundThrottling: false, // as Eagle's plugin windows
			preload: path.join(__dirname, 'mock-eagle.js'),
		},
	});
	win.webContents.on('console-message', (_e, level, message, line, source) => {
		consoleLog.push({ level: ['verbose', 'info', 'warning', 'error'][level] || level, message, source: `${path.basename(source || '')}:${line}` });
		if (consoleLog.length > 2000) consoleLog.shift();
	});
	win.webContents.on('render-process-gone', (_e, d) => consoleLog.push({ level: 'error', message: `renderer gone: ${d.reason}` }));
	if (eagleUrl) {
		const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));
		// eagleplugin://<id>/<path> → file on disk (host = plugin id, path = drive path)
		protocol.registerFileProtocol('eagleplugin', (req, cb) => {
			const u = new URL(req.url);
			cb({ path: path.normalize(decodeURIComponent(u.pathname).replace(/^\/+(?=[A-Za-z]:)/, '')) });
		});
		const url = pathToFileURL(`${pluginDir}/${manifest.main.url}`).href.replace('file://', `eagleplugin://${manifest.id}/`) + '?theme=GRAY&locale=en';
		consoleLog.push({ level: 'info', message: `loading ${url}` });
		win.loadURL(url);
	}
	else win.loadFile(path.join(pluginDir, 'index.html'), { query: { theme: 'GRAY', locale: 'en' } });

	// Eagle's keepAlive behaviour: close only hides; 'hide' starts the destroy timer, 'show'
	// cancels it (app/js/plugin: startKeepAliveTimer / clearKeepAliveTimer).
	let keepAliveTimer = false;
	win.on('close', (e) => { if (quitting) return; e.preventDefault(); win.blur(); win.hide(); });
	win.on('hide', () => { keepAliveTimer = true; win.webContents.send('plugin-hide'); });
	win.on('show', () => { keepAliveTimer = false; win.webContents.send('plugin-show'); });

	ipcMain.handle('harness.window', (_e, method, a, b) => {
		switch (method) {
			case 'showInactive': win.showInactive(); return true;
			case 'setOpacity': win.setOpacity(a); return true;
			case 'isMinimized': return win.isMinimized();
			case 'isVisible': return win.isVisible();
			case 'keepAliveTimer': return keepAliveTimer;
			case 'minimize': win.minimize(); return true;
			case 'maximize': win.maximize(); return true;
			case 'unmaximize': win.unmaximize(); return true;
			case 'isMaximized': return win.isMaximized();
			case 'hide': win.hide(); return true;
			case 'show': win.show(); return true;
			case 'setSize': win.setSize(a, b); return true;
			default: return null;
		}
	});
	ipcMain.handle('harness.dialog', async (_e, method, options) => {
		// Dialogs are answered from a queue the test can fill via /eval (window.__dialogAnswers).
		if (method === 'showMessageBox') return dialog.showMessageBox(win, options);
		if (method === 'showOpenDialog') return dialog.showOpenDialog(win, options);
		if (method === 'showSaveDialog') return dialog.showSaveDialog(win, options);
		return null;
	});
	ipcMain.handle('harness.clipboard', (_e, text) => { clipboard.writeText(text); return true; });

	http.createServer((req, res) => {
		const url = new URL(req.url, `http://127.0.0.1:${port}`);
		const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
		if (url.pathname === '/eval') {
			let body = '';
			req.on('data', (d) => { body += d; });
			req.on('end', async () => {
				try {
					const wrapped = `(async () => { ${body} })().then((r) => { try { return JSON.parse(JSON.stringify(r === undefined ? null : r)); } catch (e) { return String(r); } })`;
					send(200, { ok: true, result: await win.webContents.executeJavaScript(wrapped, true) });
				}
				catch (err) { send(200, { ok: false, error: String(err && err.stack || err) }); }
			});
			return;
		}
		if (url.pathname === '/shot') {
			win.webContents.capturePage().then((img) => {
				const file = url.searchParams.get('file');
				fs.writeFileSync(file, img.toPNG());
				send(200, { ok: true, file });
			}).catch((err) => send(500, { ok: false, error: String(err) }));
			return;
		}
		if (url.pathname === '/console') { const out = consoleLog.splice(0); send(200, { ok: true, log: out }); return; }
		if (url.pathname === '/reload') { win.webContents.reloadIgnoringCache(); send(200, { ok: true }); return; }
		if (url.pathname === '/size') { win.setSize(Number(url.searchParams.get('w')), Number(url.searchParams.get('h'))); send(200, { ok: true }); return; }
		if (url.pathname === '/key') {
			// a real key press (keyDown/char/keyUp), so default actions like Enter on a button run
			const keyCode = url.searchParams.get('code');
			win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
			if (keyCode === 'Enter' || keyCode.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Enter' ? '\r' : keyCode });
			win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
			setTimeout(() => send(200, { ok: true }), 150);
			return;
		}
		if (url.pathname === '/quit') { quitting = true; send(200, { ok: true }); setTimeout(() => app.exit(0), 100); return; }
		send(404, { ok: false });
	}).listen(port, '127.0.0.1');
});

app.on('window-all-closed', () => app.quit());
