// 辞書の複数作成(タイプ選択式)のE2E検証
// 使い方: node tools/verify-dict3.cjs <url> <prefix> [assert]
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const WS = require('/home/maco/.openclaw/workspace/projects/udonarium-lycoris/node_modules/ws');
const JSZip = require('/home/maco/.openclaw/workspace/projects/udonarium-lycoris/node_modules/jszip');

const appUrl = process.argv[2] || 'http://127.0.0.1:14289/';
const prefix = process.argv[3] || 'd3';
const doAssert = process.argv[4] === 'assert';
const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:19368';
const OUT_DIR = '/home/maco/.openclaw/workspace/projects/udonarium-lycoris/tmp/dict3-20261006';
fs.mkdirSync(OUT_DIR, { recursive: true });

assert(/^http:\/\/(127\.0\.0\.1|localhost):\d+\/$/.test(appUrl), 'isolated local URL only: ' + appUrl);

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const stamp = Date.now() % 100000;
const CHAR_NAME = 'ZIPスライム' + stamp;
const ZIP_XML = `<character name="${CHAR_NAME}" location.x="0" location.y="0" size="1" imageIdentifier="img-zip-${stamp}"><data name="HP" type="numberResource" currentValue="15">15</data></character>`;

const pause = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // ── テストアセット ──
  const zip = new JSZip();
  zip.file('character.xml', ZIP_XML);
  zip.file(`img-zip-${stamp}.png`, Buffer.from(PNG_B64, 'base64'));
  const zipPath = path.join(OUT_DIR, 'test-character.zip');
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: 'nodebuffer' }));

  const v2zip = new JSZip();
  v2zip.file('dictionary.json', JSON.stringify({
    version: 2, dictionary: { name: '配布辞書', type: 'characters' },
    characters: [{ id: 'x1', name: '配布ゴブリン', tags: [], xml: '<character name="配布ゴブリン"></character>', images: [], createdAt: 1 }],
    materials: [], palettes: [],
  }));
  const v2zipPath = path.join(OUT_DIR, 'haifu-dictionary.zip');
  fs.writeFileSync(v2zipPath, await v2zip.generateAsync({ type: 'nodebuffer' }));

  const legacyPath = path.join(OUT_DIR, 'legacy-dictionary.json');
  fs.writeFileSync(legacyPath, JSON.stringify({
    version: 1,
    characters: [{ id: 'x2', name: 'レガシーA', tags: [], xml: '<character name="レガシーA"></character>', images: [], createdAt: 2 }],
  }));

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
      // confirm/promptは自動承認（削除確認を通す）
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
  const closeOverlays = async () => {
    for (let i = 0; i < 5; i++) { await js(`(()=>{const b=document.querySelector('modal .title-button button');if(b)b.click();return !!b})()`); await pause(500); }
  };
  const menuItems = async () => js(`(() => {
    const lis = Array.from(document.querySelectorAll('context-menu li'));
    let vis = lis.filter(li => li.offsetParent !== null);
    if (!vis.length) vis = lis;
    return vis.map(li => li.textContent.trim());
  })()`);
  const setFileInput = async (selector, filePath, waitForExpr) => {
    const doc = await call('DOM.getDocument');
    const node = await call('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    if (!node.nodeId) throw new Error('file input not found: ' + selector);
    await call('DOM.setFileInputFiles', { files: [filePath], nodeId: node.nodeId });
    if (waitForExpr) {
      for (let i = 0; i < 10; i++) {
        await pause(300);
        if (await waitForExpr()) return true;
      }
    }
    return js(`(()=>{const el=document.querySelector('${selector}');if(el)el.dispatchEvent(new Event('change',{bubbles:true}));return !!el})()`);
  };
  const dsvc = expr => js(`(() => { const el = document.querySelector('dictionary-panel'); const c = el && window.ng.getComponent(el); return c ? (${expr}) : null; })()`);
  const dictIdByName = async name => dsvc(`(function(){ const col = c.dictionary.collections.find(x => x.name === '${name}'); return col ? col.id : null; })()`);
  const countByName = async name => dsvc(`(function(){ const col = c.dictionary.collections.find(x => x.name === '${name}'); return col ? c.dictionary.countOf(col.type, col.id) : -1; })()`);
  const selectDictByName = async name => {
    const did = await dictIdByName(name);
    if (!did) return 0;
    return js(`(function(){ const s = document.querySelector('dictionary-panel .dict-select'); if (!s) return 0; s.value = '${did}'; s.dispatchEvent(new Event('change', {bubbles: true})); return 1; })()`);
  };
  const panelBtn = (scope, txt) => js(`(function(){ const b = Array.from(document.querySelectorAll('dictionary-panel ${scope} button')).find(x => x.textContent.trim() === '${txt}' && !x.disabled); if (b) { b.click(); return true; } return false; })()`);
  const pointOn = hostExpr => js(`(() => {
    const hosts = Array.from(document.querySelectorAll('game-character')).filter(h => (${hostExpr}));
    if (!hosts.length) return null;
    const host = hosts[0];
    const els = [host, ...host.querySelectorAll('*')];
    for (const e of els) {
      const r = e.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const pts = [[r.x + r.width / 2, r.y + r.height / 2], [r.x + r.width / 2, r.y + Math.min(r.height - 3, 12)]];
      for (const [x, y] of pts) {
        const ix = Math.round(x), iy = Math.round(y);
        if (ix < 5 || iy < 5 || ix > 1395 || iy > 995) continue;
        const at = document.elementFromPoint(ix, iy);
        if (at && at.closest('game-character') === host) return { x: ix, y: iy };
      }
    }
    return null;
  })()`);
  const rightClick = async (x, y) => {
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 2, clickCount: 1 });
    await pause(700);
  };
  const openDictPanel = async () => {
    await js(`(() => { const lis = Array.from(document.querySelectorAll('li')).filter(li => li.textContent.trim().endsWith('辞書') && li.offsetParent !== null); const li = lis[lis.length - 1]; if (li) li.click(); return !!li; })()`);
    for (let i = 0; i < 20 && !await js(`!!document.querySelector('dictionary-panel .dict-select')`); i++) await pause(300);
  };
  const closeDictPanel = async () => {
    await js(`(() => { const dp = document.querySelector('dictionary-panel'); if (!dp) return 0; const panel = dp.closest('.draggable-panel'); const btn = panel ? Array.from(panel.querySelectorAll('button')).find(b => (b.textContent || '').includes('close')) : null; if (btn) btn.click(); return panel ? 1 : 0; })()`);
    for (let i = 0; i < 10 && await js(`!!document.querySelector('dictionary-panel')`); i++) await pause(300);
  };
  // 作成フォーム操作
  const createDictUI = async (name, type) => {
    await panelBtn('.dict-toolbar', '＋作成');
    for (let i = 0; i < 10 && !await js(`!!document.querySelector('dictionary-panel .dict-create input[name="dictName"]')`); i++) await pause(200);
    await js(`(function(){ const inp = document.querySelector('dictionary-panel .dict-create input[name="dictName"]'); if (!inp) return 0; inp.value = '${name}'; inp.dispatchEvent(new Event('input', {bubbles: true})); return 1; })()`);
    if (type) await js(`(function(){ const r = document.querySelector('dictionary-panel .dict-create input[name="newDictType"][value="${type}"]'); if (!r) return 0; r.checked = true; r.dispatchEvent(new Event('change', {bubbles: true})); return 1; })()`);
    await panelBtn('.dict-create', '作成');
    for (let i = 0; i < 15 && !await dictIdByName(name); i++) await pause(300);
    return !!(await dictIdByName(name));
  };

  try {
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: appUrl });
    for (let i = 0; i < 60 && !await js(`(() => Array.from(document.querySelectorAll('li')).some(li => li.textContent.trim().endsWith('辞書') && li.offsetParent !== null))()`); i++) await pause(500);
    await pause(1500);
    await closeOverlays();
    await js(`(() => { const s = document.createElement('style'); s.textContent = '.modal-background, modal { display: none !important; }'; document.head.appendChild(s); const ps = document.querySelectorAll('.draggable-panel'); ps.forEach(p => { if (!p.innerText.includes('メニュー')) p.style.display = 'none'; }); return 1; })()`);

    // ── 辞書パネルを開く ──
    await openDictPanel();
    ok('辞書パネルが開く', await js(`!!document.querySelector('dictionary-panel .dict-select')`), '');

    // ── 1. 既定3辞書 ──
    const labels = await js(`(() => { const s = document.querySelector('dictionary-panel .dict-select'); return s ? Array.from(s.options).map(o => o.textContent.trim()) : []; })()`);
    ok('初回起動で既定3辞書ができる', labels.some(l => l.includes('コマ辞書')) && labels.some(l => l.includes('資料辞書')) && labels.some(l => l.includes('チャパレ辞書')), labels);

    // ── 2. コマ辞書タイプで「ダンジョン用」を作成 ──
    const created1 = await createDictUI('ダンジョン用', 'characters');
    ok('コマ辞書タイプで新辞書を作成', created1, {});
    const activeName = await dsvc(`c.activeDict ? c.activeDict.name : null`);
    ok('作成した辞書が選択される', activeName === 'ダンジョン用', { activeName });
    const activeType = await dsvc(`c.activeDict ? c.activeDict.type : null`);
    ok('作成時のタイプがコマになっている', activeType === 'characters', { activeType });
    await shot('created');

    // ── 3. ZIP取込 → 選択中の辞書だけに入る ──
    await setFileInput('dictionary-panel .dict-actions input[type="file"]', zipPath, async () => (await countByName('ダンジョン用')) > 0);
    for (let i = 0; i < 10 && (await countByName('ダンジョン用')) < 1; i++) await pause(300);
    const cntDun = await countByName('ダンジョン用');
    const cntDefault = await countByName('コマ辞書');
    ok('ZIP取込は選択中の辞書に入る', cntDun === 1 && cntDefault === 0, { cntDun, cntDefault });
    const zipEntry = await dsvc(`(function(){ const col = c.dictionary.collections.find(x => x.name === 'ダンジョン用'); const e = c.dictionary.entriesOfCharacters(col.id)[0]; return e ? { name: e.name, imgs: e.images.length, dictId: e.dictId === col.id } : null; })()`);
    ok('登録エントリはZIPの内容を持つ', !!zipEntry && zipEntry.name === CHAR_NAME && zipEntry.imgs >= 1 && zipEntry.dictId === true, zipEntry);

    // ── 4. 盤面→右クリック「辞書に登録」→ 既定コマ辞書へ ──
    const spawned = await dsvc(`(function(){ const col = c.dictionary.collections.find(x => x.name === 'ダンジョン用'); const e = c.dictionary.entriesOfCharacters(col.id)[0]; const ch = c.dictionary.spawnCharacter(e, { x: 2, y: 2, z: 0 }); return ch ? ch.name : null; })()`);
    ok('辞書からコマをスポーンできる', spawned === CHAR_NAME, { spawned });
    await closeDictPanel();
    let pt = null;
    for (let i = 0; i < 20 && !pt; i++) { await pause(400); pt = await pointOn(`h.textContent.includes('${CHAR_NAME}')`); }
    ok('スポーンしたコマのクリック点がある', !!pt, pt);
    await rightClick(pt.x, pt.y);
    const items1 = await menuItems();
    ok('コマ右クリックに「辞書に登録」がある', Array.isArray(items1) && items1.includes('辞書に登録'), { items: items1 });
    await js(`(() => { const lis = Array.from(document.querySelectorAll('context-menu li')).filter(li => li.textContent.includes('辞書に登録')); if (!lis.length) return 0; lis[lis.length - 1].click(); return 1; })()`);
    await pause(800);
    await openDictPanel();
    for (let i = 0; i < 12 && (await countByName('コマ辞書')) < 1; i++) await pause(300);
    const cntDefault2 = await countByName('コマ辞書');
    ok('盤面からの登録は既定コマ辞書に入る', cntDefault2 === 1 && (await countByName('ダンジョン用')) === 1, { cntDefault2, dun: await countByName('ダンジョン用') });
    await shot('board-to-default');

    // ── 5. 資料辞書タイプで「世界設定」を作成 ──
    const created2 = await createDictUI('世界設定', 'materials');
    ok('資料辞書タイプで新辞書を作成', created2, {});
    ok('資料辞書が選択されタイプも資料', await dsvc(`c.activeDict ? c.activeDict.name + '/' + c.activeDict.type : null`) === '世界設定/materials', {});
    await panelBtn('.dict-body', '＋セクション追加');
    for (let i = 0; i < 12 && (await countByName('世界設定')) < 1; i++) await pause(300);
    ok('セクションはその辞書だけに入る', (await countByName('世界設定')) === 1 && (await countByName('ダンジョン用')) === 1, { sekai: await countByName('世界設定') });
    await shot('material-dict');

    // ── 6. チャパレ辞書（既定）にチャパレ追加 ──
    await selectDictByName('チャパレ辞書');
    await pause(300);
    ok('チャパレ辞書へ切り替え', await dsvc(`c.activeDict ? c.activeDict.name : null`) === 'チャパレ辞書', {});
    await panelBtn('.dict-body', '＋チャパレ追加');
    for (let i = 0; i < 12 && (await countByName('チャパレ辞書')) < 1; i++) await pause(300);
    ok('チャパレ追加で1件', (await countByName('チャパレ辞書')) === 1, { pals: await countByName('チャパレ辞書') });

    // ── 7. 書き出し(辞書単位の中身) ──
    await selectDictByName('コマ辞書');
    await pause(300);
    const exp = await dsvc(`(function(){ const col = c.dictionary.collections.find(x => x.name === 'コマ辞書'); return c.dictionary.exportCollection(col.id); })()`);
    ok('書き出しはv2形式で辞書単位', !!exp && exp.version === 2 && exp.dictionary && exp.dictionary.name === 'コマ辞書' && exp.dictionary.type === 'characters' && exp.characters.length === 1, exp);

    // ── 8. v2形式の読み込み → 新しい辞書が作られる ──
    await setFileInput('dictionary-panel .dict-toolbar input[type="file"]', v2zipPath, async () => !!(await dictIdByName('配布辞書')));
    for (let i = 0; i < 12 && !(await dictIdByName('配布辞書')); i++) await pause(300);
    ok('v2読み込みで新しい辞書が作られる', !!(await dictIdByName('配布辞書')), {});
    ok('配布辞書の中身は1件', (await countByName('配布辞書')) === 1, { cnt: await countByName('配布辞書') });

    // ── 9. v1レガシー読み込み → 既定辞書へ振り分け ──
    const legacyBase = await countByName('コマ辞書');
    await setFileInput('dictionary-panel .dict-toolbar input[type="file"]', legacyPath, async () => (await countByName('コマ辞書')) > legacyBase);
    for (let i = 0; i < 12 && (await countByName('コマ辞書')) <= legacyBase; i++) await pause(300);
    ok('v1レガシーは既定コマ辞書に追加', (await countByName('コマ辞書')) === legacyBase + 1, { legacyBase, now: await countByName('コマ辞書') });
    await shot('imported');

    // ── 10. 辞書削除 → 中身も消える ──
    await selectDictByName('ダンジョン用');
    await pause(300);
    await panelBtn('.dict-toolbar', '削除');
    for (let i = 0; i < 15 && (await dictIdByName('ダンジョン用')); i++) await pause(300);
    const dunGone = !(await dictIdByName('ダンジョン用'));
    const totalChars = await dsvc(`c.dictionary.characters.length`);
    ok('辞書を削除すると中身も消える', dunGone && totalChars === legacyBase + 2, { dunGone, totalChars, expect: legacyBase + 2 });
    const activeAfterDelete = await dsvc(`c.activeDict ? c.activeDict.name : null`);
    ok('削除後は別の辞書が選択される', !!activeAfterDelete && activeAfterDelete !== 'ダンジョン用', { activeAfterDelete });

    const real = consoleErrors.filter(e => !/skyWay onFatalError/.test(e));
    ok('ページエラー0件（SkyWay接続系を除く）', real.length === 0, { total: consoleErrors.length, real: real.length, sample: real.slice(0, 3) });
    console.log('done:', prefix);
  } finally {
    try { ws.close(); } catch (e) { }
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
