// 修正検証: ZIP取込の名前解決(name属性/<name>子要素/zip名・"data"にならない) ＋ 辞書検索 ＋ チャパレD&D追記
// 使い方: node tools/verify-dict5.cjs <url> <prefix> [assert]
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const WS = require('/home/maco/.openclaw/workspace/projects/udonarium-lycoris/node_modules/ws');
const JSZip = require('/home/maco/.openclaw/workspace/projects/udonarium-lycoris/node_modules/jszip');

const appUrl = process.argv[2] || 'http://127.0.0.1:14289/';
const prefix = process.argv[3] || 'd5';
const doAssert = process.argv[4] === 'assert';
const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:19368';
const OUT_DIR = '/home/maco/.openclaw/workspace/projects/udonarium-lycoris/tmp/dict5-20261006';
fs.mkdirSync(OUT_DIR, { recursive: true });

assert(/^http:\/\/(127\.0\.0\.1|localhost):\d+\/$/.test(appUrl), 'isolated local URL only: ' + appUrl);

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const pngBuf = Buffer.from(PNG_B64, 'base64');
const stamp = Date.now() % 100000;
const APP_NAME = 'APPスライム' + stamp;        // data.xml＋name属性あり
const APP_IMG = 'img-app-' + stamp;
const NC_NAME = 'NCスライム' + stamp;          // data.xml＋name属性なし＋<name>子要素
const NC_IMG = 'img-nc-' + stamp;
const NONAME_ZIP = 'noname-save' + stamp;      // data.xml完全name無し→zip名から。「data」にならない
const DN_IMG = 'img-dn-' + stamp;
const NB_NAME = 'モンスターB' + stamp;         // <名前>.xml 形式
const NB_IMG = 'img-nb-' + stamp;
const CH_NAME = 'CHARスライム' + stamp;        // character.xml 形式(回帰)
const CH_IMG = 'img-ch-' + stamp;
const PAL_TOKEN = 'チャパレトークン' + stamp;
const MAT_TOKEN = '資料トークン' + stamp;

const charXml = (name, imgId) => `<character name="${name}" location.x="0" location.y="0" size="1" imageIdentifier="${imgId}"><data name="HP" type="numberResource" currentValue="15">15</data></character>`;
const charXmlNameChild = (name, imgId) => `<character location.x="0" location.y="0" size="1" imageIdentifier="${imgId}"><name>${name}</name><data name="HP" type="numberResource" currentValue="15">15</data></character>`;
const charXmlNoName = imgId => `<character location.x="0" location.y="0" size="1" imageIdentifier="${imgId}"><data name="HP" type="numberResource" currentValue="15">15</data></character>`;

const pause = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // ── テストアセット ──
  const appZip = new JSZip();
  appZip.file('data.xml', charXml(APP_NAME, APP_IMG));
  appZip.file(`${APP_IMG}.png`, pngBuf);
  appZip.file('imagetag.xml', '<?xml version="1.0"?><imagetag></imagetag>');
  const appZipPath = path.join(OUT_DIR, 'app-save.zip');
  fs.writeFileSync(appZipPath, await appZip.generateAsync({ type: 'nodebuffer' }));

  const nlZip = new JSZip(); // data.xml＋name属性なし＋<name>子要素 → 子要素から
  nlZip.file('data.xml', charXmlNameChild(NC_NAME, NC_IMG));
  nlZip.file(`${NC_IMG}.png`, pngBuf);
  const nlZipPath = path.join(OUT_DIR, 'name-child.zip');
  fs.writeFileSync(nlZipPath, await nlZip.generateAsync({ type: 'nodebuffer' }));

  const dnZip = new JSZip(); // data.xml完全name無し → zip名から（「data」禁止）
  dnZip.file('data.xml', charXmlNoName(DN_IMG));
  dnZip.file(`${DN_IMG}.png`, pngBuf);
  const dnZipPath = path.join(OUT_DIR, `${NONAME_ZIP}.zip`);
  fs.writeFileSync(dnZipPath, await dnZip.generateAsync({ type: 'nodebuffer' }));

  const nbZip = new JSZip();
  nbZip.file(`${NB_NAME}.xml`, charXml(NB_NAME, NB_IMG));
  nbZip.file(`${NB_IMG}.png`, pngBuf);
  const nbZipPath = path.join(OUT_DIR, 'named-xml.zip');
  fs.writeFileSync(nbZipPath, await nbZip.generateAsync({ type: 'nodebuffer' }));

  const chZip = new JSZip();
  chZip.file('character.xml', charXml(CH_NAME, CH_IMG));
  chZip.file(`${CH_IMG}.png`, pngBuf);
  const chZipPath = path.join(OUT_DIR, 'character-format.zip');
  fs.writeFileSync(chZipPath, await chZip.generateAsync({ type: 'nodebuffer' }));

  const roomZip = new JSZip();
  roomZip.file('data.xml', '<?xml version="1.0"?><room name="てすと"><table></table></room>');
  roomZip.file('imagetag.xml', '<?xml version="1.0"?><imagetag></imagetag>');
  const roomZipPath = path.join(OUT_DIR, 'room-save.zip');
  fs.writeFileSync(roomZipPath, await roomZip.generateAsync({ type: 'nodebuffer' }));

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
  const dismissErrorModals = async () => {
    for (let i = 0; i < 4; i++) {
      await js(`(() => { let n = 0; document.querySelectorAll('modal').forEach(m => { if (!m.querySelector('dict-picker')) { const b = m.querySelector('.title-button button, button'); if (b) { b.click(); n++; } } }); return n; })()`);
      await pause(400);
    }
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
      return js(`(()=>{const el=document.querySelector('${selector}');if(el)el.dispatchEvent(new Event('change',{bubbles:true}));return !!el})()`);
    }
  };
  const dsvc = expr => js(`(() => { const el = document.querySelector('dictionary-panel'); const c = el && window.ng.getComponent(el); return c ? (${expr}) : null; })()`);
  const dsvcA = expr => js(`(async () => { const el = document.querySelector('dictionary-panel'); const c = el && window.ng.getComponent(el); return c ? await (${expr}) : null; })()`, true);
  const dictIdByName = async name => dsvc(`(function(){ const col = c.dictionary.collections.find(x => x.name === '${name}'); return col ? col.id : null; })()`);
  const countByName = async name => dsvc(`(function(){ const col = c.dictionary.collections.find(x => x.name === '${name}'); return col ? c.dictionary.countOf(col.type, col.id) : -1; })()`);
  const entryNames = async dictName => dsvc(`(function(){ const col = c.dictionary.collections.find(x => x.name === '${dictName}'); return col ? c.dictionary.entriesOfCharacters(col.id).map(e => e.name) : []; })()`);
  const panelMessage = () => js(`(() => { const m = document.querySelector('dictionary-panel .dict-message'); return m ? m.textContent.trim() : ''; })()`);
  const openDictPanel = async () => {
    await js(`(() => { const lis = Array.from(document.querySelectorAll('li')).filter(li => li.textContent.trim().endsWith('辞書') && li.offsetParent !== null); const li = lis[lis.length - 1]; if (li) li.click(); return !!li; })()`);
    for (let i = 0; i < 20 && !await js(`!!document.querySelector('dictionary-panel .dict-select')`); i++) await pause(300);
  };
  const closeDictPanel = async () => {
    await js(`(() => { const dp = document.querySelector('dictionary-panel'); if (!dp) return 0; const panel = dp.closest('.draggable-panel'); const btn = panel ? Array.from(panel.querySelectorAll('button')).find(b => (b.textContent || '').includes('close')) : null; if (btn) btn.click(); return panel ? 1 : 0; })()`);
    for (let i = 0; i < 10 && await js(`!!document.querySelector('dictionary-panel')`); i++) await pause(300);
  };
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
  const createDictUI = async (name, type) => {
    await js(`(function(){ const b = Array.from(document.querySelectorAll('dictionary-panel .dict-toolbar button')).find(x => x.textContent.trim() === '＋作成'); if (b) b.click(); return !!b; })()`);
    for (let i = 0; i < 10 && !await js(`!!document.querySelector('dictionary-panel .dict-create input[name="dictName"]')`); i++) await pause(200);
    await js(`(function(){ const inp = document.querySelector('dictionary-panel .dict-create input[name="dictName"]'); if (!inp) return 0; inp.value = '${name}'; inp.dispatchEvent(new Event('input', {bubbles: true})); return 1; })()`);
    if (type) await js(`(function(){ const r = document.querySelector('dictionary-panel .dict-create input[name="newDictType"][value="${type}"]'); if (!r) return 0; r.checked = true; r.dispatchEvent(new Event('change', {bubbles: true})); return 1; })()`);
    await js(`(function(){ const b = Array.from(document.querySelectorAll('dictionary-panel .dict-create button')).find(x => x.textContent.trim() === '作成'); if (b) b.click(); return !!b; })()`);
    for (let i = 0; i < 15 && !await dictIdByName(name); i++) await pause(300);
    return !!(await dictIdByName(name));
  };
  const pickerOpen = () => js(`(() => { const p = document.querySelector('dict-picker'); return !!p; })()`);
  const pickerCheckedName = () => js(`(() => { const p = document.querySelector('dict-picker'); if (!p) return ''; const c = p.querySelector('input[type=radio]:checked'); const row = c ? c.closest('.picker-row') : null; const n = row ? row.querySelector('.picker-name') : null; return n ? n.textContent.trim() : ''; })()`);
  const pickerSelectByName = async name => js(`(function(){ const p = document.querySelector('dict-picker'); if (!p) return 0; const rows = Array.from(p.querySelectorAll('.picker-row')); const row = rows.find(r => { const n = r.querySelector('.picker-name'); return n && n.textContent.trim() === '${name}'; }); if (!row) return 0; const inp = row.querySelector('input[type=radio]'); inp.checked = true; inp.dispatchEvent(new Event('change', {bubbles: true})); return 1; })()`);
  const pickerRegister = () => js(`(function(){ const p = document.querySelector('dict-picker'); if (!p) return 0; const b = Array.from(p.querySelectorAll('button')).find(x => x.textContent.trim() === '登録' && !x.disabled); if (!b) return 0; b.click(); return 1; })()`);
  const pickerMessage = () => js(`(() => { const m = document.querySelector('dict-picker .picker-message'); return m ? m.textContent.trim() : ''; })()`);
  const waitPickerClosed = async () => { for (let i = 0; i < 15 && await pickerOpen(); i++) await pause(300); };
  const setSearch = v => js(`(function(){ const i = document.querySelector('dictionary-panel .dict-search input'); if (!i) return 0; i.value = '${v}'; i.dispatchEvent(new Event('input', {bubbles: true})); return 1; })()`);
  const domCount = sel => js(`(() => document.querySelectorAll('${sel}').length)()`);
  const selectDictByName = async name => { const did = await dictIdByName(name); return dsvc(`(function(){ c.selectDict('${did}'); return c.activeDict ? c.activeDict.name : null; })()`); };
  const paletteValueOf = hostExpr => js(`(() => { const h = Array.from(document.querySelectorAll('game-character')).find(h => (${hostExpr})); const c = h && window.ng.getComponent(h); const p = c && c.gameCharacter.chatPalette; return p ? String(p.value) : null; })()`);

  try {
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: appUrl });
    for (let i = 0; i < 60 && !await js(`(() => Array.from(document.querySelectorAll('li')).some(li => li.textContent.trim().endsWith('辞書') && li.offsetParent !== null))()`); i++) await pause(500);
    await pause(1500);
    await dismissErrorModals();
    // SkyWay再表示対策: dict-pickerを含まないモーダルだけ恒久非表示（:hasで picker は生かす）
    await js(`(() => { const s = document.createElement('style'); s.textContent = 'modal:not(:has(dict-picker)), .modal-background:not(:has(dict-picker)) { display: none !important; }'; document.head.appendChild(s); const ps = document.querySelectorAll('.draggable-panel'); ps.forEach(p => { if (!p.innerText.includes('メニュー')) p.style.display = 'none'; }); return 1; })()`);

    // ── 辞書パネル ──
    await openDictPanel();
    ok('辞書パネルが開く', await js(`!!document.querySelector('dictionary-panel .dict-select')`), '');
    ok('検索ボックスがある', await js(`!!document.querySelector('dictionary-panel .dict-search input')`), {});
    const labels = await js(`(() => { const s = document.querySelector('dictionary-panel .dict-select'); return s ? Array.from(s.options).map(o => o.textContent.trim()) : []; })()`);
    ok('初回起動で既定3辞書ができる', labels.some(l => l.includes('コマ辞書')) && labels.some(l => l.includes('資料辞書')) && labels.some(l => l.includes('チャパレ辞書')), labels);
    ok('コマ辞書タイプで「ダンジョン用」を作成', await createDictUI('ダンジョン用', 'characters'), {});
    ok('作成辞書が選択される', await dsvc(`c.activeDict ? c.activeDict.name : null`) === 'ダンジョン用', {});

    // ── 1. data.xml＋name属性あり ──
    await setFileInput('dictionary-panel .dict-actions input[type="file"]', appZipPath, async () => (await countByName('ダンジョン用')) > 0);
    for (let i = 0; i < 12 && (await countByName('ダンジョン用')) < 1; i++) await pause(300);
    ok('data.xmlZIPが1件登録される', (await countByName('ダンジョン用')) === 1, { cnt: await countByName('ダンジョン用') });
    const appEntry = await dsvc(`(function(){ const col = c.dictionary.collections.find(x => x.name === 'ダンジョン用'); const e = c.dictionary.entriesOfCharacters(col.id).find(x => x.name === '${APP_NAME}'); return e ? { name: e.name, imgs: e.images.length } : null; })()`);
    ok('name属性から正しい名前＋画像復元', !!appEntry && appEntry.imgs >= 1, appEntry);

    // ── 2. data.xml＋<name>子要素 ──
    await setFileInput('dictionary-panel .dict-actions input[type="file"]', nlZipPath, async () => (await countByName('ダンジョン用')) > 1);
    for (let i = 0; i < 12 && (await countByName('ダンジョン用')) < 2; i++) await pause(300);
    ok('name属性無しでも<name>子要素の名前で登録', (await entryNames('ダンジョン用')).includes(NC_NAME), { names: await entryNames('ダンジョン用') });

    // ── 3. data.xml完全name無し → zip名から（「data」禁止） ──
    await setFileInput('dictionary-panel .dict-actions input[type="file"]', dnZipPath, async () => (await countByName('ダンジョン用')) > 2);
    for (let i = 0; i < 12 && (await countByName('ダンジョン用')) < 3; i++) await pause(300);
    const names3 = await entryNames('ダンジョン用');
    ok('完全name無しはzip名で登録される（「data」にならない）', names3.includes(NONAME_ZIP) && !names3.includes('data') && !names3.includes('date'), { names: names3 });

    // ── 4. <名前>.xml 形式 ──
    await setFileInput('dictionary-panel .dict-actions input[type="file"]', nbZipPath, async () => (await countByName('ダンジョン用')) > 3);
    for (let i = 0; i < 12 && (await countByName('ダンジョン用')) < 4; i++) await pause(300);
    ok('<名前>.xml形式ZIPも登録される', (await countByName('ダンジョン用')) === 4, { cnt: await countByName('ダンジョン用') });

    // ── 5. character.xml 形式（回帰） ──
    await setFileInput('dictionary-panel .dict-actions input[type="file"]', chZipPath, async () => (await countByName('ダンジョン用')) > 4);
    for (let i = 0; i < 12 && (await countByName('ダンジョン用')) < 5; i++) await pause(300);
    ok('character.xml形式ZIPも登録される（回帰）', (await countByName('ダンジョン用')) === 5, { cnt: await countByName('ダンジョン用') });

    // ── 6. ルーム形式ZIPは0件＋理由表示 ──
    await setFileInput('dictionary-panel .dict-actions input[type="file"]', roomZipPath, null);
    await pause(1200);
    const roomMsg = await panelMessage();
    ok('ルーム形式ZIPは0件で理由が出る', (await countByName('ダンジョン用')) === 5 && roomMsg.includes('コマが見つからなかった'), { msg: roomMsg });
    await shot('zip-import');

    // ── 7. スポーン→右クリック→ピッカー ──
    const spawned = await dsvc(`(function(){ const col = c.dictionary.collections.find(x => x.name === 'ダンジョン用'); const e = c.dictionary.entriesOfCharacters(col.id).find(x => x.name === '${APP_NAME}'); const ch = c.dictionary.spawnCharacter(e, { x: 2, y: 2, z: 0 }); return ch ? ch.name : null; })()`);
    ok('辞書からコマをスポーンできる', spawned === APP_NAME, { spawned });
    await closeDictPanel();
    let pt = null;
    for (let i = 0; i < 20 && !pt; i++) { await pause(400); pt = await pointOn(`h.textContent.includes('${APP_NAME}')`); }
    ok('スポーンしたコマのクリック点がある', !!pt, pt);
    await dismissErrorModals();
    await rightClick(pt.x, pt.y);
    const items1 = await menuItems();
    ok('コマ右クリックに「辞書に登録」がある', Array.isArray(items1) && items1.includes('辞書に登録'), { items: items1 });
    await js(`(() => { const lis = Array.from(document.querySelectorAll('context-menu li')).filter(li => li.textContent.includes('辞書に登録')); if (!lis.length) return 0; lis[lis.length - 1].click(); return 1; })()`);
    for (let i = 0; i < 15 && !await pickerOpen(); i++) await pause(300);
    ok('登録先を選ぶピッカーが開く', await pickerOpen(), {});
    const checked1 = await pickerCheckedName();
    ok('初期選択は最初のコマ辞書', checked1 === 'コマ辞書', { checked: checked1 });

    // ── 8. ピッカーでコマ辞書へ登録 ──
    ok('ピッカーで登録先を選べる', await pickerSelectByName('コマ辞書') === 1, {});
    await pickerRegister();
    for (let i = 0; i < 12 && !await pickerMessage(); i++) await pause(300);
    const msg1 = await pickerMessage();
    ok('メッセージに登録先の辞書名が出る', msg1.includes('辞書「コマ辞書」に登録'), { msg: msg1 });
    await waitPickerClosed();
    ok('ピッカーは自動で閉じる', !(await pickerOpen()), {});
    await openDictPanel();
    const cntDefault1 = await countByName('コマ辞書');
    ok('選んだ辞書(コマ辞書)に1件入る', cntDefault1 === 1 && (await countByName('ダンジョン用')) === 5, { cntDefault1, dun: await countByName('ダンジョン用') });
    await shot('picker-registered');

    // ── 9. 検索(コマ): 名前・タグ・無一致 ──
    await selectDictByName('ダンジョン用');
    await pause(400);
    ok('検索で1件に絞り込める', await setSearch('NCスライム' + stamp) === 1 && (await domCount('dictionary-panel .char-grid .char-card')) === 1, { cnt: await domCount('dictionary-panel .char-grid .char-card') });
    ok('検索無一致は0件＋専用メッセージ', await setSearch('存在しない語' + stamp) === 1 && (await domCount('dictionary-panel .char-grid .char-card')) === 0 && (await js(`(() => { const e = document.querySelector('dictionary-panel .empty'); return e ? e.textContent.trim() : ''; })()`)).includes('一致するコマは無い'), {});
    await setSearch('');
    await dsvcA(`(async function(){ const col = c.dictionary.collections.find(x => x.name === 'ダンジョン用'); const e = c.dictionary.entriesOfCharacters(col.id).find(x => x.name === '${APP_NAME}'); e.tags = ['火属性']; await c.dictionary.saveCharacter(e); return 1; })()`);
    await pause(400);
    ok('タグでも検索できる', await setSearch('火属性') === 1 && (await domCount('dictionary-panel .char-grid .char-card')) === 1, { cnt: await domCount('dictionary-panel .char-grid .char-card') });
    await setSearch('');
    ok('検索クリアで全件表示', (await domCount('dictionary-panel .char-grid .char-card')) === 5, { cnt: await domCount('dictionary-panel .char-grid .char-card') });

    // ── 10. 検索(チャパレ・資料) ──
    await dsvcA(`(async function(){ const pc = c.dictionary.collections.find(x => x.name === 'チャパレ辞書'); await c.dictionary.savePalette({ id: 'DPAL' + Date.now(), dictId: pc.id, name: '火力チャパレ', dicebot: 'DiceBot', text: 'CCB<= ({SV}+甲)*2 //${PAL_TOKEN}', tags: ['火力'], createdAt: Date.now() }); const mc = c.dictionary.collections.find(x => x.name === '資料辞書'); await c.dictionary.saveMaterial({ id: 'DMAT' + Date.now(), dictId: mc.id, title: '世界設定', pages: [{ id: 'DPG' + Date.now(), type: 'text', title: '王都について', text: '${MAT_TOKEN} の内容です' }], createdAt: Date.now() }); return 1; })()`);
    await pause(400);
    await selectDictByName('チャパレ辞書');
    await pause(400);
    ok('チャパレの中身で検索できる', await setSearch(PAL_TOKEN) === 1 && (await domCount('dictionary-panel .palette-layout .palette-list .section-row')) === 1, { cnt: await domCount('dictionary-panel .palette-layout .palette-list .section-row') });
    await selectDictByName('資料辞書');
    await pause(400);
    ok('資料のページ本文で検索できる', await setSearch(MAT_TOKEN) === 1 && (await domCount('dictionary-panel .material-sections .section-row')) === 1, { cnt: await domCount('dictionary-panel .material-sections .section-row') });
    await setSearch('');
    await shot('search');

    // ── 11. チャパレD&D → コマへ追記 ──
    await selectDictByName('チャパレ辞書');
    await pause(400);
    const drag1 = await js(`(function(){
      const row = document.querySelector('dictionary-panel .palette-layout .palette-list .section-row[draggable="true"]');
      const hosts = Array.from(document.querySelectorAll('game-character')).filter(h => h.textContent.includes('${APP_NAME}'));
      if (!row || !hosts.length) return { err: 'row=' + !!row + ' host=' + hosts.length };
      const dt = new DataTransfer();
      row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      const dragId = dt.getData('text/lycoris-dict-palette');
      if (!dragId) return { err: 'dragId empty' };
      const host = hosts[0];
      host.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      host.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return { dragId: dragId };
    })()`);
    ok('チャパレ行のドラッグでIDが運ばれる', !!drag1 && !!drag1.dragId, drag1);
    const pv1 = await paletteValueOf(`h.textContent.includes('${APP_NAME}')`);
    ok('ドロップでコマのチャパレに入る', typeof pv1 === 'string' && pv1.includes(PAL_TOKEN), { pv1 });
    await js(`(function(){
      const row = document.querySelector('dictionary-panel .palette-layout .palette-list .section-row[draggable="true"]');
      const host = Array.from(document.querySelectorAll('game-character')).find(h => h.textContent.includes('${APP_NAME}'));
      const dt = new DataTransfer();
      row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      host.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      host.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return 1;
    })()`);
    const pv2 = await paletteValueOf(`h.textContent.includes('${APP_NAME}')`);
    const occur = typeof pv2 === 'string' ? pv2.split(PAL_TOKEN).length - 1 : 0;
    ok('2回目のドロップは追記（置換じゃない）', occur === 2, { occur, pv2: typeof pv2 === 'string' ? pv2.slice(0, 120) : pv2 });
    await shot('dnd-palette');

    const real = consoleErrors.filter(e => !/skyWay onFatalError/.test(e));
    ok('ページエラー0件（SkyWay接続系を除く）', real.length === 0, { total: consoleErrors.length, real: real.length, sample: real.slice(0, 3) });
    console.log('done:', prefix);
  } finally {
    try { ws.close(); } catch (e) { }
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
