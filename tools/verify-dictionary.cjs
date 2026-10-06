// 辞書機能(コマ/資料/チャパレ)のE2E検証。
// 使い方: node tools/verify-dictionary.cjs <url> <prefix> [assert]
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const WS = require('/home/maco/.openclaw/workspace/projects/udonarium-lycoris/node_modules/ws');

const appUrl = process.argv[2] || 'http://127.0.0.1:14289/';
const prefix = process.argv[3] || 'new';
const doAssert = process.argv[4] === 'assert';
const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:19368';
const OUT_DIR = '/home/maco/.openclaw/workspace/projects/udonarium-lycoris/tmp/dictionary-20261006';

assert(/^http:\/\/(127\.0\.0\.1|localhost):\d+\/$/.test(appUrl), 'isolated local URL only: ' + appUrl);

// テスト用キャラXML(identifier無し=出すたび新identifierが振られる仕様の確認も兼ねる)
const TEST_XML = '<character name="テストスライム" location.x="0" location.y="0" size="1" imageIdentifier="dict-test-image"><data name="HP" type="numberResource" currentValue="30">30</data></character>';
// 1x1 PNG
const TEST_PNG_DATAURL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

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
  // ファイル入力(CDPで実バイトをセット+change dispatch)
  const waitForDict = expr => js(`(()=>{const el=document.querySelector('dictionary-panel');const c=window.ng.getComponent(el);if(!c)return false;return (${expr});})()`);
  const setFileInput = async (selector, filePath, waitForExpr) => {
    const doc = await call('DOM.getDocument');
    const node = await call('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    if (!node.nodeId) throw new Error('file input not found: ' + selector);
    await call('DOM.setFileInputFiles', { files: [filePath], nodeId: node.nodeId });
    // setFileInputFilesのchange発火は環境により揺れるため、変化を待って必要ならdispatchする
    if (waitForExpr) {
      for (let i = 0; i < 10; i++) {
        await pause(300);
        if (await waitForDict(waitForExpr)) return true;
      }
    }
    return js(`(()=>{const el=document.querySelector('${selector}');if(el)el.dispatchEvent(new Event('change',{bubbles:true}));return !!el})()`);
  };
  const openDictionary = async () => {
    await js(`(()=>{const lis=Array.from(document.querySelectorAll('li')).filter(li=>li.textContent.trim().endsWith('辞書')&&li.offsetParent!==null);const li=lis[lis.length-1];if(li)li.click();return !!li})()`);
    for (let i = 0; i < 20 && !await js(`!!document.querySelector('dictionary-panel')`); i++) await pause(300);
    return !!await js(`!!document.querySelector('dictionary-panel')`);
  };
  const svc = expr => js(`(()=>{
    const el = document.querySelector('dictionary-panel');
    const c = window.ng.getComponent(el);
    if (!c) return null;
    return (${expr});
  })()`);

  try {
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: appUrl });
    await pause(9000);
    await closeOverlays();

    // ── メニュー起動 ──
    const menuCount = await js(`Array.from(document.querySelectorAll('li')).filter(li=>li.textContent.trim().endsWith('辞書')&&li.offsetParent!==null).length`);
    ok('メニューに「辞書」がある', menuCount >= 1, { menuCount });
    ok('メニューで辞書パネルが開く', await openDictionary(), '');
    ok('タブが3つある(コマ/資料/チャパレ)', await js(`document.querySelectorAll('dictionary-panel .dict-tabs label').length`) === 3, '');
    await shot('panel-open');

    // ── コマ: XMLインポート ──
    const xmlPath = path.join(OUT_DIR, 'test-character.xml');
    fs.writeFileSync(xmlPath, TEST_XML);
    await setFileInput('dictionary-panel .dict-actions input[type="file"]', xmlPath, 'c.dictionary.characters.length >= 1');
    for (let i = 0; i < 20 && !(await svc(`c.dictionary.characters.length`)) ; i++) await pause(300);
    const charCount = await svc(`c.dictionary.characters.length`);
    ok('XML読み込みでコマ辞書に1件登録', charCount === 1, { charCount });
    const charInfo = await svc(`(()=>{const e=c.dictionary.characters[0];return {name:e.name, images:e.images.length, xml:e.xml}})()`);
    ok('コマ名がXMLから取れている', charInfo && charInfo.name === 'テストスライム', { name: charInfo && charInfo.name });
    ok('未登録画像は素直にスキップされる', charInfo && charInfo.images === 0, { images: charInfo && charInfo.images });
    ok('XMLからidentifier属性が除去されている', charInfo && !/ identifier="/.test(charInfo.xml), '');

    // ── 盤面へ(連番) ──
    await js(`(()=>{const b=Array.from(document.querySelectorAll('dictionary-panel .char-card button')).find(b=>b.textContent==='盤面へ');if(b)b.click();return !!b})()`);
    await pause(800);
    let names = await js(`(()=>{const app=document.querySelector('app-root');return Array.from(app.querySelectorAll('game-character')).map(el=>{const comp=window.ng.getComponent(el);return comp&&comp.gameCharacter?comp.gameCharacter.name:''}).filter(Boolean)})()`);
    ok('盤面へボタンで「テストスライム」が出る', names.includes('テストスライム'), { names });
    await js(`(()=>{const b=Array.from(document.querySelectorAll('dictionary-panel .char-card button')).find(b=>b.textContent==='盤面へ');if(b)b.click();return 1})()`);
    await pause(800);
    names = await js(`(()=>{const app=document.querySelector('app-root');return Array.from(app.querySelectorAll('game-character')).map(el=>{const comp=window.ng.getComponent(el);return comp&&comp.gameCharacter?comp.gameCharacter.name:''}).filter(Boolean)})()`);
    ok('2体目は「テストスライム(1)」と連番', names.includes('テストスライム(1)'), { names });
    await shot('spawned');

    // ── ドラッグ＆ドロップで卓へ ──
    const drag = await js(`(()=>{
      const card = document.querySelector('dictionary-panel .char-card');
      const table = document.querySelector('#app-game-table') || document.querySelector('game-table .component-content');
      if (!card || !table) return { error: 'elements-missing' };
      const dt = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }));
      const dropped = table.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: 700, clientY: 600 }));
      return { dropped };
    })()`);
    await pause(900);
    names = await js(`(()=>{const app=document.querySelector('app-root');return Array.from(app.querySelectorAll('game-character')).map(el=>{const comp=window.ng.getComponent(el);return comp&&comp.gameCharacter?comp.gameCharacter.name:''}).filter(Boolean)})()`);
    ok('卓へのドラッグ＆ドロップで3体目が出る', names.includes('テストスライム(2)'), { names, drag });
    const pos = await js(`(()=>{
      const app=document.querySelector('app-root');
      for (const el of app.querySelectorAll('game-character')) {
        const comp = window.ng.getComponent(el);
        if (comp && comp.gameCharacter && comp.gameCharacter.name === 'テストスライム(2)') {
          return { x: Math.round(comp.gameCharacter.location.x), y: Math.round(comp.gameCharacter.location.y) };
        }
      }
      return null;
    })()`);
    ok('ドロップ位置にnearで出ている(x,y > 0)', pos && pos.x > 0 && pos.y > 0, { pos });

    // ── 画像入りの辞書JSONを読み込み→生成で画像復元 ──
    const imgDictJson = JSON.stringify({ version: 1, characters: [{ id: 'img-entry', name: '画像スライム', tags: [], xml: '<character name="画像スライム" location.x="0" location.y="0" size="1" imageIdentifier="dict-test-image"></character>', images: [{ identifier: 'dict-test-image', name: 'test.png', url: TEST_PNG_DATAURL }], createdAt: 1 }], materials: [], palettes: [] });
    const imgJsonPath = path.join(OUT_DIR, 'img-entry.json');
    fs.writeFileSync(imgJsonPath, imgDictJson);
    await setFileInput('dictionary-panel .dict-toolbar input[type="file"]', imgJsonPath, 'c.dictionary.characters.length >= 2');
    for (let i = 0; i < 20 && (await svc(`c.dictionary.characters.length`)) < 2; i++) await pause(300);
    ok('画像入りの辞書JSON読み込みでコマ追加', (await svc(`c.dictionary.characters.length`)) === 2, { characters: await svc(`c.dictionary.characters.length`) });
    const imgEntryOk = await svc(`(()=>{const e=c.dictionary.characters.find(x=>x.name==='画像スライム');return e&&e.images.length===1&&e.images[0].url.startsWith('data:')})()`);
    ok('画像がdataURLのまま保存されている', !!imgEntryOk, '');
    await js(`(()=>{const cards=Array.from(document.querySelectorAll('dictionary-panel .char-card'));const card=cards.find(el=>el.querySelector('.char-name').textContent==='画像スライム');const b=card&&Array.from(card.querySelectorAll('button')).find(b=>b.textContent==='盤面へ');if(b)b.click();return !!b})()`);
    await pause(900);
    const imgOk = await js(`(()=>{
      const app=document.querySelector('app-root');
      for (const el of app.querySelectorAll('game-character')) {
        const comp = window.ng.getComponent(el);
        if (comp && comp.gameCharacter && comp.gameCharacter.name.startsWith('画像スライム')) {
          let urlLen = 'err';
          try { urlLen = comp.imageFile.url.length; } catch(e) { urlLen = 'err:' + String(e && e.message || e).slice(0, 60); }
          const img = el.querySelector('img.image') || el.querySelector('img.flat-character-image');
          return { urlLen, imgFound: !!img, nw: img ? img.naturalWidth : 0 };
        }
      }
      return null;
    })()`);
    ok('生成したコマに画像が復元される(url解決+描画)', imgOk && typeof imgOk.urlLen === 'number' && imgOk.urlLen > 0 && (imgOk.nw === undefined || imgOk.nw > 0 || imgOk.imgFound === false) && !(imgOk.imgFound && imgOk.nw === 0), { imgOk });

    // ── チャパレ辞書 ──
    await js(`(()=>{const inputs=document.querySelectorAll('dictionary-panel .dict-tabs label input');if(inputs[2])inputs[2].click();return 1})()`);
    await pause(400);
    await js(`(()=>{const b=Array.from(document.querySelectorAll('dictionary-panel button')).find(b=>b.textContent.includes('＋チャパレ追加'));if(b)b.click();return !!b})()`);
    await pause(500);
    ok('チャパレ追加で1件できる', (await svc(`c.dictionary.palettes.length`)) === 1, { palettes: await svc(`c.dictionary.palettes.length`) });
    // 編集: 名前+本文(デバウンス保存)
    await js(`(()=>{
      const panel = document.querySelector('dictionary-panel');
      const nameInput = panel.querySelector('.palette-head input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(nameInput, '魔法パレ');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      const ta = panel.querySelector('.palette-text');
      const tSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      tSetter.call(ta, '◆攻撃\\n2d6+3 ファイア!\\n◆回復\\n2d6 ヒール!');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return 1;
    })()`);
    await pause(1100);
    const palText = await svc(`(()=>{const p=c.dictionary.palettes[0];return {name:p.name, text:p.text}})()`);
    ok('チャパレ編集がデバウンス保存される', palText && palText.name === '魔法パレ' && palText.text.includes('ファイア!'), { palText });
    // 適用先セレクト→置換適用
    await js(`(()=>{
      const panel = document.querySelector('dictionary-panel');
      const sel = panel.querySelector('.apply-row select');
      const app = document.querySelector('app-root');
      let targetId = '';
      for (const el of app.querySelectorAll('game-character')) {
        const comp = window.ng.getComponent(el);
        if (comp && comp.gameCharacter && comp.gameCharacter.name === 'テストスライム') { targetId = comp.gameCharacter.identifier; break; }
      }
      const sSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      sSetter.call(sel, targetId);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return targetId;
    })()`);
    await pause(300);
    await js(`(()=>{const b=Array.from(document.querySelectorAll('dictionary-panel .apply-row button')).find(b=>b.textContent==='置換適用');if(b)b.click();return !!b})()`);
    await pause(800);
    const applied = await js(`(()=>{
      const app=document.querySelector('app-root');
      for (const el of app.querySelectorAll('game-character')) {
        const comp = window.ng.getComponent(el);
        if (comp && comp.gameCharacter && comp.gameCharacter.name === 'テストスライム') {
          const pal = comp.gameCharacter.chatPalette;
          return { has: !!pal, text: pal ? String(pal.value).slice(0, 40) : '', dice: pal ? pal.dicebot : '' };
        }
      }
      return null;
    })()`);
    ok('置換適用でコマのチャパレが変わる', applied && applied.has && applied.text.includes('ファイア!'), { applied });
    await shot('palette-applied');

    // パレット行のドラッグ→コマへドロップ(置換)
    await js(`(()=>{
      const panel = document.querySelector('dictionary-panel');
      const row = panel.querySelector('.palette-list .section-row[draggable="true"]');
      const dt = new DataTransfer();
      row.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }));
      const target = Array.from(document.querySelectorAll('#app-game-table game-character')).find(el => {
        const comp = window.ng.getComponent(el);
        return comp && comp.gameCharacter && comp.gameCharacter.name === 'テストスライム(1)';
      });
      if (!target) return { error: 'target-missing' };
      target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      return { ok: true };
    })()`);
    await pause(800);
    const applied2 = await js(`(()=>{
      const app=document.querySelector('app-root');
      for (const el of app.querySelectorAll('game-character')) {
        const comp = window.ng.getComponent(el);
        if (comp && comp.gameCharacter && comp.gameCharacter.name === 'テストスライム(1)') {
          const pal = comp.gameCharacter.chatPalette;
          return { has: !!pal, text: pal ? String(pal.value).slice(0, 40) : '' };
        }
      }
      return null;
    })()`);
    ok('パレット行ドラッグ→コマへドロップで適用', applied2 && applied2.has && applied2.text.includes('ファイア!'), { applied2 });

    // ── 資料辞書 ──
    await js(`(()=>{const inputs=document.querySelectorAll('dictionary-panel .dict-tabs label input');if(inputs[1])inputs[1].click();return 1})()`);
    await pause(400);
    await js(`(()=>{const b=Array.from(document.querySelectorAll('dictionary-panel button')).find(b=>b.textContent.includes('＋セクション追加'));if(b)b.click();return !!b})()`);
    await pause(500);
    await js(`(()=>{
      const panel = document.querySelector('dictionary-panel');
      const nameInput = panel.querySelector('.section-name');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(nameInput, 'ワールド資料');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      const b = Array.from(panel.querySelectorAll('button')).find(b=>b.textContent.includes('＋テキスト'));
      if (b) b.click();
      return 1;
    })()`);
    await pause(500);
    await js(`(()=>{
      const panel = document.querySelector('dictionary-panel');
      const ta = panel.querySelector('.page-card textarea');
      const tSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      tSetter.call(ta, '王国は東に大きい森がある。');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return 1;
    })()`);
    await pause(1100);
    const mat = await svc(`(()=>{const m=c.dictionary.materials[0];return m?{title:m.title, pages:m.pages.length, text:m.pages[0]?m.pages[0].text:''}:null})()`);
    ok('資料: セクション+テキストページが保存される', mat && mat.title === 'ワールド資料' && mat.pages === 1 && mat.text.includes('王国は東に'), { mat });

    // ── 永続化: 同一プロファイルで再訪(IndexedDB) ──
    await call('Page.navigate', { url: appUrl });
    await pause(9000);
    await closeOverlays();
    ok('再訪でも辞書パネルが開く', await openDictionary(), '');
    await pause(500);
    const persisted = await svc(`(()=>({characters:c.dictionary.characters.length, materials:c.dictionary.materials.length, palettes:c.dictionary.palettes.length, firstName:c.dictionary.characters[0]?c.dictionary.characters[0].name:'', matTitle:c.dictionary.materials[0]?c.dictionary.materials[0].title:'', palName:c.dictionary.palettes[0]?c.dictionary.palettes[0].name:''}))()`);
    ok('IndexedDBから再読込される(コマ2/資料1/チャパレ1)', persisted && persisted.characters === 2 && persisted.materials === 1 && persisted.palettes === 1, { persisted });
    ok('各データの中身も一致', persisted && ['テストスライム', '画像スライム'].includes(persisted.firstName) && persisted.matTitle === 'ワールド資料' && persisted.palName === '魔法パレ', { persisted });
    await shot('persisted');

    // ── エクスポートデータの中身 ──
    const exported = await svc(`(()=>{const d=c.dictionary.exportData();return {version:d.version, characters:d.characters.length, materials:d.materials.length, palettes:d.palettes.length, jsonLen:JSON.stringify(d).length}})()`);
    ok('exportDataに全データが入る', exported && exported.characters === 2 && exported.materials === 1 && exported.palettes === 1 && exported.jsonLen > 500, { exported });

    // ── インポート(JSONファイル経由) ──
    const exportJson = await svc(`JSON.stringify(c.dictionary.exportData())`);
    const importPath = path.join(OUT_DIR, 'import-test.json');
    fs.writeFileSync(importPath, exportJson);
    await setFileInput('dictionary-panel .dict-toolbar input[type="file"]', importPath, 'c.dictionary.characters.length >= 4');
    await pause(1200);
    const afterImport = await svc(`(()=>({characters:c.dictionary.characters.length, palettes:c.dictionary.palettes.length}))()`);
    ok('ZIP/JSON読み込みでデータが複数登録される', afterImport && afterImport.characters === 4 && afterImport.palettes === 2, { afterImport });

    await shot('final');

    console.log('console errors:', consoleErrors.length, consoleErrors.slice(0, 2));
    if (doAssert) {
      const realErrors = consoleErrors.filter(e => !/skyWay onFatalError/.test(e));
      ok('ページエラー0件（SkyWay接続系を除く）', realErrors.length === 0, { total: consoleErrors.length, real: realErrors.length, sample: realErrors.slice(0, 2) });
    }
    console.log('done:', prefix);
  } catch (e) {
    console.log('ERROR:', e.message);
    if (doAssert) process.exitCode = 1;
  } finally {
    ws.close();
  }
})();
