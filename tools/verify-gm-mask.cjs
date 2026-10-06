// GMモードのマスク白モヤ修正の検証。
// 使い方: node tools/verify-gm-mask.cjs <url> <prefix> [assert]
//   url: 検証対象のローカル配信URL（旧dist / 新ビルド）
//   prefix: スクリーンショット・指標の出力名
//   assert: 「assert」を付けると新ビルドの挙動を検査する（旧ビルドでは失敗するのが正しい）
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const WS = require('/home/maco/.openclaw/workspace/projects/udonarium-lycoris/node_modules/ws');

const appUrl = process.argv[2] || 'http://127.0.0.1:14287/';
const prefix = process.argv[3] || 'new';
const doAssert = process.argv[4] === 'assert';
const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:19358';
const OUT_DIR = '/home/maco/.openclaw/workspace/projects/udonarium-lycoris/tmp/gm-mask-20261005';

const pause = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const tabs = await (await fetch(`${CDP_HTTP}/json/list`)).json();
  const ws = new WS(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  let id = 0; const pending = new Map();
  ws.on('message', data => {
    const m = JSON.parse(data);
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
  // 矩形の平均輝度をブラウザ内で計測（スクショ→Image→canvas→getImageData）
  const lum = async rect => {
    const clip = {
      x: Math.max(0, Math.floor(rect.x)), y: Math.max(0, Math.floor(rect.y)),
      width: Math.max(2, Math.floor(rect.width)), height: Math.max(2, Math.floor(rect.height)), scale: 1
    };
    const r = await call('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false });
    const b64 = r.data;
    return js(`new Promise(res => { const i = new Image(); i.onload = () => {
      const cv = document.createElement('canvas'); cv.width = i.width; cv.height = i.height;
      const cx = cv.getContext('2d'); cx.drawImage(i, 0, 0);
      const d = cx.getImageData(0, 0, i.width, i.height).data;
      let s = 0, n = 0;
      for (let p = 0; p < d.length; p += 4) { s += 0.2126*d[p] + 0.7152*d[p+1] + 0.0722*d[p+2]; n++; }
      res(n ? Math.round(s / n * 10) / 10 : -1);
    }; i.onerror = () => res(-2); i.src = 'data:image/png;base64,${b64}'; })`, true);
  };
  const hideNoise = (keepOptions = false) => js(`(()=>{document.querySelectorAll('modal').forEach(e=>{if(e.innerText.includes('ネットワークエラー'))e.style.display='none'});document.querySelectorAll('.draggable-panel').forEach(p=>{const keep=!!p.querySelector('game-table-mask,game-character,initiative-panel')${keepOptions ? "||!!p.querySelector('options-panel')" : ''};if(!keep)p.style.display='none'});return 1})()`);
  const showOptions = () => js(`(()=>{document.querySelectorAll('.draggable-panel').forEach(p=>{if(p.querySelector('options-panel'))p.style.display=''});return 1})()`);
  const hideOptions = () => js(`(()=>{document.querySelectorAll('.draggable-panel').forEach(p=>{if(p.querySelector('options-panel'))p.style.display='none'});return 1})()`);

  try {
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: appUrl });
    await pause(9000);
    for (let i = 0; i < 5; i++) { await js(`(()=>{const b=document.querySelector('modal .title-button button');if(b)b.click();return !!b})()`); await pause(600); }
    await hideNoise(true);

    const hasNg = await js(`!!window.ng`);
    console.log('window.ng:', hasNg);

    // ── マスク作成 ──
    if (hasNg) {
      const created = await js(`(()=>{
        const ng = window.ng;
        const app = document.querySelector('app-root');
        let svc = null;
        const seen = new Set();
        for (const el of app.querySelectorAll('*')) {
          const c = ng.getComponent(el);
          if (!c || seen.has(c)) continue;
          seen.add(c);
          if (typeof c.createGameTableMask === 'function') { svc = c; break; }
          if (c.tabletopActionService && typeof c.tabletopActionService.createGameTableMask === 'function') { svc = c.tabletopActionService; break; }
        }
        if (!svc) return { error: 'service-not-found' };
        const mask = svc.createGameTableMask({ x: 260, y: 200, z: 0 });
        if (!mask) return { error: 'mask-not-created' };
        mask.update();
        return { ok: true };
      })()`);
      console.log('mask create (service):', JSON.stringify(created));
    } else {
      // 旧productionビルド: 卓の右クリック→「マップマスクを作成」
      let menuOk = false;
      for (const [x, y] of [[900, 640], [700, 500], [1000, 750], [600, 700]]) {
        await hideNoise(true);
        await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', clickCount: 1 });
        await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', clickCount: 1 });
        await pause(800);
        menuOk = await js(`(()=>{const lis=Array.from(document.querySelectorAll('li')).filter(li=>li.textContent.trim().endsWith('マップマスクを作成')&&li.offsetParent!==null);const li=lis[lis.length-1];if(li){li.click();return true}return false})()`);
        if (menuOk) break;
        await js(`(()=>{document.querySelectorAll('context-menu,.context-menu').forEach(e=>e.remove());return 1})()`);
      }
      console.log('mask create (contextmenu):', menuOk);
    }
    for (let i = 0; i < 20 && !await js(`!!document.querySelector('game-table-mask')`); i++) await pause(300);
    await hideNoise(true);

    const readOp = () => js(`(()=>{
      const host = document.querySelector('game-table-mask');
      if (!host) return null;
      for (const el of [host, ...host.querySelectorAll('*')]) {
        if (el.style && el.style.opacity !== '') return el.style.opacity;
      }
      return getComputedStyle(host).opacity;
    })()`);
    const maskRect = () => js(`(()=>{const h=document.querySelector('game-table-mask');if(!h)return null;for(const el of [h,...h.querySelectorAll('*')]){const r=el.getBoundingClientRect();if(r.width>10&&r.height>10)return {x:r.x,y:r.y,width:r.width,height:r.height}}const r=h.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);

    await pause(500);
    const plOpacity = await readOp();
    ok('PLはマスク不透明', plOpacity === '1', { plOpacity });

    // GM宣言（オプション経由・UI結線の確認も兼ねる）
    await js(`(()=>{const li=Array.from(document.querySelectorAll('li')).find(x=>x.textContent.trim().includes('オプション'));if(li)li.click();return !!li})()`);
    await pause(800);
    showOptions();
    await js(`(()=>{const b=document.querySelector('options-panel .option-toggle.gm');if(b&&!b.classList.contains('on'))b.click();return !!b})()`);
    await pause(800);
    await hideNoise(true);

    const gmOpacity = await readOp();
    ok('GMでもマスクは不透明（修正後の既定）', gmOpacity === '1', { gmOpacity });
    await hideOptions();
    await pause(200);
    await shot('gm-mask');

    showOptions();
    const rowVisible = await js(`(()=>{const r=Array.from(document.querySelectorAll('options-panel .option-row')).find(x=>x.textContent.includes('GMでもマスクを半透明で覗く'));return !!r && r.offsetParent!==null})()`);
    if (hasNg) ok('オプションに覗き見トグル表示（GM時）', rowVisible, { rowVisible });
    else console.log('INFO 覗き見トグル表示(旧ビルド):', rowVisible);

    if (hasNg) {
      // 覗き見ON → GMだけ半透明
      await js(`(()=>{const r=Array.from(document.querySelectorAll('options-panel .option-row')).find(x=>x.textContent.includes('GMでもマスクを半透明で覗く'));if(r)r.querySelector('button').click();return !!r})()`);
      await pause(600);
      const gmPeekOpacity = await readOp();
      ok('覗き見ONでGMは半透明(0.35)', gmPeekOpacity === '0.35', { gmPeekOpacity });
      await hideOptions();
      await pause(200);
      await shot('gm-mask-peek');

      // 覗き見OFF → 戻す
      showOptions();
      await js(`(()=>{const r=Array.from(document.querySelectorAll('options-panel .option-row')).find(x=>x.textContent.includes('GMでもマスクを半透明で覗く'));if(r)r.querySelector('button').click();return !!r})()`);
      await pause(600);
      ok('覗き見OFFでGMは不透明に戻る', await readOp() === '1', { gmOpacity: await readOp() });
    }

    // ── 照明シーン: GMの白モヤ改善（新ビルドのみ） ──
    let gmLitLum = null, gmNoLitLum = null;
    if (hasNg) {
      const lit = await js(`(()=>{
        const t = ng.getComponent(document.querySelector('game-table')).currentTable;
        if (!t) return { error: 'table-not-found' };
        t.lightingEnabled = true; t.lightingNightMode = true; t.lightingIntensity = 0.55; t.update();
        return { ok: true };
      })()`);
      console.log('lighting:', JSON.stringify(lit));

      // 光源つきコマをマスクの上に置く
      await js(`(()=>{
        const gc = document.querySelector('game-character');
        const Char = ng.getComponent(gc).gameCharacter.constructor;
        const c = Char.create('光源テスト', 1, '');
        c.lightSourceEnabled = true; c.lightRadius = 8; c.lightIntensity = 1; c.lightColor = '#ffffff';
        c.location.name = 'table'; c.location.x = 280; c.location.y = 220; c.update();
        return c.identifier;
      })()`);
      await pause(2500);
      await hideNoise(true);

      const mr = await maskRect();
      console.log('maskRect:', JSON.stringify(mr));
      gmLitLum = mr && mr.width > 4 ? await lum(mr) : -1;
      console.log('GM+照明のマスク領域輝度:', gmLitLum);
      await hideOptions();
      await shot('gm-lighting');

      await js(`(()=>{const t=ng.getComponent(document.querySelector('game-table')).currentTable;t.lightingEnabled=false;t.update();return 1})()`);
      await pause(1500);
      const mr2 = await maskRect();
      gmNoLitLum = mr2 && mr2.width > 4 ? await lum(mr2) : -1;
      console.log('GM+照明OFFのマスク領域輝度:', gmNoLitLum);
      ok('照明ONでもGMのマスク領域は大きく白化しない（差 < 40）', gmLitLum >= 0 && gmNoLitLum >= 0 && Math.abs(gmLitLum - gmNoLitLum) < 40, { gmLitLum, gmNoLitLum });
    }

    // PL視点（GM解除）
    showOptions();
    await js(`(()=>{const b=document.querySelector('options-panel .option-toggle.gm');if(b&&b.classList.contains('on'))b.click();return 1})()`);
    await pause(1000);
    await hideNoise(true);
    await shot('pl');

    fs.writeFileSync(path.join(OUT_DIR, `${prefix}-metrics.json`), JSON.stringify({ hasNg, plOpacity, gmOpacity, gmLitLum, gmNoLitLum }, null, 2));
    console.log(`done: ${prefix}`);
  } finally {
    ws.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
