// 検証: VNステージ吹き出しが立ち絵サイズ変更に追従するか（立ち絵上端に若干被せる配置）
// 使い方: node tools/verify-vnbubble.cjs <url> <prefix> [assert]
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const zlib = require('zlib');
const WS = require('/home/maco/.openclaw/workspace/projects/udonarium-lycoris/node_modules/ws');

const appUrl = process.argv[2] || 'http://127.0.0.1:14305/';
const prefix = process.argv[3] || 'vnb';
const doAssert = process.argv[4] === 'assert';
const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:19389';
const OUT_DIR = '/home/maco/.openclaw/workspace/projects/udonarium-lycoris/tmp/vnbubble-20261008';
fs.mkdirSync(OUT_DIR, { recursive: true });

assert(/^http:\/\/(127\.0\.0\.1|localhost):\d+\/$/.test(appUrl), 'isolated local URL only: ' + appUrl);

const pause = ms => new Promise(r => setTimeout(r, ms));

// ── 立ち絵形状のテストPNG生成（200x400, 純Node） ──
function makePng(w, h) {
  const crcTable = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8bit RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const o = row + 1 + x * 3;
      raw[o] = 120 + Math.floor((x / w) * 80);
      raw[o + 1] = 60 + Math.floor((y / h) * 60);
      raw[o + 2] = 140;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}
const PNG_B64 = makePng(200, 400).toString('base64');

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
  let passCount = 0, failCount = 0;
  const ok = (name, cond, info) => {
    cond ? passCount++ : failCount++;
    console.log((cond ? 'PASS' : 'FAIL') + `  ${name}  ` + JSON.stringify(info ?? ''));
    if (doAssert) assert(cond, name);
    return cond;
  };
  const shot = async name => {
    const r = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT_DIR, `${prefix}-${name}.png`), Buffer.from(r.data, 'base64'));
  };
  const vnprobe = expr => js(`(() => { const el = document.querySelector('vn-stage'); const c = el && window.ng.getComponent(el); return c ? (${expr}) : null; })()`);
  // 吹き出しを出して測定（bubbleは8秒で消えるため直前送信）
  const send = async text => vnprobe(`(function(){ c.inputText = ${JSON.stringify(text)}; c.sendVnChat(); return c.inputText === ''; })()`);
  const measure = async index => js(`(function(){
    const actors = document.querySelectorAll('.vn-actor');
    const actor = actors[${index}];
    if (!actor) return null;
    const bubble = actor.querySelector('.vn-bubble');
    const stack = actor.querySelector('.vn-portrait-stack');
    const a = actor.getBoundingClientRect();
    const b = bubble ? bubble.getBoundingClientRect() : null;
    const s = stack ? stack.getBoundingClientRect() : null;
    const out = { actorLeft: Math.round(a.left), actorRight: Math.round(a.right), actorW: Math.round(a.width), actorH: Math.round(a.height) };
    if (b) { out.bubbleTop = Math.round(b.top); out.bubbleBottom = Math.round(b.bottom); out.bubbleLeft = Math.round(b.left); out.bubbleRight = Math.round(b.right); out.bubbleH = Math.round(b.height); }
    if (s) { out.stackTop = Math.round(s.top); out.stackBottom = Math.round(s.bottom); out.stackLeft = Math.round(s.left); out.stackH = Math.round(s.height); out.stackW = Math.round(s.width); }
    if (b && s) out.overlap = Math.round(b.bottom - s.top);
    return out;
  })()`);
  const mousedown = selector => js(`(function(){
    const el = ${selector};
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    return true;
  })()`);

  try {
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    // VNモード有効化＋autofit設定（新document向けにlocalStorageへ事前設定）
    await call('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('udonarium.vnStage.visible.v1', '1'); localStorage.setItem('udonarium.vnStage.autoFit.v1', '1'); } catch (e) {}` });
    await call('Page.navigate', { url: appUrl });
    for (let i = 0; i < 60 && !await js(`!!document.querySelector('vn-stage')`); i++) await pause(500);
    await pause(2500);
    await js(`(() => { const b = document.querySelector('modal .title-button button'); if (b) b.click(); return 1; })()`);
    await pause(600);
    ok('VNモードが表示される', await js(`!!document.querySelector('vn-stage')`) === true, {});

    // ── trusted rightClickヘルパ（卓の空きスペース → キャラクターを作成） ──
    // ── 卓メニューを開く：ポインタ移動はtrusted（PointerDeviceServiceに座標を記録させ）、contextmenuはgame-tableへJS発火（VNステージのオーバーレイに遮られない） ──
    const rightClick = async (x, y) => {
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await pause(150);
      return js(`(function(){
        if (document.activeElement && document.activeElement !== document.body) { try { document.activeElement.blur(); } catch (e) {} }
        const host = document.querySelector('game-table');
        if (!host) return 'no-game-table';
        host.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y} }));
        return true;
      })()`);
    };
    const clickMenuItem = async label => {
      for (let i = 0; i < 12; i++) {
        const done = await js(`(function(){
          const lis = Array.from(document.querySelectorAll('li')).filter(li => li.textContent.trim().endsWith(${JSON.stringify(label)}) && li.offsetParent !== null);
          const li = lis[lis.length - 1];
          if (!li) return false;
          li.click(); return true;
        })()`);
        if (done) return true;
        await pause(250);
      }
      return false;
    };

    // ── 登場キャラ: VNオーバーレイ下では卓の右クリックメニューが開けないため、卓に既存のテストキャラを使用 ──
    for (let i = 0; i < 20 && !await js(`!!document.querySelector('game-character')`); i++) await pause(300);
    await pause(500);
    const chars1 = await vnprobe(`c.characters.map(x => ({ id: x.identifier, name: x.name }))`);
    ok('VNステージのキャラ一覧に載る', Array.isArray(chars1) && chars1.length >= 1, { chars: chars1 });
    const chars1Ids = chars1.map(x => x.id);
    const char1 = chars1[0];
    await vnprobe(`(function(){ c.selectedCharacterId = ${JSON.stringify(char1.id)}; c.enterStage(); return c.actors.length; })()`);
    for (let i = 0; i < 20 && (await vnprobe(`c.actors.length`)) < 1; i++) await pause(300);
    ok('VNステージに登場する', (await vnprobe(`c.actors.length`)) >= 1, {});

    // ── 画像をvn-inputにドロップしてImageStorageへ登録 ──
    const drop = await js(`(function(){
      const b64 = '${PNG_B64}';
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], 'tachie.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.querySelector('.vn-input');
      if (!input) return 'no-input';
      input.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      return 'dropped';
    })()`);
    let imgId = null;
    for (let i = 0; i < 20 && !imgId; i++) {
      await pause(500);
      imgId = await vnprobe(`(function(){
        const msgs = (c.chatLogMessages || []).filter(m => m.imageIdentifier);
        if (msgs.length) return msgs[msgs.length - 1].imageIdentifier;
        const svc = c.chatMessageService;
        const tabs = svc ? svc.chatTabs : [];
        for (const t of tabs) { const ms = (t.chatMessages || []).filter(m => m.imageIdentifier); if (ms.length) return ms[ms.length - 1].imageIdentifier; }
        return null;
      })()`);
    }
    ok('画像ドロップでImageStorageに登録', !!imgId, { drop, imgId });

    // ── アクターに立ち絵を設定 ──
    await vnprobe(`(function(){ c.setActorImage(c.actors[0], ${JSON.stringify(imgId)}); return c.actors[0].imageIdentifier; })()`);
    for (let i = 0; i < 20 && !await js(`!!document.querySelector('.vn-actor .vn-portrait-stack')`); i++) await pause(300);
    ok('立ち絵スタックが表示される', await js(`!!document.querySelector('.vn-actor .vn-portrait-stack')`) === true, {});
    // 画像が他のものに差し替わってないか確認し、必要なら再設定
    let curImgId = await vnprobe(`c.actors[0].imageIdentifier`);
    if (curImgId !== imgId) { await vnprobe(`(function(){ c.setActorImage(c.actors[0], ${JSON.stringify(imgId)}); return 1; })()`); await pause(500); curImgId = await vnprobe(`c.actors[0].imageIdentifier`); }
    ok('アクターにドロップ画像が設定される', curImgId === imgId, { curImgId, imgId });
    for (let i = 0; i < 16; i++) {
      const st = await js(`(function(){ const img = document.querySelector('.vn-actor img.vn-portrait-current'); return img ? { complete: img.complete, natural: img.naturalWidth + 'x' + img.naturalHeight } : null; })()`);
      if (st && st.complete && !/^0x0/.test(st.natural)) { ok('立ち絵画像が読み込まれる', true, st); break; }
      if (i === 15) ok('立ち絵画像が読み込まれる', false, st);
      await pause(400);
    }

    // ── 吹き出しを出して測定（通常サイズ） ──
    await send('通常サイズのセリフです');
    for (let i = 0; i < 16 && !await js(`!!document.querySelector('.vn-actor .vn-bubble')`); i++) await pause(250);
    ok('吹き出しが表示される', await js(`!!document.querySelector('.vn-actor .vn-bubble')`) === true, {});
    const m0 = await measure(0);
    await shot('normal');
    ok('通常サイズ: 吹き出しが立ち絵上端に重なる（被せ8〜26px）', !!m0 && m0.overlap >= 8 && m0.overlap <= 26, m0);
    ok('通常サイズ: stackがアクター高さいっぱい（autofit×scale1）', !!m0 && m0.actorH > 100 && Math.abs(m0.stackH - m0.actorH) <= 8, { stackH: m0.stackH, actorH: m0.actorH });
    ok('通常サイズ: 吹き出しは右寄り（flex-end）', !!m0 && m0.bubbleRight <= m0.actorRight + 3 && m0.bubbleRight >= m0.actorRight - 40, { bubbleRight: m0.bubbleRight, actorRight: m0.actorRight });
    ok('通常サイズ: 吹き出しが画面内', !!m0 && m0.bubbleTop >= 0, m0);

    // ── サイズ縮小 ×3（1.0 → 0.7）で追従確認 ──
    for (let i = 0; i < 3; i++) { await mousedown(`Array.from(document.querySelectorAll('vn-stage button')).find(b => (b.title || '') === '小さく')`); await pause(250); }
    await pause(400);
    const scaleLabel1 = await vnprobe(`c.selectedActorScaleLabel`);
    await send('小さくしたときのセリフです');
    for (let i = 0; i < 16 && !await js(`!!document.querySelector('.vn-actor .vn-bubble')`); i++) await pause(250);
    const m1 = await measure(0);
    await shot('scaled70');
    ok('サイズ縮小が効く（stack高さが縮む）', !!m1 && !!m0 && m1.stackH < m0.stackH * 0.85, { before: m0.stackH, after: m1.stackH, label: scaleLabel1 });
    ok('縮小後も吹き出しが立ち絵上端に追従', !!m1 && m1.overlap >= 8 && m1.overlap <= 26, m1);
    ok('縮小後も吹き出しが画面内', !!m1 && m1.bubbleTop >= 0, m1);

    // ── さらに縮小 ×2（0.7 → 0.5） ──
    for (let i = 0; i < 2; i++) { await mousedown(`Array.from(document.querySelectorAll('vn-stage button')).find(b => (b.title || '') === '小さく')`); await pause(250); }
    await pause(400);
    await send('もっと小さくしました');
    for (let i = 0; i < 16 && !await js(`!!document.querySelector('.vn-actor .vn-bubble')`); i++) await pause(250);
    const m2 = await measure(0);
    await shot('scaled50');
    ok('極小サイズでも吹き出しが追従', !!m2 && m2.overlap >= 8 && m2.overlap <= 26, m2);

    // ── サイズリセット ──
    await mousedown(`Array.from(document.querySelectorAll('vn-stage button')).find(b => (b.title || '') === 'サイズリセット')`);
    await pause(400);
    await send('サイズを戻しました');
    for (let i = 0; i < 16 && !await js(`!!document.querySelector('.vn-actor .vn-bubble')`); i++) await pause(250);
    const m3 = await measure(0);
    ok('サイズリセットで通常配置に復帰', !!m3 && m3.overlap >= 8 && m3.overlap <= 26 && Math.abs(m3.stackH - m0.stackH) <= 6, m3);

    // ── 明示サイズ経路（リサイズハンドル相当: portraitWidth/Height直接） ──
    await vnprobe(`(function(){ const a = c.actors[0]; a.portraitWidth = 30; a.portraitHeight = 45; return { w: a.portraitWidth, h: a.portraitHeight }; })()`);
    await pause(400);
    await send('明示サイズでもずれない');
    for (let i = 0; i < 16 && !await js(`!!document.querySelector('.vn-actor .vn-bubble')`); i++) await pause(250);
    const m4 = await measure(0);
    ok('明示サイズ(30vw×45vh)がlayoutに反映', !!m4 && Math.abs(m4.stackW - 0.30 * 1400) <= 20 && Math.abs(m4.stackH - 0.45 * 1000) <= 20, { m4, expectW: 420, expectH: 450 });
    ok('明示サイズでも吹き出しが追従', !!m4 && m4.overlap >= 8 && m4.overlap <= 26, m4);
    await vnprobe(`(function(){ const a = c.actors[0]; a.portraitWidth = 0; a.portraitHeight = 0; return 1; })()`);
    await pause(300);

    // ── 2人目（既存キャラ）を登場させてbubble-left（align-self: flex-start）を確認 ──
    const chars2 = await vnprobe(`c.characters.map(x => ({ id: x.identifier, name: x.name }))`);
    const char2 = Array.isArray(chars2) ? chars2.find(x => x.id !== char1.id) : null;
    ok('2人目のキャラが使える', !!char2, { chars2 });
    if (char2) {
      await vnprobe(`(function(){ c.selectedCharacterId = ${JSON.stringify(char2.id)}; c.enterStage(); return c.actors.length; })()`);
      for (let i = 0; i < 20 && (await vnprobe(`c.actors.length`)) < 2; i++) await pause(300);
      await send('二人目は左側のセリフ');
      for (let i = 0; i < 16 && !await js(`(function(){ const a = document.querySelectorAll('.vn-actor')[1]; return !!(a && a.querySelector('.vn-bubble')); })()`); i++) await pause(250);
      const m5 = await measure(1);
      await shot('two-actors');
      ok('2人目の吹き出しは左寄り（flex-start）', !!m5 && m5.bubbleLeft <= m5.actorLeft + 40 && m5.bubbleLeft >= m5.actorLeft - 3, m5);
    }

    // ── 送信フロー整合（ログに残っている） ──
    const logCount = await vnprobe(`(c.chatLogMessages || []).length`);
    ok('VNチャットログに発言が記録される', logCount >= 4, { logCount });

    // ── ページエラー ──
    const realErrors = consoleErrors.filter(e => !/favicon|Autofocus|The play\(\)|Icon URL|jpg|png|404|SkyWay|skyway|APIバックエンド|SkyWayの認証/.test(e));
    ok('ページエラーなし', realErrors.length === 0, realErrors.slice(0, 3));

    console.log('RESULT ' + JSON.stringify({ checks: passCount + failCount, passed: passCount, failures: failCount, prefix }));
    if (failCount > 0) process.exitCode = 1;
  } catch (err) {
    console.log('FATAL ' + (err && err.message ? err.message : String(err)));
    process.exitCode = 1;
  } finally {
    try { ws.close(); } catch (_) { }
  }
})();
