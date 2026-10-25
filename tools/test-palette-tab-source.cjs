// Pure source-boundary regressions; no browser/backend or test-runner setup.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { transformSync } = require('esbuild');
const input = fs.readFileSync(path.join(__dirname, '../src/app/class/palette-document.ts'), 'utf8');
const code = transformSync(input, {loader:'ts', format:'cjs', target:'es2022'}).code;
const compiled = {exports:{}};
new Function('module','exports',code)(compiled,compiled.exports);
const {replacePaletteTabBody,parsePaletteDocument} = compiled.exports;
let checks=0;
const equal=(actual,expected)=>{assert.equal(actual,expected);checks++;};
const source='//能力=5\n// @tab 戦闘\n// @fold 攻撃\n2d6\n// @end\n\n// @tab 台詞\nこんにちは\n';
equal(replacePaletteTabBody(source,1,'2d6+1\n\n1d6'), '//能力=5\n// @tab 戦闘\n2d6+1\n\n1d6\n// @tab 台詞\nこんにちは\n');
equal(replacePaletteTabBody(source,1,''), '//能力=5\n// @tab 戦闘\n// @tab 台詞\nこんにちは\n');
equal(replacePaletteTabBody(source,-1,'//能力=8\n共通の説明'), '//能力=8\n共通の説明\n// @tab 戦闘\n// @fold 攻撃\n2d6\n// @end\n\n// @tab 台詞\nこんにちは\n');
equal(replacePaletteTabBody(source,-1,''), source.slice(source.indexOf('// @tab')));
equal(replacePaletteTabBody('// @tab A\n1\n// @tab A\n2',2,'3'), '// @tab A\n1\n// @tab A\n3');
equal(replacePaletteTabBody('// @tab 空',0,'追加'), '// @tab 空\n追加');
equal(replacePaletteTabBody('// @tab 空\n',0,''), '// @tab 空\n');
equal(replacePaletteTabBody('2d6\n説明',-1,'1d6'), '1d6');
equal(replacePaletteTabBody('',-1,'1d6'), '1d6');
const windows='//能力=5\r\n// @tab 戦闘\r\n旧行\r\n// @tab 台詞\r\nそのまま\r\n';
equal(replacePaletteTabBody(windows,1,'新行\n\n次行'), '//能力=5\r\n// @tab 戦闘\r\n新行\r\n\r\n次行\r\n// @tab 台詞\r\nそのまま\r\n');
for(const tab of parsePaletteDocument(source).tabs){
  const body=parsePaletteDocument(source).lines.slice(tab.start<0?0:tab.start+1,tab.end).join('\n');
  equal(replacePaletteTabBody(source,tab.start,body),source);
}
equal(replacePaletteTabBody(source,1,'2d6\n// @tab 別タブ\n1d6'),null);
equal(replacePaletteTabBody(source,-2,'全体'),null);
equal(replacePaletteTabBody(source,999,'不明'),null);
console.log(`PASS ${checks} tab-body boundary checks`);
