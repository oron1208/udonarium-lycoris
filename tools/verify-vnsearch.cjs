// 診断: VNチャパレのログ検索ジャンプ（候補クリックしてもチャットログが動かない問題の原因特定）
// 使い方: node tools/verify-vnsearch.cjs <url> <prefix> [assert]
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const WS = require('/home/maco/.openclaw/workspace/projects/udonarium-lycoris/node_modules/ws');

const appUrl = process.argv[2] || 'http://127.0.0.1:14289/';
const prefix = process.argv[3] || 'vn';
const doAssert = process.argv[4] === 'assert';
const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:19368';
const OUT_DIR = '/home/maco/.openclaw/workspace/projects/udonarium-lycoris/tmp/vnsearch-20261007';
fs.mkdirSync(OUT_DIR, { recursive: true });

assert(/^http:\/\/(127\.0\.0\.1|localhost):\d+\/$/.test(appUrl), 'isolated local URL only: ' + appUrl);

const stamp = Date.now() % 100000;
const MARK = 'VN目印' + stamp;
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
  const vnprobe = expr => js(`(() => { const el = document.querySelector('vn-stage'); const c = el && window.ng.getComponent(el); return c ? (${expr}) : null; })()`);
  const vnSend = async text => vnprobe(`(function(){
    const svc = c.chatMessageService;
    const tab = svc.chatTabs[0];
    svc.sendMessage(tab, ${JSON.stringify(text)}, null, null, null, 0, '', null, false, '');
    return 1;
  })()`);

  try {
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    // VNモード有効化（新document向けにlocalStorageへ事前設定）
    await call('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('udonarium.vnStage.visible.v1', '1'); } catch (e) {}` });
    await call('Page.navigate', { url: appUrl });
    for (let i = 0; i < 60 && !await js(`!!document.querySelector('vn-stage')`); i++) await pause(500);
    await pause(2500);
    await js(`(() => { const b = document.querySelector('modal .title-button button'); if (b) b.click(); return 1; })()`);
    await pause(600);
    ok('VNモードが表示される', await js(`!!document.querySelector('vn-stage')`) === true, {});

    // ── 0. VNチャットログを展開（デフォルトは折りたたみで vn-chat-log がDOMに無い） ──
    const expanded0 = await vnprobe(`c.chatLogExpanded`);
    if (!expanded0) { await vnprobe(`c.toggleChatLog()`); await pause(800); }
    ok('VNチャットログが展開される', await vnprobe(`!!c.chatLogExpanded`) === true, {});
    ok('VNログDOMが存在する', await js(`!!document.querySelector('vn-stage .vn-log-messages')`) === true, {});

    // ── 1. 発言×45（目印は最後の1通→ジャンプでスクロールが実際に動くか検証） ──
    let sent2 = { sent: false };
    for (let i = 0; i < 45; i++) {
      const text = i === 44 ? MARK + ' これはVN目印の発言です' : 'VN検索テスト' + (i + 1) + ' ' + stamp;
      const r = await vnSend(text);
      if (i === 44) sent2 = { sent: !!r };
      await pause(200);
    }
    await pause(800);
    const markerInService = await vnprobe(`(function(){
      const svc = c.chatMessageService;
      const tabs = svc ? svc.chatTabs : [];
      return tabs.some(t => t.chatMessages.some(m => (m.text || '').includes(${JSON.stringify(MARK)})));
    })()`);
    ok('VN発言がサービスに記録される', markerInService === true, { markerInService, sent2 });

    // ── 2. VNログの表示状態 ──
    const logState = await js(`(() => {
      const msgs = document.querySelectorAll('vn-stage .vn-log-msg');
      const sc = document.querySelector('vn-stage .vn-log-messages');
      return { count: msgs.length, scrollHeight: sc ? sc.scrollHeight : -1, clientHeight: sc ? sc.clientHeight : -1 };
    })()`);
    ok('VNログにメッセージが表示される', !!logState && 1 <= logState.count, logState);
    console.log('SCROLLROOM ' + JSON.stringify(logState));

    // ── 3. VN検索パネル ──
    await js(`(() => { const b = Array.from(document.querySelectorAll('vn-stage .vn-log-pin')).find(x => (x.title || '') === 'ログを検索'); if (b) b.click(); return !!b; })()`);
    await pause(500);
    ok('VN検索パネルが開く', await js(`!!document.querySelector('vn-stage .vn-log-search')`) === true, {});
    const inputOk = await js(`(function(){
      const input = document.querySelector('vn-stage .vn-log-search-input');
      if (!input) return 0;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(MARK)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return 1;
    })()`);
    await pause(800);
    const itemInfo = await js(`(() => {
      const items = document.querySelectorAll('vn-stage .vn-log-search-item');
      return { count: items.length, first: items[0] ? items[0].textContent.slice(0, 30) : '' };
    })()`);
    ok('VN検索でヒットする', !!itemInfo && itemInfo.count >= 1, itemInfo);
    const targetId = await vnprobe(`(function(){ const rs = c.vnSearchResults; return rs.length ? rs[0].identifier : null; })()`);
    ok('VN検索の対象IDが取れる', !!targetId, { targetId });

    // ── 4. ジャンプ前: スクロール最上部へ ──
    await js(`(() => { const sc = document.querySelector('vn-stage .vn-log-messages'); if (sc) sc.scrollTop = 0; return 1; })()`);
    await pause(400);
    const before = await js(`(() => { const sc = document.querySelector('vn-stage .vn-log-messages'); return { top: sc ? sc.scrollTop : -1 }; })()`);
    ok('ジャンプ前にスクロール位置を最上部へ', !!before && before.top === 0, before);

    // ── 5. クリック（vnJumpToMessage） ──
    await js(`(() => { const it = document.querySelector('vn-stage .vn-log-search-item'); if (it) it.dispatchEvent(new MouseEvent('click', { bubbles: true })); return !!it; })()`);
    await pause(1600);
    const after = await js(`(function(){
      const sc = document.querySelector('vn-stage .vn-log-messages');
      const el = document.querySelector('vn-stage .vn-log-msg[data-vn-msg-id=\"${targetId}\"]');
      let inView = null;
      if (el) { const r = el.getBoundingClientRect(); inView = { top: Math.round(r.top), bottom: Math.round(r.bottom), hl: (el.style.backgroundColor || '') !== '' }; }
      return { searchOpen: !!document.querySelector('vn-stage .vn-log-search'), scrollTop: sc ? Math.round(sc.scrollTop) : -1, elFound: !!el, inView };
    })()`);
    ok('VNクリックで検索パネルが閉じる', !!after && after.searchOpen === false, { searchOpen: after && after.searchOpen });
    ok('VNジャンプでスクロールが実際に動く', !!after && after.scrollTop > 200, { before: before && before.top, after: after && after.scrollTop });
    ok('VNジャンプで対象要素が見つかる', !!after && after.elFound === true, { elFound: after && after.elFound });
    ok('VNジャンプで対象が画面内に入る（ジャンプ成功）', !!after && !!after.inView && 0 <= after.inView.top && after.inView.bottom <= 1000, after && after.inView);
    if (after && !after.elFound) {
      const diag3 = await js(`(() => {
        const msgs = Array.from(document.querySelectorAll('vn-stage .vn-log-msg'));
        return { count: msgs.length, ids: msgs.slice(0, 5).map(m => m.getAttribute('data-vn-msg-id')) };
      })()`);
      console.log('DIAG3 ' + JSON.stringify(diag3));
    }
    console.log('SCROLLINFO ' + JSON.stringify({ before: before && before.top, after: after && after.scrollTop }));
    await shot('vn-jump');

    const real = consoleErrors.filter(e => !/skyWay onFatalError/.test(e));
    ok('ページエラー0件（SkyWay接続系を除く）', real.length === 0, { total: consoleErrors.length, real: real.length, sample: real.slice(0, 3) });
    console.log('done:', prefix);
  } finally {
    try { ws.close(); } catch (e) { }
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
