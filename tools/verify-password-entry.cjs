// Real keyboard/mouse regression check against an isolated relay, never live rooms.
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const WS = require('ws');
const root = path.resolve(__dirname, '..');
const build = path.resolve(root, process.argv[2] || 'dist/udonarium-lycoris');
const action = process.argv[3] || 'enter';
const roomMode = process.env.ROOM_MODE || 'standard';
const expected = process.env.EXPECT || 'fixed';
const stamp = Date.now();
const out = path.join(root, 'tmp/password-entry', `${stamp}-${action}-${roomMode}`);
fs.mkdirSync(out, {recursive:true});
const children = [], clients = [], results = [];
const origin = 'https://localhost:14439';
const room = `Entry${stamp % 1000000}`, password = 'entry-test';
const delay = ms => new Promise(r => setTimeout(r, ms));
const record = (name, value) => { results.push({name, value}); console.log(name, JSON.stringify(value)); };
async function ready(url) {
  for(let i=0;i<100;i++) {try {if((await fetch(url)).ok)return;}catch{} await delay(100);}
  throw Error(`Not ready: ${url}`);
}
async function client(port, name) {
  const fd = fs.openSync(path.join(out, name+'.log'), 'w');
  const profile = path.join('/home/maco/.cache/lycoris-e2e', `password-${stamp}-${name}`);
  const child = spawn('/opt/google/chrome/chrome', ['--headless=new','--no-sandbox','--disable-gpu','--ignore-certificate-errors','--no-first-run','--no-default-browser-check','--window-size=1440,1000',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'about:blank'], {stdio:['ignore',fd,fd]});
  children.push(child);
  await ready(`http://127.0.0.1:${port}/json/version`);
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json();
  const ws = new WS(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  let id=0; const pending=new Map(), dialogs=[], exceptions=[], navs=[];
  const call=(method,params={})=>new Promise((resolve,reject)=>{
    const n=++id, timer=setTimeout(()=>{pending.delete(n);reject(Error('CDP timeout '+method));},15000);
    pending.set(n,{resolve,reject,timer});ws.send(JSON.stringify({id:n,method,params}));
  });
  ws.on('message',raw=>{
    const m=JSON.parse(raw), p=pending.get(m.id);
    if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}
    if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails);
    if(m.method==='Page.frameRequestedNavigation')navs.push(m.params);
    if(m.method==='Page.javascriptDialogOpening'){
      dialogs.push(m.params.type);
      call('Page.handleJavaScriptDialog',{accept:false}).catch(()=>{});
    }
    if(m.method==='Fetch.requestPaused')call('Fetch.fulfillRequest',{
      requestId:m.params.requestId,responseCode:200,
      responseHeaders:[{name:'Content-Type',value:'text/yaml'}],
      body:Buffer.from('backend:\n  mode: websocket-relay\n  url: ""\n').toString('base64')
    }).catch(()=>{});
  });
  const js=async expression=>{
    const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result?.value;
  };
  const wait=async expression=>{
    for(let i=0;i<110;i++){if(await js(expression))return;await delay(150);}
    throw Error('Wait timeout '+expression);
  };
  const click=async expression=>{
    const p=await js(`(()=>{const e=(${expression});if(!e)throw Error('Missing click target: '+${JSON.stringify(expression)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);return{x,y,hit:e===h||e.contains(h),hitTag:h?.tagName};})()`);
    assert(p.hit, 'Click blocked '+JSON.stringify(p)+' '+expression);
    for(const type of ['mousePressed','mouseReleased'])await call('Input.dispatchMouseEvent',{type,x:p.x,y:p.y,button:'left',clickCount:1});
    await delay(120);
  };
  const key=async (numpad=false)=>{
    await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:numpad?'NumpadEnter':'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r',isKeypad:numpad});
    await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:numpad?'NumpadEnter':'Enter',windowsVirtualKeyCode:13,isKeypad:numpad});
  };
  const s={ws,js,wait,click,key,call,dialogs,exceptions,navs};clients.push(s);
  await call('Runtime.enable');await call('Page.enable');
  await call('Fetch.enable',{patterns:[{urlPattern:'*/assets/config.yaml'}]});
  await call('Page.navigate',{url:origin});
  await wait(`!!document.querySelector('game-table') && !!document.querySelector('peer-menu')`);
  await delay(1700);
  await js(`(()=>{document.querySelector('modal .title-button button')?.click();const e=document.createElement('style');e.textContent='modal:not(:has(lobby)):not(:has(room-setting)):not(:has(password-check)){display:none!important}';document.head.append(e);return true;})()`);
  record(name+'-build',await js(`document.querySelector('script[src*="main"]').src`));
  return s;
}
const button=(scope,text)=>`[...document.querySelectorAll('${scope} button')].find(b=>b.textContent.trim()===${JSON.stringify(text)})`;
async function lobby(s){
  await s.wait(`(${button('peer-menu','ロビー（ルーム一覧）を表示')})?.matches(':enabled')`);
  await s.click(button('peer-menu','ロビー（ルーム一覧）を表示'));
  await s.wait(`!!document.querySelector('lobby')`);
}
const setInput=(s,selector,value)=>s.js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.focus();return true;})()`);
const joined=()=>`document.querySelector('peer-menu')?.textContent.includes(${JSON.stringify(room)})`;
(async()=>{
  const server=path.join(out,'server');fs.mkdirSync(path.join(server,'data'),{recursive:true});fs.mkdirSync(path.join(server,'dist'));
  fs.copyFileSync(path.join(root,'unified-server.js'),path.join(server,'unified-server.js'));
  for(const dir of ['node_modules','signaling-server'])fs.symlinkSync(path.join(root,dir),path.join(server,dir),'dir');
  for(const file of ['server-cert.pem','server-key.pem'])fs.copyFileSync(path.join(root,'data',file),path.join(server,'data',file));
  fs.symlinkSync(build,path.join(server,'dist/udonarium-lycoris'),'dir');
  const fd=fs.openSync(path.join(out,'server.log'),'w');
  children.push(spawn(process.execPath,[path.join(server,'unified-server.js')],{cwd:server,env:{...process.env,PORT:'14439'},stdio:['ignore',fd,fd]}));
  await ready('http://localhost:14440/v1/status');
  const a=await client(19551,'host');await lobby(a);
  await a.click(button('lobby','新しいルームを作成する'));
  await a.wait(`!!document.querySelector('room-setting input')`);
  await setInput(a,'room-setting input',room);
  if(action!=='no-password')await setInput(a,'room-setting input[autocomplete="new-password"]',password);
  if(roomMode==='advanced')await a.click(`document.querySelector('room-setting .room-mode-card.advanced input')`);
  await a.click(button('room-setting','新しいルームを作成'));await a.wait(joined());
  const b=await client(19552,'joiner');await lobby(b);
  const row=`[...document.querySelectorAll('lobby tr')].find(e=>e.textContent.includes(${JSON.stringify(room)})&&e.querySelector('button'))`;
  await b.wait(`!!(${row})`);
  await b.js(`(()=>{window.__entryAlive=true;window.__entryEvents=[];for(const type of ['submit','keydown','keyup'])document.addEventListener(type,e=>{if(e.target.closest('password-check'))window.__entryEvents.push({type,key:e.key,prevented:e.defaultPrevented,isTrusted:e.isTrusted});});window.addEventListener('beforeunload',()=>window.__entryEvents.push({type:'beforeunload'}));return true;})()`);
  await b.click(`(${row}).querySelector('button')`);
  if(action!=='no-password'){
    await b.wait(`!!document.querySelector('password-check input')`);
    record('password-dom',await b.js(`document.querySelector('password-check').outerHTML`));
    if(action==='wrong-then-enter'){
      await setInput(b,'password-check input','incorrect');await b.key();
      await b.wait(`document.querySelector('password-check')?.textContent.includes('パスワードが違います')`);
      assert.equal(b.dialogs.length,0);assert.equal(b.navs.length,0);
      record('wrong-password-stays',true);
    }
    await setInput(b,'password-check input',password);
    if(action==='click')await b.click(button('password-check','入室'));
    else await b.key(action==='numpad');
  }
  await delay(2600);
  const state=await b.js(`({alive:!!window.__entryAlive,joined:!!(${joined()}),events:window.__entryEvents,peers:document.querySelector('peer-menu')?.textContent.slice(0,450)})`);
  record('entry',{action,roomMode,expected,dialogs:b.dialogs,navs:b.navs,state,exceptions:[...a.exceptions,...b.exceptions]});
  if(expected==='buggy')assert(b.dialogs.length||b.navs.length||!state.alive,'Expected navigation bug');
  else {
    assert(state.alive);assert(state.joined);assert.equal(b.dialogs.length,0);assert.equal(b.navs.length,0);
    assert.equal(a.exceptions.length+b.exceptions.length,0);
    // Refresh protection must remain enabled once joined.
    await b.call('Page.reload');await delay(500);
    record('intentional-reload-dialog',b.dialogs);
    assert(b.dialogs.includes('beforeunload'),'Real departure still needs protection');
    assert(await b.js('!!window.__entryAlive'),'Cancel departure must keep the page');
  }
  record('PASS',{action,roomMode,expected});
})().catch(e=>{record('FAIL',e.stack);process.exitCode=1;}).finally(async()=>{
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));
  for(const s of clients)s.ws.close();for(const c of children)c.kill('SIGTERM');await delay(300);
  console.log('EVIDENCE',out);
});
