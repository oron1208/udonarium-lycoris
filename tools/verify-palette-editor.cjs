// チャパレ「全文テキスト編集」の大型エディタ検証（通常モード・trusted右クリック）
// 使い方: CDP_HTTP=http://127.0.0.1:19388 node tools/verify-palette-editor.cjs <isolated-url> <prefix>
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const WS = require('/home/maco/.openclaw/workspace/projects/udonarium-lycoris/node_modules/ws');

const appUrl = process.argv[2] || 'http://127.0.0.1:14302/';
const prefix = process.argv[3] || 'pe';
const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:19388';
const OUT_DIR = '/home/maco/.openclaw/workspace/projects/udonarium-lycoris/tmp/palette-editor-20261007';
fs.mkdirSync(OUT_DIR, { recursive: true });

assert(/^http:\/\/(127\.0\.0\.1|localhost):\d+\/$/.test(appUrl), 'isolated local URL only: ' + appUrl);

const pause = ms => new Promise(r => setTimeout(r, ms));

(async () => {
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
    checks++; if (!cond) failures++;
    console.log((cond ? 'PASS' : 'FAIL') + `  ${name}  ` + JSON.stringify(info ?? ''));
    return cond;
  };
  const shot = async name => {
    const r = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT_DIR, `${prefix}-${name}.png`), Buffer.from(r.data, 'base64'));
  };
  const pbprobe = expr => js(`(() => { const el = document.querySelector('palette-browser'); const c = el && window.ng.getComponent(el); return c ? (${expr}) : null; })()`);
  const rightClick = async (x, y) => {
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2 });
    await pause(60);
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 2 });
  };
  const clickMenuItem = async label => js(`(function(){
    const lis = Array.from(document.querySelectorAll('li')).filter(li => li.textContent.trim().endsWith(${JSON.stringify(label)}) && li.offsetParent !== null);
    const li = lis[lis.length - 1];
    if (!li) return false;
    li.click(); return true;
  })()`);
  const openEditor = async () => {
    await js(`(function(){const b=Array.from(document.querySelectorAll('palette-browser button')).find(e=>e.textContent.trim()==='追加・編集');if(b)b.click();return !!b})()`);
    await pause(250);
    await js(`(function(){const b=Array.from(document.querySelectorAll('palette-browser button')).find(e=>e.textContent.trim()==='全文テキスト編集');if(b)b.click();return !!b})()`);
    for (let i = 0; i < 20 && !await js(`!!document.querySelector('.palette-source-editor')`); i++) await pause(150);
    await pause(350);
  };
  const setBody = value => js(`(function(){
    const ta=document.querySelector('.palette-source-editor .pse-textarea');
    if(!ta) return 'no-ta';
    const s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
    s.call(ta,${JSON.stringify(value)});
    ta.dispatchEvent(new Event('input',{bubbles:true}));
    return 'set';
  })()`);
  const editorState = () => js(`(function(){
    const el=document.querySelector('.palette-source-editor');
    if(!el) return {found:false};
    const r=el.getBoundingClientRect();
    const cs=getComputedStyle(el);
    const ta=el.querySelector('.pse-textarea');
    const bgm=/rgba\\(([^)]+)\\)/.exec(cs.backgroundColor);
    const alpha=bgm?Number(bgm[1].split(',')[3]):1;
    return {found:true,parent:el.parentElement===document.body?'body':(el.parentElement?el.parentElement.tagName:'none'),
      right:Math.round(r.right),width:Math.round(r.width),top:Math.round(r.top),bottom:Math.round(r.bottom),
      vw:window.innerWidth,alpha,fontSize:ta?getComputedStyle(ta).fontSize:null,
      value:ta?ta.value:null,inlineForm:!!document.querySelector('palette-browser form.editor'),
      rowsVisible:(function(){const rows=document.querySelector('palette-browser .rows');if(!rows)return false;const b=rows.getBoundingClientRect();return b.width>50&&b.height>50;})(),
      editDisabled:(function(){const b=Array.from(document.querySelectorAll('palette-browser button')).find(e=>e.textContent.trim()==='全文テキスト編集');return b?b.matches(':disabled'):null;})(),
      stats:(el.querySelector('.pse-stats')?el.querySelector('.pse-stats').textContent:'')};
  })()`);

  try {
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: appUrl });
    for (let i = 0; i < 60 && !await js(`!!document.querySelector('chat-window textarea')`); i++) await pause(500);
    await pause(2200);
    await js(`(function(){ document.querySelector('modal .title-button button')?.click(); const s=document.createElement('style'); s.id='test-layout'; s.textContent='modal,.modal-background{display:none!important} .draggable-panel:not(:has(chat-window)):not(:has(palette-browser)){display:none!important}'; document.head.appendChild(s); })()`);
    await pause(300);

    // 卓の空きスペース右クリック → キャラクターを作成
    await rightClick(700, 300);
    await pause(400);
    ok('卓メニューが開く', await clickMenuItem('キャラクターを作成'), {});
    for (let i = 0; i < 20 && !await js(`!!document.querySelector('game-character')`); i++) await pause(300);
    ok('コマが作成される', await js(`!!document.querySelector('game-character')`) === true, {});
    await pause(600);

    // コマの実ヒット点 → trusted rightClick → チャットパレットを表示
    const hit = await js(`(function(){
      const host=document.querySelector('game-character');
      if(!host) return null;
      const els=[host].concat(Array.prototype.slice.call(host.querySelectorAll('*')));
      for(const e of els){
        const r=e.getBoundingClientRect();
        if(r.width<10||r.height<10) continue;
        const pts=[[r.left+r.width/2,r.top+r.height/2],[r.left+Math.min(18,r.width/2),r.top+Math.min(18,r.height/2)],[r.left+r.width-Math.min(18,r.width/2),r.top+r.height-Math.min(18,r.height/2)]];
        for(const pt of pts){const h=document.elementFromPoint(pt[0],pt[1]);if(h&&host.contains(h))return {x:Math.round(pt[0]),y:Math.round(pt[1])};}
      }
      return null;
    })()`);
    ok('コマのクリック点が取れる', !!hit, { hit });
    await rightClick(hit.x, hit.y);
    await pause(400);
    ok('コマ右クリックでチャパレパネルが開く', await clickMenuItem('チャットパレットを表示'), {});
    for (let i = 0; i < 20 && !await js(`!!document.querySelector('palette-browser')`); i++) await pause(300);
    ok('チャパレパネルが表示される', await js(`!!document.querySelector('palette-browser')`) === true, {});
    await pause(400);

    // ── 大型エディタを開く ──
    await openEditor();
    const st1 = await editorState();
    ok('大型エディタが開く', st1.found === true, {});
    ok('エディタはbody直下（transform影響なし）', st1.parent === 'body', st1);
    ok('インラインフォームは出ない', st1.inlineForm === false, {});
    ok('エディタは画面右側に配置', st1.found && st1.right >= st1.vw - 30 && st1.width >= 400, st1);
    ok('エディタは画面内に収まる', st1.found && st1.top >= 0 && st1.bottom <= 1000, st1);
    ok('背景が半透明', st1.found && st1.alpha < 1, { alpha: st1.alpha });
    ok('パレット一覧は見えたまま', st1.rowsVisible === true, {});
    ok('編集中は他の編集ボタンが無効', st1.editDisabled === true, {});
    await shot('editor-open');

    // 文字サイズ（初期15 → 17）
    await js(`(function(){const b=Array.from(document.querySelectorAll('.palette-source-editor button')).find(e=>e.getAttribute('aria-label')==='文字を大きく');b.click();return 1})()`);
    await js(`(function(){const b=Array.from(document.querySelectorAll('.palette-source-editor button')).find(e=>e.getAttribute('aria-label')==='文字を大きく');b.click();return 1})()`);
    const st2 = await editorState();
    ok('文字サイズが大きくなる', st2.fontSize === '17px', { fontSize: st2.fontSize });
    ok('文字サイズが保存される', await js(`localStorage.getItem('lycoris-palette-source-font-v1')`) === '17', {});
    await js(`(function(){const b=Array.from(document.querySelectorAll('.palette-source-editor button')).find(e=>e.getAttribute('aria-label')==='文字を小さく');b.click();return 1})()`);

    // 入力→保存
    const body1 = '// @tab テスト\n2d6+1 ダイスロール\n〈回復薬〉HPを10回復';
    await setBody(body1);
    const st3 = await editorState();
    ok('行数・文字数が表示される', /3 行/.test(st3.stats || ''), { stats: st3.stats });
    await js(`(function(){const b=document.querySelector('.palette-source-editor .pse-save');b.click();return 1})()`);
    await pause(400);
    const saved = await pbprobe(`c.palette.value`);
    ok('保存でパレット本文が更新される', saved === body1, { saved: String(saved).slice(0, 40) });
    ok('保存でエディタが閉じる', await js(`!!document.querySelector('.palette-source-editor')`) === false, {});

    // 再オープン→復元
    await openEditor();
    const st4 = await editorState();
    ok('再オープンで本文が復元される', st4.value === body1, { value: String(st4.value).slice(0, 40) });

    // Escでキャンセル
    await setBody(body1 + '\n消える行');
    await js(`(function(){const ta=document.querySelector('.palette-source-editor .pse-textarea');ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return 1})()`);
    await pause(350);
    ok('Escでキャンセルして閉じる', await js(`!!document.querySelector('.palette-source-editor')`) === false, {});
    ok('キャンセルで本文は不変', (await pbprobe(`c.palette.value`)) === body1, {});

    // Ctrl+Enterで保存
    await openEditor();
    const body2 = body1 + '\n// @fold 戦闘\n1d20+{敏捷}\n// @end';
    await setBody(body2);
    await js(`(function(){const ta=document.querySelector('.palette-source-editor .pse-textarea');ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}));return 1})()`);
    await pause(400);
    ok('Ctrl+Enterで保存される', (await pbprobe(`c.palette.value`)) === body2, {});
    ok('保存後にタブが反映される', await pbprobe(`c.document.tabs.some(t=>t.name==='テスト')`) === true, {});
    await shot('after-save');

    const real = consoleErrors.filter(e => !/skyWay onFatalError/.test(e));
    ok('ページエラーなし', real.length === 0, real.slice(0, 4));
    console.log('RESULT', JSON.stringify({ checks, passed: checks - failures, failures, prefix }));
    process.exitCode = failures ? 1 : 0;
  } finally {
    try { ws.close(); } catch (e) { }
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
