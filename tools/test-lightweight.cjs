const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),delay=ms=>new Promise(r=>setTimeout(r,ms));
function source(file,imports={},globals={}){const m={exports:{}};const js=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText.replace('import.meta.url','"file:///test"');vm.runInNewContext(js,{module:m,exports:m.exports,require:name=>{if(!(name in imports))throw Error('Unexpected import '+name);return imports[name]},queueMicrotask,setTimeout,clearTimeout,console,URL,...globals});return m.exports;}
(async()=>{
  const {AsyncWorkQueue}=source('src/app/class/core/system/util/async-work-queue.ts');
  const q=new AsyncWorkQueue(2),started=[],release=[];let active=0,peak=0;
  const run=(name,priority,fail=false)=>q.run(async()=>{started.push(name);peak=Math.max(peak,++active);await new Promise(r=>release.push(r));active--;if(fail)throw Error(name);return name},priority);
  const a=run('a',0),b=run('b',0);await delay(0);
  const low=run('low',-1),high=run('high',1,true).catch(e=>e.message),last=run('last',0);
  release.shift()();await a;await delay(0);assert.deepEqual(started,['a','b','high']);
  release.shift()();await b;await delay(0);assert.deepEqual(started,['a','b','high','last']);
  release.shift()();assert.equal(await high,'high');await delay(0);assert.equal(started.at(-1),'low');
  release.shift()();await last;release.shift()();await low;await delay(0);
  assert.equal(peak,2);assert.equal(q.active,0);assert.equal(q.pending,0);console.log('PASS bounded work, queued priority and rejection release');
  const workers=[];class FakeWorker{constructor(){this.sent=[];this.terminated=0;workers.push(this)}postMessage(job){this.sent.push(job)}terminate(){this.terminated++}}
  const {FileProcessingWorker}=source('src/app/class/core/file-storage/file-processing-worker.ts',{'../system/util/logger':{Logger:{warn(){},info(){}}},'../system/util/async-work-queue':{AsyncWorkQueue}},{Worker:FakeWorker});
  const tasks=Array.from({length:8},()=>FileProcessingWorker.sha256(new ArrayBuffer(10)));
  await delay(0);assert.equal(workers.length,1);assert.equal(workers[0].sent.length,2);
  const before=Date.now();workers[0].onerror(Error('injected worker failure'));const result=await Promise.allSettled(tasks);
  assert(result.every(r=>r.status==='rejected'));assert(Date.now()-before<1000);assert.equal(workers[0].terminated,1);assert.equal(FileProcessingWorker.isAvailable(),false);
  console.log('PASS worker concurrency and immediate queued/running failure settlement');
})().catch(e=>{console.error(e);process.exitCode=1});
