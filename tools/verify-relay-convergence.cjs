// Relay-mode convergence: does a client that was away while the room log was compacted come back
// to the same state as the clients that stayed? Evidence for the relay stabilization work.
// Two real browsers on the fixture server, plus a raw relay client for what a fresh joiner receives.

const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),{fixture,delay}=require('./lib/lightweight-browser.cjs');
const WS=require('ws'),mp=require('msgpack-lite'),lz=require('lzbase62'),zlib=require('node:zlib');
let env;const results=[];const out=path.join(root,'tmp/relay-convergence');
const room='RCV',roomName='収束検証';
// Volatile per-peer objects (cursors) and personal notices (to-pl-system-message, created by each client
// for itself) are left out of every comparison.
const HELPERS="window.__t={net(){return window.peer.networkService},conn(){return window.peer.networkService.connection},catalog(){const s=window.peer.gameRoomService;return s.getCatalog().map(c=>{const o=s.get(c.identifier);return o&&o.aliasName!=='PeerCursor'&&!(o.tags&&0<=o.tags.indexOf('to-pl-system-message'))?o.aliasName+'#'+c.identifier+'@'+(+c.version).toFixed(3):null}).filter(Boolean).sort()},chats(ids){const s=window.peer.gameRoomService;return ids.map(id=>{const o=s.get(id);return o?{id,text:String(o.text||'').slice(0,60),name:(o.attributes&&o.attributes.name)||'',from:(o.attributes&&o.attributes.from)||'',tag:(o.attributes&&o.attributes.tag)||''}:null}).filter(Boolean)},async drop(){const c=this.conn();c.intentionalClose=true;c.socket.close();for(let i=0;i<40&&c.socket;i++)await new Promise(r=>setTimeout(r,50));return !c.socket},hold(){const n=this.net();if(!n.__open)n.__open=n.open;n.open=()=>{};return true},quiet(){const c=this.conn();c.__setPeers=c.setPeers;c.setPeers=()=>{};return true},loud(){const c=this.conn();if(c.__setPeers){c.setPeers=c.__setPeers;delete c.__setPeers}return true},netState(){const c=this.conn();return{open:this.net().isOpen,peerOpen:c.peerContext.isOpen,socket:c.socket?c.socket.readyState:null,lastSeq:c.lastSeq,peers:c.peerIds.length}},release(){const n=this.net();if(n.__open){n.open=n.__open;delete n.__open}return true},async resume(){const c=this.conn();c.intentionalClose=false;c.openSocket();for(let i=0;i<80&&!c.peerContext.isOpen;i++)await new Promise(r=>setTimeout(r,50));return c.peerContext.isOpen},async reopen(){this.release();const pc=this.net().peerContext;this.net().open(pc.userId,pc.roomId,pc.roomName,pc.password);for(let i=0;i<100;i++){if(this.net().isOpen)break;await new Promise(r=>setTimeout(r,100))}return this.net().isOpen},seq(){return this.conn().lastSeq},watch(){window.__t.snapshots=[];const seen=new Set();setInterval(()=>{const c=window.peer.networkService.connection;const socket=c&&c.socket;if(!socket||seen.has(socket))return;seen.add(socket);socket.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.type==='snapshot-ack'||m.type==='snapshot-rejected'||m.type==='room-snapshot')window.__t.snapshots.push({type:m.type,seq:m.seq,snapshotSeq:m.snapshotSeq,reason:m.reason,events:(m.events||[]).length,objects:((m.snapshot&&m.snapshot.data&&m.snapshot.data.objects)||[]).length})})},200);return true}};true";
const report=(name,ok,detail)=>{results.push({name,passed:!!ok,...(detail?{detail}:{})});console.log((ok?'PASS ':'FAIL ')+name+(detail?' '+JSON.stringify(detail).slice(0,1500):''))};
const join=b=>b.js("peer.networkService.open('U"+Math.random().toString(36).slice(2,8)+"','"+room+"','"+roomName+"','');true").then(()=>b.wait("peer.networkService.isOpen&&peer.networkService.peerContext.roomId==='"+room+"'"));
const catalog=b=>b.js('window.__t.catalog()');
const chatsOf=(b,ids)=>b.js('window.__t.chats('+JSON.stringify(ids)+')');
const idsOf=c=>c.map(x=>x.split('@')[0]);
const diff=(a,b)=>{const A=idsOf(a),B=idsOf(b);return{onlyInB:B.filter(x=>!A.includes(x)).slice(0,8),onlyInA:A.filter(x=>!B.includes(x)).slice(0,8)}};
const settled=async (bs)=>{let last=null;for(let i=0;i<50;i++){const cats=await Promise.all(bs.map(catalog));const key=JSON.stringify(cats);if(key===last)return cats;last=key;await delay(400)}return null};
const lastSnapshots=async b=>(await b.js('window.__t.snapshots')).slice(-5);
// What the server hands to a fresh joiner: the room snapshot followed by the events after it.
const freshJoiner=()=>new Promise((resolve,reject)=>{
  const socket=new WS(env.origin.replace('http:','ws:')+'/signaling');const timer=setTimeout(()=>{socket.close();reject(Error('probe timeout'))},8000);
  socket.on('open',()=>socket.send(JSON.stringify({type:'register',mode:'relay',id:'zzzprb'+room+lz.compress(roomName)+'-'})));
  socket.on('message',raw=>{const m=JSON.parse(raw.toString());
    if(m.type==='registered')socket.send(JSON.stringify({type:'sync-request',sinceSeq:0}));
    if(m.type!=='room-snapshot')return;socket.close();clearTimeout(timer);
    const held=new Map(),info=new Map();const note=c=>({text:String((c.syncData&&c.syncData.value)||'').slice(0,60),name:(c.syncData&&c.syncData.attributes&&c.syncData.attributes.name)||'',from:(c.syncData&&c.syncData.attributes&&c.syncData.attributes.from)||'',tag:(c.syncData&&c.syncData.attributes&&c.syncData.attributes.tag)||''});
    for(const c of (m.snapshot&&m.snapshot.data&&m.snapshot.data.objects)||[]){held.set(c.identifier,c.aliasName);if(c.syncData&&c.syncData.attributes&&c.syncData.attributes.tag==='DiceBot to-pl-system-message')held.delete(c.identifier);else info.set(c.identifier,note(c))}
    for(const entry of m.events||[]){let bytes=Buffer.from((entry.container&&entry.container.data)||'','base64');if(entry.container&&entry.container.isCompressed)bytes=zlib.gunzipSync(bytes);
      for(const e of mp.decode(bytes)){if(e.eventName==='UPDATE_GAME_OBJECT'&&e.data&&e.data.identifier){held.set(e.data.identifier,e.data.aliasName);info.set(e.data.identifier,note(e.data))}else if(e.eventName==='DELETE_GAME_OBJECT'&&e.data&&e.data.identifier)held.delete(e.data.identifier)}}
    resolve({snapshotObjects:((m.snapshot&&m.snapshot.data&&m.snapshot.data.objects)||[]).length,events:(m.events||[]).length,snapshotSeq:m.snapshotSeq,seq:m.seq,info,
      catalog:[...held].filter(([,a])=>a!=='PeerCursor').map(([id,a])=>a+'#'+id).sort()})});
  socket.on('error',reject);
});
(async()=>{try{
 env=await fixture(process.env.LYCORIS_BUILD||'tmp/relay-stabilization/dev/browser','relay-convergence',14689,19889);
 const a=await env.browser('a');await a.js(HELPERS);await join(a);await a.js('window.__t.watch()');
 const b=await env.browser('b');await b.js(HELPERS);await join(b);await b.js('window.__t.watch()');
 const base=await settled([a,b]);if(!base)throw Error('A and B never converged after joining: '+JSON.stringify(diff(await catalog(a),await catalog(b))));
 report('two-clients-converge-after-joining',true,{objects:base[0].length});
 const x=await a.js("(()=>{const t=gt.characters[0];return {id:t.identifier,name:t.name}})()");await delay(500);
 // B drops the way a dead network drops it, and cannot come back by itself while it is away.
 const dropped=await b.js('window.__t.drop()'),held=await b.js('window.__t.hold()'),bSeq=await b.js('window.__t.seq()');
 // While B is away, A deletes that character, keeps working, and the room log is compacted into a new snapshot.
 await a.js("gt.characters.find(c=>c.identifier==='"+x.id+"').destroy();true");
 await a.js("(()=>{const t=gt.characters[0];for(let i=0;i<70;i++){t.location={name:'table',x:100+(i%5),y:200+i%7};}return true})()");
 await delay(16000);await a.js('peer.networkService.manualSaveSnapshot()');
 let compacted=null;for(let i=0;i<30;i++){compacted=(await a.js('window.__t.snapshots')).filter(m=>m.type==='snapshot-ack'&&m.snapshotSeq>bSeq).pop();if(compacted)break;await delay(300)}
 report('room-log-compacted-while-b-was-away',!!compacted,{dropped,held,bSeq,compacted});
 const aCat=await catalog(a);
 // Path 3: the same connection resumes, but no other member can hand over a room bundle (as when the
 // only other member is a client without bundles): B relies on the relay's snapshot and events alone.
 await b.js('window.__t.quiet()');
 const back3=await b.js('window.__t.resume()');await delay(3000);
 let bCat=await catalog(b),d=diff(aCat,bCat);
 report('returning-client-on-relay-snapshot-alone-matches-the-client-that-stayed',back3&&d.onlyInB.length===0&&d.onlyInA.length===0,{back:back3,bSnapshots:await lastSnapshots(b),net:await b.js('window.__t.netState()'),objectsA:aCat.length,objectsB:bCat.length,...d,ghosts:d.onlyInB.slice(0,5),bChats:await chatsOf(b,d.onlyInB.map(c=>c.split('#')[1])),aChats:await chatsOf(a,d.onlyInA.map(c=>c.split('#')[1]))});
 await b.js('window.__t.loud()');
 // Path 1: the same connection resumes with B's old cursor.
 await b.js('window.__t.drop()');await b.js('window.__t.hold()');const bSeq2=await b.js('window.__t.seq()');
 const y=await a.js("(()=>{const t=gt.characters[0];return {id:t.identifier,name:t.name}})()");
 await a.js("gt.characters.find(c=>c.identifier==='"+y.id+"').destroy();true");await delay(16000);await a.js('peer.networkService.manualSaveSnapshot()');
 let compacted2=null;for(let i=0;i<30;i++){compacted2=(await a.js('window.__t.snapshots')).filter(m=>m.type==='snapshot-ack'&&m.snapshotSeq>bSeq2).pop();if(compacted2)break;await delay(300)}
 const aCat2=await catalog(a);
 const back=await b.js('window.__t.resume()');await delay(3500);
 bCat=await catalog(b);d=diff(aCat2,bCat);
 report('returning-client-same-connection-matches-the-client-that-stayed',back&&d.onlyInB.length===0&&d.onlyInA.length===0,{back,compacted2,bSnapshots:await lastSnapshots(b),objectsA:aCat2.length,objectsB:bCat.length,...d,bChats:await chatsOf(b,d.onlyInB.map(c=>c.split('#')[1])),aChats:await chatsOf(a,d.onlyInA.map(c=>c.split('#')[1]))});
 // Path 2: what AutoReconnect does: a fresh connection of the same page, local objects kept.
 await b.js('window.__t.drop()');await b.js('window.__t.hold()');await delay(500);
 const reopened=await b.js('window.__t.reopen()');await delay(3500);await b.js('window.__t.release()');
 bCat=await catalog(b);d=diff(aCat2,bCat);
 report('reconnecting-client-fresh-connection-matches-the-client-that-stayed',reopened&&d.onlyInB.length===0&&d.onlyInA.length===0,{reopened,net:await b.js('window.__t.netState()'),bSnapshots:await lastSnapshots(b),objectsA:aCat2.length,objectsB:bCat.length,...d,bChats:await chatsOf(b,d.onlyInB.map(c=>c.split('#')[1])),aChats:await chatsOf(a,d.onlyInA.map(c=>c.split('#')[1]))});
 // What the server would hand to whoever joins next.
 let fresh=null;try{fresh=await freshJoiner()}catch(e){report('fresh-joiner-probe',false,{error:e.message})}
 if(fresh){const d3=diff(aCat2,fresh.catalog.map(c=>c+'@0.000')),fi=fresh.info;
  report('later-joiner-matches-the-client-that-stayed',d3.onlyInB.length===0&&d3.onlyInA.length===0,{snapshotObjects:fresh.snapshotObjects,events:fresh.events,snapshotSeq:fresh.snapshotSeq,seq:fresh.seq,objectsA:aCat2.length,...d3,freshChats:d3.onlyInB.map(c=>fi.get(c.split('#')[1])),aChats:await chatsOf(a,d3.onlyInA.map(c=>c.split('#')[1]))})}
 const errors={a:a.exceptions.map(e=>(e.exception&&e.exception.description)||'').slice(0,3),b:b.exceptions.map(e=>(e.exception&&e.exception.description)||'').slice(0,3)};
 if(errors.a.length||errors.b.length)report('no-browser-exceptions',false,errors);
 }catch(e){results.push({name:'ERROR',passed:false,detail:e.stack});console.error(e.stack);process.exitCode=1}
 finally{fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));if(env)await env.close()}})();
