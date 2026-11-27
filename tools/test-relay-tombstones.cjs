// Relay server: a deletion outlives the event log, a snapshot cannot bring a deleted object back,
// and a client whose cursor falls into the trimmed log gets the snapshot as its base again.
const path=require('node:path'),assert=require('node:assert/strict'),WS=require('ws'),mp=require('msgpack-lite'),lz=require('lzbase62');
const root=path.resolve(__dirname,'..'),{fixture}=require('./lib/lightweight-browser.cjs');
let env;const sockets=[];const results=[];
const record=(name)=>{results.push({name,passed:true});console.log('PASS',name)};
const ctx=(id,parent='',minor=.1)=>({identifier:id,aliasName:'data',majorVersion:1,minorVersion:minor,syncData:{parentIdentifier:parent,value:'test',attributes:{}}});
const upd=data=>({eventName:'UPDATE_GAME_OBJECT',data}),del=identifier=>({eventName:'DELETE_GAME_OBJECT',data:{identifier}});
const relay=events=>({type:'relay-data',container:{data:Buffer.from(mp.encode(events)).toString('base64'),isCompressed:false}});
const roomId='RMB',ROOM_NAME=lz.compress('墓標'); // lzbase62.compress must be called once: a second call never returns
function peer(name){
  const socket=new WS(env.origin.replace('http:','ws:')+'/signaling');sockets.push(socket);let waiters=[];
  socket.on('message',raw=>{const m=JSON.parse(raw);waiters=waiters.filter(w=>{if(!w.types.includes(m.type))return true;clearTimeout(w.timer);w.resolve(m);return false})});
  return{name,socket,
    // The socket connects as soon as it is created, so its open event may already be gone by now.
    async open(){if(socket.readyState===1)return;await new Promise((r,j)=>{socket.once('open',r);socket.once('error',j)})},
    call(message,types){socket.send(JSON.stringify(message));return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{waiters=waiters.filter(w=>w.types!==types);reject(Error('Response timeout '+types))},5000);waiters.push({types,timer,resolve})})},
    async join(){await this.open();return this.call({type:'register',mode:'relay',id:'tmb'+String(name).padStart(3,'0')+roomId+ROOM_NAME+'-'},['registered'])},
    sync(sinceSeq){return this.call({type:'sync-request',sinceSeq},['room-snapshot','error'])}};
}
const held=m=>{const objects=new Map((m.snapshot?.data?.objects||[]).map(c=>[c.identifier,c]));for(const e of m.events||[])for(const ev of mp.decode(Buffer.from(e.container.data,'base64'))){if(ev.eventName==='UPDATE_GAME_OBJECT')objects.set(ev.data.identifier,ev.data);if(ev.eventName==='DELETE_GAME_OBJECT')objects.delete(ev.data.identifier)}return objects};
(async()=>{try{
 process.env.MAX_ROOM_EVENTS='24';
 // Every snapshot save counts here; the defaults rate-limit saves to one per 15 s and 100 events.
 process.env.MIN_SNAPSHOT_EVENT_ADVANCE='1';process.env.MIN_SNAPSHOT_SAVE_INTERVAL_MS='1';
 env=await fixture('tmp/unity-dice-sync/dev/browser','relay-tombstones',14591,19791,{serverSource:path.join(root,'unified-server.js')});
 const a=peer('a'),b=peer('b');
 await a.join();
 const ack1=await a.call(relay([upd(ctx('o1')),upd(ctx('o2','o1')),upd(ctx('o3'))]),['ack']);
 await b.join();let m=await b.sync(0);
 assert.deepEqual([...held(m).keys()].sort(),['o1','o2','o3']);const bSeq=m.seq;
 // A deletes o1 while B is away, keeps working, and the log is compacted into a snapshot.
 await a.call(relay([del('o1')]),['ack']);
 await a.call(relay([upd(ctx('o3','',.2)),upd(ctx('o3','',.3))]),['ack']);
 assert.equal((await a.call({type:'snapshot-save',snapshot:{objects:[ctx('o3')]}},['snapshot-ack','snapshot-rejected'])).type,'snapshot-ack');record('snapshot-after-a-deletion-accepted');
 // B asks for what it missed with its old cursor. The delete is no longer in the log.
 m=await b.sync(bSeq);
 assert.ok(m.deleted&&m.deleted.includes('o1'),'deleted '+JSON.stringify(m.deleted));
 record('deletion-reaches-a-client-that-missed-it-after-compaction');
 assert.ok(m.deleted.includes('o2'),'deleted '+JSON.stringify(m.deleted));record('deletion-cascades-to-the-child');
 // A re-creates o1 on purpose.
 await a.call(relay([upd(ctx('o1','',.2))]),['ack']);
 m=await b.sync(m.seq);
 assert.ok(!m.deleted||!m.deleted.includes('o1'),'deleted '+JSON.stringify(m.deleted));record('later-update-clears-the-deletion');
 // A client that still holds a deleted object cannot bring it back with its snapshot.
 await a.call(relay([del('o2')]),['ack']);
 const saved=await a.call({type:'snapshot-save',snapshot:{objects:[ctx('o1'),ctx('o2','o1'),ctx('o3')]}},['snapshot-ack','snapshot-rejected']);
 assert.equal(saved.type,'snapshot-ack');assert.ok(saved.snapshotSeq>ack1.seq,'saved as a new snapshot');
 const c=peer('c');await c.join();m=await c.sync(0);
 assert.ok(!held(m).has('o2'),'o2 returned through a snapshot');record('snapshot-cannot-bring-a-deleted-object-back');
 // A personal notice is neither kept nor handed to other members.
 const notice=ctx('notice-1');notice.aliasName='chat';notice.syncData.attributes.tag='DiceBot to-pl-system-message';
 const before=(await a.call(relay([upd(notice),upd(ctx('o3','',.5))]),['ack'])).seq;
 m=await c.sync(m.seq);assert.ok(!held(m).has('notice-1'),'notice stored');assert.equal(m.seq,before);record('personal-notice-is-not-kept-in-the-room');
 // Liveness.
 assert.equal((await a.call({type:'ping',t:12345},['pong'])).t,12345);record('ping-answered');
 // A cursor inside the trimmed log: the snapshot is the base again, marked so the client applies it.
 let last=null;for(let i=4;i<40;i++)last=(await a.call(relay([upd(ctx('o3','',i/10))]),['ack'])).seq;
 const since=last-30;
 m=await c.sync(since);
 assert.equal(m.resync,'gap');assert.ok(m.snapshot&&m.snapshotSeq<since);assert.ok(m.events.every(e=>e.seq>m.snapshotSeq));
 assert.deepEqual([...held(m).keys()].sort(),['o1','o3']);
 record('cursor-in-the-trimmed-log-gets-the-snapshot-as-base-again');
 }catch(e){results.push({name:'FAIL',error:e.stack});console.error(e.stack);process.exitCode=1}
 finally{for(const s of sockets)s.close();if(env)await env.close()}})();
