// セルフホストガイドではなく、チャパレフォームのflex実測デバッグ
const fs = require('fs');
const WS = require('/home/maco/.openclaw/workspace/projects/udonarium-lycoris/node_modules/ws');
const appUrl = process.argv[2] || 'http://127.0.0.1:14308/';
const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:19393';
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
    if (r.exceptionDetails) { console.log('JS_ERR', JSON.stringify(r.exceptionDetails).slice(0, 300)); return undefined; }
    return r.result ? r.result.value : undefined;
  };
  await call('Page.enable');
  await call('Runtime.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: appUrl });
  for (let i = 0; i < 50 && !await js(`!!document.querySelector('chat-window textarea')`); i++) await pause(500);
  await pause(2000);
  await js(`(function(){ document.querySelector('modal .title-button button')?.click(); const s=document.createElement('style'); s.textContent='modal,.modal-background{display:none!important} .draggable-panel:not(:has(chat-window)):not(:has(palette-browser)){display:none!important}'; document.head.appendChild(s); })()`);
  await js(`(function(){ document.querySelectorAll('li').forEach(()=>{}); const b=Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()==='追加・編集'); return !!b; })()`);
  await rightClick(700, 300);
  await pause(400);
  await js(`(function(){const lis=Array.from(document.querySelectorAll('li')).filter(li=>li.textContent.trim().endsWith('キャラクターを作成')&&li.offsetParent!==null);(lis[lis.length-1]||{click(){}}).click();return 1})()`);
  for (let i = 0; i < 20 && !await js(`!!document.querySelector('game-character')`); i++) await pause(300);
  await pause(500);
  const hit = await js(`(function(){const host=document.querySelector('game-character');if(!host)return null;const els=[host].concat(Array.prototype.slice.call(host.querySelectorAll('*')));for(const e of els){const r=e.getBoundingClientRect();if(r.width<10||r.height<10)continue;const h=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);if(h&&host.contains(h))return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};}return null;})()`);
  await rightClick(hit ? hit.x : 599, hit ? hit.y : 436);
  await pause(400);
  await js(`(function(){const lis=Array.from(document.querySelectorAll('li')).filter(li=>li.textContent.trim().endsWith('チャットパレットを表示')&&li.offsetParent!==null);(lis[lis.length-1]||{click(){}}).click();return 1})()`);
  for (let i = 0; i < 20 && !await js(`!!document.querySelector('palette-browser')`); i++) await pause(300);
  await pause(300);
  await js(`(function(){const b=Array.from(document.querySelectorAll('palette-browser button')).find(e=>e.textContent.trim()==='追加・編集');if(b)b.click();return 1})()`);
  await pause(250);
  await js(`(function(){const b=Array.from(document.querySelectorAll('palette-browser button')).find(e=>e.textContent.trim()==='全文テキスト編集');if(b)b.click();return 1})()`);
  for (let i = 0; i < 20 && !await js(`!!document.querySelector('palette-browser form.editor')`); i++) await pause(150);
  await pause(300);
  const info = await js(`(function(){
    const browser=document.querySelector('palette-browser .browser');
    const form=document.querySelector('palette-browser form.editor');
    const ta=form.querySelector('textarea[name="body"]');
    const label=ta.closest('label');
    const cs=e=>{const c=getComputedStyle(e);return {display:c.display,flex:c.flex,minH:c.minHeight,maxH:c.maxHeight};};
    const rr=e=>{const r=e.getBoundingClientRect();return {h:Math.round(r.height),top:Math.round(r.top),bottom:Math.round(r.bottom)};};
    const btn=[...form.querySelectorAll('button')].find(e=>e.textContent.trim()==='保存');
    return {
      browserCS: cs(browser), browserRect: rr(browser),
      editorCS: cs(form), editorRect: rr(form),
      labelCS: cs(label), labelRect: rr(label),
      taCS: cs(ta), taRect: rr(ta),
      btnRect: btn?rr(btn):null,
      taAttrRows: ta.getAttribute('rows'),
      labelHasTextarea: label.contains(ta)
    };
  })()`);
  console.log(JSON.stringify(info, null, 1));
  ws.close();
  async function rightClick(x, y) {
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2 });
    await pause(60);
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 2 });
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
