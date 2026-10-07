// 通常/VNログ検索: 実マウスの押下・解放・ダブルクリックとログ枠内の可視性を検証。
// 使い方: CDP_HTTP=http://127.0.0.1:19378 node tools/verify-search-trusted.cjs <isolated-url> <prefix>
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const WS = require('/home/maco/.openclaw/workspace/projects/udonarium-lycoris/node_modules/ws');

const appUrl = process.argv[2] || 'http://127.0.0.1:14289/';
const prefix = process.argv[3] || 'vn';
const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:19378';
const OUT_DIR = '/home/maco/.openclaw/workspace/projects/udonarium-lycoris/tmp/search-recheck-20261007';
fs.mkdirSync(OUT_DIR, { recursive: true });

assert(/^http:\/\/(127\.0\.0\.1|localhost):\d+\/$/.test(appUrl), 'isolated local URL only: ' + appUrl);

const pause = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // ── CDPハーネス ──
  const tabs = await (await fetch(`${CDP_HTTP}/json/list`)).json();
  const ws = new WS(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  let id = 0; const pending = new Map();
  const consoleErrors = [];
  ws.on('message', data => {
    const m = JSON.parse(data);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(m.params.args.map(a => String(a.value ?? a.description ?? '')).join(' ').slice(0, 200));
    if (m.method === 'Runtime.exceptionThrown') consoleErrors.push('exception: ' + String(m.params.exceptionDetails?.exception?.description ?? '').slice(0, 200));
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
  const js = async (expression, awaitPromise = false) => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
    return r.result ? r.result.value : undefined;
  };
  let failures = 0; let checks = 0;
  const ok = (name, cond, info) => {
    console.log((cond ? 'PASS' : 'FAIL') + `  ${name}  ` + JSON.stringify(info ?? ''));
    checks++; if (!cond) failures++;
    return cond;
  };
  const shot = async name => {
    const r = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT_DIR, `${prefix}-${name}.png`), Buffer.from(r.data, 'base64'));
  };
  const mouse = async (selector, twice=false) => {
    const p = await js(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return null; const r=e.getBoundingClientRect(); const x=r.left+Math.min(30,r.width/2), y=r.top+r.height/2; return {x,y,hit:e.contains(document.elementFromPoint(x,y))}; })()`);
    if(!p || !p.hit) throw new Error('クリック対象が遮蔽: '+selector+' '+JSON.stringify(p));
    await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x,y:p.y});
    for(let n=1;n<=(twice?2:1);n++){
      await call('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',buttons:1,clickCount:n});
      await pause(35);
      await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:'left',buttons:0,clickCount:n});
      await pause(70);
    }
  };
  const input = (selector,value) => js(`(() => {const e=document.querySelector(${JSON.stringify(selector)}); e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const state = (kind,mark) => js(`(() => {
    const sc=${kind==='chat'?"document.querySelector('chat-window').closest('.scrollable-panel')":"document.querySelector('.vn-log-messages')"};
    const e=Array.from(document.querySelectorAll(${JSON.stringify(kind==='chat'?'chat-window chat-message':'.vn-log-msg')})).find(e=>e.textContent.includes(${JSON.stringify(mark)}));
    const s=sc?.getBoundingClientRect(),r=e?.getBoundingClientRect();
    const sticky=document.querySelector('chat-window .sticky-bottom')?.getBoundingClientRect();
    const bottom=${kind==='chat'?"Math.min(s.bottom,sticky.top)":"s.bottom"};
    return {top:sc?.scrollTop,max:sc?sc.scrollHeight-sc.clientHeight:0,found:!!e,inView:!!r && r.bottom>s.top && r.top<bottom,fullyVisible:!!r && r.top>=s.top && r.bottom<=bottom,rect:r?{top:r.top,bottom:r.bottom}:null,viewport:s?{top:s.top,bottom}:null,highlight:!!e?.style.backgroundColor,search:!!document.querySelector(${JSON.stringify(kind==='chat'?'.chat-search':'.vn-log-search')})};
  })()`);
  try {
    await call('Page.enable'); await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride',{width:1400,height:1000,deviceScaleFactor:1,mobile:false});
    await call('Page.addScriptToEvaluateOnNewDocument',{source:`try { localStorage.setItem('udonarium.vnStage.visible.v1','1'); } catch(e) {}`});
    await call('Page.navigate',{url:appUrl});
    for(let i=0;i<60&&!await js(`!!document.querySelector('chat-window textarea')`);i++) await pause(500);
    await pause(2200);
    await js(`(() => { document.querySelector('modal .title-button button')?.click(); const s=document.createElement('style'); s.id='test-layout'; s.textContent='modal,.modal-background{display:none!important} vn-stage{visibility:hidden} .draggable-panel:not(:has(chat-window)){display:none!important}'; document.head.appendChild(s); })()`);
    // UI入力経路で140通、描画範囲外・80件より古い発言も含む。
    for(let i=0;i<140;i++){
      await input('chat-window textarea','検索検証行'+String(i).padStart(3,'0')+' 本文 '+(i%9===0?'複数行の発言\n二行目の内容':'通常の発言'));
      await js(`document.querySelector('chat-window textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}))`);
      await pause(70);
    }
    await pause(1800);
    ok('140通のUI送信完了',await js(`document.querySelector('chat-window textarea').value==='' && Array.from(document.querySelectorAll('chat-window chat-message')).some(e=>e.textContent.includes('検索検証行139'))`));
    const initialTab=await js(`document.querySelector('chat-window input[name="chat-tab"]:checked').value`);
    for(const idx of [70,5,135]){
      if(idx===5){ await js(`document.querySelectorAll('chat-window input[name="chat-tab"]')[1].click()`); await pause(300); }
      const mark='検索検証行'+String(idx).padStart(3,'0');
      if(!await js(`!!document.querySelector('.chat-search')`)) await js(`Array.from(document.querySelectorAll('chat-window button')).find(e=>e.title==='全タブのチャットログを検索').click()`);
      await input('.chat-search-input',mark); await pause(400);
      const before=await state('chat',mark);
      await js(`window.__hit=document.querySelector('.chat-search-item');window.__events=[];if(!window.__chatEventProbe){window.__chatEventProbe=true;for(const t of ['mousedown','mouseup','click','dblclick'])document.addEventListener(t,e=>{if(e.target.closest('.chat-search-item'))window.__events.push(t)},true)}`);
      await mouse('.chat-search-item',true); await pause(1100);
      const after=await state('chat',mark);
      ok('通常ログ 実ダブルクリック '+idx,!after.search&&after.fullyVisible&&after.highlight,{before,after,events:await js('window.__events'),sameNode:await js('window.__hit.isConnected')});
      ok('通常ログ 正しいタブへ移動 '+idx,await js(`document.querySelector('chat-window input[name="chat-tab"]:checked').value`)===initialTab);
      await shot('chat-'+idx);
      await pause(1700);
      const settled=await state('chat',mark);ok('通常ログ 移動後も対象を維持 '+idx,settled.fullyVisible,settled);
    }
    await js(`document.querySelector('#test-layout').textContent='modal,.modal-background{display:none!important} .draggable-panel:not(:has(chat-window)){display:none!important}'`);
    // 展開操作はUI（折りたたみボタン）を使用。
    await js(`Array.from(document.querySelectorAll('.vn-expand-btn')).find(e=>e.textContent.includes('ログ'))?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`);
    if(!await js(`!!document.querySelector('.vn-log-messages')`)) {
      console.log('EXPAND_BUTTONS',await js(`Array.from(document.querySelectorAll('.vn-expand-btn')).map(e=>({text:e.textContent,title:e.title}))`));
      throw new Error('VNログ未展開');
    }
    await pause(600);
    for(const idx of [70,5,135]){
      const mark='検索検証行'+String(idx).padStart(3,'0');
      if(!await js(`!!document.querySelector('.vn-log-search')`)) await mouse('button[title="ログを検索"]');
      await input('.vn-log-search-input',mark);await pause(400);
      const count=await js(`document.querySelectorAll('.vn-log-search-item').length`);
      ok('VN 検索ヒット '+idx,count===1,{count});if(!count) continue;
      const before=await state('vn',mark);
      await js(`window.__events=[];if(!window.__vnEventProbe){window.__vnEventProbe=true;for(const t of ['mousedown','mouseup','click','dblclick'])document.addEventListener(t,e=>{if(e.target.closest('.vn-log-search-item'))window.__events.push(t)},true)}`);
      await mouse('.vn-log-search-item',true);await pause(1100);
      const after=await state('vn',mark);
      ok('VN 実ダブルクリック '+idx,!after.search&&after.fullyVisible&&after.highlight,{before,after,events:await js('window.__events')});
      await shot('vn-'+idx);
      await pause(1700);
      const settled=await state('vn',mark);ok('VN 移動後も対象を維持 '+idx,settled.fullyVisible,settled);
    }
    const real=consoleErrors.filter(e=>!/skyWay onFatalError/.test(e));
    ok('ページエラーなし',real.length===0,real.slice(0,4));
    console.log('RESULT',JSON.stringify({checks,passed:checks-failures,failures,prefix}));process.exitCode=failures?1:0;
  } finally {ws.close();}
})().catch(e=>{console.error(e);process.exit(1)});
