// Reuse the pre-existing rotation/front/label acceptance scripts against an isolated production build.
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),yaml=require('js-yaml');
const root=path.resolve(__dirname,'..'),build=path.resolve(root,process.argv[2]||'tmp/spike-3d/model-storage-production/browser');
const out=path.join(root,'tmp/spike-3d','storage-regressions-'+Date.now()),server=path.join(out,'server');
const delay=ms=>new Promise(r=>setTimeout(r,ms));let child;
(async()=>{
  fs.mkdirSync(path.join(server,'dist'),{recursive:true});
  fs.copyFileSync(path.join(root,'unified-server.js'),path.join(server,'unified-server.js'));
  for(const name of ['node_modules','signaling-server'])fs.symlinkSync(path.join(root,name),path.join(server,name),'dir');
  fs.symlinkSync(build,path.join(server,'dist/udonarium-lycoris'),'dir');
  const config=path.join(build,'assets/config.yaml'),cfg=yaml.load(fs.readFileSync(config,'utf8'));
  cfg.backend={mode:'websocket-relay',url:''};cfg.webrtc={key:'',signalingUrl:'ws://localhost:14459/signaling'};
  fs.writeFileSync(config,yaml.dump(cfg));
  fs.copyFileSync(path.join(root,'tmp/spike-3d/front-positive-z.glb'),path.join(out,'front-positive-z.glb'));
  const fd=fs.openSync(path.join(out,'server.log'),'w');
  child=spawn(process.execPath,[path.join(server,'unified-server.js')],{cwd:server,env:{...process.env,PORT:'14459'},stdio:['ignore',fd,fd]});
  let ready=false;for(let n=0;n<100;n++){try{if((await fetch('http://localhost:14459/v1/status')).ok){ready=true;break;}}catch{}await delay(100);}
  if(!ready)throw Error('Isolated server did not start');
  for(const name of ['handle-direction-e2e-test.cjs','front-and-cleanup-e2e-test.cjs']){
    const source=fs.readFileSync(path.join(root,'tmp/spike-3d',name),'utf8')
      .replaceAll('https://localhost:12081/','http://localhost:14459/')
      .replace("await call('Page.navigate',", "await call('Page.addScriptToEvaluateOnNewDocument', {source: \"localStorage.setItem('lycoris.experimental.model3d','1');\"}); await call('Page.navigate',")
      .replace('const js = async expression => {', 'const js = async expression => { console.log("CDP evaluation", expression.slice(0, 120));');
    const target=path.join(out,name);fs.writeFileSync(target,source);
    const logfile=fs.openSync(path.join(out,name+'.log'),'w');
    const code=await new Promise(resolve=>{const p=spawn(process.execPath,[target],{cwd:root,stdio:['ignore',logfile,logfile]});p.on('exit',resolve);});
    const log=fs.readFileSync(path.join(out,name+'.log'),'utf8');
    console.log(name,'exit='+code,log.slice(-1400));
    if(code!==0||!log.includes('exceptions: 0'))throw Error(name+' failed');
  }
  console.log('PASS production regressions');
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{child?.kill('SIGTERM');await delay(300);console.log('EVIDENCE',out);});
