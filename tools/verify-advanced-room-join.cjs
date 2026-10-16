const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { spawn, execFileSync } = require('child_process');
const WS = require('ws');
const yaml = require('js-yaml');
// Usage: node tools/verify-advanced-room-join.cjs <development-build-dir> [fixed|buggy|probe]
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'tmp/advanced-join');
fs.mkdirSync(out, {recursive:true});
const build = path.resolve(root, process.argv[2] || 'tmp/advanced-join/after');
const expected = process.argv[3] || 'fixed';
const mode = process.env.ROOM_MODE || 'advanced';
const backend = process.env.JOIN_BACKEND || 'websocket-relay';
const password = process.env.JOIN_PASSWORD || '';
const label = path.basename(build) + '-' + mode + '-' + backend + (password ? '-password' : '') + (process.env.CUSTOM_TABLE ? '-custom' : '') + (process.env.SAVE_SNAPSHOT ? '-snapshot' : '') + (process.env.CHECK_RECONNECT ? '-reconnect' : '');
const children = [], sockets = [], results = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
const origin = 'https://localhost:14329';
const log = (label, value) => { results.push({label, value}); console.log(label, JSON.stringify(value)); };
async function ready(url) {
  for (let n = 0; n < 100; n++) { try { if ((await fetch(url)).ok) return; } catch {} await delay(100); }
  throw Error('Not ready: ' + url);
}
async function client(port, name) {
  const fd = fs.openSync(path.join(out, `${label}-${name}.log`), 'w');
  children.push(spawn('/opt/google/chrome/chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check', '--window-size=1440,1000', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(out, 'profiles', name + Date.now())}`, 'about:blank'], {stdio:['ignore', fd, fd]}));
  await ready(`http://127.0.0.1:${port}/json/version`);
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {method:'PUT'})).json();
  const ws = new WS(target.webSocketDebuggerUrl); sockets.push(ws);
  await new Promise((r,j) => { ws.once('open',r); ws.once('error',j); });
  let id=0; const pending=new Map(), exceptions=[];
  ws.on('message', raw => {
    const m=JSON.parse(raw), p=pending.get(m.id);
    if(p) {clearTimeout(p.timer); pending.delete(m.id); m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}
    if(m.method==='Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails);
    if(m.method==='Page.javascriptDialogOpening') ws.send(JSON.stringify({id:++id,method:'Page.handleJavaScriptDialog',params:{accept:false}}));
  });
  const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>{pending.delete(n);reject(Error('CDP timeout '+method));},15000);pending.set(n,{resolve,reject,timer});ws.send(JSON.stringify({id:n,method,params}));});
  const js=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result?.value;};
  const wait=async expression=>{for(let n=0;n<100;n++){if(await js(expression))return;await delay(150);}throw Error('Wait timeout '+expression);};
  const click=async expression=>{
    const p=await js(`(()=>{const e=(${expression});if(!e)throw Error('Missing click target');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);return {x,y,hit:e===h||e.contains(h)};})()`);
    assert(p.hit, 'Click blocked: '+expression);
    for(const type of ['mousePressed','mouseReleased'])await call('Input.dispatchMouseEvent',{type,x:p.x,y:p.y,button:'left',clickCount:1});
    await delay(150);
  };
  await call('Runtime.enable'); await call('Page.enable');
  await call('Page.navigate',{url:origin});
  await wait(`!!window.ng && !!document.querySelector('peer-menu') && !!document.querySelector('game-table')`);
  await delay(1600);
  await js(`(()=>{document.querySelector('modal .title-button button')?.click();const s=document.createElement('style');s.textContent='modal:not(:has(lobby)):not(:has(room-setting)):not(:has(password-check)):not(:has(re-connect)){display:none!important}';document.head.append(s);window.app=ng.getComponent(document.querySelector('app-root'));window.peer=ng.getComponent(document.querySelector('peer-menu'));window.gt=ng.getComponent(document.querySelector('game-table'));return true;})()`);
  const state=()=>js(`({mode:gt.currentTable.roomMode,id:gt.currentTable.identifier,version:gt.currentTable.version,selector:gt.tableSelecter.viewTableIdentifier,advanced:app.isAdvancedRoom,badge:!!document.querySelector('.advanced-room-badge'),body:document.body.classList.contains('udonarium-advanced-room'),dice:gt.currentTable.diceCutinEnabled,cutin:ng.getComponent(document.querySelector('dice-cutin')).table?.identifier})`);
  return {js,call,wait,click,state,exceptions,name};
}
const button=(selector,text)=>`[...document.querySelectorAll('${selector} button')].find(b=>b.textContent.trim()===${JSON.stringify(text)})`;
async function lobby(s) {
  await s.wait(`(${button('peer-menu','ロビー（ルーム一覧）を表示')})?.matches(':enabled')`);
  await s.click(button('peer-menu','ロビー（ルーム一覧）を表示'));
  await s.wait(`!!document.querySelector('lobby')`);
}
async function create(s, mode, room) {
  await lobby(s);
  await s.click(button('lobby','新しいルームを作成する'));
  await s.wait(`!!document.querySelector('room-setting')`);
  await s.js(`(()=>{const e=document.querySelector('room-setting input');e.value=${JSON.stringify(room)};e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  if(password)await s.js(`(()=>{const e=document.querySelector('room-setting input[autocomplete="new-password"]');e.value=${JSON.stringify(password)};e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  if(mode==='advanced')await s.click(`document.querySelector('room-setting .room-mode-card.advanced input')`);
  await s.click(button('room-setting','新しいルームを作成'));
  await s.wait(`peer.networkService.isOpen && peer.networkService.peerContext.roomName===${JSON.stringify(room)}`);
  await delay(1000);
}
async function join(s, room) {
  await lobby(s);
  await s.wait(`!ng.getComponent(document.querySelector('lobby')).isReloading`);
  await s.wait(`[...document.querySelectorAll('lobby tr')].some(tr=>tr.textContent.includes(${JSON.stringify(room)})&&tr.querySelector('button'))`);
  await s.click(`[...document.querySelectorAll('lobby tr')].find(tr=>tr.textContent.includes(${JSON.stringify(room)})&&tr.querySelector('button')).querySelector('button')`);
  if(password){
    await s.wait(`!!document.querySelector('password-check input')`);
    await s.js(`(()=>{const e=document.querySelector('password-check input');e.value=${JSON.stringify(password)};e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    await s.click(button('password-check','入室'));
  }
  await s.wait(`peer.networkService.isOpen && peer.networkService.peerContext.roomName===${JSON.stringify(room)}`);
  await delay(3000);
}
(async()=>{
  const server=path.join(out,'server-'+Date.now());
  fs.mkdirSync(path.join(server,'data'),{recursive:true});
  fs.mkdirSync(path.join(server,'dist'),{recursive:true});
  fs.copyFileSync(path.join(root,'unified-server.js'),path.join(server,'unified-server.js'));
  fs.symlinkSync(path.join(root,'signaling-server'),path.join(server,'signaling-server'),'dir');
  for(const f of ['server-cert.pem','server-key.pem'])fs.copyFileSync(path.join(root,'data',f),path.join(server,'data',f));
  const dist=path.join(server,'dist/udonarium-lycoris');
  fs.cpSync(fs.existsSync(path.join(build,'browser/index.html'))?path.join(build,'browser'):build,dist,{recursive:true});
  const config=path.join(dist,'assets/config.yaml'), c=yaml.load(fs.readFileSync(config,'utf8'));
  c.backend={...(c.backend||{}),mode:backend};
  fs.writeFileSync(config,yaml.dump(c));
  const fd=fs.openSync(path.join(out,label+'-server.log'),'w');
  const serverEnv={...process.env,PORT:'14329'};
  if(backend==='skyway2023'){
    const configured=execFileSync('systemctl',['--user','show','udonarium-lycoris.service','-p','Environment','--value'],{encoding:'utf8'});
    for(const m of configured.matchAll(/(?:^|\s)"?(SKYWAY_APP_ID|SKYWAY_SECRET_KEY)=([^"\s]+)"?/g))serverEnv[m[1]]=m[2];
    assert(serverEnv.SKYWAY_APP_ID&&serverEnv.SKYWAY_SECRET_KEY,'Local test SkyWay app must be configured');
  }
  children.push(spawn(process.execPath,[path.join(server,'unified-server.js')],{cwd:server,env:serverEnv,stdio:['ignore',fd,fd]}));
  await ready(origin+'/v1/status');
  const a=await client(19481,'host'), b=await client(19482,'player');
  const room='Advanced'+Date.now().toString().slice(-6);
  await create(a,mode,room);
  if(process.env.CUSTOM_TABLE==='1'){
    await a.js(`app.open('GameTableSettingComponent');true`);
    await a.wait(`!!document.querySelector('game-table-setting')`);
    await a.js(`ng.getComponent(document.querySelector('game-table-setting')).createGameTable();true`);
    await a.wait(`gt.currentTable.identifier!=='gameTable'`);
    await delay(300);
  }
  if(process.env.SAVE_SNAPSHOT==='1'){
    assert(await a.js(`peer.networkService.manualSaveSnapshot()`));
    await delay(1000);
  }
  log('host-created',await a.state());
  const originalHost=await a.state();
  if(process.env.STALE_PLAYER!=='0')await b.js(`(()=>{gt.currentTable.roomMode=${JSON.stringify(mode==='advanced'?'standard':'advanced')};for(let i=0;i<12;i++){gt.currentTable.gridColor=i%2?'#ff0000':'#000000';gt.tableSelecter.tableGridDummy=i%2===0;}return true;})()`);
  log('player-before',await b.state());
  await join(b,room);
  if(expected==='fixed')await b.wait(`gt.currentTable.roomMode===${JSON.stringify(mode)} && gt.currentTable.identifier===${JSON.stringify(originalHost.id)}`);
  log('host-after',await a.state());log('player-after',await b.state());
  await b.js(`(()=>{const svc=app.chatMessageService;const tab=svc.chatTabs[0];svc.sendMessage(tab,'2d6+1>=1',{ID:'SwordWorld2.5',name:'SwordWorld2.5',COMMAND_PATTERN:/^[0-9]+D/i},peer.myPeer?.identifier||gt.tabletopService.peerCursors.find(c=>c.peerId===peer.networkService.peerId)?.identifier,null,0);return true;})()`);
  await delay(1200);
  log('cutin',await b.js(`({active:ng.getComponent(document.querySelector('dice-cutin')).active,card:!!document.querySelector('.dice-cutin-overlay .cutin-card'),messages:app.chatMessageService.chatTabs[0]?.chatMessages.slice(-3).map(m=>m.text)})`));
  log('exceptions',{host:a.exceptions.map(e=>e.exception?.description||e.text),player:b.exceptions.map(e=>e.exception?.description||e.text)});
  if(expected==='fixed'){
    const s=await b.state(), advanced=mode==='advanced';
    assert.equal(s.mode,mode);assert.equal(s.id,originalHost.id);assert.equal(s.selector,originalHost.selector);
    assert.equal(s.advanced,advanced);assert.equal(s.badge,advanced);assert.equal(s.body,advanced);
    assert.equal(await b.js(`ng.getComponent(document.querySelector('dice-cutin')).active && !!document.querySelector('.dice-cutin-overlay .cutin-card')`),advanced);
    assert.equal((await a.state()).mode,mode);
    await delay(4000);
    assert.equal(await b.js(`!!document.querySelector('.dice-cutin-overlay')`),false);
    if(process.env.CHECK_RECONNECT==='1'){
      await b.js(`peer.showReConnect();true`);
      await b.wait(`!!document.querySelector('re-connect') && !ng.getComponent(document.querySelector('re-connect')).isReloading`);
      await b.click(button('re-connect','切断実行'));
      await b.wait(`peer.networkService.isOpen`);
      await b.click(button('re-connect','再接続実行'));
      await b.wait(`gt.currentTable.roomMode===${JSON.stringify(mode)} && gt.currentTable.identifier===${JSON.stringify(originalHost.id)}`);
      await delay(500);
      log('manual-reconnect',await b.state());
      assert.equal((await b.state()).badge,advanced);
    }
    assert.equal(a.exceptions.length+b.exceptions.length,0);
    log('PASS', {mode,backend,password:!!password,customTable:!!process.env.CUSTOM_TABLE});
  } else if(expected==='buggy') {
    assert.notEqual((await b.state()).mode,mode);
    log('BUG_REPRODUCED',true);
  }
})().catch(e=>{console.error(e);log('error',e.stack);process.exitCode=1;}).finally(async()=>{
  fs.writeFileSync(path.join(out,label+'-results.json'),JSON.stringify(results,null,2));
  for(const ws of sockets)ws.close();for(const child of children)child.kill('SIGTERM');await delay(500);
});
