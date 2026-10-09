// 実ポインタ操作で曲選択・停止後の曲名保持・再生再開とBGM優先度を検証する。
// 使い方: node tools/verify-miniplayer.cjs <url> <prefix> [assert]
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const WS = require('/home/maco/.openclaw/workspace/projects/udonarium-lycoris/node_modules/ws');

const appUrl = process.argv[2] || 'http://127.0.0.1:14289/';
const prefix = process.argv[3] || 'mp';
const doAssert = process.argv[4] === 'assert';
const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:19368';
const OUT_DIR = process.env.OUT_DIR || path.resolve('tmp/miniplayer-20261009');
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
  let checks = 0, failures = 0;
  ws.on('message', data => {
    const m = JSON.parse(data);
    if (m.method === 'Fetch.requestPaused') {
      const {requestId, request} = m.params;
      const url = new URL(request.url);
      let body, mime;
      if (url.pathname === '/api/audio-library') {
        body = Buffer.from(JSON.stringify({tracks:[{id:'fixture-library',name:'検証用ライブラリ曲',category:'検証',url:'/fixture.wav',duration:1}]}));
        mime = 'application/json';
      } else if (request.method === 'POST') {
        body = Buffer.from('{"ok":true}'); mime = 'application/json';
      } else {
        const bHash = require('crypto').createHash('sha256').update(fs.readFileSync(wavBPath)).digest('hex');
        body = fs.readFileSync(url.pathname.endsWith(bHash) ? wavBPath : wavAPath); mime = 'audio/wav';
      }
      call('Fetch.fulfillRequest', {requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:mime}],body:body.toString('base64')}).catch(e=>consoleErrors.push(e.message));
      return;
    }
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
    checks++; if (!cond) failures++;
    console.log((cond ? 'PASS' : 'FAIL') + `  ${name}  ` + JSON.stringify(info ?? ''));
    if (doAssert) assert(cond, name);
    return cond;
  };
  const shot = async name => {
    const r = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT_DIR, `${prefix}-${name}.png`), Buffer.from(r.data, 'base64'));
  };
  const click = async (selector, text = '') => {
    const point = await js(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.includes(${JSON.stringify(text)}));
      if (!el) return null;
      el.scrollIntoView({block:'nearest'});
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      return { x, y, hit: el.contains(document.elementFromPoint(x,y)) };
    })()`);
    assert(point && point.hit, 'クリック対象が遮蔽されていない: ' + selector);
    await call('Input.dispatchMouseEvent', {type:'mouseMoved', x:point.x, y:point.y});
    await call('Input.dispatchMouseEvent', {type:'mousePressed', x:point.x, y:point.y, button:'left', buttons:1, clickCount:1});
    await pause(100);
    await call('Input.dispatchMouseEvent', {type:'mouseReleased', x:point.x, y:point.y, button:'left', buttons:0, clickCount:1});
    await pause(200);
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
    // 音源APIのみ隔離fixture。音声要素のデコード・再生処理は実ブラウザで動かす。
    await call('Fetch.enable', {patterns:[{urlPattern:'*/api/audio-library'},{urlPattern:'*/api/media/audio/*'},{urlPattern:'*/fixture.wav'}]});
    await call('Page.addScriptToEvaluateOnNewDocument', {source:`
      window.__bgmAudios = [];
      window.Audio = class extends Audio { constructor(...args) { super(...args); window.__bgmAudios.push(this); } };
    `});
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
    await msvc(`(c.open(), true)`);
    await pause(200);
    await click('.mp-play');
    ok('未選択の再生ボタンで曲一覧を開く', await msvc('c.trackListOpen'));
    await click('.mp-select');
    ok('専用ボタンで一覧を閉じられる', !await msvc('c.trackListOpen'));

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
    ok('テーブルBGMの曲名を表示', (await js(`document.querySelector('.mp-title').textContent`)).includes('bgmA'));
    const audioState = () => js(`window.__bgmAudios.filter(a=>!a.paused && a.readyState >= 2).map(a=>({src:a.src,time:a.currentTime}))`);
    ok('テーブルBGMの音声要素が実再生', (await audioState()).some(a => a.src.includes(trackA.identifier)));

    // ── 3. ミニプレイヤーで曲Bを選択 → jukeboxに切り替わる（修正の主目的） ──
    await click('.mp-info');
    for (let i = 0; i < 10 && !await js(`!!document.querySelector('.mp-track-item')`); i++) await pause(300);
    await js(`document.addEventListener('click', e => { if (e.target.closest('.mp-track-item')) window.__trustedTrackClick = e.isTrusted; }, true); true`);
    await click('.mp-track-item', 'bgmB');
    await pause(900);
    const st1 = await msvc(`(function(){ const j = c.jukebox; return { source: j.activeBgmSource, audioId: j.audioIdentifier, playing: j.isPlaying }; })()`);
    ok('曲Bへの実クリックが行に届く', await js('window.__trustedTrackClick === true'));
    ok('選択でjukeboxソースに切り替わる', !!st1 && st1.source === 'jukebox' && st1.audioId === trackB.identifier, st1);
    ok('選択すると一覧が閉じる', !await msvc('c.trackListOpen'));
    ok('選択曲Bだけが実再生', (await audioState()).length === 1 && (await audioState())[0].src.includes(trackB.identifier), await audioState());
    const label1 = await msvc(`c.nowPlayingName`);
    ok('再生中の曲名表示も曲Bになる', typeof label1 === 'string' && label1.includes('bgmB'), { label1 });
    await shot('select-b-while-table-bgm');
    await click('.mp-stop');
    ok('停止後も曲Bの名前を維持', (await js(`document.querySelector('.mp-title').textContent`)).includes('bgmB'));
    ok('停止で音声要素がすべて止まる', (await audioState()).length === 0);
    await click('.mp-select');
    ok('停止した曲Bが選択状態のまま', await js(`!![...document.querySelectorAll('.mp-track-item[aria-pressed="true"]')].find(e=>e.textContent.includes('bgmB'))`));
    await click('.mp-select');
    await click('.mp-play');
    await pause(600);
    ok('停止後に再生ボタンで曲Bを実再生', (await audioState()).some(a=>a.src.includes(trackB.identifier)));
    await msvc('(c.jukebox.stop(), true)');
    await pause(200);
    ok('他パネル相当の停止でも選択曲名を保持', (await msvc('c.nowPlayingName')).includes('bgmB'));
    await click('.mp-close');
    await js(`window.ng.getComponent(document.querySelector('app-jukebox')).openMiniPlayer(); true`);
    await pause(200);
    ok('閉じて開き直しても選択曲名を保持', (await js(`document.querySelector('.mp-title').textContent`)).includes('bgmB'));

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
    await click('.mp-stop');
    await click('.mp-play');
    await pause(600);
    ok('テーブルBGMも停止・再開できる', await msvc(`c.jukebox.activeBgmSource === 'table'`) && (await audioState()).some(a=>a.src.includes(trackA.identifier)));

    // ── 5. もう一度曲B選択 → jukebox（繰り返し切替OK） ──
    await click('.mp-select');
    for (let i = 0; i < 10 && !await js(`!!document.querySelector('.mp-track-item')`); i++) await pause(300);
    // 長押し・定期変更検知を挟んでも同じDOM行を維持する。
    await js(`window.__trackRow = [...document.querySelectorAll('.mp-track-item')].find(e=>e.textContent.includes('bgmB')); true`);
    await pause(1700);
    ok('定期更新で曲の行DOMを作り直さない', await js('window.__trackRow.isConnected'));
    await click('.mp-track-item', 'bgmB');
    await pause(900);
    const st2 = await msvc(`(function(){ const j = c.jukebox; return { source: j.activeBgmSource, audioId: j.audioIdentifier }; })()`);
    ok('再度選択でもjukeboxに切り替わる', !!st2 && st2.source === 'jukebox' && st2.audioId === trackB.identifier, st2);
    await shot('select-b-again');

    // ── 6. 停止してもテーブルBGMが勝手に復活しない ──
    await click('.mp-stop');
    await pause(600);
    const st3 = await msvc(`(function(){ const j = c.jukebox; return { source: j.activeBgmSource, playing: j.isPlaying }; })()`);
    ok('停止後はテーブルBGMが自動復活しない', !!st3 && st3.source === '' && st3.playing === false, st3);

    // 戦闘BGMは古い単曲選択より優先して表示。停止・再開・選曲は実クリック。
    await msvc(`(c.jukebox.playCombatBgm(${JSON.stringify(trackA.identifier)}), true)`);
    await pause(600);
    ok('戦闘BGMの曲名が表示される', (await js(`document.querySelector('.mp-title').textContent`)).includes('bgmA'));
    await click('.mp-stop');
    ok('戦闘BGMを停止し曲名を保持', !await msvc('c.isPlaying') && (await msvc('c.nowPlayingName')).includes('bgmA') && !(await audioState()).length);
    await click('.mp-play');
    await pause(600);
    ok('戦闘BGM停止後に選択曲を再生できる', (await audioState()).some(a=>a.src.includes(trackA.identifier)));
    await msvc(`(c.jukebox.playCombatBgm(${JSON.stringify(trackA.identifier)}), true)`);
    await pause(200);
    await click('.mp-select');
    await click('.mp-track-item','bgmB');
    await pause(600);
    ok('戦闘BGM中も曲Bを選択・実再生', (await audioState()).length === 1 && (await audioState())[0].src.includes(trackB.identifier));

    // 複数レイヤーの全停止と再開。
    await msvc(`(c.jukebox.setJukeboxLayers(${JSON.stringify([trackA,trackB].map(t=>({name:t.name,audioIdentifier:t.identifier,mode:'loop',volume:0.5,enabled:true})))}), c.jukebox.playJukeboxLayers(), true)`);
    await pause(600);
    ok('複数レイヤーの曲名を表示・2音源が実再生', (await msvc('c.nowPlayingName')).includes('bgmA') && (await msvc('c.nowPlayingName')).includes('bgmB') && (await audioState()).length === 2);
    await click('.mp-stop');
    await pause(200);
    ok('全停止は複数レイヤーも止める', !await msvc('c.isPlaying') && !(await audioState()).length);
    await click('.mp-play');
    await pause(600);
    ok('レイヤー構成を維持して再開', (await audioState()).length === 2);

    // サーバー曲とキーボード選択。
    await msvc(`(c.jukebox.setPinnedLibraryTrackIds(['fixture-library']), true)`);
    await click('.mp-select');
    await click('.mp-track-item', '検証用ライブラリ曲');
    await pause(600);
    ok('サーバー曲も選択・曲名表示・実再生', (await msvc('c.nowPlayingName')) === '検証用ライブラリ曲' && (await audioState()).some(a=>a.src.endsWith('/fixture.wav')));
    await click('.mp-stop');
    await click('.mp-select');
    await js(`document.querySelector('.mp-track-item').focus(); true`);
    await call('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
    await call('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await pause(600);
    ok('キーボードでも曲を選択・実再生', (await audioState()).some(a=>a.src.includes(trackA.identifier)), await js(`({focus:document.activeElement.outerHTML.slice(0,200),audios:window.__bgmAudios.filter(a=>!a.paused).map(a=>a.src)})`));
    await click('.mp-stop');

    // 未取得の曲が他の再生を妨げず、取得後に同じ行のまま有効になる。
    await js(`(()=>{const c=ng.getComponent(document.querySelector('app-jukebox'));const a=c.audios.find(a=>a.name.includes('bgmB'));window.__savedAudioContext={...a.context};a.context={...a.context,blob:null,url:''};return true})()`);
    await click('.mp-select');
    ok('音源未取得の行には理由を表示し選択を無効化', await js(`(()=>{const e=[...document.querySelectorAll('.mp-track-item')].find(e=>e.textContent.includes('bgmB'));return e.disabled && e.textContent.includes('未取得')})()`));
    await js(`window.__unreadyRow=[...document.querySelectorAll('.mp-track-item')].find(e=>e.textContent.includes('bgmB')); true`);
    await js(`(()=>{const c=ng.getComponent(document.querySelector('app-jukebox'));c.audios.find(a=>a.name.includes('bgmB')).context=window.__savedAudioContext;return true})()`);
    await pause(1600);
    ok('取得完了後は同じ行DOMのまま選択可能', await js('window.__unreadyRow.isConnected && !window.__unreadyRow.disabled'));
    await click('.mp-select');

    // 狭い画面と下端配置でも一覧を操作できる。
    await call('Emulation.setDeviceMetricsOverride', {width:390,height:700,deviceScaleFactor:1,mobile:false});
    await pause(300);
    await msvc('(c.pos = {x:14,y:630}, true)');
    await pause(200);
    await click('.mp-select');
    const bounds = await js(`(()=>{const p=document.querySelector('.mini-player').getBoundingClientRect(),l=document.querySelector('.mp-track-list').getBoundingClientRect();return {p:{left:p.left,right:p.right,bottom:p.bottom},l:{left:l.left,right:l.right,top:l.top,bottom:l.bottom}}})()`);
    ok('狭い画面・下端では一覧を上に開き画面内に収まる', bounds.p.left>=0 && bounds.p.right<=390 && bounds.l.top>=0 && bounds.l.bottom<=bounds.p.bottom && bounds.l.right<=390,bounds);
    await shot('narrow-list');
    ok('曲一覧に横スクロールが生じない', await js(`(()=>{const e=document.querySelector('.mp-track-list');return e.scrollWidth<=e.clientWidth})()`));
    await click('.mp-track-item','bgmB');
    await pause(600);
    ok('狭い画面でも実クリックで選曲', (await audioState()).some(a=>a.src.includes(trackB.identifier)));
    await click('.mp-stop');
    await click('.mp-select');
    const art = await js(`(()=>{const r=document.querySelector('.mp-art').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await call('Input.dispatchMouseEvent', {type:'mouseMoved',...art});
    for (const clickCount of [1,2]) {
      await call('Input.dispatchMouseEvent', {type:'mousePressed',...art,button:'left',buttons:1,clickCount});
      await pause(50);
      await call('Input.dispatchMouseEvent', {type:'mouseReleased',...art,button:'left',buttons:0,clickCount});
      await pause(50);
    }
    await pause(200);
    ok('アイコンの実ダブルクリックで位置と一覧方向をリセット', await js(`(()=>{const p=document.querySelector('.mini-player').getBoundingClientRect(),l=document.querySelector('.mp-track-list').getBoundingClientRect();return p.top<30 && l.top>p.bottom && l.top<100})()`));

    const real = consoleErrors.filter(e => !/skyWay onFatalError|Failed to load resource.*404|SkyWay|skyway/.test(e));
    ok('ページエラー0件（SkyWay接続系を除く）', real.length === 0, { total: consoleErrors.length, real: real.length, sample: real.slice(0, 3) });
    console.log('RESULT', JSON.stringify({checks,passed:checks-failures,failures,prefix}));
    if (failures) process.exitCode = 1;
  } finally {
    try { ws.close(); } catch (e) { }
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
