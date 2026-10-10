// セルフホストガイドのプレビュー撮影（fade-up強制表示＋全ページスクショ）
const fs = require('fs');
const path = require('path');
const WS = require('/home/maco/.openclaw/workspace/projects/udonarium-lycoris/node_modules/ws');

const appUrl = process.argv[2] || 'http://127.0.0.1:14307/guide/self-host.html';
const outPng = process.argv[3] || '/tmp/selfhost-full.png';
const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:19391';

const pause = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const tabs = await (await fetch(`${CDP_HTTP}/json/list`)).json();
  const ws = new WS(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  let id = 0; const pending = new Map();
  ws.on('message', data => {
    const m = JSON.parse(data);
    const p = pending.get(m.id);
    if (!p) return;
    clearTimeout(p.timer); pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => { pending.delete(n); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
    pending.set(n, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const js = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result ? r.result.value : undefined;
  };

  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 2000, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: appUrl });
  await pause(2500);
  // fade-up を強制表示（headless撮影用）
  await js(`(() => {
    const s = document.createElement('style');
    s.textContent = '.fade-up{opacity:1 !important; transform:none !important; transition:none !important}';
    document.head.appendChild(s);
    const nav = document.querySelector('nav.nav'); if (nav) nav.classList.add('scrolled');
    return document.body.scrollHeight;
  })()`);
  const height = await js('document.body.scrollHeight');
  console.log('page height:', height);
  await pause(400);
  const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  fs.writeFileSync(outPng, Buffer.from(shot.data, 'base64'));
  console.log('saved:', outPng, fs.statSync(outPng).size, 'bytes');
  ws.close();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
