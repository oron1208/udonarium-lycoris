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
const build = path.resolve(root, process.argv[2] || 'tmp/spike-3d/axe-review-dev/browser');
const out = path.join(root, 'tmp/spike-3d', 'scene-browser-' + Date.now());
const origin = 'http://localhost:14469';
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
  const config = path.join(build, 'assets/config.yaml'), cfg = yaml.load(fs.readFileSync(config, 'utf8'));
  cfg.backend = { mode: 'websocket-relay', url: '' }; cfg.webrtc = { key: '', signalingUrl: 'ws://localhost:14469/signaling' };
  fs.writeFileSync(config, yaml.dump(cfg));
  const fd = fs.openSync(path.join(out, 'server.log'), 'w');
  children.push(spawn(process.execPath, [path.join(server, 'unified-server.js')], { cwd: server, env: { ...process.env, PORT: '14469' }, stdio: ['ignore', fd, fd] }));
  await ready(origin + '/v1/status');
  const a = await browser(19571, 'scene'); await boot(a);
  // A valid, self-contained glTF skin with one joint. Both copies must bind to their own joint.
  const bytes = Buffer.alloc(108);
  [-0.5,0,0, 0.5,0,0, 0,2,0].forEach((v,i) => bytes.writeFloatLE(v, i*4));
  for (let i=0;i<3;i++) bytes.writeFloatLE(1, 60+i*16);
  const gltf = { asset:{version:'2.0'}, scene:0, scenes:[{nodes:[0,1]}],
    nodes:[{name:'Hip'},{name:'RigMesh',mesh:0,skin:0}], skins:[{joints:[0]}],
    meshes:[{primitives:[{attributes:{POSITION:0,JOINTS_0:1,WEIGHTS_0:2},material:0}]}],
    materials:[{doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[1,0,0,1],metallicFactor:0}}],
    buffers:[{byteLength:108,uri:'data:application/octet-stream;base64,'+bytes.toString('base64')}],
    bufferViews:[{buffer:0,byteOffset:0,byteLength:36},{buffer:0,byteOffset:36,byteLength:24},{buffer:0,byteOffset:60,byteLength:48}],
    accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[-0.5,0,0],max:[0.5,2,0]},
      {bufferView:1,componentType:5123,count:3,type:'VEC4'},{bufferView:2,componentType:5126,count:3,type:'VEC4'}] };
  const id = await a.js(`__spike3d.registerModel('skin.gltf', ${JSON.stringify(JSON.stringify(gltf))}, 108)`);
  await a.js(`(async()=>{
    window.layer=gt.table3dSpike;
    window.ca=gt.characters[0].constructor.create('Skin A',1,'');ca.location={name:'table',x:350,y:250};
    window.cb=gt.characters[0].constructor.create('Skin B',1,'');cb.location={name:'table',x:500,y:250};
    await __spike3d.assignModel('${id}',ca.identifier);await __spike3d.assignModel('${id}',cb.identifier);
    window.ea=layer.boundModels.get(ca.identifier);window.eb=layer.boundModels.get(cb.identifier);
    window.original=layer.modelRegistry.get('${id}').scene;
    window.meshOf=root=>{let found;root.traverse(o=>{if(o.isSkinnedMesh)found=o});return found};
    window.ma=meshOf(ea.scene);window.mb=meshOf(eb.scene);window.mo=meshOf(original);
    return true;
  })()`);
  const ownership = await a.js(`(()=>{
    const owns=(entry,mesh)=>{let found=false;entry.scene.traverse(o=>{if(o===mesh.skeleton.bones[0])found=true});return found};
    return {a:owns(ea,ma),b:owns(eb,mb),different:ma.skeleton!==mb.skeleton && ma.skeleton!==mo.skeleton,
      geometry:ma.geometry===mb.geometry,bufferReleased:layer.modelRegistry.get('${id}').buffer===undefined};
  })()`);
  assert.deepEqual(ownership,{a:true,b:true,different:true,geometry:true,bufferReleased:true});
  record('real-gltf-skeleton-ownership',ownership);
  await a.wait('__spike3d.info().triangles>=2 && __spike3d.canvasPixels().total>10 && !!ea.element && !!eb.element');
  const before = await a.js('({height:__spike3d.boundInfo().find(e=>e.id===ca.identifier).height,lift:parseFloat(ea.element.style.getPropertyValue("--spike3d-taglift"))})');
  await a.js('ca.size=2;true');
  await a.wait('Math.abs(ea.wrapper.scale.x-2)<1e-8');
  const after = await a.js('({height:__spike3d.boundInfo().find(e=>e.id===ca.identifier).height,lift:parseFloat(ea.element.style.getPropertyValue("--spike3d-taglift")),bScale:eb.wrapper.scale.x})');
  assert(Math.abs(after.height-2*before.height)<1e-8); assert(Math.abs((after.lift-12)-2*(before.lift-12))<=1); assert.equal(after.bScale,1);
  await a.js('ca.model3dScale=160;true'); await a.wait('Math.abs(ea.wrapper.scale.x-3.2)<1e-8');
  record('live-token-size-and-name-clearance',{before,after,scaled:true});
  await a.js('ca.model3dScale=Infinity;ca.model3dYaw=NaN;ca.rotate=Infinity;ca.roll=-Infinity;true');
  await a.wait('ea.wrapper.scale.x===2 && ea.object.rotation.z===0');
  assert(await a.js('ea.object.matrix.elements.every(Number.isFinite) && ea.wrapper.matrix.elements.every(Number.isFinite)'));
  record('invalid-settings-finite-transform',true);
  await a.js('ca.model3dScale=100;ca.model3dYaw=0;ca.rotate=0;ca.roll=0;ca.size=1;true');
  // GPU resources are really allocated by this point, not just mocked dispose methods.
  await a.wait('!!ma.skeleton.boneTexture && !!mb.skeleton.boneTexture');
  await a.js(`window.freed={geometry:0,material:0,boneA:0,boneB:0};
    ma.geometry.addEventListener('dispose',()=>freed.geometry++);ma.material.addEventListener('dispose',()=>freed.material++);
    ma.skeleton.boneTexture.addEventListener('dispose',()=>freed.boneA++);mb.skeleton.boneTexture.addEventListener('dispose',()=>freed.boneB++);
    __spike3d.unbindModel(ca.identifier);true`);
  assert.deepEqual(await a.js('freed'),{geometry:0,material:0,boneA:1,boneB:0});
  assert(await a.js('!!mb.skeleton.boneTexture && eb.object.visible'));
  record('unbind-preserves-second-skinned-token',true);
  const shot=await a.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'skin-b.png'),Buffer.from(shot.data,'base64'));
  // A decoder completing after deletion must free the discarded scene, not resurrect it.
  const cancelled = await a.js(`(async()=>{
    const parse=layer.gltfLoader.parse.bind(layer.gltfLoader);window.lateFreed=0;window.lateDecoded=false;
    layer.gltfLoader.parse=(data,path,done,fail)=>parse(data,path,g=>{
      meshOf(g.scene).geometry.addEventListener('dispose',()=>lateFreed++);lateDecoded=true;setTimeout(()=>done(g),200);
    },fail);
    const id=await __spike3d.registerModel('late.gltf',${JSON.stringify(JSON.stringify({...gltf,asset:{version:'2.0',generator:'late'}}))},108);
    const pending=__spike3d.assignModel(id,ca.identifier);
    while(!lateDecoded)await new Promise(r=>setTimeout(r,5));
    await __spike3d.removeModel(id);const assigned=await pending;layer.gltfLoader.parse=parse;
    return {assigned,freed:lateFreed,bound:layer.boundModels.has(ca.identifier)};
  })()`);
  assert.deepEqual(cancelled,{assigned:false,freed:1,bound:false});record('delete-during-parse-cleans-late-result',cancelled);
  const removed=await a.js(`(async()=>{await __spike3d.removeModel('${id}');return {freed,bindings:layer.boundModels.size,previews:layer.models.length}})()`);
  assert.deepEqual(removed,{freed:{geometry:1,material:1,boneA:1,boneB:1},bindings:0,previews:0});
  record('delete-cache-releases-all-owned-resources',removed);
  // Disposal is safe even when repeated; worker pools are closed with their table.
  await a.js('window.decoderDisposals=0;for(const decoder of [layer.dracoLoader,layer.ktx2Loader]){const dispose=decoder.dispose.bind(decoder);decoder.dispose=()=>{decoderDisposals++;return dispose()}};layer.dispose();layer.dispose();true');
  assert.equal(await a.js('decoderDisposals'),2);record('table-dispose-closes-decoders-once',true);
  assert.equal(a.exceptions.length,0,JSON.stringify(a.exceptions));record('runtime-exceptions',a.exceptions.length);
})().catch(e=>{record('FAIL',String(e.stack));process.exitCode=1;}).finally(async()=>{
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));
  for(const c of clients)c.ws.close();for(const child of children)child.kill('SIGTERM');
  await delay(300);console.log('EVIDENCE',out);
});
