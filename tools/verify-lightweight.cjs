const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {fixture,delay}=require('./lib/lightweight-browser.cjs');
let env;const results=[];const record=(name,value)=>{results.push({name,value});console.log(name,JSON.stringify(value));};
(async()=>{
  env=await fixture(process.argv[2]||'tmp/spike-3d/hidden-dev/browser',process.argv[3]||'baseline');const s=await env.browser();
  await s.js("window.counts={lighting:0,ms:0};const original=gt.renderLighting.bind(gt);gt.renderLighting=(...args)=>{const start=performance.now();counts.lighting++;try{return original(...args)}finally{counts.ms+=performance.now()-start}};true");
  async function measure(name){await delay(700);await s.js('counts={lighting:0,ms:0};true');const before=Object.fromEntries((await s.call('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));await delay(3000);const after=Object.fromEntries((await s.call('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));record(name,{...await s.js('counts'),seconds:3,taskSeconds:after.TaskDuration-before.TaskDuration,scriptSeconds:after.ScriptDuration-before.ScriptDuration,heapBytes:after.JSHeapUsedSize});}
  await s.js('gt.currentTable.lightingEnabled=false;gt.currentTable.roomMode="standard";window.c=gt.characters[0];true');
  await measure('normal-idle');
  await s.js('gt.currentTable.lightingEnabled=true;gt.currentTable.lightingNightMode=true;c.lightSourceEnabled=true;c.lightType="normal";true');
  await measure('static-light-idle');
  await s.js('c.lightType="torch";true');await measure('animated-light');
  await s.js('gt.currentTable.lightingEnabled=false;c.lightSourceEnabled=false;for(let i=0;i<64;i++){const c=gt.characters[0].constructor.create("Load "+i,1,gt.characters[0].imageFile.identifier);c.location={name:"table",x:100+(i%8)*90,y:100+Math.floor(i/8)*90}}true');
  await measure('heavy-64-token-idle');
  await s.js("[...document.querySelectorAll('li')].find(e=>e.textContent.trim().endsWith('画像'))?.click();true");await s.wait("!!document.querySelector('file-storage')");
  record('gallery',{images:await s.js("ng.getComponent(document.querySelector('file-storage')).images.length"),lazy:await s.js("document.querySelectorAll('file-storage img[loading=lazy]').length")});
  assert.equal(s.exceptions.length,0,JSON.stringify(s.exceptions));assert.equal(await s.js('!!window.__spike3d'),false);record('exceptions',0);
})().catch(e=>{record('FAIL',e.stack);process.exitCode=1}).finally(async()=>{if(env){fs.writeFileSync(path.join(env.out,'results.json'),JSON.stringify(results,null,2));console.log('EVIDENCE',env.out);await env.close()}});
