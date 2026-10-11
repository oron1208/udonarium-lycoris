const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');
const WS = require('ws');
const dir = path.resolve(__dirname, '..', 'tmp', 'extended-dice-review');
const delay = ms => new Promise(r => setTimeout(r, ms));
const output = [];
const record = (label, value) => { output.push({label, value}); console.log(label, JSON.stringify(value)); };
const children = [];
const sockets = [];
async function ready(url) {
  for (let n=0;n<80;n++) { try { const r=await fetch(url); if(r.ok) return r; } catch {} await delay(250); }
  throw Error('Not ready: '+url);
}
async function client() {
  const target = await (await fetch('http://127.0.0.1:19419/json/new?about:blank', {method:'PUT'})).json();
  const ws=new WS(target.webSocketDebuggerUrl); sockets.push(ws);
  await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)});
  let id=0; const pending=new Map();
  ws.on('message', raw=>{const m=JSON.parse(raw);const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>{pending.delete(n);reject(Error('CDP timeout '+method))},20000);pending.set(n,{resolve,reject,timer});ws.send(JSON.stringify({id:n,method,params}))});
  const js=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result?.value};
  const wait=async expression=>{for(let n=0;n<100;n++){if(await js(expression))return;await delay(150)}throw Error('Wait timeout '+expression)};
  const click=async expression=>{const p=await js(`(()=>{const e=(${expression});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;const h=document.elementFromPoint(x,y);return {x,y,hit:h===e||e.contains(h)}})()`);if(!p?.hit)throw Error('Click target blocked '+JSON.stringify(p));for(const type of ['mousePressed','mouseReleased'])await call('Input.dispatchMouseEvent',{type,x:p.x,y:p.y,button:'left',clickCount:1});await delay(220)};
  await call('Page.enable');await call('Runtime.enable');await call('Network.enable');
  await call('Network.setBlockedURLs',{urls:['https://*','wss://*']});
  await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await call('Page.navigate',{url:'http://127.0.0.1:14319/'});
  await wait(`!!window.ng && !!document.querySelector('game-table') && !!document.querySelector('peer-menu')`);
  await delay(1600);
  if(await js(`!!document.querySelector('text-view button')`))await click(`document.querySelector('text-view button')`);
  return {call,js,wait,click};
}
(async()=>{
  const serverLog=fs.openSync(path.join(dir,'server.log'),'w');
  children.push(spawn(process.execPath,[path.join(dir,'server/unified-server.js')],{env:{...process.env,PORT:'14319'},stdio:['ignore',serverLog,serverLog]}));
  await ready('http://127.0.0.1:14319/health');
  const chromeLog=fs.openSync(path.join(dir,'chrome.log'),'w');
  children.push(spawn('/opt/google/chrome/chrome',['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=19419','--user-data-dir='+path.join(dir,'profile-'+Date.now()),'about:blank'],{stdio:['ignore',chromeLog,chromeLog]}));
  await ready('http://127.0.0.1:19419/json/version');
  const a=await client();
  await a.js(`window.peer=ng.getComponent(document.querySelector('peer-menu'));peer.networkService.open('reviewA','DICE01','dice-review','');true`);
  await a.wait(`peer.networkService.isOpen && peer.networkService.peerContext.isRoom`);
  await a.js(`window.app=ng.getComponent(document.querySelector('app-root'));window.table=ng.getComponent(document.querySelector('game-table')).currentTable;app.ngZone.run(()=>{table.roomMode='advanced';table.update()});true`);
  await a.js(`app.ngZone.run(()=>app.open('OptionsPanelComponent'));true`);await a.wait(`!!document.querySelector('options-panel')`);
  await a.js(`window.options=ng.getComponent(document.querySelector('options-panel'));true`);
  record('options state',await a.js(`({advanced:options.isAdvancedRoom,mode:table.roomMode,optionsText:document.querySelector('options-panel').textContent.slice(-900)})`));
  await a.wait(`[...document.querySelectorAll('options-panel .option-row')].some(e=>e.textContent.includes('拡張ダイスボット'))`);
  await a.click(`[...document.querySelectorAll('options-panel .option-row')].find(e=>e.textContent.includes('拡張ダイスボット')).querySelector('button')`);
  record('option after trusted ON',await a.js(`({ui:options.isExtendedDiceBotEnabled,table:table.extendedDiceBotEnabled,serialized:table.toContext()})`));
  await a.js(`app.ngZone.run(()=>options.addSampleCharacters());true`);await a.wait(`!!document.querySelector('game-character')`);
  await a.js(`window.gc=ng.getComponent(document.querySelector('game-character'));app.ngZone.run(()=>gc.showChatPalette(gc.gameCharacter));true`);
  await a.wait(`!!document.querySelector('chat-palette')`);
  record('palette setup',await a.js(`(()=>{window.cp=ng.getComponent(document.querySelector('chat-palette'));window.cw=ng.getComponent(document.querySelector('chat-window'));cp.palette.setPalette(${JSON.stringify('//Lv=5\n//X=10\n//TX=3')});return {enabled:cp.isExtendedDiceBotEnabled,name:cp.character.name,tab:cp.chatTab?.name}})()`));
  const cases=['{max(3,7,5)}','{min(3,7,5)}','{sum(3,5,7)}','{avg(10,15,14)}','{abs(-4)}','{ceil(3.2)}','{floor(3.8)}','{round(3.5)}','{clamp(15,1,10)}','{ceil({Lv}/2)}d6','距離: {abs({X}-{TX})}'];
  for(const input of cases){
    const result=await a.js(`(()=>{const p={text:${JSON.stringify(input)},gameSystem:null,sendFrom:cp.character.identifier,sendTo:'',tachieNum:0,messColor:'#000000'};cp.sendChat(p);const palette=cp.chatTab.chatMessages.slice(-1)[0]?.text;cw.sendChat(p);return {palette,chat:cw.chatTab.chatMessages.slice(-1)[0]?.text}})()`);
    record(input,result);
  }
  await a.js(`peer.networkService.manualSaveSnapshot();true`);await delay(1000);
  const b=await client();
  await b.js(`window.peer=ng.getComponent(document.querySelector('peer-menu'));peer.networkService.open('reviewB','DICE01','dice-review','');true`);
  await b.wait(`peer.networkService.isOpen && peer.networkService.peerContext.isRoom`);
  await b.wait(`ng.getComponent(document.querySelector('game-table')).currentTable.extendedDiceBotEnabled===true`);
  record('second client receives ON',await b.js(`({enabled:ng.getComponent(document.querySelector('game-table')).currentTable.extendedDiceBotEnabled,mode:ng.getComponent(document.querySelector('game-table')).currentTable.roomMode})`));
  await a.js(`options.toggleExtendedDiceBot();true`);
  await b.wait(`ng.getComponent(document.querySelector('game-table')).currentTable.extendedDiceBotEnabled===false`);
  record('second client receives OFF',true);
  record('DONE',true);
})().catch(e=>{record('ERROR',e.stack);process.exitCode=1}).finally(async()=>{
  fs.writeFileSync(path.join(dir,'browser-baseline.json'),JSON.stringify(output,null,2));
  for(const ws of sockets)ws.close();
  for(const child of children)child.kill('SIGTERM');
  await delay(300);
});
