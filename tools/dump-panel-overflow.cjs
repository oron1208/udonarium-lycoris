// テーブル設定パネルの9pxはみ出し原因の一回限りダンプ。
// 使い方: node tools/dump-panel-overflow.cjs <url>
const WS = require('/home/maco/.openclaw/workspace/projects/udonarium-lycoris/node_modules/ws');
const appUrl = process.argv[2] || 'http://127.0.0.1:14289/';
const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:19368';
const pause = ms => new Promise(r => setTimeout(r, ms));
assert_local();
function assert_local() { if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/$/.test(appUrl)) { console.log('isolated local URL only'); process.exit(1); } }

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
  const js = async expression => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result ? r.result.value : undefined;
  };
  try {
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: appUrl });
    await pause(9000);
    for (let i = 0; i < 5; i++) { await js(`(()=>{const b=document.querySelector('modal .title-button button');if(b)b.click();return !!b})()`); await pause(500); }
    await js(`(()=>{const lis=Array.from(document.querySelectorAll('li')).filter(li=>li.textContent.trim().endsWith('テーブル設定')&&li.offsetParent!==null);const li=lis[lis.length-1];if(li)li.click();return !!li})()`);
    for (let i = 0; i < 20 && !await js(`!!document.querySelector('game-table-setting')`); i++) await pause(300);

    await js(`(()=>{const b=Array.from(document.querySelectorAll('game-table-setting button')).find(b=>b.textContent.includes('ループ追加'));if(b)b.click();return !!b})()`);
    for (let i = 0; i < 15 && !await js(`!!document.querySelector('game-table-setting .table-audio-layer')`); i++) await pause(300);

    const dump = await js(`(()=>{
      const panel = document.querySelector('game-table-setting')?.closest('.draggable-panel');
      if (!panel) return { error: 'no-panel' };
      const info = el => {
        const cs = getComputedStyle(el);
        return { tag: el.tagName.toLowerCase(), cls: (el.className||'').toString().slice(0,50), sw: el.scrollWidth, cw: el.clientWidth, ow: el.offsetWidth, pad: cs.paddingLeft+'/'+cs.paddingRight, bor: cs.borderLeftWidth+'/'+cs.borderRightWidth, box: cs.boxSizing, disp: cs.display };
      };
      const out = { panel: info(panel), widest: [], chain: [] };
      // スクロールコンテナ基準で一番横に広い要素を Top8 で列挙
      const scrollable0 = panel.querySelector('.scrollable-panel') ?? panel;
      const base = scrollable0.clientWidth;
      const all = [...scrollable0.querySelectorAll('*')].map(el => ({ el, w: el.getBoundingClientRect().width })).sort((a, b) => b.w - a.w).slice(0, 8);
      for (const { el, w } of all) {
        const cs = getComputedStyle(el);
        out.widest.push({ w: Math.round(w), base, tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 60), width: cs.width, minW: cs.minWidth, disp: cs.display, ws: cs.whiteSpace });
      }
      // はみ出し要素を深さ順に列挙して、その子の内訳も出す
      const flagged = [panel, ...panel.querySelectorAll('*')].filter(el => el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0);
      for (const el of flagged.slice(0, 4)) {
        const entry = { self: info(el), children: [] };
        for (const c of el.children) {
          const cs = getComputedStyle(c);
          entry.children.push({ tag: c.tagName.toLowerCase(), cls: (c.className||'').toString().slice(0,40), rectW: Math.round(c.getBoundingClientRect().width), ml: cs.marginLeft, mr: cs.marginRight, sw: c.scrollWidth });
        }
        out.chain.push(entry);
      }
      return out;
    })()`);
    console.log(JSON.stringify(dump, null, 1));
  } catch (e) {
    console.log('ERROR:', e.message);
  } finally {
    ws.close();
  }
})();
