// 症状特定: 辞書に登録されたコマの画像が「反映されない」経路を実機で特定する
// 1) ZIP取込→エントリimages  2) カードimg表示  3) スポーン→卓コマ画像  4) リロード後の復元  5) 右クリック登録のimages
// 使い方: node tools/verify-img.cjs <url> <prefix> [assert]
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const WS = require('/home/maco/.openclaw/workspace/projects/udonarium-lycoris/node_modules/ws');
const JSZip = require('/home/maco/.openclaw/workspace/projects/udonarium-lycoris/node_modules/jszip');

const appUrl = process.argv[2] || 'http://127.0.0.1:14289/';
const prefix = process.argv[3] || 'img';
const doAssert = process.argv[4] === 'assert';
const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:19368';
const OUT_DIR = '/home/maco/.openclaw/workspace/projects/udonarium-lycoris/tmp/imgcheck-20261007';
fs.mkdirSync(OUT_DIR, { recursive: true });

// おれおん提供の実物ZIP（データ要素形式: <data type="image" name="imageIdentifier">）
const REAL_ION_SRC = '/home/maco/.openclaw/workspace/media/inbound/openclaw-staged-fd143e03-f9f1-4dd2-8bb6-baebb4254493/input-xml_2026-09-21_0316---a9e886b7-e2bf-408d-8873-aea0564526f4.zip';
const REAL_HOTO_SRC = '/home/maco/.openclaw/workspace/media/inbound/openclaw-staged-fd143e03-f9f1-4dd2-8bb6-baebb4254493/input-xml_2026-09-06_1933---ec76f2f2-c62e-4172-a949-2db47c910f90.zip';
const realIonZipPath = path.join(OUT_DIR, 'real-ion.zip');
const realHotoZipPath = path.join(OUT_DIR, 'real-hoto.zip');
const hasRealIon = fs.existsSync(REAL_ION_SRC);
const hasRealHoto = fs.existsSync(REAL_HOTO_SRC);
if (hasRealIon) fs.copyFileSync(REAL_ION_SRC, realIonZipPath);
if (hasRealHoto) fs.copyFileSync(REAL_HOTO_SRC, realHotoZipPath);

assert(/^http:\/\/(127\.0\.0\.1|localhost):\d+\/$/.test(appUrl), 'isolated local URL only: ' + appUrl);

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const pngBuf = Buffer.from(PNG_B64, 'base64');
const stamp = Date.now() % 100000;
const NAME = '画像スライム' + stamp;
const IMG_ID = 'imgchk-' + stamp;

const charXml = `<character name="${NAME}" location.x="0" location.y="0" size="1" imageIdentifier="${IMG_ID}"><data name="HP" type="numberResource" currentValue="15">15</data></character>`;
// 不一致構造（キャラ作成サイト系を想定）: name属性なし＋共通データ要素(name)にキャラ名＋imageIdentifierがZIP内画像ファイル名と不一致
const ND_NAME = 'データ名スライム' + stamp;
const DIFF_IMG_ID = 'diff-img-' + stamp;
const charXmlDiff = `<character location.x="0" location.y="0" size="1" imageIdentifier="${DIFF_IMG_ID}"><data name="name">${ND_NAME}</data><data name="HP" type="numberResource" currentValue="15">15</data></character>`;
// imageIdentifier無し＋画像1枚（注入対象）
const NOIMG_NAME = '無識別スライム' + stamp;
const charXmlNoImg = `<character name="${NOIMG_NAME}" location.x="0" location.y="0" size="1"><data name="HP" type="numberResource" currentValue="15">15</data></character>`;
// 重複ガード補完の再現用（画像なしで登録済み→再取込で補完）
const DUP_NAME = '補完スライム' + stamp;
const DUP_IMG_ID = 'dup-img-' + stamp;
const charXmlDup = `<character name="${DUP_NAME}" location.x="0" location.y="0" size="1" imageIdentifier="${DUP_IMG_ID}"><data name="HP" type="numberResource" currentValue="15">15</data></character>`;

const pause = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const zip = new JSZip();
  zip.file('data.xml', charXml);
  zip.file(`${IMG_ID}.png`, pngBuf);
  zip.file('imagetag.xml', '<?xml version="1.0"?><imagetag></imagetag>');
  const zipPath = path.join(OUT_DIR, 'img-char.zip');
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: 'nodebuffer' }));

  const diffZip = new JSZip();
  diffZip.file('data.xml', charXmlDiff);
  diffZip.file('photo.png', pngBuf); // ファイル名はDIFF_IMG_IDと不一致
  const diffZipPath = path.join(OUT_DIR, 'diff-structure.zip');
  fs.writeFileSync(diffZipPath, await diffZip.generateAsync({ type: 'nodebuffer' }));

  const noimgZip = new JSZip();
  noimgZip.file('data.xml', charXmlNoImg); // imageIdentifier属性なし
  noimgZip.file('picture.png', pngBuf);
  const noimgZipPath = path.join(OUT_DIR, 'no-imageid.zip');
  fs.writeFileSync(noimgZipPath, await noimgZip.generateAsync({ type: 'nodebuffer' }));

  const dupZip = new JSZip();
  dupZip.file('data.xml', charXmlDup);
  dupZip.file('other.png', pngBuf); // ファイル名はDUP_IMG_IDと不一致
  const dupZipPath = path.join(OUT_DIR, 'dup-enrich.zip');
  fs.writeFileSync(dupZipPath, await dupZip.generateAsync({ type: 'nodebuffer' }));

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
  const pickerOpen = () => js(`(() => { const p = document.querySelector('dict-picker'); return !!p; })()`);
  const pickerRegister = () => js(`(function(){ const p = document.querySelector('dict-picker'); if (!p) return 0; const b = Array.from(p.querySelectorAll('button')).find(x => x.textContent.trim() === '登録' && !x.disabled); if (!b) return 0; b.click(); return 1; })()`);
  const waitPickerClosed = async () => { for (let i = 0; i < 15 && await pickerOpen(); i++) await pause(300); };
  const entryInfo = () => dsvc(`(function(){ const col = c.dictionary.collections.find(x => x.name === 'コマ辞書'); const e = c.dictionary.entriesOfCharacters(col.id).find(x => x.name === '${NAME}'); if (!e) return null; return { name: e.name, imgs: e.images.length, url0: e.images.length ? String(e.images[0].url).slice(0, 30) : '' }; })()`);
  const entryInfoDiff = () => dsvc(`(function(){ const col = c.dictionary.collections.find(x => x.name === 'コマ辞書'); const e = c.dictionary.entriesOfCharacters(col.id).find(x => x.name === '${ND_NAME}'); if (!e) return null; return { name: e.name, imgs: e.images.length, url0: e.images.length ? String(e.images[0].url).slice(0, 30) : '' }; })()`);
  const entryInfoNoImg = () => dsvc(`(function(){ const col = c.dictionary.collections.find(x => x.name === 'コマ辞書'); const e = c.dictionary.entriesOfCharacters(col.id).find(x => x.name === '${NOIMG_NAME}'); if (!e) return null; return { name: e.name, imgs: e.images.length, url0: e.images.length ? String(e.images[0].url).slice(0, 30) : '' }; })()`);
  const entryInfoDup = () => dsvc(`(function(){ const col = c.dictionary.collections.find(x => x.name === 'コマ辞書'); const e = c.dictionary.entriesOfCharacters(col.id).find(x => x.name === '${DUP_NAME}'); if (!e) return null; return { name: e.name, imgs: e.images.length, url0: e.images.length ? String(e.images[0].url).slice(0, 30) : '' }; })()`);
  const entryInfoIon = () => dsvc(`(function(){ const col = c.dictionary.collections.find(x => x.name === 'コマ辞書'); const e = c.dictionary.entriesOfCharacters(col.id).find(x => x.name === 'イオン'); if (!e) return null; return { name: e.name, imgs: e.images.length, url0: e.images.length ? String(e.images[0].url).slice(0, 30) : '' }; })()`);
  const entryInfoHoto = () => dsvc(`(function(){ const col = c.dictionary.collections.find(x => x.name === 'コマ辞書'); const e = c.dictionary.entriesOfCharacters(col.id).find(x => x.name === 'ホ・トゥーケ'); if (!e) return null; return { name: e.name, imgs: e.images.length, url0: e.images.length ? String(e.images[0].url).slice(0, 30) : '' }; })()`);
  const cardImgInfo = match => js(`(() => {
    const cards = Array.from(document.querySelectorAll('dictionary-panel .char-grid .char-card'));
    const card = cards.find(el => el.textContent.includes('${match}'));
    if (!card) return { found: false };
    const img = card.querySelector('img.char-thumb');
    return { found: true, hasImg: !!img, src0: img ? String(img.getAttribute('src')).slice(0, 30) : '', nw: img ? img.naturalWidth : -1, complete: img ? img.complete : null };
  })()`);
  const boardImgInfo = match => js(`(() => {
    const hosts = Array.from(document.querySelectorAll('game-character')).filter(h => h.textContent.includes('${match}'));
    if (!hosts.length) return { found: false };
    const host = hosts[0];
    const imgs = Array.from(host.querySelectorAll('img.image, img.flat-character-image'));
    const visible = imgs.filter(i => i.offsetParent !== null || getComputedStyle(i).display !== 'none');
    const img = visible[0] || imgs[0];
    return { found: true, imgCount: imgs.length, hasImg: !!img, src0: img ? String(img.getAttribute('src')).slice(0, 30) : '', nw: img ? img.naturalWidth : -1 };
  })()`);

  try {
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: appUrl });
    for (let i = 0; i < 60 && !await js(`(() => Array.from(document.querySelectorAll('li')).some(li => li.textContent.trim().endsWith('辞書') && li.offsetParent !== null))()`); i++) await pause(500);
    await pause(1500);
    await dismissErrorModals();
    await js(`(() => { const s = document.createElement('style'); s.textContent = 'modal:not(:has(dict-picker)), .modal-background:not(:has(dict-picker)) { display: none !important; }'; document.head.appendChild(s); const ps = document.querySelectorAll('.draggable-panel'); ps.forEach(p => { if (!p.innerText.includes('メニュー')) p.style.display = 'none'; }); return 1; })()`);

    // ── 1. ZIP取り込み → エントリのimages ──
    await openDictPanel();
    await setFileInput('dictionary-panel .dict-actions input[type="file"]', zipPath, async () => !!await entryInfo());
    for (let i = 0; i < 12 && !await entryInfo(); i++) await pause(300);
    const info1 = await entryInfo();
    ok('ZIP取込でエントリに画像が入る', !!info1 && info1.imgs >= 1 && info1.url0.startsWith('data:'), info1);

    // ── 1b. 不一致構造ZIP（name属性なし＋data[name="name"]＋imageIdentifier≠ファイル名） ──
    await setFileInput('dictionary-panel .dict-actions input[type="file"]', diffZipPath, async () => !!await entryInfoDiff());
    for (let i = 0; i < 12 && !await entryInfoDiff(); i++) await pause(300);
    const infoD = await entryInfoDiff();
    ok('不一致ZIPはデータ要素の名前で登録される', !!infoD && infoD.name === ND_NAME, infoD);
    ok('不一致ZIPの画像がimageIdentifierに紐付く', !!infoD && infoD.imgs >= 1 && infoD.url0.startsWith('data:'), infoD);
    const cardD = await cardImgInfo(ND_NAME);
    ok('不一致ZIPのコマもカードに画像が出る', !!cardD && cardD.found === true && cardD.hasImg === true && cardD.nw > 0, cardD);
    await shot('diff-structure');

    // ── 2. カードのサムネイル表示 ──
    const card1 = await cardImgInfo(NAME);
    ok('辞書カードのimg要素がdataURLを参照する', !!card1 && card1.hasImg === true && (card1.src0 || '').startsWith('data:'), card1);
    ok('カードimgは実際にレンダリングされる(naturalWidth>0)', !!card1 && card1.nw > 0, card1);
    await shot('card-thumb');

    // ── 3. スポーン（不一致構造のコマ） → 卓コマの画像 ──
    await dsvc(`(function(){ const col = c.dictionary.collections.find(x => x.name === 'コマ辞書'); const e = c.dictionary.entriesOfCharacters(col.id).find(x => x.name === '${ND_NAME}'); const ch = c.dictionary.spawnCharacter(e, { x: 2, y: 2, z: 0 }); return ch ? ch.name : null; })()`);
    await closeDictPanel();
    let pt = null;
    for (let i = 0; i < 20 && !pt; i++) { await pause(400); pt = await pointOn(`h.textContent.includes('${ND_NAME}')`); }
    ok('スポーンしたコマがある', !!pt, pt);
    const board1 = await boardImgInfo(ND_NAME);
    ok('卓コマのimgがdataURLを参照する', !!board1 && board1.hasImg === true && (board1.src0 || '').startsWith('data:'), board1);
    ok('卓コマのimgはレンダリングされる(naturalWidth>0)', !!board1 && board1.nw > 0, board1);
    await shot('board-spawn');

    // ── 4. 右クリック「辞書に登録」→ 新エントリのimages ──
    await dismissErrorModals();
    await rightClick(pt.x, pt.y);
    await js(`(() => { const lis = Array.from(document.querySelectorAll('context-menu li')).filter(li => li.textContent.includes('辞書に登録')); if (!lis.length) return 0; lis[lis.length - 1].click(); return 1; })()`);
    for (let i = 0; i < 15 && !await pickerOpen(); i++) await pause(300);
    ok('ピッカーが開く', await pickerOpen(), {});
    await pickerRegister();
    await waitPickerClosed();
    await openDictPanel();
    const beforeDup = await entryInfoDiff();
    ok('右クリック登録で画像も入る（重複ガードで同一エントリ）', !!beforeDup && beforeDup.imgs >= 1 && beforeDup.url0.startsWith('data:'), beforeDup);

    // ── 5. リロード → IndexedDB復元 → カード表示 ──
    await call('Page.navigate', { url: appUrl });
    for (let i = 0; i < 60 && !await js(`(() => Array.from(document.querySelectorAll('li')).some(li => li.textContent.trim().endsWith('辞書') && li.offsetParent !== null))()`); i++) await pause(500);
    await pause(1500);
    await dismissErrorModals();
    await js(`(() => { const s = document.createElement('style'); s.textContent = 'modal:not(:has(dict-picker)), .modal-background:not(:has(dict-picker)) { display: none !important; }'; document.head.appendChild(s); const ps = document.querySelectorAll('.draggable-panel'); ps.forEach(p => { if (!p.innerText.includes('メニュー')) p.style.display = 'none'; }); return 1; })()`);
    await openDictPanel();
    const info2 = await entryInfoDiff();
    ok('リロード後もエントリの画像は生きている', !!info2 && info2.imgs >= 1 && info2.url0.startsWith('data:'), info2);
    const card2 = await cardImgInfo(ND_NAME);
    ok('リロード後もカードimgはレンダリングされる', !!card2 && card2.hasImg === true && card2.nw > 0, card2);
    await shot('after-reload');

    // ── 6b. 重複ガード補完: 画像なしで登録済みのエントリが再取り込みで補完される ──
    const dupCountBefore = await dsvc(`(function(){ const col = c.dictionary.collections.find(x => x.name === 'コマ辞書'); return c.dictionary.countOf('characters', col.id); })()`);
    await dsvcA(`(async function(){ const col = c.dictionary.collections.find(x => x.name === 'コマ辞書'); await c.dictionary.registerCharacterXml('${charXmlDup}', 'data', col.id); return 1; })()`);
    const dupBroken = await entryInfoDup();
    ok('画像なしエントリを直接登録できる（旧データ再現）', !!dupBroken && dupBroken.imgs === 0, dupBroken);
    await setFileInput('dictionary-panel .dict-actions input[type="file"]', dupZipPath, async () => { const e = await entryInfoDup(); return !!e && e.imgs >= 1; });
    for (let i = 0; i < 12; i++) { const e = await entryInfoDup(); if (e && e.imgs >= 1) break; await pause(300); }
    const dupAfter = await entryInfoDup();
    ok('再取り込みで既存エントリに画像が補完される', !!dupAfter && dupAfter.imgs >= 1, dupAfter);
    const dupCountAfter = await dsvc(`(function(){ const col = c.dictionary.collections.find(x => x.name === 'コマ辞書'); return c.dictionary.countOf('characters', col.id); })()`);
    ok('補完時はエントリが増えない（重複ガード）', dupCountAfter === dupCountBefore + 1, { before: dupCountBefore, after: dupCountAfter });
    await shot('dup-enrich');

    // ── 6c. imageIdentifier無し＋画像1枚 → 自動注入で紐付け ──
    await setFileInput('dictionary-panel .dict-actions input[type="file"]', noimgZipPath, async () => !!await entryInfoNoImg());
    for (let i = 0; i < 12 && !await entryInfoNoImg(); i++) await pause(300);
    const infoN = await entryInfoNoImg();
    ok('imageIdentifier無しZIPは画像1枚を自動紐付け', !!infoN && infoN.imgs >= 1 && infoN.url0.startsWith('data:'), infoN);
    const cardN = await cardImgInfo(NOIMG_NAME);
    ok('無識別コマもカードに画像が出る', !!cardN && cardN.found === true && cardN.hasImg === true && cardN.nw > 0, cardN);
    await dsvc(`(function(){ const col = c.dictionary.collections.find(x => x.name === 'コマ辞書'); const e = c.dictionary.entriesOfCharacters(col.id).find(x => x.name === '${NOIMG_NAME}'); const ch = c.dictionary.spawnCharacter(e, { x: 3, y: 3, z: 0 }); return ch ? ch.name : null; })()`);
    await closeDictPanel();
    let ptN = null;
    for (let i = 0; i < 20 && !ptN; i++) { await pause(400); ptN = await pointOn(`h.textContent.includes('${NOIMG_NAME}')`); }
    ok('無識別コマのスポーンがある', !!ptN, ptN);
    const boardN = await boardImgInfo(NOIMG_NAME);
    ok('無識別コマの卓imgもレンダリングされる', !!boardN && boardN.hasImg === true && boardN.nw > 0, boardN);
    await shot('noimg-inject');

    // ── 6d. 実物ZIP（イオン: 画像6枚・データ要素形式のimageIdentifier） ──
    if (hasRealIon) {
      await openDictPanel();
      await setFileInput('dictionary-panel .dict-actions input[type="file"]', realIonZipPath, async () => !!await entryInfoIon());
      for (let i = 0; i < 15 && !await entryInfoIon(); i++) await pause(400);
      const infoI = await entryInfoIon();
      ok('実物ZIP(イオン)がキャラ名で登録される', !!infoI && infoI.name === 'イオン', infoI);
      ok('実物ZIP(イオン)は6枚の画像が紐付く', !!infoI && infoI.imgs >= 6, infoI);
      const cardI = await cardImgInfo('イオン');
      ok('実物(イオン)のカードに画像が出る', !!cardI && cardI.found === true && cardI.hasImg === true && cardI.nw > 0, cardI);
      await dsvc(`(function(){ const col = c.dictionary.collections.find(x => x.name === 'コマ辞書'); const e = c.dictionary.entriesOfCharacters(col.id).find(x => x.name === 'イオン'); const ch = c.dictionary.spawnCharacter(e, { x: 4, y: 2, z: 0 }); return ch ? ch.name : null; })()`);
      await closeDictPanel();
      let ptI = null;
      for (let i = 0; i < 20 && !ptI; i++) { await pause(400); ptI = await pointOn(`h.textContent.includes('イオン')`); }
      ok('実物(イオン)のスポーンがある', !!ptI, ptI);
      const boardI = await boardImgInfo('イオン');
      ok('実物(イオン)の卓imgもレンダリングされる', !!boardI && boardI.hasImg === true && boardI.nw > 0, boardI);
      await shot('real-ion');
    } else {
      console.log('SKIP  実物ZIP(イオン)  ファイル無し');
    }

    // ── 6e. 実物ZIP（ホ・トゥーケ: 画像1枚・回帰） ──
    if (hasRealHoto) {
      await openDictPanel();
      await setFileInput('dictionary-panel .dict-actions input[type="file"]', realHotoZipPath, async () => !!await entryInfoHoto());
      for (let i = 0; i < 15 && !await entryInfoHoto(); i++) await pause(400);
      const infoH = await entryInfoHoto();
      ok('実物ZIP(ホ・トゥーケ)も画像が紐付く（回帰）', !!infoH && infoH.imgs >= 1 && infoH.url0.startsWith('data:'), infoH);
      await shot('real-hoto');
    } else {
      console.log('SKIP  実物ZIP(ホ・トゥーケ)  ファイル無し');
    }

    const real = consoleErrors.filter(e => !/skyWay onFatalError/.test(e));
    ok('ページエラー0件（SkyWay接続系を除く）', real.length === 0, { total: consoleErrors.length, real: real.length, sample: real.slice(0, 3) });
    console.log('done:', prefix);
  } finally {
    try { ws.close(); } catch (e) { }
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
