// テーブル設定の列順レイアウト変更の検証。
// 使い方: node tools/verify-table-setting.cjs <url> <prefix> [assert]
//   url: 検証対象のローカル配信URL（旧dist / 新ビルド）
//   prefix: スクリーンショットの出力名
//   assert: 「assert」を付けると新ビルドの挙動を検査する（旧ビルドでは失敗するのが正しい）
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
    if (m.method === 'Runtime.exceptionThrown') consoleErrors.push('exception: ' + String(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '').slice(0, 120));
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
    const clicked = await js(`(()=>{
      const lis = Array.from(document.querySelectorAll('li')).filter(li => li.textContent.trim().endsWith('テーブル設定') && li.offsetParent !== null);
      const li = lis[lis.length - 1];
      if (!li) return false;
      li.click();
      return true;
    })()`);
    for (let i = 0; i < 20 && !await js(`!!document.querySelector('game-table-setting')`); i++) await pause(300);
    return clicked && !!await js(`!!document.querySelector('game-table-setting')`);
  };
  const ensureTable = async () => {
    if (await js(`!!document.querySelector('game-table-setting .table-setting-grid')`)) return 'exists';
    await js(`(()=>{const b=Array.from(document.querySelectorAll('game-table-setting button')).find(b=>b.textContent.includes('新しいテーブルを作る'));if(b)b.click();return !!b})()`);
    for (let i = 0; i < 20 && !await js(`!!document.querySelector('game-table-setting .table-setting-grid')`); i++) await pause(300);
    return await js(`!!document.querySelector('game-table-setting .table-setting-grid')`) ? 'created' : 'failed';
  };
  // 列の表示順を計測（普通のdivなのでhost 0x0問題は無い）
  const measure = () => js(`(()=>{
    const g = document.querySelector('game-table-setting .table-setting-grid');
    if (!g) return null;
    const r = sel => { const el = g.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width) }; };
    return {
      preview: r('.table-preview-column'),
      param: r('.table-param-column'),
      toggle: !!g.parentElement.querySelector('.column-order-toggle button'),
      paramFirst: g.classList.contains('param-first'),
      stored: localStorage.getItem('lycoris.table-setting.preview-first.v1')
    };
  })()`);

  try {
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: appUrl });
    await pause(9000);
    await closeOverlays();

    // ── モーダルを開く ──
    ok('テーブル設定メニューでモーダルが開く', await openTableSetting(), '');
    console.log('table ensure:', await ensureTable());

    // ── 既定の列順 ──
    let m = await measure();
    console.log('measure(default):', JSON.stringify(m));
    if (doAssert) {
      ok('既定は画像・BGM列が左（新順）', m && m.preview && m.param && m.preview.x < m.param.x, { preview: m.preview && m.preview.x, param: m.param && m.param.x });
      ok('列順トグルボタンが表示される', !!m.toggle, '');
      ok('既定でparam-firstクラスが無い', m.paramFirst === false, '');
    } else {
      console.log('旧ビルドの既定順: param.x=' + (m && m.param && m.param.x) + ' preview.x=' + (m && m.preview && m.preview.x) + (m && m.param && m.preview && m.param.x < m.preview.x ? ' （旧順: 設定列が左）' : ' (???)'));
    }
    await shot('layout-default');

    // ── トグルで逆順へ ──
    if (doAssert) {
      await js(`(()=>{const b=document.querySelector('game-table-setting .column-order-toggle button');if(b)b.click();return !!b})()`);
      await pause(500);
      m = await measure();
      console.log('measure(toggled):', JSON.stringify(m));
      ok('トグルで設定列が左に切り替わる', m && m.preview && m.param && m.param.x < m.preview.x, { preview: m.preview && m.preview.x, param: m.param && m.param.x });
      ok('param-firstクラスが付く', m.paramFirst === true, '');
      ok('選択がlocalStorageに保存される(0)', m.stored === '0', { stored: m.stored });
      await shot('layout-toggled');
    }

    // ── 永続化: 同一プロファイルで再訪 ──
    if (doAssert) {
      await call('Page.navigate', { url: appUrl });
      await pause(9000);
      await closeOverlays();
      ok('再訪でもモーダルが開く', await openTableSetting(), '');
      await ensureTable();
      m = await measure();
      console.log('measure(revisit):', JSON.stringify(m));
      ok('再訪後も設定列が左を維持（永続化）', m && m.preview && m.param && m.param.x < m.preview.x, { stored: m.stored });
      // 元に戻す
      await js(`(()=>{const b=document.querySelector('game-table-setting .column-order-toggle button');if(b)b.click();return !!b})()`);
      await pause(500);
      m = await measure();
      ok('トグルで新順に戻る', m && m.preview && m.param && m.preview.x < m.param.x, { stored: m.stored });
      ok('戻したらlocalStorageが1', m.stored === '1', { stored: m.stored });
    }

    // ── 機能スモーク: 名前変更がリストへ反映（並べ替えでバインディングが壊れていない） ──
    if (doAssert) {
      const renamed = await js(`(()=>{
        const input = document.querySelector('game-table-setting .table-name-row input');
        if (!input) return { error: 'name-input-not-found' };
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '改名テスト');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return { ok: true };
      })()`);
      await pause(700);
      const listName = await js(`(()=>{const el=document.querySelector('game-table-setting .table-list-row.selected .table-name-button');return el?el.textContent.trim():null})()`);
      ok('Name入力がテーブルリストへ反映される', renamed.ok && listName === '改名テスト', { listName });
    }
    await shot('final');

    console.log('console errors:', consoleErrors.length, consoleErrors.slice(0, 3));
    // 隔離環境ではSkyWayシグナリング不可の接続エラーが必ず出るため除外
    const realErrors = consoleErrors.filter(e => !/skyWay onFatalError/.test(e));
    if (doAssert) ok('ページエラー0件（SkyWay接続系を除く）', realErrors.length === 0, { total: consoleErrors.length, real: realErrors.length, sample: realErrors.slice(0, 2) });
    console.log('done:', prefix);
  } catch (e) {
    console.log('ERROR:', e.message);
    if (doAssert) { process.exitCode = 1; }
  } finally {
    ws.close();
  }
})();
