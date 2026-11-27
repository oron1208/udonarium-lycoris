// Relay-mode images: a character that comes in through a ZIP with its own image file is visible, image
// included, to the members who are already in the room and to whoever joins next.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const root=path.resolve(__dirname,'..'),{fixture,delay}=require('./lib/lightweight-browser.cjs');
const JSZip=require('jszip');let env;const results=[];const out=path.join(root,'tmp/relay-images');
const room='RIM',roomName='画像検証';
const report=(name,ok,detail)=>{results.push({name,passed:!!ok,...(detail?{detail}:{})});console.log((ok?'PASS ':'FAIL ')+name+(detail?' '+JSON.stringify(detail).slice(0,1500):''))};
const HELPERS="window.__t={img(name){const c=gt.characters.find(c=>c.name===name);if(!c)return {character:false};const i=c.imageFile;return {character:true,image:i?i.identifier:null,state:i?i.state:null,blob:!!(i&&i.blob),missing:!!(i&&i.missing),url:i?i.url:null}},async wait(name,ms){const end=Date.now()+ms;for(;;){const s=this.img(name);if(s.character&&s.state>=2&&s.blob)return {...s,afterMs:ms-(end-Date.now())};if(Date.now()>end)return s;await new Promise(r=>setTimeout(r,250))}}};true";
const join=b=>b.js("peer.networkService.open('U"+Math.random().toString(36).slice(2,8)+"','"+room+"','"+roomName+"','');true").then(()=>b.wait("peer.networkService.isOpen&&peer.networkService.peerContext.roomId==='"+room+"'"));
const loadIn=(page,bytes,name)=>page.js("window.confirm=()=>true;const b=Uint8Array.from(atob('"+bytes.toString('base64')+"'),c=>c.charCodeAt(0));app.handleFileSelect({target:{files:[new File([b],"+JSON.stringify(name)+",{type:'application/zip'})],value:''}});true");
// A small PNG made here, so that no bundled image is involved.
const png=(()=>{const crcTable=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;crcTable[n]=c>>>0}const crc=b=>{let c=~0;for(const x of b)c=crcTable[(c^x)&255]^(c>>>8);return ~c>>>0};
  const chunk=(type,data)=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const body=Buffer.concat([Buffer.from(type),data]);const sum=Buffer.alloc(4);sum.writeUInt32BE(crc(body));return Buffer.concat([len,body,sum])};
  const w=40,h=30,raw=Buffer.alloc((w*3+1)*h);for(let y=0;y<h;y++){raw[y*(w*3+1)]=0;for(let x=0;x<w;x++){const o=y*(w*3+1)+1+x*3;raw[o]=x<w/2?200:40;raw[o+1]=60;raw[o+2]=y<h/2?200:40}}
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))])})();
(async()=>{try{
 env=await fixture(process.env.LYCORIS_BUILD||'tmp/relay-stabilization/dev/browser','relay-images',14691,19891);
 const a=await env.browser('a');await a.js(HELPERS);await join(a);
 const b=await env.browser('b');await b.js(HELPERS);await join(b);
 await b.wait("gt.characters.length>=7");
 // A character with its own image file arrives through a ZIP, as when a member brings one from another room.
 const zip=new JSZip();
 zip.file('data.xml','<?xml version="1.0" encoding="UTF-8"?><character location.name="table" location.x="500" location.y="300" isLock="false" rotate="0" roll="0"><data name="character"><data name="image"><data name="imageIdentifier" type="image">zipcharimg</data></data><data name="common"><data name="name">画像テスト</data><data name="size">1</data><data name="altitude">0</data><data name="initiative">0</data><data name="initiativeFormula"></data></data><data name="detail" type="noteGroup"><data name="リソース" type="ResourceSmall"><data name="HP" type="numberResource" currentValue="200">200</data><data name="MP" type="numberResource" currentValue="100">100</data></data></data><data name="buff-palette" type="note"></data></data><data name="chat-palette" type="note"></data></character>');
zip.file('zipcharimg.png',png);zip.file('imagetag.xml','<?xml version="1.0" encoding="UTF-8"?><image-tag-list><image-tag imageIdentifier="zipcharimg" tag=""/></image-tag-list>');
 const bytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
 const t0=Date.now();await loadIn(a,bytes,'image-character.zip');
 const mine=await a.js('window.__t.wait("画像テスト",30000)');
 report('uploader-has-the-character-with-its-image',mine.character&&mine.state>=2&&mine.blob,{afterMs:Date.now()-t0,image:mine.image&&mine.image.slice(0,12)});
 if(!mine.character||!mine.image){report('rest',false,{mine});return}
 const theirs=await b.js('window.__t.wait("画像テスト",30000)');
 report('member-already-in-the-room-sees-the-image',theirs.character&&theirs.state>=2&&theirs.blob,{afterMs:Date.now()-t0,image:theirs.image&&theirs.image.slice(0,12)});
 // The server holds the image bytes.
 const response=await fetch(env.origin+'/api/media/image/'+mine.image);const held=Buffer.from(await response.arrayBuffer());
 report('server-holds-the-image',response.status===200&&held.length===png.length&&held.equals(png),{status:response.status,bytes:held.length,expected:png.length});
 // Whoever joins next starts empty-handed.
 await b.call('Browser.close').catch(()=>{});await delay(1500);
 const c=await env.browser('c');await c.js(HELPERS);await join(c);
 const late=await c.js('window.__t.wait("画像テスト",30000)');
 report('late-joiner-sees-the-image',late.character&&late.state>=2&&late.blob,{afterMs:Date.now()-t0,image:late.image&&late.image.slice(0,12),state:late.state,blob:late.blob,missing:late.missing});
 const errors={a:a.exceptions.map(e=>(e.exception&&e.exception.description)||'').slice(0,3),c:c.exceptions.map(e=>(e.exception&&e.exception.description)||'').slice(0,3)};
 if(errors.a.length||errors.c.length)report('no-browser-exceptions',false,errors);
 }catch(e){results.push({name:'ERROR',passed:false,detail:e.stack});console.error(e.stack);process.exitCode=1}
 finally{fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));if(env)await env.close()}})();
