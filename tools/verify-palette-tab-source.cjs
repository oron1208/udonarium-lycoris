// Current-tab source editing regression: isolated relay, trusted mouse/keyboard.
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const WS = require('ws');
const root = path.resolve(__dirname, '..');
const build = path.resolve(root, process.argv[2] || 'tmp/palette-tab-source/dev/browser');
const action = 'tab-source';
const roomMode = 'local';
const stamp = Date.now();
const out = path.join(root, 'tmp/palette-tab-source', `${stamp}-${action}-${roomMode}`);
fs.mkdirSync(out, {recursive:true});
const children = [], clients = [], results = [];
const origin = 'https://localhost:14439';
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
(async()=>{
  const server=path.join(out,'server');fs.mkdirSync(path.join(server,'data'),{recursive:true});fs.mkdirSync(path.join(server,'dist'));
  fs.copyFileSync(path.join(root,'unified-server.js'),path.join(server,'unified-server.js'));
  for(const dir of ['node_modules','signaling-server'])fs.symlinkSync(path.join(root,dir),path.join(server,dir),'dir');
  for(const file of ['server-cert.pem','server-key.pem'])fs.copyFileSync(path.join(root,'data',file),path.join(server,'data',file));
  fs.symlinkSync(build,path.join(server,'dist/udonarium-lycoris'),'dir');
  const fd=fs.openSync(path.join(out,'server.log'),'w');
  children.push(spawn(process.execPath,[path.join(server,'unified-server.js')],{cwd:server,env:{...process.env,PORT:'14439'},stdio:['ignore',fd,fd]}));
  await ready('http://localhost:14440/v1/status');
  const s=await client(19551,'palette');await s.wait('!!window.ng');
  await s.js(`(()=>{window.app=ng.getComponent(document.querySelector('app-root'));const gc=ng.getComponent(document.querySelector('game-character'));gc.showChatPalette(gc.gameCharacter);return true;})()`);
  await s.wait(`!!document.querySelector('palette-browser')`);
  await s.js(`(()=>{window.pb=ng.getComponent(document.querySelector('palette-browser'));const style=document.createElement('style');style.textContent='modal,.modal-background{display:none!important}.draggable-panel:not(:has(chat-palette)){display:none!important}';document.head.append(style);const p=document.querySelector('chat-palette').closest('.draggable-panel');p.style.left='620px';p.style.top='25px';p.style.width='650px';p.style.height='930px';pb.managing=true;ng.applyChanges(pb);return true;})()`);
  const source='//能力=5\n共通コマンド\n// @tab 戦闘\n// @fold 攻撃\n2d6+{能力}\n// @end\n\n// @tab 台詞\nこんにちは\n// @tab 空';
  async function reset(value=source,name='戦闘'){
    await s.js(`(()=>{pb.cancel();pb.readOnly=false;pb.palette.setPalette(${JSON.stringify(value)});pb.query='';pb.managing=true;const t=pb.document.tabs.find(t=>t.name===${JSON.stringify(name)});pb.selectTab(t?.start??-2);ng.applyChanges(pb);return true;})()`);
    await delay(80);
  }
  const read=()=>s.js('pb.source');
  const edit=()=>s.click(button('palette-browser','現タブ全文編集'));
  const body=()=>s.js(`document.querySelector('palette-browser textarea[name=body]')?.value`);
  const type=async text=>{
    await s.click(`document.querySelector('palette-browser textarea[name=body]')`);
    await s.call('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
    await s.call('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
    if(text)await s.call('Input.insertText',{text});
    else await s.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
  };
  const save=()=>s.click(button('palette-browser form.editor','保存'));
  const cancel=()=>s.click(button('palette-browser form.editor','キャンセル'));
  await reset(source,'不存在');
  assert(await s.js(`(${button('palette-browser','現タブ全文編集')}).matches(':disabled')`));record('all-view-disabled',true);
  await s.click(`[...document.querySelectorAll('palette-browser .tabs button')].find(b=>b.textContent.trim()==='戦闘')`);
  await edit();assert.equal(await body(),'// @fold 攻撃\n2d6+{能力}\n// @end\n');
  assert((await s.js(`document.querySelector('palette-browser form.editor strong').textContent`)).includes('戦闘'));
  await type('// @fold 新しい攻撃\n2d6+9\n// @end\n\n1d6 回復');
  const shot=await s.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'tab-editor.png'),Buffer.from(shot.data,'base64'));
  await save();
  const edited='//能力=5\n共通コマンド\n// @tab 戦闘\n// @fold 新しい攻撃\n2d6+9\n// @end\n\n1d6 回復\n// @tab 台詞\nこんにちは\n// @tab 空';
  assert.equal(await read(),edited);assert.equal(await s.js('pb.activeTab.name'),'戦闘');record('named-tab-only-save',true);
  await edit();assert.equal(await body(),'// @fold 新しい攻撃\n2d6+9\n// @end\n\n1d6 回復');await type('破棄する');await cancel();assert.equal(await read(),edited);record('reopen-and-cancel',true);
  await reset();await edit();await type('');await save();assert.equal(await read(),'//能力=5\n共通コマンド\n// @tab 戦闘\n// @tab 台詞\nこんにちは\n// @tab 空');assert.equal(await s.js('pb.activeTab.name'),'戦闘');record('clear-body-keeps-tab',true);
  await reset(source,'共通');await edit();assert.equal(await body(),'//能力=5\n共通コマンド');await type('//能力=8\n共通だけ更新');await save();assert.equal(await read(),source.replace('//能力=5\n共通コマンド','//能力=8\n共通だけ更新'));record('common-tab-isolated',true);
  await reset(source,'空');await edit();assert.equal(await body(),'');await type('追加コマンド');await save();assert.equal(await read(),source+'\n追加コマンド');record('empty-last-tab',true);
  await reset();await s.js(`pb.query='こんにちは';ng.applyChanges(pb);true`);await edit();assert.equal(await body(),'// @fold 攻撃\n2d6+{能力}\n// @end\n');await cancel();record('search-does-not-limit-source',true);
  await reset();await edit();await type('2d6\n// @tab 別タブ\n1d6');await save();assert.equal(await read(),source);assert((await s.js('pb.error')).includes('タブ区切り'));assert((await body()).includes('別タブ'));await cancel();record('reject-new-tab-boundary',true);
  await reset();await edit();await type('自分の未保存入力');await s.js(`pb.palette.setPalette(${JSON.stringify(source+'\n別の人の更新')});true`);await delay(100);await save();assert.equal(await read(),source+'\n別の人の更新');assert((await s.js('pb.error')).includes('更新'));assert.equal(await body(),'自分の未保存入力');await cancel();record('concurrent-edit-protected',true);
  await reset();await s.click(button('palette-browser','全文テキスト編集'));assert.equal(await body(),source);await cancel();record('whole-source-editor-unchanged',true);
  await s.js(`pb.readOnly=true;pb.begin('tab-source');ng.applyChanges(pb);true`);assert.equal(await s.js('pb.form'),'');record('read-only-protected',true);
  await reset();await edit();await s.js(`document.querySelector('palette-browser').classList.add('vn-palette-theme');true`);
  record('dark-editor-colors',await s.js(`(()=>{const e=document.querySelector('palette-browser textarea');const c=getComputedStyle(e);return{color:c.color,background:c.backgroundColor};})()`));await cancel();
  assert.equal(s.exceptions.length,0);record('PASS',{uiCases:11,exceptions:s.exceptions});
})().catch(e=>{record('FAIL',e.stack);process.exitCode=1;}).finally(async()=>{
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));
  for(const s of clients)s.ws.close();for(const c of children)c.kill('SIGTERM');await delay(300);
  console.log('EVIDENCE',out);
});
