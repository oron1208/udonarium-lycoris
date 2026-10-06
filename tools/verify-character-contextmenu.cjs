// コマ右クリック→コマメニュー回帰検証（テーブルメニュー誤発火バグの修正確認 2026-10-06）
// 使い方: node tools/verify-character-contextmenu.cjs <url> <prefix> [assert]
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const WS = require('/home/maco/.openclaw/workspace/projects/udonarium-lycoris/node_modules/ws');

const appUrl = process.argv[2] || 'http://127.0.0.1:14289/';
const prefix = process.argv[3] || 'ctx';
const doAssert = process.argv[4] === 'assert';
const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:19368';
const OUT_DIR = '/home/maco/.openclaw/workspace/projects/udonarium-lycoris/tmp/contextmenu-20261006';
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
  const closeOverlays = async () => {
    for (let i = 0; i < 5; i++) { await js(`(()=>{const b=document.querySelector('modal .title-button button');if(b)b.click();return !!b})()`); await pause(500); }
  };
  const menuItems = async () => js(`(() => {
    const lis = Array.from(document.querySelectorAll('context-menu li'));
    let vis = lis.filter(li => li.offsetParent !== null);
    if (!vis.length) vis = lis;
    return vis.map(li => li.textContent.trim());
  })()`);
  const rightClick = async (x, y) => {
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 2, clickCount: 1 });
    await pause(700);
  };
  // 目的のgame-character上に実在する点をelementFromPointで探す（3D transformでrect中心が要素外になることがある）
  const pointOn = hostExpr => js(`(() => {
    const hosts = Array.from(document.querySelectorAll('game-character')).filter(h => (${hostExpr}));
    if (!hosts.length) return null;
    const host = hosts[0];
    const els = [host, ...host.querySelectorAll('*')];
    const pts = [];
    for (const e of els) {
      const r = e.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      pts.push([r.x + r.width / 2, r.y + r.height / 2]);
      pts.push([r.x + r.width / 2, r.y + Math.min(r.height - 3, 12)]);
    }
    for (const [x, y] of pts) {
      const ix = Math.round(x), iy = Math.round(y);
      if (ix < 5 || iy < 5 || ix > 1395 || iy > 995) continue;
      const e = document.elementFromPoint(ix, iy);
      if (e && e.closest('game-character') === host) return { x: ix, y: iy };
    }
    return null;
  })()`);
  // コマでもパネルでもない卓面上の点をグリッド走査で探す
  const findTableSpot = () => js(`(() => {
    const bad = e => e && e.closest('game-character,draggable-panel,dictionary-panel,modal,chat-window,chat-tab,context-menu,game-table-setting,options-panel,initiative-panel');
    const xs = [250, 420, 600, 780, 960, 1140, 1300];
    const ys = [130, 240, 350, 460, 640, 760, 880];
    for (const y of ys) for (const x of xs) {
      const e = document.elementFromPoint(x, y);
      if (!e || bad(e)) continue;
      if (!e.closest('.component.is-fill')) continue;
      return { x, y, tag: e.tagName + '.' + String(e.className).slice(0, 24) };
    }
    return null;
  })()`);

  try {
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: appUrl });
    // devビルドは初回ロードが重いので出揃いを待つ
    for (let i = 0; i < 40 && !await js(`!!(document.querySelector('game-table') || document.querySelector('modal'))`); i++) await pause(500);
    await pause(3000);
    await closeOverlays();
    // 隔離環境ではSkyWay失敗の「ネットワークエラー」モーダルが頻発し、.modal-backgroundが全クリックを横取る → 非表示化
    await js(`(() => { const s = document.createElement('style'); s.id = 'ctxfix-hide-modal'; s.textContent = '.modal-background, modal { display: none !important; }'; document.head.appendChild(s); return !!document.getElementById('ctxfix-hide-modal'); })()`);
    // defaultレイアウトのチャット窓等floaterが卓中央に被さるので退避（既存手順）
    await js(`(() => { const ps = document.querySelectorAll('.draggable-panel'); ps.forEach(p => p.style.display = 'none'); return ps.length; })()`);
    // 卓が無い新規プロファイルはテーブル設定から新規作成する
    if (!await js(`!!document.querySelector('game-table')`)) {
      await js(`(() => { const lis = Array.from(document.querySelectorAll('li')).filter(li => li.textContent.trim().endsWith('テーブル設定') && li.offsetParent !== null); const li = lis[lis.length - 1]; if (li) li.click(); return !!li; })()`);
      for (let i = 0; i < 20 && !await js(`!!document.querySelector('game-table-setting')`); i++) await pause(300);
      await js(`(() => { const els = Array.from(document.querySelectorAll('game-table-setting button, game-table-setting li')).filter(e => e.textContent.includes('新しいテーブルを作る') && e.offsetParent !== null); const e = els[els.length - 1]; if (e) e.click(); return !!e; })()`);
      for (let i = 0; i < 20 && !await js(`!!document.querySelector('game-table')`); i++) await pause(300);
      await closeOverlays();
    }
    ok('卓がある', await js(`!!document.querySelector('game-table')`), '');

    // 既存コマ（デフォルト部屋のモンスターA。無ければ何か1体）の上の実クリック点を探す
    let pt = null;
    for (let i = 0; i < 30 && !pt; i++) { await pause(500); pt = await pointOn(`h.textContent.includes('モンスターA')`); }
    if (!pt) pt = await pointOn('true');
    if (!pt) {
      const diag = await js(`(() => ({ chars: document.querySelectorAll('game-character').length, tables: document.querySelectorAll('game-table').length, modals: document.querySelectorAll('modal').length, bodyText: document.body.innerText.slice(0, 120) }))()`);
      console.log('info: diag =', diag);
    }
    ok('卓上にコマとそのクリック点がある', !!pt, pt);

    const hit = await js(`(() => { const e = document.elementFromPoint(${pt.x}, ${pt.y}); if (!e) return 'null'; return (e.closest('game-character') ? 'in-char|' : 'OUT|') + e.tagName + '.' + String(e.className).slice(0, 30); })()`);
    console.log('info: char point =', pt, hit);

    // コマ右クリック → コマメニュー
    await rightClick(pt.x, pt.y);
    let items1 = await menuItems();
    if (!Array.isArray(items1) || !items1.length) {
      console.log('info: menu html =', String(await js(`(()=>{const m=document.querySelector('context-menu');return m?m.outerHTML.slice(0,300):'none'})()`)));
    }
    await shot('char-menu');
    ok('コマ右クリックでコマメニュー（メモを編集を含む）', Array.isArray(items1) && items1.includes('メモを編集'), { items: items1 });

    // メモ編集モーダルが開く
    let modalOk = false;
    if (Array.isArray(items1) && items1.includes('メモを編集')) {
      const clicked = await js(`(() => { const lis = Array.from(document.querySelectorAll('context-menu li')).filter(li => li.textContent.includes('メモを編集')); if (!lis.length) return 0; lis[lis.length - 1].click(); return lis.length; })()`);
      for (let i = 0; i < 12 && !modalOk; i++) { await pause(300); modalOk = await js(`(() => !!document.querySelector('modal memo-edit'))()`); }
      if (!modalOk) console.log('info: memo diag', { clicked, modals: await js(`document.querySelectorAll('modal').length`), texts: await js(`Array.from(document.querySelectorAll('modal')).map(m => m.innerText.slice(0, 40))`) });
      const memoTitle = await js(`(() => { const m = Array.from(document.querySelectorAll('modal')).find(x => x.querySelector('memo-edit')); return m ? m.querySelector('.title').textContent.trim() : 'none'; })()`);
      console.log('info: memo modal title =', memoTitle);
      await shot('memo-modal');
      await closeOverlays();
    }
    ok('メモ編集モーダルが開く', modalOk, '');

    // 卓の空きスペース右クリック（コマでもパネルでもない点をグリッド走査）
    const spot = await findTableSpot();
    console.log('info: table spot =', spot);
    ok('卓の空きスペースが見つかる', !!spot, spot);
    let items2 = [];
    if (spot) {
      await rightClick(spot.x, spot.y);
      items2 = await menuItems();
    }
    await shot('table-menu');
    ok('卓の空きスペース右クリックは卓メニュー（コマメニューと別）', Array.isArray(items2) && items2.length > 0 && !items2.includes('メモを編集'), { items: items2 });

    const real = consoleErrors.filter(e => !/skyWay onFatalError/.test(e));
    ok('ページエラー0件（SkyWay接続系を除く）', real.length === 0, { total: consoleErrors.length, real: real.length, sample: real.slice(0, 3) });
    console.log('done:', prefix);
  } finally {
    try { ws.close(); } catch (e) {}
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
