const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const core=require('jasmine-core'),jasmine=core.core(core),env=jasmine.getEnv();env.configure({random:false});
const api=core.interface(jasmine,env);let failed=false;
env.addReporter({specDone:r=>{if(r.status==='failed'){failed=true;console.error('FAIL',r.fullName,r.failedExpectations.map(x=>x.message).join(';'))}},jasmineDone:r=>{console.log('SkyWay flow-control/native channel specs:',r.overallStatus);process.exitCode=failed||r.overallStatus!=='passed'?1:0}});
const root=path.resolve(__dirname,'..'),mp=require('msgpack-lite');
const peer={parse:id=>({peerId:id,isOpen:false,session:{}}),create:id=>({peerId:id,isOpen:false,session:{}})};
const zero={setZeroTimeout:fn=>globalThis.setTimeout(fn,0),clearZeroTimeout:id=>globalThis.clearTimeout(id)};
const imports={events:require('node:events'),'../../util/message-pack':{MessagePack:{encode:x=>new Uint8Array(mp.encode(x)),decode:x=>mp.decode(x)}},'../../util/uuid':{UUID:{generateUuid:()=>require('node:crypto').randomUUID()}},'../../util/zero-timeout':zero,'../peer-context':{PeerContext:peer},'../peer-session-state':{PeerSessionGrade:{HIGH:3,MIDDLE:2,LOW:1,UNSPECIFIED:0}},'../webrtc/webrtc-stats':{CandidateType:{UNKNOWN:0},WebRTCStats:class{}},'../webrtc/webrtc-stats-monitor':{WebRTCStatsMonitor:{add(){},remove(){}}},'../../util/logger':{Logger:{warn(){},debug(){}}}};
function load(file,dependencies,globals={}){const module={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{module,exports:module.exports,require:n=>{if(!(n in dependencies))throw Error('Unexpected import '+n);return dependencies[n]},setTimeout:(...a)=>globalThis.setTimeout(...a),clearTimeout:(...a)=>globalThis.clearTimeout(...a),performance,console,DOMException,Uint8Array,...globals},{filename:file});return module.exports;}
const stream=load('src/app/class/core/system/network/skyway2023/skyway-data-stream.ts',imports);
load('src/app/class/core/system/network/skyway2023/skyway-data-stream.spec.ts',{'./skyway-data-stream':stream,'../peer-context':{PeerContext:peer},'../../util/zero-timeout':zero},{...api,jasmine});
env.execute();
