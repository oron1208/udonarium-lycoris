// 修正検証: テーブルBGM再生中にミニプレイヤーで曲を選ぶと jukebox に切り替わる（従来はテーブルBGMが勝ち続けて選択不可に見えた）
// 使い方: node tools/verify-miniplayer.cjs <url> <prefix> [assert]
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const WS = require('/home/maco/.openclaw/workspace/projects/udonarium-lycoris/node_modules/ws');

const appUrl = process.argv[2] || 'http://127.0.0.1:14289/';
const prefix = process.argv[3] || 'mp';
const doAssert = process.argv[4] === 'assert';
const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:19368';
const OUT_DIR = '/home/maco/.openclaw/workspace/projects/udonarium-lycoris/tmp/miniplayer-20261006';
fs.mkdirSync(OUT_DIR, { recursive: true });

assert(/^http:\/\/(127\.0\.0\.1|localhost):\d+\/$/.test(appUrl), 'isolated local URL only: ' + appUrl);

function makeWav(freq, seconds, rate = 8000) {
  const n = Math.floor(rate * seconds);
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
  // ── テストアセット: 周波数違い2曲 ──
  const wavAPath = path.join(OUT_DIR, 'bgmA-tone.wav');
  const wavBPath = path.join(OUT_DIR, 'bgmB-tone.wav');
  fs.writeFileSync(wavAPath, makeWav(440, 1));
  fs.writeFileSync(wavBPath, makeWav(880, 1));

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
  const msvc = expr => js(`(() => { const el = document.querySelector('app-mini-player'); const c = el && window.ng.getComponent(el); return c ? (${expr}) : null; })()`);
  const setFileInput = async (selector, filePaths, waitForExpr) => {
    const doc = await call('DOM.getDocument');
    const node = await call('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    if (!node.nodeId) throw new Error('file input not found: ' + selector);
    await call('DOM.setFileInputFiles', { files: filePaths, nodeId: node.nodeId });
    if (waitForExpr) {
      for (let i = 0; i < 12; i++) {
        await pause(300);
        if (await waitForExpr()) return true;
      }
      return js(`(()=>{const el=document.querySelector('${selector}');if(el)el.dispatchEvent(new Event('change',{bubbles:true}));return !!el})()`);
    }
  };

  try {
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: appUrl });
    for (let i = 0; i < 60 && !await js(`(() => Array.from(document.querySelectorAll('li')).some(li => li.textContent.trim().endsWith('音楽') && li.offsetParent !== null))()`); i++) await pause(500);
    await pause(1500);
    await js(`(() => { let n = 0; document.querySelectorAll('modal').forEach(m => { const b = m.querySelector('.title-button button, button'); if (b) { b.click(); n++; } }); return n; })()`);
    await pause(400);
    // モーダル恒久非表示＋被りパネル退避（メニューバーは除く）
    await js(`(() => { const s = document.createElement('style'); s.textContent = '.modal-background, modal { display: none !important; }'; document.head.appendChild(s); const ps = document.querySelectorAll('.draggable-panel'); ps.forEach(p => { if (!p.innerText.includes('メニュー')) p.style.display = 'none'; }); return 1; })()`);

    // ── 1. 音楽パネルで2曲アップロード ──
    await js(`(() => { const lis = Array.from(document.querySelectorAll('li')).filter(li => li.textContent.trim().endsWith('音楽') && li.offsetParent !== null); const li = lis[lis.length - 1]; if (li) li.click(); return !!li; })()`);
    for (let i = 0; i < 20 && !await js(`!!document.querySelector('app-jukebox')`); i++) await pause(300);
    ok('ジュークボックスパネルが開く', await js(`!!document.querySelector('app-jukebox')`), '');
    await setFileInput('app-jukebox input[type="file"]', [wavAPath, wavBPath], async () => (await msvc(`c.trackList.length`)) >= 2);
    for (let i = 0; i < 12 && (await msvc(`c.trackList.length`)) < 2; i++) await pause(300);
    const tracks = await msvc(`c.trackList`);
    ok('2曲がミニプレイヤーの一覧に出る', Array.isArray(tracks) && tracks.length >= 2, tracks);
    const trackA = (tracks || []).find(t => /bgmA/.test(t.name));
    const trackB = (tracks || []).find(t => /bgmB/.test(t.name));
    ok('曲A・曲Bのidentifierを取れる', !!trackA && !!trackB, { a: trackA && trackA.name, b: trackB && trackB.name });
    const allReady = (tracks || []).every(t => t.ready);
    ok('両曲ともready状態', allReady === true, { allReady });

    // ── 2. 卓にテーブルBGM設定（曲A）を付けて再生 ──
    const setup = await js(`(function(){
      const mp = document.querySelector('app-mini-player');
      const m = mp && window.ng.getComponent(mp);
      const j = m && m.jukebox;
      const gt = document.querySelector('game-table');
      const g = gt && window.ng.getComponent(gt);
      const table = g && (g.currentTable || g.table);
      if (!j || !table) return { err: 'j=' + !!j + ' table=' + !!table };
      table.setAttribute('lycorisTableAudioLayers', JSON.stringify([{ name: 'BGM-A', audioIdentifier: '${trackA.identifier}', mode: 'loop', volume: 0.5, enabled: true }]));
      j.playTableAudio(table);
      return { source: j.activeBgmSource, audioId: j.audioIdentifier };
    })()`);
    ok('テーブルBGM(曲A)が再生状態になる', !!setup && setup.source === 'table', setup);
    await pause(600);

    // ── 3. ミニプレイヤーで曲Bを選択 → jukeboxに切り替わる（修正の主目的） ──
    await msvc(`(function(){ c.open(); if (!c.trackListOpen) c.toggleTrackList(); return 1; })()`);
    for (let i = 0; i < 10 && !await js(`!!document.querySelector('.mp-track-item')`); i++) await pause(300);
    const clickB = await js(`(function(){
      const items = Array.from(document.querySelectorAll('.mp-track-item'));
      const item = items.find(it => it.textContent.includes('bgmB'));
      if (!item) return 0;
      item.click();
      return 1;
    })()`);
    await pause(900);
    const st1 = await msvc(`(function(){ const j = c.jukebox; return { source: j.activeBgmSource, audioId: j.audioIdentifier, playing: j.isPlaying }; })()`);
    ok('曲Bをクリックできる', clickB === 1, { clickB });
    ok('選択でjukeboxソースに切り替わる', !!st1 && st1.source === 'jukebox' && st1.audioId === trackB.identifier, st1);
    const label1 = await msvc(`c.nowPlayingName`);
    ok('再生中の曲名表示も曲Bになる', typeof label1 === 'string' && label1.includes('bgmB'), { label1 });
    await shot('select-b-while-table-bgm');

    // ── 4. 回帰: テーブルBGMを明示再生すると戻る（override解除） ──
    const setup2 = await js(`(function(){
      const mp = document.querySelector('app-mini-player');
      const m = mp && window.ng.getComponent(mp);
      const j = m && m.jukebox;
      const gt = document.querySelector('game-table');
      const g = gt && window.ng.getComponent(gt);
      if (!j || !g || !(g.currentTable || g.table)) return null;
      j.playTableAudio(g.currentTable || g.table);
      return { source: j.activeBgmSource };
    })()`);
    ok('テーブルBGM明示再生でtableに戻る', !!setup2 && setup2.source === 'table', setup2);
    await pause(400);

    // ── 5. もう一度曲B選択 → jukebox（繰り返し切替OK） ──
    await msvc(`(function(){ if (!c.trackListOpen) c.toggleTrackList(); return 1; })()`);
    for (let i = 0; i < 10 && !await js(`!!document.querySelector('.mp-track-item')`); i++) await pause(300);
    await js(`(function(){ const items = Array.from(document.querySelectorAll('.mp-track-item')); const item = items.find(it => it.textContent.includes('bgmB')); if (item) item.click(); return 1; })()`);
    await pause(900);
    const st2 = await msvc(`(function(){ const j = c.jukebox; return { source: j.activeBgmSource, audioId: j.audioIdentifier }; })()`);
    ok('再度選択でもjukeboxに切り替わる', !!st2 && st2.source === 'jukebox' && st2.audioId === trackB.identifier, st2);
    await shot('select-b-again');

    // ── 6. 停止してもテーブルBGMが勝手に復活しない ──
    await msvc(`(function(){ const j = c.jukebox; j.stop(); return 1; })()`);
    await pause(600);
    const st3 = await msvc(`(function(){ const j = c.jukebox; return { source: j.activeBgmSource, playing: j.isPlaying }; })()`);
    ok('停止後はテーブルBGMが自動復活しない', !!st3 && st3.source === '' && st3.playing === false, st3);

    const real = consoleErrors.filter(e => !/skyWay onFatalError/.test(e));
    ok('ページエラー0件（SkyWay接続系を除く）', real.length === 0, { total: consoleErrors.length, real: real.length, sample: real.slice(0, 3) });
    console.log('done:', prefix);
  } finally {
    try { ws.close(); } catch (e) { }
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
