// XMLインポートの二重登録を計装して究明する一回限りのプローブ（waitForフロー版）。
// 使い方: node tools/probe-dict-import.cjs <url> <xmlPath>
const fs = require('fs');
const WS = require('/home/maco/.openclaw/workspace/projects/udonarium-lycoris/node_modules/ws');
const appUrl = process.argv[2] || 'http://127.0.0.1:14289/';
const xmlPath = process.argv[3];
const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:19368';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/$/.test(appUrl)) { console.log('isolated only'); process.exit(1); }
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
  const js = async expression => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) return { __pageError: JSON.stringify(r.exceptionDetails).slice(0, 300) };
    return r.result ? r.result.value : undefined;
  };
  const state = () => js(`(()=>{
    const c = window.ng.getComponent(document.querySelector('dictionary-panel'));
    if (!c) return null;
    return { count: c.dictionary.characters.length, calls: (window.__regCalls||[]).length, detail: JSON.stringify(window.__regCalls||[]), ids: c.dictionary.characters.map(x=>x.id.slice(0,8)+':'+x.name) };
  })()`);

  try {
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: appUrl });
    await pause(9000);
    for (let i = 0; i < 5; i++) { await js(`(()=>{const b=document.querySelector('modal .title-button button');if(b)b.click();return !!b})()`); await pause(500); }
    await js(`(()=>{const lis=Array.from(document.querySelectorAll('li')).filter(li=>li.textContent.trim().endsWith('辞書')&&li.offsetParent!==null);const li=lis[lis.length-1];if(li)li.click();return !!li})()`);
    for (let i = 0; i < 20 && !await js(`!!document.querySelector('dictionary-panel')`); i++) await pause(300);
    console.log('panels:', await js(`document.querySelectorAll('dictionary-panel').length`));
    console.log('base:', JSON.stringify(await state()));

    // 計装
    await js(`(()=>{
      const c = window.ng.getComponent(document.querySelector('dictionary-panel'));
      const dict = c.dictionary;
      const orig = dict.registerCharacterXml.bind(dict);
      window.__regCalls = [];
      dict.registerCharacterXml = async (xml, name) => {
        window.__regCalls.push({ name, xmlLen: xml ? xml.length : 0, t: Date.now(), stack: new Error().stack.split('\\n').slice(1, 4).join(' | ').slice(0, 200) });
        return orig(xml, name);
      };
      return 1;
    })()`);

    // E2Eと同じ: setFileInputFiles → waitFor（300ms×10）→ dispatchは不要なら無し
    const doc = await call('DOM.getDocument');
    const node = await call('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'dictionary-panel .dict-actions input[type="file"]' });
    await call('DOM.setFileInputFiles', { files: [xmlPath], nodeId: node.nodeId });
    for (let i = 0; i < 10; i++) {
      await pause(300);
      const s = await state();
      if (s && s.count >= 1) break;
    }
    await pause(600);
    console.log('after waitFor flow:', JSON.stringify(await state()));

    // 追試: もう一度同じ入力をセット（setFileInputFilesのみ）
    await call('DOM.setFileInputFiles', { files: [xmlPath], nodeId: node.nodeId });
    await pause(1200);
    console.log('after 2nd setFileInputFiles:', JSON.stringify(await state()));
  } catch (e) {
    console.log('ERROR:', e.message);
  } finally {
    ws.close();
  }
})();
