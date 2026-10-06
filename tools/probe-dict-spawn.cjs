// spawn登録とXML_LOADED経路を比較する一回限りのプローブ。
// 使い方: node tools/probe-dict-spawn.cjs <url>
const WS = require('/home/maco/.openclaw/workspace/projects/udonarium-lycoris/node_modules/ws');
const appUrl = process.argv[2] || 'http://127.0.0.1:14289/';
const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:19368';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/$/.test(appUrl)) { console.log('isolated only'); process.exit(1); }
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
    if (m.method === 'Runtime.exceptionThrown') consoleErrors.push('exception: ' + String(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '').slice(0, 200));
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
    if (r.exceptionDetails) return { __pageError: JSON.stringify(r.exceptionDetails).slice(0, 400) };
    return r.result ? r.result.value : undefined;
  };
  const tableNames = () => js(`(()=>{const app=document.querySelector('app-root');return Array.from(app.querySelectorAll('game-character')).map(el=>{const comp=window.ng.getComponent(el);return comp&&comp.gameCharacter?comp.gameCharacter.name:''}).filter(Boolean)})()`);

  try {
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: appUrl });
    await pause(9000);
    for (let i = 0; i < 5; i++) { await js(`(()=>{const b=document.querySelector('modal .title-button button');if(b)b.click();return !!b})()`); await pause(500); }
    await js(`(()=>{const lis=Array.from(document.querySelectorAll('li')).filter(li=>li.textContent.trim().endsWith('辞書')&&li.offsetParent!==null);const li=lis[lis.length-1];if(li)li.click();return !!li})()`);
    for (let i = 0; i < 20 && !await js(`!!document.querySelector('dictionary-panel')`); i++) await pause(300);

    const result = await js(`(()=>{
      const el = document.querySelector('dictionary-panel');
      const c = window.ng.getComponent(el);
      if (!c) return { error: 'no-component' };
      const entry = c.dictionary.characters[0];
      if (!entry) return { error: 'no-entry' };
      const storeBefore = c.gameCharacters.length;
      const ch = c.dictionary.spawnCharacter(entry);
      const storeAfter = c.gameCharacters.length;
      const inStore = ch ? c.gameCharacters.some(x => x.identifier === ch.identifier) : false;
      return { spawnOk: !!ch, name: ch ? ch.name : null, locName: ch ? ch.location.name : null, storeBefore, storeAfter, inStore, xmlHead: entry.xml.slice(0, 100) };
    })()`);
    console.log('A) service spawn:', JSON.stringify(result));
    await pause(1000);
    console.log('A) table names:', JSON.stringify(await tableNames()));

    // ── XML_LOADED 経路（実績ある入口） ──
    const xmlLoaded = await js(`(()=>{
      const el = document.querySelector('dictionary-panel');
      const c = window.ng.getComponent(el);
      const entry = c.dictionary.characters[0];
      const doc = new DOMParser().parseFromString(entry.xml, 'application/xml');
      const xmlElement = doc.documentElement;
      EventSystem.trigger('XML_LOADED', { xmlElement: xmlElement });
      return { triggered: true };
    })()`);
    console.log('B) XML_LOADED:', JSON.stringify(xmlLoaded));
    await pause(1200);
    console.log('B) table names:', JSON.stringify(await tableNames()));

    // mousemoveでCDを起こしてから最終確認
    await js(`(()=>{const el=document.querySelector('#app-game-table')||document.body;el.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:600,clientY:500}));return 1})()`);
    await pause(1000);
    console.log('C) table names after mousemove:', JSON.stringify(await tableNames()));
    const storeNow = await js(`(()=>{const el=document.querySelector('dictionary-panel');const c=window.ng.getComponent(el);return {store:c.gameCharacters.length, names:c.gameCharacters.map(x=>x.name).slice(0,12)}})()`);
    console.log('C) store:', JSON.stringify(storeNow));
    console.log('console errors:', consoleErrors.length, consoleErrors.filter(e => !/skyWay/.test(e)).slice(0, 3));
  } catch (e) {
    console.log('ERROR:', e.message);
  } finally {
    ws.close();
  }
})();
