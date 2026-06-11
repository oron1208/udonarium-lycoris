import { SyncObject, SyncVar } from './core/synchronize-object/decorator';
import { ObjectContext } from './core/synchronize-object/game-object';
import { ObjectNode } from './core/synchronize-object/object-node';
import { StringUtil } from './core/system/util/string-util';
import { DataElement } from './data-element';
import { GameCharacter } from './game-character';

export interface PaletteLine {
  palette: string;
}

export interface PaletteIndex {
  name: string;
  line: number;
}

export interface PaletteMatch {
  text: string;
  line: number;
}

export interface PaletteVariable {
  name: string;
  value: string;
}

@SyncObject('chat-palette')
export class ChatPalette extends ObjectNode {
  @SyncVar() dicebot: string = 'DiceBot';
  //TODO: キャラシ項目のコピー

  get paletteLines(): PaletteLine[] {
    if (!this.isAnalized) this.parse(<string>this.value);
    return this._paletteLines;
  }

  get paletteVariables(): PaletteVariable[] {
    if (!this.isAnalized) this.parse(<string>this.value);
    return this._paletteVariables;
  }

  isPaletteIndex( line: string , no: number): PaletteIndex{
    let index: PaletteIndex = {
      name: '',
      line: 0,
    };

    // コマ作成サイト(ユドナリウムのキャラコマを作るやつ様)の標準的な見出し区切りの書式から見出し語を抜き出す
    let matchRes1 = line.match(/^\/\/--[-]+(.*)$/);
    let matchRes2 = line.match(/^◆(.*)$/);
    if (matchRes1){
      index.name = matchRes1[1].replace(/-+$/,'');
      index.line = no;
      return index;
    }

    if (matchRes2){
      index.name = matchRes2[1];
      index.line = no;
      return index;
    }

    return null;
  }

  get paletteIndex(): PaletteIndex[]{
    let count = 0;
    let ret;
    let indexList: PaletteIndex[] = [];
    let palettString = <string> this.value;
    let palettes = palettString.split('\n');

    for (let line of palettes ){
      ret = this.isPaletteIndex(line, count);
      if (ret){
        indexList.push(ret);
      }
      count++;
    }
    return indexList;
  }

  paletteMatch(text: string): string[]{
    let count = 0;
    let matchList: string[] = [];

    let palettString = <string> this.value;
    let palettes = palettString.split('\n');

    for (let line of palettes ){
      if (line.indexOf(text) >= 0){
        matchList.push(line);
      }
      count++;
    }
    return matchList;
  }

  paletteMatchLine(text: string ,nth :number): number{
    let matchCount = 0;
    let lineNo = 0;
    let palettString = <string> this.value;
    let palettes = palettString.split('\n');

    for (let line of palettes ){
      if (line.indexOf(text) >= 0){
        if(matchCount == nth){
          return lineNo;
        }
        matchCount++;
      }
      lineNo++;
    }
    return -1;
  }

  private _palettes: string[] = [];
  private _paletteLines: PaletteLine[] = [];
  private _paletteVariables: PaletteVariable[] = [];
  private isAnalized: boolean = false;

  getPalette(): string[] {
    if (!this.isAnalized) this.parse(<string>this.value);
    return this._palettes;
  }

  setPalette(paletteSource: string) {
    this.value = paletteSource;
    this.isAnalized = false;
  }

  checkTargetCharactor(text: string): boolean{
    let istarget = text.match(/[tTｔＴ][{｛]\s*([^{}｛｝]+)\s*[}｝]/g) ? true : false;

    if( text.match(/^[sSｓＳ]?[tTｔＴ][:：]([^:：]+)/g) ){
      istarget = true;
    }
    if( text.match(/\s[sSｓＳ]?[tTｔＴ][:：]([^:：]+)/g) ){
      istarget = true;
    }
    if( text.match(/^[tTｔＴ][&＆]([^&＆]+)/g) ){
      istarget = true;
    }
    if( text.match(/\s[tTｔＴ][&＆]([^&＆]+)/g) ){
      istarget = true;
    }
    console.log('複数対象用コマンド：'+istarget);
    return istarget;
  }

  private resolveVariableValue(name: string, extendVariables?: DataElement, target?: GameCharacter, useMax: boolean = false): string {
    // パレット変数から検索
    if (target?.chatPalette) {
      for (let variable of target.chatPalette.paletteVariables) {
        if (variable.name == name) return variable.value;
      }
    }
    for (let variable of this.paletteVariables) {
      if (variable.name == name) return variable.value;
    }

    // コマデータ要素から検索
    if (target) {
      let element = target.rootDataElement.getFirstElementByName(name);
      if (element) {
        if (useMax && element.isNumberResource) return element.value + '';
        return element.isNumberResource ? element.currentValue + '' : element.value + '';
      }
    }
    if (extendVariables) {
      let element = extendVariables.getFirstElementByName(name);
      if (element) {
        if (useMax && element.isNumberResource) return element.value + '';
        return element.isNumberResource ? element.currentValue + '' : element.value + '';
      }
    }
    return '';
  }

  private evaluateFunction(funcName: string, argsStr: string, extendVariables?: DataElement, target?: GameCharacter): string {
    const args = argsStr.split(',').map(a => StringUtil.toHalfWidth(a.trim()));
    const values: number[] = [];
    for (const arg of args) {
      // 数値リテラルかチェック
      const literalNum = parseFloat(arg);
      if (!isNaN(literalNum) && arg.match(/^[\d.]+$/)) {
        values.push(literalNum);
        continue;
      }
      // タグ名として検索
      const val = this.resolveVariableValue(arg, extendVariables, target);
      const num = parseFloat(val);
      if (!isNaN(num)) values.push(num);
    }
    if (values.length === 0) return '';
    if (funcName === 'max') return Math.max(...values) + '';
    if (funcName === 'min') return Math.min(...values) + '';
    return '';
  }

  evaluate(line: PaletteLine, extendVariables?: DataElement, target?: GameCharacter, enableExtendedDiceBot?: boolean): string
  evaluate(line: string, extendVariables?: DataElement, target?: GameCharacter, enableExtendedDiceBot?: boolean): string
  evaluate(line: any, extendVariables?: DataElement, target?: GameCharacter, enableExtendedDiceBot?: boolean): string {
    let evaluate: string = '';
    if (typeof line === 'string') {
      evaluate = line;
    } else {
      evaluate = line.palette;
    }

    console.log(evaluate);
    let limit = 128;
    let loop = 0;
    let isContinue = true;
    while (isContinue) {
      loop++;
      isContinue = false;
      evaluate = evaluate.replace(/[tTｔＴ]?[{｛]\s*([^{}｛｝]+)\s*[}｝]/g, (match, name) => {

        name = StringUtil.toHalfWidth(name);

        // max()/min() 関数の処理（拡張ダイスボット有効時のみ）
        let funcMatch = enableExtendedDiceBot ? name.match(/^(max|min)\((.+)\)$/i) : null;
        if (funcMatch) {
          const result = this.evaluateFunction(funcMatch[1].toLowerCase(), funcMatch[2], extendVariables, target);
          isContinue = true;
          return result;
        }

        let useMax = false;
        let namematch = name.match(/(.+)([\^＾]$)/);
        if (namematch) {
          name = namematch[1];
          useMax = true;
        }
        isContinue = true;

        if (match.match(/^[tTｔＴ].*/)) {
          for (let variable of target.chatPalette.paletteVariables) {
            if (variable.name == name) return variable.value.replace(/[{｛]/g,'t{');;
          }
          if (target) {
            let element = target.rootDataElement.getFirstElementByName(name);
            if (element) {
              let targetElementText =''
              if (useMax && element.isNumberResource){
                targetElementText = element.value + '';
              }else{
                targetElementText = element.isNumberResource ? element.currentValue + '' : element.value + '';
              }
              if ( targetElementText.match(/[{｛]\s*([^{}｛｝]+)\s*[}｝]/g)) {
                targetElementText = targetElementText.replace(/[{｛]/g,'t{');
              }
              return targetElementText;
            }
          }
        }else{
          for (let variable of this.paletteVariables) {
            if (variable.name == name) return variable.value;
          }

          if (extendVariables) {
            let element = extendVariables.getFirstElementByName(name);
            if (element) {
              if(useMax && element.isNumberResource) return element.value + '';
              return element.isNumberResource ? element.currentValue + '' : element.value + '';
            }
          }
        }
        return '';
      });
      if (limit < loop) isContinue = false;
    }
    return evaluate;
  }

  private parse(paletteSource: string) {
    this._palettes = paletteSource.split('\n');

    this._paletteLines = [];
    this._paletteVariables = [];

    for (let palette of this._palettes) {
      let variable = this.parseVariable(palette);
      if (variable) {
        this._paletteVariables.push(variable);
        continue;
      }
      let line: PaletteLine = { palette: palette };
      this._paletteLines.push(line);
    }
    this.isAnalized = true;
  }

  private parseVariable(palette: string): PaletteVariable {
    let array = /^\s*[/／]{2}([^=＝{}｛｝\s]+)\s*[=＝]\s*(.+)\s*/gi.exec(palette);
    if (!array) return null;
    let variable: PaletteVariable = {
      name: StringUtil.toHalfWidth(array[1]),
      value: array[2]
    }
    return variable;
  }

  // override
  apply(context: ObjectContext) {
    super.apply(context);
    this.isAnalized = false;
  }
}

@SyncObject('buff-palette')
export class BuffPalette extends ChatPalette {
}


@SyncObject('dice-table-palette')
export class DiceTablePalette extends ChatPalette {
}
