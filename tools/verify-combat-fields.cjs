// 隔離した開発ビルド用。CDP Chrome と localhost の配信を先に起動する。
// CDP_PORT=19348 APP_URL=http://127.0.0.1:14281/ node tools/verify-combat-fields.cjs
const WS = require('ws');
const fs = require('fs');
const assert = require('assert/strict');
const pause = ms => new Promise(r => setTimeout(r, ms));
const appUrl = process.env.APP_URL || 'http://127.0.0.1:14281/';
assert(['127.0.0.1', 'localhost'].includes(new URL(appUrl).hostname), '隔離したローカル開発ビルドのみ使用');
let count = 0;
(async () => {
  const tabs = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || 19348}/json/list`)).json();
  const ws = new WS(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  let id = 0; const pending = new Map();
  ws.on('message', data => {
    const m = JSON.parse(data);
    if (m.method === 'Page.javascriptDialogOpening') { call('Page.handleJavaScriptDialog', {accept:true}).catch(()=>{}); return; }
    const p = pending.get(m.id);
    if (!p) return;
    clearTimeout(p.timer); pending.delete(m.id);
    if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => { pending.delete(n); reject(new Error(`CDP timeout: ${method}`)); }, 12000);
    pending.set(n, {resolve, reject, timer}); ws.send(JSON.stringify({id:n, method, params}));
  });
  const js = async expression => {
    const r = await call('Runtime.evaluate', {expression, returnByValue:true, awaitPromise:true});
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result?.value;
  };
  const check = async (name, expr, expected = true) => {
    assert.deepEqual(await js(expr), expected, name); console.log(`PASS ${++count}: ${name}`);
  };
  const waitFor = async expr => { for (let i=0;i<60;i++) { if(await js(expr)) return; await pause(250); } throw new Error(`Not ready: ${expr}`); };
  const click = async expr => {
    // 認証バックエンドのない隔離サーバーではネットワークエラーだけを退避。
    await js("document.querySelectorAll('modal').forEach(e=>{if(e.innerText.includes('ネットワークエラー'))e.style.display='none'})");
    const pos = await js(`(()=>{const e=${expr}; if(!e)throw Error('ボタンなし');e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,hit:e.contains(document.elementFromPoint(x,y))}})()`);
    assert(pos.hit, `クリック位置が遮られている: ${expr}`);
    for(const type of ['mouseMoved','mousePressed','mouseReleased']) await call('Input.dispatchMouseEvent',{type,x:pos.x,y:pos.y,button:'left',clickCount:1});
    await pause(150);
  };
  try {
    await call('Page.enable');
    await call('Page.handleJavaScriptDialog', {accept:true}).catch(()=>{});
    await call('Network.enable');
    // 実卓・外部サーバーには接続しない。
    await call('Network.setBlockedURLs', {urls:['ws://*','wss://*','https://*']});
    await call('Page.addScriptToEvaluateOnNewDocument', {source:"localStorage.setItem('udonarium.pendingRoomMode.v1','advanced')"});
    await call('Page.navigate', {url:appUrl});
    await waitFor("!!window.ng && !!document.querySelector('game-character')");
    await js("document.querySelector('modal .title-button button')?.click()");
    await js(`(()=>{const app=ng.getComponent(document.querySelector('app-root'));app.ngZone.run(()=>app.toggleInitiativePanel());})()`);
    await waitFor("!!document.querySelector('initiative-panel')");
    await js(`(()=>{
      window.panel=ng.getComponent(document.querySelector('initiative-panel'));
      const base=ng.getComponent(document.querySelector('game-character')).gameCharacter;
      window.Char=base.constructor; window.DE=base.rootDataElement.constructor;
      window.actor=Char.create('連動テスト',1,''); window.actor2=Char.create('項目なしテスト',1,'');
      const detail=actor.detailDataElement;
      window.hp=detail.getFirstElementByName('HP'); hp.value=30;hp.currentValue=18;
      window.stat=detail.getFirstElementByName('敏捷度') || detail.appendChild(DE.create('敏捷度',12));stat.value=12;
      window.note=detail.getFirstElementByName('メモ') || detail.appendChild(DE.create('メモ','待機',{type:'note'}));note.value='待機';
      panel.ngZone.run(()=>{
        panel.gmModeService.setGmMode(true);
        panel.startCombat();
        panel.initiativeService.reorderCombat([actor.identifier,actor2.identifier]);
        panel.setCustomFields(['HP','敏捷度','メモ','未所持']);
      });
      window.row=()=>Array.from(document.querySelectorAll('initiative-panel .list-row')).find(e=>e.querySelector('.name-text').textContent.trim()==='連動テスト');
      window.field=n=>Array.from(row().querySelectorAll('.field-value')).find(e=>e.getAttribute('aria-label')==='連動テストの'+n);
      window.edit=(n,v)=>{const e=field(n);e.value=v;e.dispatchEvent(new Event('change',{bubbles:true}));};
      for(const p of document.querySelectorAll('.draggable-panel')) { if(!p.querySelector('initiative-panel')) p.style.display='none'; }
      const host=document.querySelector('initiative-panel').closest('.draggable-panel');host.style.left='20px';host.style.top='60px';host.style.width='620px';host.style.height='780px';
    })()`);
    await pause(500);
    await js("document.querySelectorAll('modal .title-button button').forEach(e=>e.click())");
    await check('初期値は盤面のデータと一致', "['HP','敏捷度','メモ'].map(n=>field(n).value)", ['18','12','待機']);
    await check('リソース以外にバーを表示しない', "row().querySelectorAll('.field-bar').length",1);
    await check('項目のないコマは編集不可', "field('未所持').disabled && field('未所持').placeholder==='—'");
    await js("edit('HP','7');edit('敏捷度','15');edit('メモ','行動済み')");
    await pause(150);
    await check('戦闘管理→コマ本体の型別更新（最大値は保持）', "[hp.currentValue,hp.value,stat.value,note.value,stat.currentValue]",[7,30,'15','行動済み','']);
    // 同期経路と同様、Angular外からモデルを更新して画面への反映を確認。
    await js("panel.ngZone.runOutsideAngular(()=>{hp.currentValue=0;stat.value=19;note.value='回復待ち';})");
    await pause(350);
    await check('コマ本体→戦闘管理の更新（0を含む）', "['HP','敏捷度','メモ'].map(n=>field(n).value)",['0','19','回復待ち']);
    await js("edit('HP','');edit('メモ','0012')");
    await check('空の現在値は最大値へ化けず、文字列の先頭0も保持',"[panel.getFieldValue(actor.identifier,'HP'),note.value]",['','0012']);
    await js("panel.ngZone.run(()=>{hp.currentValue=99;})");
    await check('リソースバーの上限', "panel.getBarPercent(actor.identifier,'HP')",100);
    await js("panel.ngZone.run(()=>{hp.currentValue=-3;})");
    await check('リソースバーの下限', "panel.getBarPercent(actor.identifier,'HP')",0);
    await js("panel.ngZone.run(()=>{hp.currentValue=18;hp.value=0;})");
    await check('最大値0ではバーを隠す', "panel.getFieldMax(actor.identifier,'HP')",null);
    await js("panel.ngZone.run(()=>{hp.value=30;stat.currentValue='古い誤書込';})");
    await check('旧実装の誤ったcurrentValueを参照しない',"panel.getFieldValue(actor.identifier,'敏捷度')",'19');
    await click("Array.from(document.querySelectorAll('.field-remove-btn')).find(e=>e.getAttribute('aria-label')==='敏捷度の表示を削除')");
    await check('×で表示列を削除し元ステータスを保持',"!panel.combatCustomFields.includes('敏捷度') && stat.value===19 && !field('敏捷度')");
    await click("document.querySelector('.field-add-btn')");
    await click("Array.from(document.querySelectorAll('.field-candidate')).find(e=>e.textContent.trim()==='敏捷度')");
    await check('候補をクリックして再追加すると現在の値を表示',"field('敏捷度').value",'19');
    await js("panel.ngZone.run(()=>panel.confirmAddField('HP'))");
    await check('同名列は重複追加されない',"panel.combatCustomFields.filter(n=>n==='HP').length",1);
    // 旧形式のラッパー無しXMLと同じ階層を作り、探索と編集を確認。
    await js(`(()=>{window.legacy=new Char();legacy.initialize();const group=legacy.appendChild(DE.create('旧形式'));window.legacyStat=group.appendChild(DE.create('SP',4,{type:'numberResource',currentValue:2}));panel.ngZone.run(()=>panel.initiativeService.addToCombat(legacy.identifier));})()`);
    await check('旧形式の入れ子項目を候補・読み取りに使用',"panel.getFieldCandidates().includes('SP') && panel.getFieldValue(legacy.identifier,'SP')==='2'");
    await js("panel.setFieldValue(legacy.identifier,'SP','0')");
    await check('旧形式の入れ子項目も書き込み連動',"legacyStat.currentValue",0);
    // 卓のコマに付く本物のステータスポップアップを開く。
    await js(`(()=>{
      window.actorHost=Array.from(document.querySelectorAll('game-character')).find(e=>ng.getComponent(e).gameCharacter===actor);
      window.tip=ng.getDirectives(actorHost).find(d=>d.tabletopObject===actor);
      panel.ngZone.run(()=>tip.open());
    })()`);
    await waitFor("!!document.querySelector('overview-panel')");
    await js(`(()=>{
      window.overview=ng.getComponent(document.querySelector('overview-panel'));
      overview.inventoryService.dataTag='HP 敏捷度 メモ';
      window.board=n=>Array.from(document.querySelectorAll('overview-panel .grid-container')).find(e=>e.querySelector('.tag')?.textContent.trim()===n)?.querySelector('input:not([type=range])');
      panel.ngZone.run(()=>{});
    })()`);
    await pause(300);
    await check('盤面のステータスUIが同じ値を表示',"board('HP').value",'18');
    await js("edit('HP','9')");await pause(350);
    await check('戦闘管理→実際の盤面ステータスUI',"board('HP').value",'9');
    await js("(()=>{const e=board('HP');e.value='24';e.dispatchEvent(new Event('input',{bubbles:true}));})()");await pause(350);
    await check('実際の盤面ステータスUI→戦闘管理',"field('HP').value",'24');
    await js("panel.ngZone.run(()=>tip.close())");
    // 表示列はテーブルの同期データで保持され、パネル再表示で失われない。
    await js("panel.ngZone.run(()=>{const app=ng.getComponent(document.querySelector('app-root'));app.toggleInitiativePanel();app.toggleInitiativePanel();})");
    await pause(350);
    await js("window.panel=ng.getComponent(document.querySelector('initiative-panel'));void 0");
    await check('パネルを開き直しても列・値を保持',"panel.combatCustomFields.includes('敏捷度') && field('HP').value==='24'");
    await js("panel.ngZone.run(()=>panel.gmModeService.setGmMode(false))");
    await check('PLには列削除ボタンを表示しない',"document.querySelectorAll('.field-remove-btn').length",0);
    await js("panel.removeCustomField('HP')");
    await check('PLから列削除メソッドを呼んでも設定を変更しない',"panel.combatCustomFields.includes('HP')");
    await js("panel.ngZone.run(()=>{panel.gmModeService.setGmMode(true);panel.removeCustomField('未所持');});const h=document.querySelector('initiative-panel').closest('.draggable-panel');h.style.left='20px';h.style.top='60px';h.style.width='390px';h.style.height='780px'");
    await pause(300);
    await check('狭い画面でも名前の長さにかかわらず列が整列', `(()=>{const x=document.querySelector('initiative-panel .list-header .col-field').getBoundingClientRect().x;return Array.from(document.querySelectorAll('initiative-panel .list-row')).map(r=>r.querySelector('.col-field')).every(e=>Math.abs(e.getBoundingClientRect().x-x)<1)})()`);
    if(process.env.SCREENSHOT) { const r=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(process.env.SCREENSHOT,Buffer.from(r.data,'base64')); }
    console.log(`全${count}件成功`);
  } finally { ws.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
