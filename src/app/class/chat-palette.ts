import { SyncObject, SyncVar } from './core/synchronize-object/decorator';
import { ObjectContext } from './core/synchronize-object/game-object';
import { ObjectNode } from './core/synchronize-object/object-node';
import { StringUtil } from './core/system/util/string-util';
import { DataElement } from './data-element';
import { GameCharacter } from './game-character';
import { Logger } from './core/system/util/logger';
import { evaluateArithmetic } from './core/system/util/arithmetic';

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
    Logger.debug('複数対象用コマンド：'+istarget);
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
      // 裸のタグ名も従来どおり解決。式は全体を解析し、部分的な数値を採用しない。
      const useMax = arg.endsWith('^');
      const val = this.resolveVariableValue(useMax ? arg.slice(0, -1) : arg, extendVariables, target, useMax);
      const num = evaluateArithmetic(val !== '' ? StringUtil.toHalfWidth(val) : arg);
      if (num === null) return null;
      values.push(num);
    }
    if (values.length === 0) return null;
    // 複数値関数
    if (funcName === 'max') return Math.max(...values) + '';
    if (funcName === 'min') return Math.min(...values) + '';
    if (funcName === 'sum') return values.reduce((a, b) => a + b, 0) + '';
    if (funcName === 'avg') return (values.reduce((a, b) => a + b, 0) / values.length) + '';
    // 単一値関数は1引数。過不足を黙って無視しない。
    if (['abs', 'ceil', 'floor', 'round'].includes(funcName) && values.length !== 1) return null;
    const v = values[0];
    if (funcName === 'abs') return Math.abs(v) + '';
    if (funcName === 'ceil') return Math.ceil(v) + '';
    if (funcName === 'floor') return Math.floor(v) + '';
    if (funcName === 'round') return Math.round(v) + '';
    // clamp(N, min, max) — 3引数必須
    if (funcName === 'clamp' && values.length === 3) {
      return Math.min(Math.max(values[0], values[1]), values[2]) + '';
    }
    return null;
  }

  evaluate(line: PaletteLine, extendVariables?: DataElement, target?: GameCharacter, enableExtendedDiceBot?: boolean, preserveUnknown?: boolean): string
  evaluate(line: string, extendVariables?: DataElement, target?: GameCharacter, enableExtendedDiceBot?: boolean, preserveUnknown?: boolean): string
  evaluate(line: any, extendVariables?: DataElement, target?: GameCharacter, enableExtendedDiceBot?: boolean, preserveUnknown = false): string {
    let evaluate: string = '';
    if (typeof line === 'string') {
      evaluate = line;
    } else {
      evaluate = line.palette;
    }

    Logger.debug(evaluate);
    // 未評価の関数やコマンド引数は後段の括弧計算からも保護する。
    const protectedTexts: string[] = [];
    let marker = '\uE000';
    while (evaluate.includes(marker)) marker += '\uE000';
    const protect = (text: string) => marker + (protectedTexts.push(text) - 1) + '\uE001';
    let limit = 128;
    let loop = 0;
    let isContinue = true;
    while (isContinue) {
      loop++;
      isContinue = false;
      evaluate = evaluate.replace(/[tTｔＴ]?[{｛]\s*([^{}｛｝]+)\s*[}｝]/g, (match, name, offset, source) => {

        name = StringUtil.toHalfWidth(name).trim();

        // max()/min() 関数の処理（拡張ダイスボット有効時のみ）
        let funcMatch = enableExtendedDiceBot ? name.match(/^(max|min|sum|avg|abs|ceil|floor|round|clamp)\((.*)\)$/i) : null;
        if (funcMatch) {
          const result = this.evaluateFunction(funcMatch[1].toLowerCase(), funcMatch[2], extendVariables, /^[tTｔＴ]/.test(match) ? target : undefined);
          isContinue = true;
          return result !== null && Number.isFinite(Number(result)) ? result : protect(match);
        }

        let useMax = false;
        let namematch = name.match(/(.+)([\^＾]$)/);
        if (namematch) {
          name = namematch[1];
          useMax = true;
        }
        isContinue = true;

        if (match.match(/^[tTｔＴ].*/)) {
          for (let variable of target?.chatPalette?.paletteVariables || []) {
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
        // 関数内の未定義値は消さない（例: {abs({missing}-3)} を3にしない）。
        const before = source.slice(0, offset);
        const insideFunction = enableExtendedDiceBot && /[｛{](?:max|min|sum|avg|abs|ceil|floor|round|clamp)\([^｝}]*$/i.test(before);
        return preserveUnknown || insideFunction ? protect(match) : '';
      });
      if (limit < loop) isContinue = false;
    }

    // 拡張ダイスボット: (数式) を計算して置換
    // 例: AR+(1-5) → AR-4, 2d6+(3*2) → 2d6+6。英字直後はBCDiceに委譲。
    if (enableExtendedDiceBot) {
      // K(式) 等、英字直後の括弧はBCDice自身の構文。入れ子も丸ごと保持する。
      for (let i = 1; i < evaluate.length; i++) {
        if (evaluate[i] !== '(' || !/[a-zA-Z]/.test(evaluate[i - 1])) continue;
        let depth = 1;
        let end = i + 1;
        while (end < evaluate.length && depth > 0) {
          if (evaluate[end] === '(') depth++;
          if (evaluate[end] === ')') depth--;
          end++;
        }
        if (depth === 0) evaluate = evaluate.slice(0, i) + protect(evaluate.slice(i, end)) + evaluate.slice(end);
      }
      let prev = '';
      while (prev !== evaluate) {
        prev = evaluate;
        evaluate = evaluate.replace(/([+-]?)\(([-+\d*/.\s]+)\)/g, (match, prefix, expr) => {
          try {
            if (/^[-+\d*/.\s]+$/.test(expr)) {
              const result = evaluateArithmetic(expr);
              if (typeof result === 'number' && isFinite(result)) {
                const absResult = Math.abs(result);
                if (prefix === '+') {
                  // +(式) → 結果に応じて +N または -N
                  return result >= 0 ? '+' + result : String(result);
                } else if (prefix === '-') {
                  // -(式) → 符号反転
                  return result > 0 ? '-' + result : '+' + absResult;
                } else {
                  // (式) 単体 → 結果に応じて +N または -N
                  return result >= 0 ? '+' + result : String(result);
                }
              }
            }
          } catch (e) {}
          return match;
        });
      }
    }

    // 外側の保護文字列が内側を参照するので、登録の逆順に復元する。
    for (let i = protectedTexts.length - 1; i >= 0; i--) {
      evaluate = evaluate.split(marker + i + '\uE001').join(protectedTexts[i]);
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
