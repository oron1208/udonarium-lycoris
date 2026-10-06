// 修正検証: チャットログ検索のダブルクリックジャンプ（シングルクリックでパネルが閉じてdblclickが発火しないバグの修正）
// 使い方: node tools/verify-chatsearch.cjs <url> <prefix> [assert]
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const WS = require('/home/maco/.openclaw/workspace/projects/udonarium-lycoris/node_modules/ws');

const appUrl = process.argv[2] || 'http://127.0.0.1:14289/';
const prefix = process.argv[3] || 'cs';
const doAssert = process.argv[4] === 'assert';
const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:19368';
const OUT_DIR = '/home/maco/.openclaw/workspace/projects/udonarium-lycoris/tmp/chatsearch-20261007';
fs.mkdirSync(OUT_DIR, { recursive: true });

assert(/^http:\/\/(127\.0\.0\.1|localhost):\d+\/$/.test(appUrl), 'isolated local URL only: ' + appUrl);

const stamp = Date.now() % 100000;
const MARK = 'ジャンプ目印' + stamp;
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
  const ok = (name, cond, info) => {
    console.log((cond ? 'PASS' : 'FAIL') + `  ${name}  ` + JSON.stringify(info ?? ''));
    if (doAssert) assert(cond, name);
    return cond;
  };
  const shot = async name => {
    const r = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT_DIR, `${prefix}-${name}.png`), Buffer.from(r.data, 'base64'));
  };
  const cwprobe = expr => js(`(() => { const el = document.querySelector('chat-window'); const c = el && window.ng.getComponent(el); return c ? (${expr}) : null; })()`);

  const sendChat = async text => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await js(`(function(){
        const ta = document.querySelector('chat-window textarea');
        if (!ta) return 'no-textarea';
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, ${JSON.stringify(text)});
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        return 'sent';
      })()`);
      await pause(1500);
      // 送信成功＝textareaがクリアされる。されてなければリトライ
      const cleared = await js(`(() => { const ta = document.querySelector('chat-window textarea'); return ta ? ta.value === '' : null; })()`);
      if (cleared === true) return { sent: true };
    }
    const diag = await cwprobe(`({ tab: c.chatTabidentifier, taVal: (document.querySelector('chat-window textarea') || {}).value })`);
    return { sent: false, diag };
  };

  try {
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: appUrl });
    for (let i = 0; i < 60 && !await js(`!!document.querySelector('chat-window textarea')`); i++) await pause(500);
    // チャット送信の準備完了待ち（chatTabidentifierが設定されるまで）
    for (let i = 0; i < 25 && !(await cwprobe(`!!c.chatTabidentifier`)); i++) await pause(400);
    await pause(3000);
    await pause(1500);
    await js(`(() => { const b = document.querySelector('modal .title-button button'); if (b) b.click(); return 1; })()`);
    await pause(600);
    // チャット窓以外のdraggable-panelを退避（メニューは除く）
    await js(`(() => { const ps = document.querySelectorAll('.draggable-panel'); ps.forEach(p => { if (!p.innerText.includes('メニュー')) p.style.display = 'none'; }); return 1; })()`);

    // ── 1. チャット送信×10（目印は2通目。スクロール余地を作る） ──
    let sent2 = { sent: false };
    for (let i = 0; i < 10; i++) {
      const text = i === 1 ? MARK + ' これは目印の発言です' : 'チャットログ検索のテスト' + (i + 1) + ' ' + stamp;
      const r = await sendChat(text);
      if (i === 1) sent2 = r;
    }
    // 仮想スクロールでは表示範囲外のメッセージはDOMに無い（正常動作）。サービス側で確認する
    const markerInService = await cwprobe(`(function(){
      const svc = c.chatMessageService;
      const tabs = svc ? svc.chatTabs : [];
      return tabs.some(t => t.chatMessages.some(m => (m.text || '').includes(${JSON.stringify(MARK)})));
    })()`);
    ok('チャット送信で目印がサービスに記録される', markerInService === true, { markerInService, sent2 });

    // ── 2. 検索パネル ──
    await js(`(() => { const b = Array.from(document.querySelectorAll('chat-window .chat-tab button')).find(x => x.textContent.includes('検索')); if (b) b.click(); return 1; })()`);
    await pause(500);
    ok('検索パネルが開く', await js(`!!document.querySelector('chat-window .chat-search')`) === true, {});
    await js(`(function(){
      const input = document.querySelector('chat-window .chat-search-input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(MARK)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await pause(800);
    const resultInfo = await cwprobe(`(function(){ const rs = c.searchResults; return { count: rs.length, firstId: rs.length ? rs[0].msgIdentifier : null }; })()`);
    ok('検索でヒットする', !!resultInfo && 1 <= resultInfo.count, resultInfo);
    const itemDom = await js(`document.querySelectorAll('chat-window .chat-search-item').length`);
    ok('検索結果のDOMが出る', itemDom >= 1, { itemDom });

    // ── 3. ジャンプ前の状態を作る（スクロールを最上部へ） ──
    await cwprobe(`(function(){ const sp = c.panelService.scrollablePanel; sp.scrollTop = 0; return sp.scrollTop; })()`);
    await pause(400);
    const before = await cwprobe(`(function(){ const sp = c.panelService.scrollablePanel; return { top: sp.scrollTop }; })()`);
    ok('ジャンプ前にスクロール位置を最上部へ', !!before && before.top === 0, before);

    // ── 4. シングルクリック: パネルは閉じない（修正の確認） ──
    await js(`(() => { const it = document.querySelector('chat-window .chat-search-item'); if (it) it.dispatchEvent(new MouseEvent('click', { bubbles: true })); return !!it; })()`);
    await pause(400);
    const afterClick = await cwprobe(`({ searchOpen: c.searchOpen })`);
    ok('シングルクリックではパネルが閉じない', !!afterClick && afterClick.searchOpen === true, afterClick);
    await shot('after-single-click');

    // ── 5. ダブルクリック: タブ移動＋スクロールジャンプ＋パネル閉じ ──
    await js(`(() => { const it = document.querySelector('chat-window .chat-search-item'); if (it) it.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); return !!it; })()`);
    await pause(1600);
    const afterDbl = await cwprobe(`(function(){
      const sp = c.panelService.scrollablePanel;
      const el = document.querySelector('chat-message[data-message-id=\"${resultInfo.firstId}\"]');
      let inView = null;
      if (el) { const r = el.getBoundingClientRect(); inView = { top: Math.round(r.top), bottom: Math.round(r.bottom), hl: el.style.backgroundColor !== '' }; }
      return { searchOpen: c.searchOpen, top: Math.round(sp.scrollTop), elFound: !!el, inView };
    })()`);
    ok('ダブルクリックで検索パネルが閉じる', !!afterDbl && afterDbl.searchOpen === false, { searchOpen: afterDbl && afterDbl.searchOpen });
    ok('ジャンプで対象メッセージ要素が見つかる', !!afterDbl && afterDbl.elFound === true, { elFound: afterDbl && afterDbl.elFound });
    ok('対象メッセージが画面内に入る（ジャンプ成功）', !!afterDbl && !!afterDbl.inView && 0 <= afterDbl.inView.top && afterDbl.inView.bottom <= 1000, afterDbl && afterDbl.inView);
    console.log('SCROLLINFO ' + JSON.stringify({ before: before && before.top, after: afterDbl && afterDbl.top }));
    await shot('after-dblclick');

    const real = consoleErrors.filter(e => !/skyWay onFatalError/.test(e));
    ok('ページエラー0件（SkyWay接続系を除く）', real.length === 0, { total: consoleErrors.length, real: real.length, sample: real.slice(0, 3) });
    console.log('done:', prefix);
  } finally {
    try { ws.close(); } catch (e) { }
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
