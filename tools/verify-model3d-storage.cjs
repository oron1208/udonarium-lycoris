// Isolated real-browser acceptance test. Never deploys or writes to the live data/dist trees.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const WS = require('ws');
const yaml = require('js-yaml');
const JSZip = require('jszip');
const root = path.resolve(__dirname, '..');
const build = path.resolve(root, process.argv[2] || 'tmp/spike-3d/model-storage-dev/browser');
const out = path.join(root, 'tmp/spike-3d', 'storage-' + Date.now());
const origin = 'http://localhost:14449';
const children = [], clients = [], results = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = (name, value) => { results.push({ name, value }); console.log(name, JSON.stringify(value)); };
fs.mkdirSync(out, { recursive: true });
async function ready(url) {
  for (let n = 0; n < 150; n++) { try { if ((await fetch(url)).ok) return; } catch {} await delay(100); }
  throw Error('Not ready: ' + url);
}
async function browser(port, name) {
  const fd = fs.openSync(path.join(out, name + '.log'), 'w');
  const profile = path.join(out, name + '-profile');
  children.push(spawn('/opt/google/chrome/chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--window-size=1440,1000', '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', fd, fd] }));
  await ready('http://127.0.0.1:' + port + '/json/version');
  const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WS(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let id = 0; const pending = new Map(), exceptions = [], logs = [];
  ws.on('message', raw => {
    const m = JSON.parse(raw), p = pending.get(m.id);
    if (p) { clearTimeout(p.timer); pending.delete(m.id); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails);
    if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 800));
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id, timer = setTimeout(() => { pending.delete(n); reject(Error(method + ' timeout')); }, 110000);
    pending.set(n, { resolve, reject, timer }); ws.send(JSON.stringify({ id: n, method, params }));
  });
  const js = async expression => {
    const value = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (value.exceptionDetails) throw Error(JSON.stringify(value.exceptionDetails).slice(0, 800));
    return value.result?.value;
  };
  const wait = async (expression, attempts = 200) => {
    for (let n = 0; n < attempts; n++) { if (await js(expression)) return; await delay(150); }
    throw Error(name + ' wait timeout: ' + expression);
  };
  const s = { ws, js, call, wait, exceptions, logs, name };
  clients.push(s);
  await call('Runtime.enable'); await call('Page.enable'); await call('Network.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('lycoris.experimental.model3d', '1');" });
  return s;
}
async function boot(s) {
  await s.call('Page.navigate', { url: origin });
  await s.wait("!!window.ng && !!window.__spike3d && !!document.querySelector('peer-menu')");
  await s.js(`(() => {
    window.app = ng.getComponent(document.querySelector('app-root'));
    window.gt = ng.getComponent(document.querySelector('game-table'));
    window.peer = ng.getComponent(document.querySelector('peer-menu'));
    document.querySelector('modal .title-button button')?.click();
    const style = document.createElement('style'); style.textContent='modal{display:none!important}'; document.head.append(style);
    window.modelEvents = [];
    const cb = peer.networkService.callback, onData = cb.onData;
    cb.onData = (id, events) => { modelEvents.push(...events.map(e=>e.eventName).filter(n=>n.includes('MODEL3D') || n.includes('model3d-'))); return onData(id, events); };
    return true;
  })()`);
  await s.wait('gt.characters.length > 0');
}
async function connect(s, user) {
  await s.js(`peer.networkService.open(${JSON.stringify(user)}, '3DM', 'ModelStorageTest', ''); true`);
  await s.wait("peer.networkService.isOpen && peer.networkService.peerContext.roomName === 'ModelStorageTest'");
}
(async () => {
  const server = path.join(out, 'server');
  fs.mkdirSync(path.join(server, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(root, 'unified-server.js'), path.join(server, 'unified-server.js'));
  for (const dir of ['node_modules', 'signaling-server']) fs.symlinkSync(path.join(root, dir), path.join(server, dir), 'dir');
  fs.symlinkSync(build, path.join(server, 'dist/udonarium-lycoris'), 'dir');
  const config = path.join(build, 'assets/config.yaml');
  const cfg = yaml.load(fs.readFileSync(config, 'utf8'));
  cfg.backend = { mode: 'websocket-signaling', url: '' };
  cfg.webrtc = { key: '', signalingUrl: 'ws://localhost:14449/signaling', iceServers: [] };
  fs.writeFileSync(config, yaml.dump(cfg));
  const fd = fs.openSync(path.join(out, 'server.log'), 'w');
  children.push(spawn(process.execPath, [path.join(server, 'unified-server.js')], { cwd: server, env: { ...process.env, PORT: '14449' }, stdio: ['ignore', fd, fd] }));
  await ready(origin + '/v1/status');
  const a = await browser(19561, 'owner'); await boot(a); await connect(a, 'ModelOwner');
  // The existing fallback signaling transport has no perfect-negotiation/glare handler.
  // Choose one offerer in this fixture; the real ordered RTCDataChannel still carries all model chunks.
  await a.js('peer.networkService.connection.shouldAutoConnectPeer=()=>false;true');
  // Unknown GLB chunks must be ignored by loaders. Random padding exercises >16 transfer chunks/window ACKs.
  const original = fs.readFileSync(path.join(root, 'tmp/spike-3d/front-positive-z.glb'));
  const padding = crypto.randomBytes(1024*1024), header=Buffer.alloc(8);
  header.writeUInt32LE(padding.length,0);header.writeUInt32LE(0x554e4b4e,4);
  const bytes = Buffer.concat([original,header,padding]);bytes.writeUInt32LE(bytes.length,8);
  const fixturePath = path.join(out,'front-large-transfer.glb');fs.writeFileSync(fixturePath,bytes);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  await a.js(`(() => { const menu = [...document.querySelectorAll('li')].find(e=>e.textContent.includes('画像')); menu.click(); return true; })()`);
  await a.wait("!!document.querySelector('file-storage')");
  await a.js("[...document.querySelectorAll('file-storage button')].find(e=>e.textContent.trim()==='3D').click(); true");
  const doc = await a.call('DOM.getDocument');
  const input = await a.call('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'file-storage input[accept=".glb,.gltf,.vrm,.fbx"]' });
  await a.call('DOM.setFileInputFiles', { files: [fixturePath], nodeId: input.nodeId });
  await a.wait(`__spike3d.listModels().some(m=>m.id==='${hash}' && m.thumb)`);
  record('import-content-hash', { hash, models: await a.js('__spike3d.listModels().map(({thumb,...m})=>m)') });
  const characterId = await a.js(`(() => { const c=gt.characters[0].constructor.create('Portable3D',1,'');c.location={name:'table',x:350,y:250};window.fixture=c;return c.identifier; })()`);
  assert.equal(await a.js(`__spike3d.assignModel('${hash}', '${characterId}')`), true);
  await a.wait(`__spike3d.isBound('${characterId}')`);
  const xml = await a.js('fixture.toXml()');
  assert(xml.includes(`model3dIdentifier="${hash}"`));
  const modelPath = path.join(server, 'data/media/model', hash);
  for (let n=0; n<100 && !fs.existsSync(modelPath); n++) await delay(100);
  assert.equal(fs.readFileSync(modelPath).compare(bytes), 0);
  const storedResponse = await fetch(origin + '/api/media/model/' + hash);
  assert.equal(Buffer.compare(Buffer.from(await storedResponse.arrayBuffer()),bytes),0);
  const bad = await fetch(origin+'/api/media/model/'+'0'.repeat(64), {method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:bytes});
  assert.equal(bad.status, 409);
  record('server-bytes-and-hash-rejection', true);

  // Real late join in a different browser profile; HTTP is blocked to require WebRTC transfer.
  const b = await browser(19562, 'joiner');
  await b.call('Network.setBlockedURLs', { urls: ['*/api/media/model/*'] });
  await boot(b);
  const privateHash=await b.js(`__spike3d.registerModel('private-from-another-room.gltf','{"asset":{"version":"2.0"},"scenes":[{}],"scene":0}',1)`);
  await connect(b, 'ModelJoiner');
  await b.wait(`gt.characters.some(c=>c.identifier==='${characterId}')`);
  await b.wait(`__spike3d.isBound('${characterId}')`, 500);
  await b.wait(`!!document.querySelector('game-character[data-identifier="${characterId}"].spike3d-bound') && __spike3d.info().triangles>0`);
  const events = await b.js('modelEvents');
  assert(events.includes('START_MODEL3D'), 'late join did not use peer transfer');
  record('late-join-peer-transfer', { bound: await b.js('__spike3d.boundInfo()'), events: [...new Set(events)] });
  assert(!(await a.js('__spike3d.listModels().map(m=>m.id)')).includes(privateHash),'unreferenced cache leaked into another room catalog');
  record('unreferenced-cache-not-announced',true);
  await a.js(`fixture.model3dScale=160; fixture.model3dYaw=70;fixture.rotate=45;true`);
  await b.wait(`Math.abs(__spike3d.boundInfo().find(m=>m.id==='${characterId}').scale-1.6)<0.001`);
  assert.equal((await b.js(`__spike3d.boundInfo().find(m=>m.id==='${characterId}')`)).rot.x, 0);
  record('remote-size-and-yaw', true);

  // Reload receives the room objects again, but must recover model bytes from IndexedDB.
  await boot(b); await connect(b, 'ModelJoinerReload');
  await b.wait(`__spike3d.isBound('${characterId}')`, 500);
  assert(!(await b.js('modelEvents')).includes('START_MODEL3D'), 'reload fetched model again instead of using cache');
  record('reload-from-indexeddb', true);

  // Same-size cache corruption must be rejected and recovered over the peer path, not silently rendered.
  await b.js(`new Promise((resolve,reject)=>{const open=indexedDB.open('Udonarium-IDB-MediaCacheModel',1);open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result,tx=db.transaction('ObjectStore','readwrite'),store=tx.objectStore('ObjectStore'),get=store.get('${hash}');get.onsuccess=()=>{const entry=get.result;entry.blob=new Blob([new Uint8Array(entry.size)]);store.put(entry,'${hash}');};tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=()=>reject(tx.error);};})`);
  await boot(b);await connect(b,'ModelJoinerCorrupt');
  await b.wait(`__spike3d.isBound('${characterId}')`,500);
  assert((await b.js('modelEvents')).includes('START_MODEL3D'),'corrupt cache did not recover via peers');
  record('corrupt-cache-peer-recovery',true);

  // Export the real character ZIP, then import in a fresh offline browser.
  const downloads = path.join(out, 'downloads');fs.mkdirSync(downloads);
  await a.call('Page.setDownloadBehavior', { behavior:'allow',downloadPath:downloads });
  await a.js(`app.saveDataService.saveGameObjectAsync(fixture,'portable3d',()=>{})`);
  let zipPath;
  for (let n=0;n<150;n++) { const file=fs.readdirSync(downloads).find(n=>n.endsWith('.zip'));if(file){zipPath=path.join(downloads,file);break;}await delay(100); }
  assert(zipPath,'ZIP download missing');
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  const modelEntry = Object.keys(zip.files).find(n=>n.startsWith('models/'+hash+'/')&&!zip.files[n].dir);
  assert(modelEntry,'ZIP missing model bytes');
  assert.equal(Buffer.compare(await zip.files[modelEntry].async('nodebuffer'),bytes),0);
  const c = await browser(19563,'offline');await c.call('Network.setBlockedURLs',{urls:['*/api/media/model/*']});await boot(c);
  await c.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:800,y:500});
  await c.call('Input.dispatchMouseEvent',{type:'mousePressed',x:800,y:500,button:'left',buttons:1,clickCount:1});
  await c.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:800,y:500,button:'left',buttons:0,clickCount:1});
  const zipBase64=fs.readFileSync(zipPath).toString('base64');
  await c.js(`(() => {const bytes=Uint8Array.from(atob('${zipBase64}'),c=>c.charCodeAt(0));app.handleFileSelect({target:{files:[new File([bytes],'portable3d.zip',{type:'application/zip'})],value:''}});return true;})()`);
  await c.wait(`gt.characters.some(c=>c.name==='Portable3D' && c.model3dIdentifier==='${hash}' && __spike3d.isBound(c.identifier))`,500);
  await c.wait(`!!document.querySelector('game-character.spike3d-bound') && __spike3d.info().triangles>0`);
  record('portable-zip-offline-restore', { entry:modelEntry, bound:await c.js('__spike3d.boundInfo()') });

  await a.js("fixture.setLocation('graveyard');true");
  await b.wait(`__spike3d.boundInfo().find(m=>m.id==='${characterId}')?.visible===false`);
  await a.js("fixture.setLocation('table');true");
  await b.wait(`__spike3d.boundInfo().find(m=>m.id==='${characterId}')?.visible===true`);
  record('inventory-hidden-and-returned',true);

  // Equal names do not overwrite different content; removal and stale async assignments stay detached.
  const json = JSON.stringify({asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{name:'Different'}]});
  const duplicateIds = await a.js(`(async()=>{const first=await __spike3d.registerModel('same.gltf',${JSON.stringify(json)},1);const second=await __spike3d.registerModel('same.gltf',${JSON.stringify(json+' ')},1);return[first,second];})()`);
  assert.notEqual(duplicateIds[0],duplicateIds[1]);
  record('same-name-distinct-content', duplicateIds);
  await a.js(`__spike3d.unbindModel('${characterId}');true`);
  await b.wait(`!__spike3d.isBound('${characterId}')`);
  await a.js(`__spike3d.assignModel('${hash}','${characterId}')`);
  await b.wait(`__spike3d.isBound('${characterId}')`);
  const race = await a.js(`(async()=>{const pending=__spike3d.assignModel('${duplicateIds[0]}','${characterId}');__spike3d.unbindModel('${characterId}');await pending;return{bound:__spike3d.isBound('${characterId}'),id:fixture.model3dIdentifier};})()`);
  assert.equal(race.bound,false);assert.equal(race.id,'');
  record('remote-unbind-rebind-and-race', race);
  const incomplete=await a.js(`app.ngZone.run(()=>app.saveDataService.modelFilesForXml('<character model3dIdentifier="${'0'.repeat(64)}" model3dName="missing.glb"></character>'))`);
  assert.equal(incomplete,null);
  await a.wait("[...document.querySelectorAll('modal')].map(m=>m.textContent).join(' ').includes('保存を中止')");
  record('missing-model-aborts-backup-with-notice',true);
  for(const s of clients) assert.equal(s.exceptions.length,0,s.name+' runtime exceptions: '+JSON.stringify(s.exceptions));
  record('PASS',{checks:results.length,backend:'websocket-signaling (real WebRTC DataChannel)',runtimeExceptions:0});
})().catch(error=>{record('FAIL',String(error.stack));process.exitCode=1;}).finally(async()=>{
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));
  for(const s of clients){fs.writeFileSync(path.join(out,s.name+'-console.json'),JSON.stringify(s.logs,null,2));try{s.ws.close();}catch{}}
  for(const child of children)try{child.kill('SIGTERM');}catch{}
  await delay(300);console.log('EVIDENCE',out);
});
