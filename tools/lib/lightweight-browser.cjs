const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),WS=require('ws'),yaml=require('js-yaml');
const root=path.resolve(__dirname,'../..'),delay=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(build,label,port=14489,cdp=19591,options={}){
  build=path.resolve(root,build);const out=path.join(root,'tmp/lightweight',label+'-'+Date.now());
  const server=path.join(out,'server'),web=path.join(server,'dist/udonarium-lycoris');fs.mkdirSync(path.join(web,'assets'),{recursive:true});
  fs.copyFileSync(options.serverSource||path.join(root,'unified-server.js'),path.join(server,'unified-server.js'));
  for(const name of ['node_modules','signaling-server'])fs.symlinkSync(path.join(root,name),path.join(server,name),'dir');
  for(const name of fs.readdirSync(build))if(name!=='assets')fs.symlinkSync(path.join(build,name),path.join(web,name));
  for(const name of fs.readdirSync(path.join(build,'assets')))if(name!=='config.yaml')fs.symlinkSync(path.join(build,'assets',name),path.join(web,'assets',name));
  const cfg=yaml.load(fs.readFileSync(path.join(build,'assets/config.yaml'),'utf8'));cfg.backend={mode:'websocket-relay',url:''};cfg.webrtc={key:'',signalingUrl:`ws://localhost:${port}/signaling`};
  fs.writeFileSync(path.join(web,'assets/config.yaml'),yaml.dump(cfg));const children=[],clients=[];
  const log=fs.openSync(path.join(out,'server.log'),'w');children.push(spawn(process.execPath,[path.join(server,'unified-server.js')],{cwd:server,env:{...process.env,PORT:String(port)},stdio:['ignore',log,log]}));
  async function ready(url){for(let n=0;n<100;n++){try{if((await fetch(url)).ok)return;}catch{}await delay(100);}throw Error('Not ready '+url);}
  await ready(`http://localhost:${port}/v1/status`);
  async function browser(name='main',options={}){
    const fd=fs.openSync(path.join(out,name+'.log'),'w'),browserPort=cdp+clients.length;
    children.push(spawn('/opt/google/chrome/chrome',['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--window-size=1440,1000',`--remote-debugging-port=${browserPort}`,`--user-data-dir=${path.join(out,name+'-profile')}`,'about:blank'],{stdio:['ignore',fd,fd]}));
    await ready(`http://127.0.0.1:${browserPort}/json/version`);
    const target=await(await fetch(`http://127.0.0.1:${browserPort}/json/new?about:blank`,{method:'PUT'})).json(),ws=new WS(target.webSocketDebuggerUrl);
    await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)});let id=0;const pending=new Map(),exceptions=[],requests=[];
    ws.on('message',raw=>{const m=JSON.parse(raw),p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails);if(m.method==='Network.requestWillBeSent')requests.push(m.params.request.url);});
    const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>{pending.delete(n);reject(Error(method+' timeout'))},45000);pending.set(n,{resolve,reject,timer});ws.send(JSON.stringify({id:n,method,params}));});
    const js=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result?.value;};
    const wait=async(expression,attempts=250)=>{for(let n=0;n<attempts;n++){if(await js(expression))return;await delay(100)}throw Error('Wait '+expression);};
    const s={ws,js,wait,call,exceptions,requests,name};clients.push(s);
    await call('Runtime.enable');await call('Page.enable');await call('Network.enable');await call('Performance.enable');
    if(options.before)await call('Page.addScriptToEvaluateOnNewDocument',{source:options.before});
    await call('Page.navigate',{url:`http://localhost:${port}/`});await call('Page.bringToFront');
    await wait("!!window.ng && !!document.querySelector('game-table') && !!document.querySelector('game-character')");
    await js("window.app=ng.getComponent(document.querySelector('app-root'));window.gt=ng.getComponent(document.querySelector('game-table'));window.peer=ng.getComponent(document.querySelector('peer-menu'));document.querySelector('modal .title-button button')?.click();const style=document.createElement('style');style.textContent='modal,.modal-background{display:none!important}';document.head.append(style);true");
    return s;
  }
  return {root,out,web,server,port,origin:`http://localhost:${port}`,browser,clients,children,delay,close:async()=>{for(const s of clients)s.ws.close();for(const child of children)child.kill('SIGTERM');await delay(300);}};
}
module.exports={fixture,delay,root};
