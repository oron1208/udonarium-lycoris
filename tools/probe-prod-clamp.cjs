// 本番URLでv1.93の拡張ダイスボット動作を実ブラウザ再現（パパ報告の切り分け用）
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WS = require('ws');
const dir = '/home/maco/.openclaw/workspace/projects/udonarium-lycoris/tmp/extended-dice-review';
const CDP_HTTP = 'http://127.0.0.1:19429';
const PROD_URL = 'https://udonarium-lycoris.ddns.net/';
const output = [];
const record = (label, value) => { output.push({ label, value }); console.log(label, JSON.stringify(value).slice(0, 800)); };
const children = [];
const sockets = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
async function ready(url) {
  for (let n = 0; n < 80; n++) { try { const r = await fetch(url); if (r.ok) return r; } catch {} await delay(250); }
  throw Error('Not ready: ' + url);
}
async function client() {
  const target = await (await fetch(CDP_HTTP + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WS(target.webSocketDebuggerUrl); sockets.push(ws);
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  let id = 0; const pending = new Map();
  ws.on('message', raw => { const m = JSON.parse(raw); const p = pending.get(m.id); if (p) { clearTimeout(p.timer); pending.delete(m.id); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
  const call = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; const timer = setTimeout(() => { pending.delete(n); reject(Error('CDP timeout ' + method)); }, 30000); pending.set(n, { resolve, reject, timer }); ws.send(JSON.stringify({ id: n, method, params })); });
  const js = async expression => { const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result?.value; };
  const wait = async expression => { for (let n = 0; n < 200; n++) { if (await js(expression)) return true; await delay(300); } throw Error('Wait timeout ' + expression); };
  await call('Page.enable'); await call('Runtime.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: PROD_URL });
  await wait(`!!window.ng && !!document.querySelector('game-table') && !!document.querySelector('peer-menu')`);
  await delay(1800);
  for (let n = 0; n < 5; n++) { if (!await js(`!!document.querySelector('text-view button')`)) break; await js(`document.querySelector('text-view button').click();true`); await delay(400); }
  return { call, js, wait };
}
(async () => {
  const serverLog = fs.openSync(path.join(dir, 'prod-chrome.log'), 'w');
  children.push(spawn('/opt/google/chrome/chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--ignore-certificate-errors', '--remote-debugging-port=19429', '--user-data-dir=' + path.join(dir, 'prod-profile-' + Date.now()), 'about:blank'], { stdio: ['ignore', serverLog, serverLog] }));
  await ready(CDP_HTTP + '/json/version');
  const a = await client();
  record('served main', await a.js(`[...document.querySelectorAll('script[src]')].map(s=>s.src.split('/').pop()).filter(s=>s.startsWith('main.'))[0]`));
  // 本番SkyWayでテスト用部屋へ（24h GCで消える専用部屋）
  await a.js(`window.peer=ng.getComponent(document.querySelector('peer-menu'));peer.networkService.open('makoClampTest','MAKOCLAMP99','clamp-verify','');true`);
  await a.wait(`peer.networkService.isOpen && peer.networkService.peerContext.isRoom`);
  record('room joined', true);
  await a.js(`window.app=ng.getComponent(document.querySelector('app-root'));window.table=ng.getComponent(document.querySelector('game-table')).currentTable;app.ngZone.run(()=>{table.roomMode='advanced';table.update()});true`);
  await a.js(`app.ngZone.run(()=>app.open('OptionsPanelComponent'));true`);
  await a.wait(`!!document.querySelector('options-panel')`);
  await a.js(`window.options=ng.getComponent(document.querySelector('options-panel'));true`);
  await a.wait(`[...document.querySelectorAll('options-panel .option-row')].some(e=>e.textContent.includes('拡張ダイスボット'))`);
  if (!await a.js(`options.isExtendedDiceBotEnabled`)) {
    const p = await a.js(`(()=>{const row=[...document.querySelectorAll('options-panel .option-row')].find(e=>e.textContent.includes('拡張ダイスボット'));const btn=row.querySelector('button');const r=btn.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;const h=document.elementFromPoint(x,y);return {x,y,hit:h===btn||btn.contains(h)}})()`);
    if (!p?.hit) throw Error('toggle blocked ' + JSON.stringify(p));
    for (const type of ['mousePressed', 'mouseReleased']) await a.call('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await delay(300);
  }
  record('extended ON', await a.js(`({ui:options.isExtendedDiceBotEnabled,table:table.extendedDiceBotEnabled,advanced:table.roomMode})`));
  const results = await a.js(`(async()=>{const cw=ng.getComponent(document.querySelector('chat-window'));const cases=['{clamp(15, 1, 10)}','{max(3, 7, 5)}','{ceil({Lv}/2)}d6'];const out={};for(const text of cases){cw.sendChat({text,gameSystem:null,sendFrom:PeerCursor.myCursor.identifier,sendTo:'',tachieNum:0,messColor:'#000000'});await new Promise(r=>setTimeout(r,300));const msg=[...cw.chatTab.chatMessages].pop();out[text]=msg?msg.text:null;}return out;})()`);
  record('prod chat results', results);
  record('DONE', true);
})().catch(e => { record('ERROR', e.stack || String(e)); process.exitCode = 1; }).finally(() => {
  fs.writeFileSync(path.join(dir, 'prod-clamp-result.json'), JSON.stringify(output, null, 2));
  for (const ws of sockets) ws.close();
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(process.exitCode || 0), 300);
});
