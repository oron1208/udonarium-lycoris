// ミニプレイヤーのドラッグ不発を切り分けるデバッグスクリプト
// 使い方: node tools/debug-mp-drag.cjs
const fs = require('fs');
const path = require('path');
const WS = require('/home/maco/.openclaw/workspace/projects/udonarium-lycoris/node_modules/ws');

const appUrl = process.argv[2] || 'http://127.0.0.1:14306/';
const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:19390';

const pause = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const tabs = await (await fetch(`${CDP_HTTP}/json/list`)).json();
  const ws = new WS(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  let id = 0; const pending = new Map();
  ws.on('message', data => {
    const m = JSON.parse(data);
    if (m.method === 'Page.javascriptDialogOpening') {
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    }
    const p = pending.get(m.id);
    if (!p) return;
    clearTimeout(p.timer); pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => { pending.delete(n); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(n, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const js = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) { console.log('JS_ERR', JSON.stringify(r.exceptionDetails).slice(0, 400)); return undefined; }
    return r.result ? r.result.value : undefined;
  };

  await call('Page.enable');
  await call('Runtime.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: appUrl });
  for (let i = 0; i < 50 && !await js(`(() => !!document.querySelector('game-table'))()`); i++) await pause(500);
  await pause(1200);
  await js(`(() => { let n = 0; document.querySelectorAll('modal').forEach(m => { const b = m.querySelector('.title-button button, button'); if (b) { b.click(); n++; } }); return n; })()`);
  await pause(300);
  await js(`(() => { const s = document.createElement('style'); s.textContent = '.modal-background, modal { display: none !important; }'; document.head.appendChild(s); const ps = document.querySelectorAll('.draggable-panel'); ps.forEach(p => { if (!p.innerText.includes('メニュー')) p.style.display = 'none'; }); return 1; })()`);

  const msvc = expr => js(`(() => { const el = document.querySelector('app-mini-player'); const c = el && window.ng.getComponent(el); return c ? (${expr}) : null; })()`);
  await msvc(`(c.open(), true)`);
  await pause(400);

  // 位置リセット（右上固定にしておく）
  await msvc(`(c.resetPosition(), true)`);
  await pause(300);

  const layout = await js(`(()=>{
    const pl = document.querySelector('.mini-player');
    const art = document.querySelector('.mp-art');
    const info = document.querySelector('.mp-info');
    const r = pl.getBoundingClientRect();
    const cx = r.x + r.width/2, cy = r.y + r.height/2;
    const hit = document.elementFromPoint(cx, cy);
    return {
      player: {x:r.x, y:r.y, w:r.width, h:r.height},
      art: art && {x:art.getBoundingClientRect().x, w:art.getBoundingClientRect().width},
      info: info && {x:info.getBoundingClientRect().x, w:info.getBoundingClientRect().width},
      center: {cx, cy},
      hitAtCenter: hit ? {tag: hit.tagName, cls: String(hit.className).slice(0,40)} : null,
      trackListOpen: (()=>{const c=ng.getComponent(document.querySelector('app-mini-player'));return c.trackListOpen})(),
      pos: (()=>{const c=ng.getComponent(document.querySelector('app-mini-player'));return c.pos})()
    };
  })()`);
  console.log('LAYOUT', JSON.stringify(layout));

  // プローブ仕込み
  await js(`(()=>{
    const el = document.querySelector('.mini-player');
    window.__pevents = [];
    for (const type of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture','gotpointercapture']) {
      el.addEventListener(type, e => { if (window.__pevents.length < 50) window.__pevents.push({type, tgt: String(e.target.className||'').slice(0,20), bs: e.buttons}); }, true);
    }
    return 1;
  })()`);

  const from = await js(`(()=>{const r=document.querySelector('.mp-art').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await call('Input.dispatchMouseEvent', { type:'mouseMoved', ...from });
  await call('Input.dispatchMouseEvent', { type:'mousePressed', ...from, button:'left', buttons:1, clickCount:1 });
  await pause(120);
  const afterPress = await js(`(()=>{
    const el = document.querySelector('app-mini-player');
    const c = el && window.ng.getComponent(el);
    return { dragging: c.dragging, dragStart: !!c.dragStart, events: window.__pevents };
  })()`);
  console.log('AFTER_PRESS', JSON.stringify(afterPress));

  // 3ステップ動かす
  for (let i = 1; i <= 3; i++) {
    await call('Input.dispatchMouseEvent', { type:'mouseMoved', x: Math.round(from.x - 100*i), y: Math.round(from.y + 200*i), button:'left', buttons:1 });
    await pause(60);
  }
  const afterMoves = await js(`(()=>{
    const el = document.querySelector('app-mini-player');
    const c = el && window.ng.getComponent(el);
    return { dragging: c.dragging, moved: c.dragMoved, pos: c.pos, events: window.__pevents };
  })()`);
  console.log('AFTER_MOVES', JSON.stringify(afterMoves));

  await call('Input.dispatchMouseEvent', { type:'mouseReleased', x: from.x - 300, y: from.y + 600, button:'left', buttons:0, clickCount:1 });
  await pause(200);
  const final = await msvc(`({pos: c.pos, moved: c.dragMoved})`);
  console.log('FINAL', JSON.stringify(final));
  ws.close();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
