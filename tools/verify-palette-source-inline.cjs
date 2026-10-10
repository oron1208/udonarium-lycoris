// チャパレ全文編集のインラインフォーム検証（v1.92: 大型エディタ廃止・rows拡大の回帰）
// 使い方: CDP_HTTP=http://127.0.0.1:19392 node tools/verify-palette-source-inline.cjs <isolated-url> <prefix>
const fs = require('fs');
const path = require('path');
const WS = require('/home/maco/.openclaw/workspace/projects/udonarium-lycoris/node_modules/ws');

const appUrl = process.argv[2] || 'http://127.0.0.1:14308/';
const prefix = process.argv[3] || 'psi';
const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:19392';
const OUT_DIR = '/home/maco/.openclaw/workspace/projects/udonarium-lycoris/tmp/palette-v192';
fs.mkdirSync(OUT_DIR, { recursive: true });

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
    for (let i = 0; i < 20 && !await js(`!!document.querySelector('palette-browser form.editor')`); i++) await pause(150);
    await pause(350);
  };
  const setBody = value => js(`(function(){
    const ta=document.querySelector('palette-browser form.editor textarea[name="body"]');
    if(!ta) return 'no-ta';
    const s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
    s.call(ta,${JSON.stringify(value)});
    ta.dispatchEvent(new Event('input',{bubbles:true}));
    return 'set';
  })()`);
  const formState = () => js(`(function(){
    const form=document.querySelector('palette-browser form.editor');
    if(!form) return {found:false};
    const ta=form.querySelector('textarea[name="body"]');
    const host=document.querySelector('palette-browser');
    return {found:true, inPalette: host ? host.contains(form) : false,
      rows: ta ? ta.getAttribute('rows') : null,
      body: ta ? ta.value : null,
      bigEditorGone: !document.querySelector('.palette-source-editor')};
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

    // ── 全文テキスト編集（インラインフォーム） ──
    await openEditor();
    const st1 = await formState();
    ok('全文編集フォーム（インライン）が開く', st1.found === true, {});
    ok('フォームはパレット内にある（body直下でない）', st1.inPalette === true, {});
    ok('大型エディタ（.palette-source-editor）は存在しない', st1.bigEditorGone === true, {});
    ok('全文編集のtextareaは8行（ちょびっと拡大）', st1.rows === '8', { rows: st1.rows });
    ok('フォーム表示中は旧仕様どおり一覧を隠す（has-form）', await js(`!!document.querySelector('palette-browser .browser.has-form')`));
    ok('編集枠が下の空きスペースを埋める', await js(`(function(){
      const form=document.querySelector('palette-browser form.editor');
      const ta=form.querySelector('textarea[name="body"]');
      const btn=[...form.querySelectorAll('button')].find(e=>e.textContent.trim()==='保存');
      if(!ta||!btn) return false;
      const tb=ta.getBoundingClientRect(), bb=btn.getBoundingClientRect();
      return tb.height>200 && (bb.top - tb.bottom) < 40;
    })()`), {});
    await shot('inline-open');

    // 入力→保存
    const body1 = '// @tab テスト\n2d6+1 ダイスロール\n〈回復薬〉HPを10回復';
    await setBody(body1);
    await js(`(function(){const b=Array.from(document.querySelectorAll('palette-browser form.editor button')).find(e=>e.textContent.trim()==='保存');b.click();return 1})()`);
    await pause(400);
    const saved = await pbprobe(`c.palette.value`);
    ok('保存でパレット本文が更新される', saved === body1, { saved: String(saved).slice(0, 40) });
    ok('保存でフォームが閉じる', await js(`!!document.querySelector('palette-browser form.editor')`) === false, {});

    // 再オープン→復元
    await openEditor();
    const st2 = await formState();
    ok('再オープンで本文が復元される', st2.body === body1, { value: String(st2.body).slice(0, 40) });

    // 通常の項目追加フォーム（＋ 行・説明文）は rows=6 のまま（回帰）
    await js(`(function(){const b=Array.from(document.querySelectorAll('palette-browser form.editor button')).find(e=>e.textContent.trim()==='キャンセル');b.click();return 1})()`);
    await pause(250);
    await js(`(function(){const b=Array.from(document.querySelectorAll('palette-browser button')).find(e=>e.textContent.trim()==='＋ 行・説明文');if(b)b.click();return !!b})()`);
    for (let i = 0; i < 15 && !await js(`!!document.querySelector('palette-browser form.editor')`); i++) await pause(150);
    const st3 = await formState();
    ok('通常の追加フォーム（＋ 行・説明文）は6行のまま', st3.found === true && st3.rows === '6', { rows: st3.rows });
    await js(`(function(){const b=Array.from(document.querySelectorAll('palette-browser form.editor button')).find(e=>e.textContent.trim()==='キャンセル');b.click();return 1})()`);
    await pause(250);

    // もう一度全文編集→保存で2タブ・折りたたみまで反映（ロールバック後も機能維持）
    await openEditor();
    const body2 = body1 + '\n// @fold 戦闘\n1d20+{敏捷}\n// @end';
    await setBody(body2);
    await js(`(function(){const b=Array.from(document.querySelectorAll('palette-browser form.editor button')).find(e=>e.textContent.trim()==='保存');b.click();return 1})()`);
    await pause(400);
    ok('保存で本文・折りたたみまで反映される', (await pbprobe(`c.palette.value`)) === body2 && await js(`!![...document.querySelectorAll('palette-browser .fold')].some(e=>e.textContent.includes('戦闘'))`), {});
    await shot('after-save');

    const real = consoleErrors.filter(e => !/skyWay onFatalError/.test(e));
    ok('ページエラーなし', real.length === 0, real.slice(0, 4));
    console.log('RESULT', JSON.stringify({ checks, passed: checks - failures, failures, prefix }));
    process.exitCode = failures ? 1 : 0;
  } finally {
    try { ws.close(); } catch (e) { }
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
