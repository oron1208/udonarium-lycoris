// 3Dコマ（GLB）スパイク検証: 卓CSS transformとWebGLカメラの射影一致を両モードで証明する。
// 使い方: ROOM_MODE=standard|advanced node tools/verify-table3d-spike.cjs [build-dir]
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const WS = require('ws');
const yaml = require('js-yaml');

const root = path.resolve(__dirname, '..');
const build = path.resolve(root, process.argv[2] || 'tmp/spike-3d/dev/browser');
const mode = process.env.ROOM_MODE || 'standard';
const out = path.join(root, 'tmp/spike-3d', 'run-' + mode + '-' + Date.now());
fs.mkdirSync(out, { recursive: true });
const children = [], clients = [], results = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
const record = (name, value) => { results.push({ name, value }); console.log(name, JSON.stringify(value)); };
async function ready(url) { for (let i = 0; i < 150; i++) { try { if ((await fetch(url)).ok) return; } catch {} await delay(100); } throw Error('Not ready: ' + url); }

async function client(port, name) {
  const fd = fs.openSync(path.join(out, name + '.log'), 'w');
  children.push(spawn('/opt/google/chrome/chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check', '--window-size=1440,1000', '--remote-debugging-port=' + port, '--user-data-dir=/home/maco/.cache/lycoris-e2e/spike3d-' + Date.now() + '-' + name, 'about:blank'], { stdio: ['ignore', fd, fd] }));
  await ready('http://127.0.0.1:' + port + '/json/version');
  const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WS(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let id = 0; const pending = new Map(), exceptions = [], consoleErrors = [];
  ws.on('message', raw => {
    const m = JSON.parse(raw), p = pending.get(m.id);
    if (p) { clearTimeout(p.timer); pending.delete(m.id); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(String(m.params.args.map(a => a.value ?? a.description ?? '').join(' ')).slice(0, 300));
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; const timer = setTimeout(() => { pending.delete(n); reject(Error(method + ' timeout')); }, 20000); pending.set(n, { resolve, reject, timer }); ws.send(JSON.stringify({ id: n, method, params })); });
  const js = async expression => { const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result ? r.result.value : undefined; };
  const wait = async expression => { for (let i = 0; i < 150; i++) { if (await js(expression)) return; await delay(150); } throw Error('Wait timeout ' + expression); };
  await call('Runtime.enable'); await call('Page.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('lycoris.experimental.model3d', '1');" });
  const s = { ws, js, call, wait, exceptions, consoleErrors, name };
  clients.push(s);
  return s;
}
const button = (scope, text) => "[...document.querySelectorAll('" + scope + " button')].find(b => b.textContent.trim() === " + JSON.stringify(text) + ")";

(async () => {
  const server = path.join(out, 'server');
  fs.mkdirSync(path.join(server, 'data'), { recursive: true });
  fs.mkdirSync(path.join(server, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(root, 'unified-server.js'), path.join(server, 'unified-server.js'));
  for (const dir of ['node_modules', 'signaling-server']) fs.symlinkSync(path.join(root, dir), path.join(server, dir), 'dir');
  for (const f of ['server-cert.pem', 'server-key.pem']) fs.copyFileSync(path.join(root, 'data', f), path.join(server, 'data', f));
  fs.symlinkSync(build, path.join(server, 'dist/udonarium-lycoris'), 'dir');
  const cfgPath = path.join(build, 'assets/config.yaml');
  const cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8'));
  cfg.backend = { ...(cfg.backend || {}), mode: 'websocket-relay' };
  fs.writeFileSync(cfgPath, yaml.dump(cfg));
  const fd = fs.openSync(path.join(out, 'server.log'), 'w');
  children.push(spawn(process.execPath, [path.join(server, 'unified-server.js')], { cwd: server, env: { ...process.env, PORT: '14439' }, stdio: ['ignore', fd, fd] }));
  await ready('http://localhost:14440/v1/status');

  const s = await client(19551, 'spike');
  await s.call('Page.navigate', { url: 'https://localhost:14439/' });
  await s.wait("!!window.ng && !!document.querySelector('game-table') && !!document.querySelector('peer-menu')");
  await delay(1600);
  await s.js("(() => { document.querySelector('modal .title-button button')?.click(); const e = document.createElement('style'); e.textContent = 'modal:not(:has(lobby)):not(:has(room-setting)){display:none!important}'; document.head.append(e); window.app = ng.getComponent(document.querySelector('app-root')); window.peer = ng.getComponent(document.querySelector('peer-menu')); window.gt = ng.getComponent(document.querySelector('game-table')); return true; })()");
  record('boot-mode', await s.js('app.isAdvancedRoom'));

  await s.wait("(" + button('peer-menu', 'ロビー（ルーム一覧）を表示') + ")?.matches(':enabled')");
  await s.js("(" + button('peer-menu', 'ロビー（ルーム一覧）を表示') + ").click();true");
  await s.wait("!!document.querySelector('lobby')");
  await s.js("(" + button('lobby', '新しいルームを作成する') + ").click();true");
  await s.wait("!!document.querySelector('room-setting input')");
  await s.js("(() => { const e = document.querySelector('room-setting input'); const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); d.set.call(e, 'Spike3d" + mode + "'); e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
  if (mode === 'advanced') await s.js("document.querySelector('room-setting .room-mode-card.advanced input').click();true");
  await s.js("(" + button('room-setting', '新しいルームを作成') + ").click();true");
  await s.wait('peer.networkService.isOpen');
  await delay(1200);

  await s.wait('!!window.__spike3d && __spike3d.ready');
  const size = await s.js('__spike3d.tableSize()');
  record('table-size', size);
  const cal = await s.js('__spike3d.calibrate()');
  record('calibrate-residual', cal);
  assert(Math.abs(cal.residualX) < 0.5 && Math.abs(cal.residualY) < 0.5, 'calibration residual too large: ' + JSON.stringify(cal));

  const states = [
    { rx: 50, ry: 0, rz: 10, tx: 100, ty: 0, tz: 0 },
    { rx: 0, ry: 0, rz: 0, tx: 0, ty: 0, tz: 0 },
    { rx: 80, ry: 0, rz: 170, tx: -200, ty: 150, tz: 300 },
    { rx: 30, ry: 0, rz: -95, tx: 250, ty: -100, tz: -250 },
    { rx: 65, ry: 0, rz: 225, tx: 0, ty: 0, tz: 150 },
  ];
  const cx = size.w / 2, cy = size.h / 2;
  let maxErr = 0;
  for (const st of states) {
    await s.js("(() => { gt['viewRotateX'] = " + st.rx + "; gt['viewRotateY'] = " + st.ry + "; gt['viewRotateZ'] = " + st.rz + "; gt['viewPotisonX'] = " + st.tx + "; gt['viewPotisonY'] = " + st.ty + "; gt['viewPotisonZ'] = " + st.tz + "; gt['applyTableTransform'](); return true; })()");
    await delay(80);
    const c1 = await s.js('__spike3d.compare(' + cx + ', ' + cy + ', 0)');
    const c2 = await s.js('__spike3d.compare(' + (cx + 200) + ', ' + (cy - 150) + ', 60)');
    const err = Math.max(Math.abs(c1.dx), Math.abs(c1.dy), Math.abs(c2.dx), Math.abs(c2.dy));
    maxErr = Math.max(maxErr, err);
    record('view-r' + st.rx + '-z' + st.rz + '-tz' + st.tz, { c1: { dx: +c1.dx.toFixed(2), dy: +c1.dy.toFixed(2) }, c2: { dx: +c2.dx.toFixed(2), dy: +c2.dy.toFixed(2) } });
    assert(err <= 3, 'projection mismatch at ' + JSON.stringify(st) + ': ' + JSON.stringify({ c1, c2 }));
  }
  record('max-error-px', +maxErr.toFixed(2));

  await s.js('gt.toggleFlatMode();true');
  await delay(250);
  assert.equal(await s.js('__spike3d.canvasVisible()'), false);
  record('flat-hidden', true);
  await s.js('gt.toggleFlatMode();true');
  await delay(250);
  assert.equal(await s.js('__spike3d.canvasVisible()'), true);
  record('flat-restore', true);

  await s.js("(() => { gt['viewRotateX'] = 50; gt['viewRotateY'] = 0; gt['viewRotateZ'] = 10; gt['viewPotisonX'] = 100; gt['viewPotisonY'] = 0; gt['viewPotisonZ'] = 0; gt['applyTableTransform'](); return true; })()");
  await delay(400);
  record('render-info', await s.js('__spike3d.info()'));
  const px = await s.js('__spike3d.canvasPixels()');
  record('canvas-pixels', { total: px.total, first: px.first.slice(0, 5) });
  const shot = await s.call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(root, 'tmp/spike-3d', 'spike-' + mode + '.png'), Buffer.from(shot.data, 'base64'));

  assert.equal(s.exceptions.length, 0, 'runtime exceptions: ' + JSON.stringify(s.exceptions.slice(0, 2).map(e => (e.exception && e.exception.description) || e.text)));
  const spikeErrors = s.consoleErrors.filter(e => e.includes('spike3d'));
  assert.equal(spikeErrors.length, 0, 'spike3d console errors: ' + JSON.stringify(spikeErrors));
  record('console-errors', s.consoleErrors);
  record('PASS', { mode, models: await s.js('__spike3d.modelCount()'), maxErrPx: +maxErr.toFixed(2) });
})().catch(e => { record('FAIL', String(e.stack || e).slice(0, 800)); process.exitCode = 1; }).finally(async () => {
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  for (const c of clients) { try { c.ws.close(); } catch {} }
  for (const ch of children) { try { ch.kill('SIGTERM'); } catch {} }
  await delay(300);
  console.log('EVIDENCE', out);
});
