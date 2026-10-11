// Run the real evaluator source, replacing only the browser/synchronization infrastructure.
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
function load(file, deps) {
  const js = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, experimentalDecorators: true}
  }).outputText;
  const mod = {exports:{}};
  new Function('require','module','exports',js)(name => {
    if (!(name in deps)) throw Error('Unexpected dependency '+name);
    return deps[name];
  }, mod, mod.exports);
  return mod.exports;
}
const arithmetic = load('src/app/class/core/system/util/arithmetic.ts', {});
const {ChatPalette} = load('src/app/class/chat-palette.ts', {
  './core/synchronize-object/decorator': {SyncObject:()=>x=>x, SyncVar:()=>()=>{}},
  './core/synchronize-object/object-node': {ObjectNode:class {}},
  './core/system/util/string-util': {StringUtil:{toHalfWidth:s=>s.replace(/[！-～]/g,c=>String.fromCharCode(c.charCodeAt(0)-0xfee0)).replace(/　/g,' ')}},
  './core/system/util/logger': {Logger:{debug(){}}},
  './core/system/util/arithmetic': arithmetic
});
const p = new ChatPalette();
p.setPalette('//Lv=5\n//X=10\n//TX=3\n//Ability=4+2');
const data = {getFirstElementByName:n=>n==='HP'?{isNumberResource:true,currentValue:20,value:30}:null};
const targetPalette = new ChatPalette(); targetPalette.setPalette('//Lv=9');
const target = {chatPalette:targetPalette,rootDataElement:data};
const cases = [
 ['{max(3,7,5)}','7'], ['{min(3,7,5)}','3'], ['{sum(3,5,7)}','15'],
 ['{avg(10,15,14)}','13'], ['{abs(-4)}','4'], ['{ceil(3.2)}','4'],
 ['{floor(3.8)}','3'], ['{round(3.5)}','4'], ['{clamp(15,1,10)}','10'],
 ['{ceil({Lv}/2)}d6','3d6'], ['距離: {abs({X}-{TX})}','距離: 7'],
 ['{max({abs(-3)},{abs(-7)})}','7'], ['{ceil((5+2)/2)}','4'],
 ['{sum(+2,.5,-1.5)}','1'], ['{ceil(Ability/2)}','{ceil(Ability/2)}'],
 ['{sum(Ability,1)}','7'], ['{max(HP,HP^)}','30'], ['{HP}/{HP^}','20/30'],
 ['{sum({HP}, {HP^})}','50'], ['{ceil(t{Lv}/2)}','5'],
 ['{max(Lv,1)}','5'], ['t{max(Lv,1)}','9'],
 ['{max(1,missing)}','{max(1,missing)}'], ['{abs({missing}-3)}','{abs({missing}-3)}'],
 ['{abs(10-3)}','7'], ['{ceil(1/0)}','{ceil(1/0)}'], ['{abs(1,2)}','{abs(1,2)}'],
 ['{clamp(1,2)}','{clamp(1,2)}'], ['{sum()}','{sum()}'],
 ['{clamp({HP}-1d6,0,999)}','{clamp(20-1d6,0,999)}'],
 ['{ceil(3.2.1)}','{ceil(3.2.1)}'], ['{ceil((5+2)/0)}','{ceil((5+2)/0)}'],
 ['K(21+5)[10]+(7+2)','K(21+5)[10]+9'], ['K(21+(2*3))[10]+(7+2)','K(21+(2*3))[10]+9'],
 ['AT+(2+(3*4))','AT+14'], ['AR(1-5)','AR(1-5)'], ['AR+(1-5)','AR-4'],
 ['{ＣＥＩＬ(５／２)}','3'], ['{sum(1e2,2)}','102']
];
let count = 0;
for (const [input,expected] of cases) {assert.equal(p.evaluate(input,data,target,true),expected,input);count++;}
assert.equal(p.evaluate('{Lv} {ceil(3.2)} AT+(2*3)',data,null,false),'5  AT+(2*3)'); count++;
assert.equal(p.evaluate('{unknown}',data,null,true,true),'{unknown}'); count++;
assert.doesNotThrow(()=>p.evaluate('t{Lv}',data,null,true)); count++;
for (const input of ['1+2garbage','1/0','2**3','process.exit()','1;2','/*x*/2','1e309',' '.repeat(5000)]) {
  assert.equal(arithmetic.evaluateArithmetic(input),null,input);count++;
}
console.log(`PASS ${count} extended dicebot regression assertions`);
