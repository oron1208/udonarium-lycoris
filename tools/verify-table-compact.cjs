// テーブル設定のコンパクト幅（窓1000px・環境音枠縮小）の検証。
// 使い方: node tools/verify-table-compact.cjs <url> <prefix> [assert]
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const WS = require('/home/maco/.openclaw/workspace/projects/udonarium-lycoris/node_modules/ws');

const appUrl = process.argv[2] || 'http://127.0.0.1:14289/';
const prefix = process.argv[3] || 'new';
const doAssert = process.argv[4] === 'assert';
const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:19368';
const OUT_DIR = '/home/maco/.openclaw/workspace/projects/udonarium-lycoris/tmp/table-setting-20261005';

// 隔離検証: 外部接続されうるURLは拒否
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
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
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
  const openTableSetting = async () => {
    await js(`(()=>{
      const lis = Array.from(document.querySelectorAll('li')).filter(li => li.textContent.trim().endsWith('テーブル設定') && li.offsetParent !== null);
      const li = lis[lis.length - 1];
      if (li) li.click();
      return !!li;
    })()`);
    for (let i = 0; i < 20 && !await js(`!!document.querySelector('game-table-setting')`); i++) await pause(300);
    return !!await js(`!!document.querySelector('game-table-setting')`);
  };
  const ensureTable = async () => {
    if (await js(`!!document.querySelector('game-table-setting .table-setting-grid')`)) return 'exists';
    await js(`(()=>{const b=Array.from(document.querySelectorAll('game-table-setting button')).find(b=>b.textContent.includes('新しいテーブルを作る'));if(b)b.click();return !!b})()`);
    for (let i = 0; i < 20 && !await js(`!!document.querySelector('game-table-setting .table-setting-grid')`); i++) await pause(300);
    return await js(`!!document.querySelector('game-table-setting .table-setting-grid')`) ? 'created' : 'failed';
  };
  const measure = () => js(`(()=>{
    const g = document.querySelector('game-table-setting .table-setting-grid');
    const panel = document.querySelector('game-table-setting')?.closest('.draggable-panel');
    if (!g || !panel) return null;
    const r = sel => { const el = g.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width) }; };
    // 中身（スクロールコンテナ）基準ではみ出しを判定。窓端のリサイズハンドルは意図的突出なので対象外
    const scrollable = panel.querySelector('.scrollable-panel') ?? panel;
    const overflows = [];
    for (const el of [scrollable, ...scrollable.querySelectorAll('*')]) {
      if (el.scrollHeight > el.clientHeight + 2 && getComputedStyle(el).overflowY !== 'visible') continue; // 縦は許容
      if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) overflows.push((el.className || el.tagName).toString().slice(0, 40) + ' ' + el.scrollWidth + '>' + el.clientWidth);
      if (overflows.length >= 3) break;
    }
    return {
      panelW: panel.offsetWidth,
      preview: r('.table-preview-column'),
      param: r('.table-param-column'),
      nameInput: (() => { const el = g.querySelector('.table-name-row input'); if (!el) return null; const b = el.getBoundingClientRect(); return { w: Math.round(b.width), right: Math.round(b.right) }; })(),
      previewRight: Math.round(g.querySelector('.table-preview-column')?.getBoundingClientRect().right ?? 0),
      overflowCount: overflows.length,
      overflows,
      paramFirst: g.classList.contains('param-first'),
      layers: g.querySelectorAll('.table-audio-layer').length
    };
  })()`);

  try {
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: appUrl });
    await pause(9000);
    await closeOverlays();

    ok('テーブル設定メニューでモーダルが開く', await openTableSetting(), '');
    console.log('table ensure:', await ensureTable());

    let m = await measure();
    console.log('measure(default):', JSON.stringify(m));
    if (doAssert) {
      ok('窓の既定幅が1000px級', m && m.panelW >= 994 && m.panelW <= 1006, { panelW: m && m.panelW });
      ok('横のはみ出しなし（1000px内に収まる）', m && m.overflowCount === 0, { overflows: m && m.overflows });
      ok('Name入力がプレビュー列内に収まる', m && m.nameInput && m.nameInput.right <= m.previewRight + 2, { nameW: m && m.nameInput && m.nameInput.w, previewRight: m && m.previewRight, inputRight: m && m.nameInput && m.nameInput.right });
      ok('画像・BGM列が左で24em級の幅', m && m.preview && m.param && m.preview.x < m.param.x && m.preview.w < 500, { previewW: m && m.preview && m.preview.w });
    } else {
      console.log('旧ビルド: 窓幅=' + (m && m.panelW) + ' はみ出し=' + (m && m.overflowCount));
    }
    await shot('wide-default');

    // ── 1000pxへ強制狭幅A/B（旧ビルドではあふれるのが正しい） ──
    await js(`(()=>{const p=document.querySelector('game-table-setting')?.closest('.draggable-panel');if(p)p.style.width='1000px';return 1})()`);
    await pause(400);
    m = await measure();
    console.log('measure(forced1000):', JSON.stringify(m));
    if (doAssert) {
      ok('1000px強制でもはみ出しなし', m && m.overflowCount === 0, { overflows: m && m.overflows });
    } else {
      console.log('旧ビルド@1000px: はみ出し=' + (m && m.overflowCount) + (m && m.overflowCount > 0 ? ' （旧はあふれる＝正しい再現）' : ''));
    }
    await shot('wide-forced1000');

    // ── 環境音レイヤーを足してもあふれない ──
    await js(`(()=>{const b=Array.from(document.querySelectorAll('game-table-setting button')).find(b=>b.textContent.includes('ループ追加'));if(b)b.click();return !!b})()`);
    for (let i = 0; i < 15 && !await js(`!!document.querySelector('game-table-setting .table-audio-layer')`); i++) await pause(300);
    m = await measure();
    console.log('measure(withLayer):', JSON.stringify(m));
    const layerInfo = await js(`(()=>{
      const b = document.querySelector('game-table-setting .table-audio-layer-body');
      if (!b) return null;
      return { w: Math.round(b.clientWidth), sw: b.scrollWidth, h: Math.round(b.getBoundingClientRect().height) };
    })()`);
    console.log('layerBody:', JSON.stringify(layerInfo));
    if (doAssert) {
      ok('環境音レイヤーが追加される', m && m.layers >= 1, { layers: m && m.layers });
      ok('環境音の枠内であふれなし（折返し収まり）', layerInfo && layerInfo.sw <= layerInfo.w + 2, { ...layerInfo });
      ok('レイヤー追加後も窓内に収まる', m && m.overflowCount === 0, { overflows: m && m.overflows });
    }

    // ── 列順トグルがまだ機能する ──
    if (doAssert) {
      await js(`(()=>{const b=document.querySelector('game-table-setting .column-order-toggle button');if(b)b.click();return !!b})()`);
      await pause(400);
      m = await measure();
      ok('トグルで設定列が左（既存機能無傷）', m && m.preview && m.param && m.param.x < m.preview.x, { paramFirst: m && m.paramFirst });
      await js(`(()=>{const b=document.querySelector('game-table-setting .column-order-toggle button');if(b)b.click();return !!b})()`);
      await pause(400);
    }
    await shot('final');

    console.log('console errors:', consoleErrors.length, consoleErrors.slice(0, 2));
    if (doAssert) {
      const realErrors = consoleErrors.filter(e => !/skyWay onFatalError/.test(e));
      ok('ページエラー0件（SkyWay接続系を除く）', realErrors.length === 0, { total: consoleErrors.length, real: realErrors.length, sample: realErrors.slice(0, 2) });
    }
    console.log('done:', prefix);
  } catch (e) {
    console.log('ERROR:', e.message);
    if (doAssert) process.exitCode = 1;
  } finally {
    ws.close();
  }
})();
