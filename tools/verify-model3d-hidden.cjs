// Isolated browser acceptance: default-off needs no WebGL; archived model data survives.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process'), WS = require('ws'), yaml = require('js-yaml');
const crypto = require('node:crypto'), JSZip = require('jszip');
const root = path.resolve(__dirname, '..');
const build = path.resolve(root, process.argv[2] || 'tmp/spike-3d/hidden-dev/browser');
const out = path.join(root, 'tmp/spike-3d', 'hidden-check-' + Date.now());
const origin = 'http://localhost:14479', children = [], clients = [], results = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = (name, value) => { results.push({ name, value }); console.log(name, JSON.stringify(value)); };
fs.mkdirSync(out, { recursive: true });
async function ready(url) {
  for (let n = 0; n < 100; n++) { try { if ((await fetch(url)).ok) return; } catch {} await delay(100); }
  throw Error('Not ready: ' + url);
}
async function browser(port, enabled) {
  const fd = fs.openSync(path.join(out, (enabled ? 'on' : 'off') + '.log'), 'w');
  children.push(spawn('/opt/google/chrome/chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    ...(!enabled ? ['--disable-webgl'] : []), '--window-size=1440,1000', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(out, 'profile-' + port), 'about:blank'], { stdio: ['ignore', fd, fd] }));
  await ready('http://127.0.0.1:' + port + '/json/version');
  const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WS(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let id = 0; const pending = new Map(), exceptions = [], requests = [];
  ws.on('message', raw => {
    const m = JSON.parse(raw), p = pending.get(m.id);
    if (p) { clearTimeout(p.timer); pending.delete(m.id); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails);
    if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id, timer = setTimeout(() => { pending.delete(n); reject(Error(method + ' timeout')); }, 30000);
    pending.set(n, { resolve, reject, timer }); ws.send(JSON.stringify({ id: n, method, params }));
  });
  const js = async expression => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result?.value;
  };
  const wait = async expression => {
    for (let n = 0; n < 200; n++) { if (await js(expression)) return; await delay(100); }
    throw Error('Wait timeout: ' + expression);
  };
  const s = { ws, call, js, wait, exceptions, requests }; clients.push(s);
  await call('Runtime.enable'); await call('Page.enable'); await call('Network.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `
    localStorage.${enabled ? "setItem('lycoris.experimental.model3d','1')" : "removeItem('lycoris.experimental.model3d')"};
    window.webglContexts=0;
    const getContext=HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext=function(type,...args){if(/webgl/i.test(type))webglContexts++;return getContext.call(this,type,...args)};
  ` });
  await call('Page.navigate', { url: origin });
  await wait("!!window.ng && !!document.querySelector('game-table') && !!document.querySelector('game-character')");
  await js(`window.app=ng.getComponent(document.querySelector('app-root'));window.gt=ng.getComponent(document.querySelector('game-table'));
    document.querySelector('modal .title-button button')?.click();
    const style=document.createElement('style');style.textContent='modal,.modal-background{display:none!important}';document.head.append(style);true`);
  if (enabled) await wait('!!window.__spike3d?.ready');
  await js("[...document.querySelectorAll('li')].find(e=>e.textContent.trim().endsWith('画像'))?.click();true");
  await wait("!!document.querySelector('file-storage input[type=file]')");
  await js(`window.files=ng.getComponent(document.querySelector('file-storage'));window.gc=ng.getComponent(document.querySelector('game-character'));
    window.character=gc.gameCharacter;gc.showDetail(character);true`);
  await wait("!!document.querySelector('game-character-sheet')");
  await js("window.sheet=ng.getComponent(document.querySelector('game-character-sheet'));sheet.characterSheetTab='display';sheet.changeDetector.detectChanges();true");
  return s;
}
(async () => {
  const server = path.join(out, 'server'); fs.mkdirSync(path.join(server, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(root, 'unified-server.js'), path.join(server, 'unified-server.js'));
  for (const dir of ['node_modules', 'signaling-server']) fs.symlinkSync(path.join(root, dir), path.join(server, dir), 'dir');
  fs.symlinkSync(build, path.join(server, 'dist/udonarium-lycoris'), 'dir');
  const config = path.join(build, 'assets/config.yaml'), cfg = yaml.load(fs.readFileSync(config, 'utf8'));
  cfg.backend = { mode: 'websocket-relay', url: '' }; cfg.webrtc = { key: '', signalingUrl: 'ws://localhost:14479/signaling' };
  fs.writeFileSync(config, yaml.dump(cfg));
  const fd = fs.openSync(path.join(out, 'server.log'), 'w');
  children.push(spawn(process.execPath, [path.join(server, 'unified-server.js')], { cwd: server, env: { ...process.env, PORT: '14479' }, stdio: ['ignore', fd, fd] }));
  await ready(origin + '/v1/status');
  const a = await browser(19581, false);
  const off = await a.js(`({api:!!window.__spike3d,contexts:webglContexts,tabs:document.querySelectorAll('.spike3d-tabs').length,
    inputs:document.querySelectorAll('input[accept=".glb,.gltf,.vrm,.fbx"]').length,settings:document.querySelector('game-character-sheet').textContent.includes('3Dコマ情報')})`);
  assert.deepEqual(off, { api: false, contexts: 0, tabs: 0, inputs: 0, settings: false });
  record('default-hidden-with-webgl-disabled', off);
  assert(!a.requests.some(url => /table-3d-spike|\/draco\/|\/basis\//.test(url)));
  record('no-three-layer-or-decoders-requested', true);
  await a.js("files.switch3d();true"); assert.equal(await a.js('files.activeTab'), 'image');
  const bytes = fs.readFileSync(path.join(root, 'tmp/spike-3d/front-positive-z.glb'));
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const literal = JSON.stringify(bytes.toString('base64'));
  await a.js(`window.modelBytes=Uint8Array.from(atob(${literal}),c=>c.charCodeAt(0));files.handleFileSelect({target:{files:[new File([modelBytes],'hidden.glb')],value:''}});true`);
  await delay(400);
  assert(!(await a.js('indexedDB.databases().then(dbs=>dbs.some(db=>db.name.includes("MediaCacheModel")))')));
  record('standalone-model-intake-disabled', true);
  // Existing ZIP contents still load as data, without activating any 3D renderer.
  const zip = new JSZip(); zip.file('models/' + hash + '/archived.glb', bytes);
  const zip64 = await zip.generateAsync({ type: 'base64' });
  await a.js(`character.model3dIdentifier='${hash}';character.model3dName='archived.glb';character.model3dScale=160;
    const data=Uint8Array.from(atob(${JSON.stringify(zip64)}),c=>c.charCodeAt(0));
    app.handleFileSelect({target:{files:[new File([data],'existing-model.zip',{type:'application/zip'})],value:''}});true`);
  await a.wait(`indexedDB.databases().then(async dbs=>{if(!dbs.some(db=>db.name.includes('MediaCacheModel')))return false;
    return new Promise(resolve=>{const open=indexedDB.open('Udonarium-IDB-MediaCacheModel');open.onsuccess=()=>{const db=open.result;const req=db.transaction('ObjectStore').objectStore('ObjectStore').get('${hash}');req.onsuccess=()=>{resolve(!!req.result?.blob);db.close()}}})})`);
  const retained = await a.js(`(async()=>{const files=await sheet.saveDataService.modelFilesForXml(character.toXml());
    return {id:character.model3dIdentifier,scale:character.model3dScale,files:await Promise.all(files.map(async f=>({name:f.name,hash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await f.arrayBuffer())),v=>v.toString(16).padStart(2,'0')).join('')}))),contexts:webglContexts,api:!!window.__spike3d}})()`);
  assert.equal(retained.id, hash); assert.equal(retained.scale, 160); assert.equal(retained.files[0].hash, hash);
  assert.equal(retained.contexts, 0); assert.equal(retained.api, false);
  await a.wait("[...document.querySelectorAll('game-character img.image')].some(img=>img.complete&&img.naturalWidth>0&&getComputedStyle(img).visibility==='visible')");
  record('archived-model-reference-and-bytes-preserved-as-image-token', retained);
  const b = await browser(19582, true);
  assert(await b.js("!!document.querySelector('.spike3d-tabs') && document.querySelector('game-character-sheet').textContent.includes('3Dコマ情報')"));
  const enabled = await b.js(`(async()=>{const bytes=Uint8Array.from(atob(${literal}),c=>c.charCodeAt(0));
    const id=await __spike3d.registerModel('hidden-test.glb',bytes.buffer,bytes.length);return __spike3d.assignModel(id,character.identifier)})()`);
  assert.equal(enabled, true);
  await b.wait('__spike3d.info().triangles>0 && __spike3d.canvasPixels().total>10');
  record('explicit-developer-opt-in-still-loads-and-renders', { assigned: enabled, contexts: await b.js('webglContexts') });
  for (const s of clients) assert.equal(s.exceptions.length, 0, JSON.stringify(s.exceptions));
  record('runtime-exceptions', 0);
})().catch(error => { record('FAIL', error.stack); process.exitCode = 1; }).finally(async () => {
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  for (const s of clients) s.ws.close(); for (const child of children) child.kill('SIGTERM');
  await delay(300); console.log('EVIDENCE', out);
});
