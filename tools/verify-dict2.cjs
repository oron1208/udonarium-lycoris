// 辞書機能拡張(ZIP取込/盤面→辞書登録/ミニプレイヤー選択)のE2E検証
// 使い方: node tools/verify-dict2.cjs <url> <prefix> [assert]
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const WS = require('/home/maco/.openclaw/workspace/projects/udonarium-lycoris/node_modules/ws');
const JSZip = require('/home/maco/.openclaw/workspace/projects/udonarium-lycoris/node_modules/jszip');

const appUrl = process.argv[2] || 'http://127.0.0.1:14289/';
const prefix = process.argv[3] || 'd2';
const doAssert = process.argv[4] === 'assert';
const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:19368';
const OUT_DIR = '/home/maco/.openclaw/workspace/projects/udonarium-lycoris/tmp/dict2-20261006';
fs.mkdirSync(OUT_DIR, { recursive: true });

assert(/^http:\/\/(127\.0\.0\.1|localhost):\d+\/$/.test(appUrl), 'isolated local URL only: ' + appUrl);

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const stamp = Date.now() % 100000;
const CHAR_NAME = 'ZIPスライム' + stamp;
const ZIP_XML = `<character name="${CHAR_NAME}" location.x="0" location.y="0" size="1" imageIdentifier="img-zip-${stamp}"><data name="HP" type="numberResource" currentValue="15">15</data></character>`;

function makeWav(freq, seconds, rate = 8000) {
  const n = rate * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / rate) * 12000), 44 + i * 2);
  return buf;
}

const pause = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // ── テストアセット ──
  const zip = new JSZip();
  zip.file('character.xml', ZIP_XML);
  zip.file(`img-zip-${stamp}.png`, Buffer.from(PNG_B64, 'base64'));
  const zipPath = path.join(OUT_DIR, 'test-character.zip');
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: 'nodebuffer' }));
  const wavPath = path.join(OUT_DIR, 'test-tone.wav');
  fs.writeFileSync(wavPath, makeWav(440, 1));

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
  // 辞書サービス式（ng=getComponent経由のprivate直読み）
  const dsvc = expr => js(`(() => { const el = document.querySelector('dictionary-panel'); const c = el && window.ng.getComponent(el); return c ? (${expr}) : null; })()`);
  const msvc = expr => js(`(() => { const el = document.querySelector('app-mini-player'); const c = el && window.ng.getComponent(el); return c ? (${expr}) : null; })()`);
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

  try {
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: appUrl });
    // メニューの「辞書」liが表示されるまで待つ（dev初回ロードは重い）
    for (let i = 0; i < 60 && !await js(`(() => Array.from(document.querySelectorAll('li')).some(li => li.textContent.trim().endsWith('辞書') && li.offsetParent !== null))()`); i++) await pause(500);
    await pause(1500);
    await closeOverlays();
    // 隔離環境のSkyWayエラーモーダルとチャット窓の被りを排除（メニューバーは.drachable-panelなので隠さない）
    await js(`(() => { const s = document.createElement('style'); s.textContent = '.modal-background, modal { display: none !important; }'; document.head.appendChild(s); const ps = document.querySelectorAll('.draggable-panel'); ps.forEach(p => { if (!p.innerText.includes('メニュー')) p.style.display = 'none'; }); return 1; })()`);

    // ── 辞書パネルを開く ──
    await js(`(() => { const lis = Array.from(document.querySelectorAll('li')).filter(li => li.textContent.trim().endsWith('辞書') && li.offsetParent !== null); const li = lis[lis.length - 1]; if (li) li.click(); return !!li; })()`);
    for (let i = 0; i < 20 && !await js(`!!document.querySelector('dictionary-panel')`); i++) await pause(300);
    ok('辞書パネルが開く', await js(`!!document.querySelector('dictionary-panel')`), '');
    const base = await dsvc(`c.dictionary.characters.length`);
    ok('コマ辞書の初期件数を取る', typeof base === 'number', { base });

    // ── 1. ZIP取込 ──
    await setFileInput('dictionary-panel .dict-actions input[type="file"]', zipPath, async () => (await dsvc(`c.dictionary.characters.length`)) > base);
    for (let i = 0; i < 10 && (await dsvc(`c.dictionary.characters.length`)) <= base; i++) await pause(300);
    const afterZip = await dsvc(`c.dictionary.characters.length`);
    ok('ZIP読み込みでコマ辞書に1件登録', afterZip === base + 1, { base, afterZip });
    const zipEntry = await dsvc(`(() => { const e = c.dictionary.characters.find(x => x.name === '${CHAR_NAME}'); return e ? { name: e.name, imgs: e.images.length, imgId: e.images.length ? e.images[0].identifier : '' } : null; })()`);
    ok('ZIPの名前・画像が辞書に入る', !!zipEntry && zipEntry.imgs >= 1, zipEntry);

    // ── 2. 盤面へ出す → 右クリック「辞書に登録」 ──
    const spawned = await dsvc(`(() => { const e = c.dictionary.characters.find(x => x.name === '${CHAR_NAME}'); const ch = c.dictionary.spawnCharacter(e, { x: 2, y: 2, z: 0 }); return ch ? ch.name : null; })()`);
    ok('辞書からコマをスポーンできる', spawned === CHAR_NAME, { spawned });
    // パネルが卓の上に被るので一度閉じる（確認時に開き直す）
    await js(`(() => { const dp = document.querySelector('dictionary-panel'); if (!dp) return 0; const panel = dp.closest('.draggable-panel'); const btn = panel ? Array.from(panel.querySelectorAll('button')).find(b => (b.textContent || '').includes('close')) : null; if (btn) btn.click(); return panel ? 1 : 0; })()`);
    for (let i = 0; i < 10 && await js(`!!document.querySelector('dictionary-panel')`); i++) await pause(300);
    let pt = null;
    for (let i = 0; i < 20 && !pt; i++) { await pause(400); pt = await pointOn(`h.textContent.includes('${CHAR_NAME}')`); }
    ok('スポーンしたコマのクリック点がある', !!pt, pt);
    await rightClick(pt.x, pt.y);
    const items1 = await menuItems();
    ok('コマ右クリックに「辞書に登録」がある', Array.isArray(items1) && items1.includes('辞書に登録'), { items: items1 });
    await js(`(() => { const lis = Array.from(document.querySelectorAll('context-menu li')).filter(li => li.textContent.includes('辞書に登録')); if (!lis.length) return 0; lis[lis.length - 1].click(); return 1; })()`);
    // パネルを開き直して登録を確認
    await js(`(() => { const lis = Array.from(document.querySelectorAll('li')).filter(li => li.textContent.trim().endsWith('辞書') && li.offsetParent !== null); const li = lis[lis.length - 1]; if (li) li.click(); return !!li; })()`);
    for (let i = 0; i < 20 && !await js(`!!document.querySelector('dictionary-panel')`); i++) await pause(300);
    for (let i = 0; i < 12 && (await dsvc(`c.dictionary.characters.length`)) <= afterZip; i++) await pause(300);
    const afterReg = await dsvc(`c.dictionary.characters.length`);
    ok('盤面のコマが辞書に新規登録される', afterReg === afterZip + 1, { afterZip, afterReg });
    const regEntry = await dsvc(`(() => { const e = c.dictionary.characters[c.dictionary.characters.length - 1]; return { name: e.name, imgs: e.images.length }; })()`);
    ok('登録されたエントリの内容', !!regEntry && regEntry.name === CHAR_NAME && regEntry.imgs >= 1, regEntry);
    await shot('board-to-dict');

    // ── 3. ミニプレイヤー（WAVアップロード→選択で再生状態になる） ──
    await js(`(() => { const lis = Array.from(document.querySelectorAll('li')).filter(li => li.textContent.trim().endsWith('音楽') && li.offsetParent !== null); const li = lis[lis.length - 1]; if (li) li.click(); return li ? li.textContent.trim() : null; })()`);
    for (let i = 0; i < 20 && !await js(`!!document.querySelector('app-jukebox')`); i++) await pause(300);
    ok('ジュークボックスパネルが開く', await js(`!!document.querySelector('app-jukebox')`), '');
    await setFileInput('app-jukebox input[type="file"]', wavPath, async () => (await msvc(`c.trackList.length`)) >= 1);
    for (let i = 0; i < 12 && (await msvc(`c.trackList.length`)) < 1; i++) await pause(300);
    const tracks = await msvc(`c.trackList`);
    ok('ミニプレイヤーの楽曲一覧に曲がある', Array.isArray(tracks) && tracks.length >= 1, tracks);
    const firstReady = await msvc(`c.trackList.length ? c.trackList[0].ready : null`);
    ok('リストの曲が再生可能(ready)状態', firstReady === true, { firstReady });
    const targetId = await msvc(`c.trackList.length ? c.trackList[0].identifier : null`);
    await msvc(`(function(){ c.open(); c.toggleTrackList(); return 1; })()`);
    for (let i = 0; i < 10 && !await js(`!!document.querySelector('.mp-track-item')`); i++) await pause(300);
    await js(`(() => { const it = document.querySelector('.mp-track-item'); if (it) it.click(); return !!it; })()`);
    await pause(900);
    const playingId = await msvc(`c.jukebox ? c.jukebox.audioIdentifier : null`);
    const isPlaying = await msvc(`c.jukebox ? c.jukebox.isPlaying : null`);
    ok('楽曲を選択して再生状態になる', playingId === targetId && isPlaying === true, { targetId, playingId, isPlaying });
    await shot('mini-player-playing');

    const real = consoleErrors.filter(e => !/skyWay onFatalError/.test(e));
    ok('ページエラー0件（SkyWay接続系を除く）', real.length === 0, { total: consoleErrors.length, real: real.length, sample: real.slice(0, 3) });
    console.log('done:', prefix);
  } finally {
    try { ws.close(); } catch (e) { }
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
