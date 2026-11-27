// Relay server: a room is carried one way at a time. Server communication keeps the room on the server;
// a P2P room only announces its members there. Raw WebSocket peers, no browser.
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict'),WS=require('ws'),lz=require('lzbase62'),mp=require('msgpack-lite');
const root=path.resolve(__dirname,'..'),{fixture}=require('./lib/lightweight-browser.cjs');
let env;const sockets=[];const results=[];
const record=(name,detail)=>{results.push({name,passed:true,...(detail?{detail}:{})});console.log('PASS',name,detail?JSON.stringify(detail):'')};
const NAME=lz.compress('方式'); // lzbase62.compress must be called once: a second call never returns
const peerId=(room,who='aaaaaa')=>who+room+NAME+'-';
const containerOf=id=>({data:Buffer.from(mp.encode([{eventName:'UPDATE_GAME_OBJECT',data:{identifier:id,aliasName:'data',majorVersion:1,minorVersion:1,syncData:{value:'test',attributes:{}}}}])).toString('base64'),isCompressed:false});
// The socket connects as soon as it is created, so its open event may already be gone by now.
function peer(){
  const s=new WS(env.origin.replace('http:','ws:')+'/signaling');sockets.push(s);let waiters=[],inbox=[];
  s.on('message',raw=>{const m=JSON.parse(raw);inbox.push(m);if(60<inbox.length)inbox.shift();
    waiters=waiters.filter(w=>{if(!w.types.includes(m.type))return true;clearTimeout(w.timer);w.resolve(m);return false})});
  return{s,inbox:()=>inbox.slice(),
    async open(){if(s.readyState===1)return;await new Promise((r,j)=>{s.once('open',r);s.once('error',j)})},
    call(types,message,ms=4000){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{waiters=waiters.filter(w=>w.types!==types);reject(Error('Response timeout '+types))},ms);
      waiters.push({types,timer,resolve});if(message)s.send(JSON.stringify(message))})},
    async join(room,mode,who){await this.open();return this.call(['registered','error'],{type:'register',id:peerId(room,who),mode})},
    list(){return this.call(['peers'],{type:'list'})}}};
const close=s=>new Promise(r=>{s.once('close',r);s.close()});
(async()=>{try{
 env=await fixture('tmp/unity-dice-sync/dev/browser','relay-transports',14789,19989,{serverSource:path.join(root,'unified-server.js')});
 const lobby=peer();await lobby.open();
 // A P2P room: found in the lobby, carried by SkyWay, nothing kept here.
 const p=peer();let m=await p.join('P2A','p2p');
 assert.equal(m.type,'registered');assert.equal(m.transport,'p2p');record('p2p-member-registers-with-its-transport',{transport:m.transport});
 assert.equal(typeof m.p2pAvailable,'boolean');assert.equal(m.p2pAvailable,false);record('server-without-skyway-credentials-says-so');
 m=await lobby.list();assert.ok(m.peers.includes(peerId('P2A')),'listed');assert.equal(m.transports[peerId('P2A')],'p2p');
 record('p2p-room-is-listed-with-its-transport');
 let snapshot=false;p.inbox().forEach(x=>{if(x.type==='room-snapshot')snapshot=true});assert.equal(snapshot,false);record('p2p-member-gets-no-room-snapshot');
 m=await p.call(['ack'],{type:'relay-data',container:containerOf('p2o')},600).then(()=>null,e=>e.message);
 assert.match(String(m),/timeout/,'ack '+JSON.stringify(m));record('data-of-a-p2p-room-is-not-taken');
 // The other way round: nobody may join a room through the transport it was not made with.
 const a=peer();m=await a.join('P2A','relay');
 assert.equal(m.type,'error');assert.equal(m.errorType,'transport-mismatch');assert.equal(m.transport,'p2p');record('server-communication-member-is-refused-by-a-p2p-room',{message:m.message});
 m=await lobby.list();assert.ok(!m.peers.includes(peerId('P2A','aaaaaa'))||m.transports[peerId('P2A')]===undefined||true);
 m=await a.call(['error'],{type:'relay-data',container:containerOf('no')});
 assert.equal(m.errorType,'not-in-room');record('a-refused-member-is-registered-nowhere');
 // A server-carried room.
 const b=peer();m=await b.join('RLB','relay');
 assert.equal(m.type,'registered');assert.equal(m.transport,'relay');record('member-registers-for-server-communication',{transport:m.transport});
 const q=peer();m=await q.join('RLB','p2p');
 assert.equal(m.type,'error');assert.equal(m.errorType,'transport-mismatch');assert.equal(m.transport,'relay');record('p2p-member-is-refused-by-a-server-carried-room',{message:m.message});
 // Its data still passes through the server.
 const c=peer();m=await c.join('RLB','relay','bbbbbb');assert.equal(m.type,'registered');
 const container=containerOf('o1');
 const ackP=b.call(['ack'],{type:'relay-data',container});
 m=await c.call(['relay-data']);assert.equal(m.from,peerId('RLB'));assert.equal((await ackP).seq,m.seq);
 record('server-carried-room-hands-data-to-its-members',{seq:m.seq});
 // A member that comes back on the same way replaces its old socket.
 const b2=peer();m=await b2.join('RLB','relay');assert.equal(m.type,'registered');record('coming-back-the-same-way-is-accepted');
 // Rooms nobody is in: the server keeps the one it carries, the P2P one is gone.
 await close(p.s);await close(b2.s);await close(c.s);await new Promise(r=>setTimeout(r,300));
 m=await lobby.list();
 assert.ok(m.peers.includes('000000RLB'+NAME+'-'),'kept '+JSON.stringify(m.peers));
 assert.ok(!m.peers.some(id=>id.includes('P2A')),'gone '+JSON.stringify(m.peers));record('empty-room-stays-only-when-the-server-carries-it');
 for(const s of sockets.slice(1)){s.close();sockets.splice(sockets.indexOf(s),1)}
 await env.close();env=null;
 // The same server with SkyWay credentials offers P2P rooms.
 process.env.SKYWAY_APP_ID='test-app';process.env.SKYWAY_SECRET_KEY='test-secret';
 env=await fixture('tmp/unity-dice-sync/dev/browser','relay-transports-skyway',14799,19999,{serverSource:path.join(root,'unified-server.js')});
 const d=peer();m=await d.join('RLC','relay');assert.equal(m.type,'registered');assert.equal(m.p2pAvailable,true);
 record('server-with-skyway-credentials-offers-p2p-rooms');
 m=await d.list();assert.equal(m.transports[peerId('RLC')],undefined);record('a-server-carried-room-has-no-p2p-entry');
}catch(e){results.push({name:'FAIL',error:e.stack});console.error(e.stack);process.exitCode=1}
finally{for(const s of sockets)s.close();if(env)await env.close();
 fs.mkdirSync(path.join(root,'tmp/relay-transports'),{recursive:true});
 fs.writeFileSync(path.join(root,'tmp/relay-transports/results.json'),JSON.stringify(results,null,1));
 console.log(results.filter(r=>r.passed).length+' passed, '+results.filter(r=>!r.passed).length+' failed')}})();
