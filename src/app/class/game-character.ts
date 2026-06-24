import { ChatPalette,BuffPalette } from './chat-palette';

import { ImageFile } from './core/file-storage/image-file';
import { ImageStorage } from './core/file-storage/image-storage';
import { SyncObject, SyncVar } from './core/synchronize-object/decorator';
import { DataElement } from './data-element';
import { TabletopObject } from './tabletop-object';
import { UUID } from '@udonarium/core/system/util/uuid';

//import { GameObjectInventoryService } from 'service/game-object-inventory.service';
import { ObjectStore } from './core/synchronize-object/object-store';

@SyncObject('character')
export class GameCharacter extends TabletopObject {
  constructor(identifier: string = UUID.generateUuid()) {
    super(identifier);
    this.isAltitudeIndicate = true;
  }

  @SyncVar() isLock: boolean = false;

  @SyncVar() rotate: number = 0;
  @SyncVar() roll: number = 0;
  @SyncVar() isDropShadow: boolean = false;

  @SyncVar() hideInventory: boolean = false;
  @SyncVar() visibility: string = 'public';
  @SyncVar() secretDetails: boolean = false;
  @SyncVar() nonTalkFlag: boolean = false;
  @SyncVar() overViewWidth: number = 270;
  @SyncVar() overViewMaxHeight: number = 250;

  @SyncVar() specifyKomaImageFlag: boolean = false;
  @SyncVar() komaImageHeignt: number = 100;

  @SyncVar() chatColorCode: string[]  = ["#000000","#FF0000","#0099FF"];
  @SyncVar() syncDummyCounter: number = 0;
  @SyncVar() statusMarkerIds: string = '[]';

  // アドバンスモード: 所有/視界設定
  @SyncVar() ownerPeerIds: string = '[]';
  @SyncVar() ownerUserIds: string = '[]';
  @SyncVar() sightEnabled: boolean = false;
  @SyncVar() sightMode: string = 'normal';
  @SyncVar() sightRadius: number = 6;
  @SyncVar() sightUnlimited: boolean = false;

  // 光源
  @SyncVar() lightSourceEnabled: boolean = false;
  @SyncVar() lightRadius: number = 3;
  @SyncVar() lightColor: string = '#ffaa44';
  @SyncVar() lightIntensity: number = 0.8;
  @SyncVar() lightType: string = 'torch';
  @SyncVar() lightShape: string = 'circle';
  @SyncVar() lightConeAngle: number = 60;
  @SyncVar() superiorDarknessEnabled: boolean = false;
  @SyncVar() superiorDarknessRadius: number = 3;

  // 自動計算バフ（アドバンスモード用）
  @SyncVar() autoBuffsJson: string = '[]';

  _targeted: boolean = false;
  get targeted(): boolean {
    return this._targeted;
  }
  set targeted( flag: boolean) {
    this._targeted = flag;
  }

  _selectedTachieNum: number = 0;
  get selectedTachieNum(): number {
    if( this._selectedTachieNum > ( this.imageDataElement.children.length - 1) ){
      this._selectedTachieNum = this.imageDataElement.children.length - 1;
    }
    if( this._selectedTachieNum < 0 ){
      this._selectedTachieNum = 0;
    }

    return this._selectedTachieNum;
  }

  set selectedTachieNum(num : number){
    console.log("set selectedTachieNum NUM=" + num +" len" + this.imageDataElement.children.length);

    if( num > ( this.imageDataElement.children.length - 1 ) ){
      num = this.imageDataElement.children.length - 1;
    }
    if( num < 0 ){
      num = 0;
    }
    this._selectedTachieNum = num
    console.log("set selectedTachieNum" + this._selectedTachieNum);

  }

  private getIconNumElement(): DataElement {
    const iconNum = this.detailDataElement.getFirstElementByName('ICON');
    if (!iconNum || !iconNum.isNumberResource) return null;
    return iconNum;
  }

  get imageFile(): ImageFile {
    if (!this.imageDataElement) return ImageFile.Empty;

    const iconNum = this.getIconNumElement();
    if (!iconNum) {
      const image: DataElement = this.imageDataElement.getFirstElementByName('imageIdentifier');
      const file = ImageStorage.instance.get(<string>image.value);
      return file ? file : ImageFile.Empty;
    } else {
      let n = <number>iconNum.currentValue;
      if (n > this.imageDataElement.children.length - 1) n = this.imageDataElement.children.length - 1;
      const image = this.imageDataElement.children[n];
      const file = ImageStorage.instance.get(<string>image.value);
      return file ? file : ImageFile.Empty;
    }
  }

  get name(): string { return this.getCommonValue('name', ''); }
  get size(): number { return this.getCommonValue('size', 1); }
  get initiative(): number { return this.getCommonValue('initiative', 0); }
  get initiativeFormula(): string { return this.getCommonValue('initiativeFormula', ''); }
  get chatPalette(): ChatPalette {
    for (let child of this.children) {
      if (child instanceof ChatPalette) return child;
    }
    return null;
  }

  set name(value:string) { this.setCommonValue('name', value); }
  set size(value: number) { this.setCommonValue('size', value); }
  set initiative(value: number) { this.setCommonValue('initiative', value); }
  set initiativeFormula(value: string) { this.setCommonValue('initiativeFormula', value); }

  TestExec() {
    console.log('TestExec');

  }
  get remoteController(): BuffPalette {
    for (let child of this.children) {
      if (child instanceof BuffPalette){
        return child;
      }
    }
    return null;
  }

  static create(name: string, size: number, imageIdentifier: string ): GameCharacter {
    let gameCharacter: GameCharacter = new GameCharacter();
    gameCharacter.createDataElements();
    gameCharacter.initialize();

    gameCharacter.createTestGameDataElement(name, size, imageIdentifier);

    return gameCharacter;
  }

  static createFromIachara(data: any, imageIdentifier: string = ''): GameCharacter {
    let gameCharacter: GameCharacter = new GameCharacter();
    gameCharacter.createDataElements();

    const characterData = data && data.data ? data.data : {};
    const name = characterData.name || 'いあきゃらキャラクター';

    gameCharacter.commonDataElement.appendChild(DataElement.create('name', name, {}, 'name_' + gameCharacter.identifier));
    gameCharacter.commonDataElement.appendChild(DataElement.create('size', 1, {}, 'size_' + gameCharacter.identifier));
    gameCharacter.commonDataElement.appendChild(DataElement.create('altitude', 0, {}, 'altitude_' + gameCharacter.identifier));
    gameCharacter.commonDataElement.appendChild(DataElement.create('initiative', 0, {}, 'initiative_' + gameCharacter.identifier));
    gameCharacter.commonDataElement.appendChild(DataElement.create('initiativeFormula', '', {}, 'initiativeFormula_' + gameCharacter.identifier));

    if (gameCharacter.imageDataElement.getFirstElementByName('imageIdentifier')) {
      gameCharacter.imageDataElement.getFirstElementByName('imageIdentifier').value = imageIdentifier;
    }

    let resourceElement: DataElement = DataElement.create('リソース', '', {}, 'リソース' + gameCharacter.identifier);
    gameCharacter.detailDataElement.appendChild(resourceElement);
    const statuses = Array.isArray(characterData.status) ? characterData.status : [];
    for (let status of statuses) {
      if (!status || status.label == null) continue;
      const value = GameCharacter.toNumberOrString(status.max != null ? status.max : status.value);
      const currentValue = GameCharacter.toNumberOrString(status.value);
      resourceElement.appendChild(DataElement.create(status.label, value, { 'type': 'numberResource', 'currentValue': currentValue }, status.label + '_' + gameCharacter.identifier));
    }

    let abilityElement: DataElement = DataElement.create('能力値', '', {}, '能力値' + gameCharacter.identifier);
    gameCharacter.detailDataElement.appendChild(abilityElement);
    const params = Array.isArray(characterData.params) ? characterData.params : [];
    for (let param of params) {
      if (!param || param.label == null) continue;
      abilityElement.appendChild(DataElement.create(param.label, GameCharacter.toNumberOrString(param.value), {}, param.label + '_' + gameCharacter.identifier));
    }

    const skillValues = GameCharacter.extractIacharaSkillValues(characterData);
    if (skillValues.size > 0) {
      let skillElement: DataElement = DataElement.create('技能', '', {}, '技能' + gameCharacter.identifier);
      gameCharacter.detailDataElement.appendChild(skillElement);
      for (let [label, value] of skillValues.entries()) {
        skillElement.appendChild(DataElement.create(label, GameCharacter.toNumberOrString(value), {}, label + '_' + gameCharacter.identifier));
      }
    }

    let infoElement: DataElement = DataElement.create('情報', '', {}, '情報' + gameCharacter.identifier);
    gameCharacter.detailDataElement.appendChild(infoElement);
    if (characterData.externalUrl) {
      infoElement.appendChild(DataElement.create('いあきゃらURL', characterData.externalUrl, { 'type': 'note' }, 'いあきゃらURL' + gameCharacter.identifier));
    }
    if (characterData.initiative != null) {
      infoElement.appendChild(DataElement.create('イニシアチブ', GameCharacter.toNumberOrString(characterData.initiative), {}, 'イニシアチブ' + gameCharacter.identifier));
    }

    let palette: ChatPalette = new ChatPalette('ChatPalette_' + gameCharacter.identifier);
    palette.dicebot = GameCharacter.detectIacharaDicebot(characterData);
    palette.setPalette(GameCharacter.buildIacharaPalette(characterData));
    palette.initialize();
    gameCharacter.appendChild(palette);

    gameCharacter.addExtendData();
    gameCharacter.setLocation('table');
    gameCharacter.update();

    return gameCharacter;
  }

  private static buildIacharaPalette(characterData: any): string {
    const dicebot = GameCharacter.detectIacharaDicebot(characterData);
    const commands = characterData.commands ? characterData.commands : '';
    const abilityValues = GameCharacter.extractIacharaNamedValues(characterData.params);
    const skillValues = GameCharacter.extractIacharaSkillValues(characterData);
    const used = new Set<string>();
    const lines: string[] = [];
    for (let rawLine of String(commands).split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || /^\/\//.test(line)) continue;
      const converted = GameCharacter.convertIacharaCommandToReference(line, dicebot, abilityValues, skillValues);
      const key = GameCharacter.iACharaCommandDedupKey(converted);
      if (key && used.has(key)) continue;
      if (key) used.add(key);
      lines.push(converted);
    }
    return lines.join('\n').trim();
  }

  static buildIacharaHotbarSlots(characterData: any): { label: string, text: string, iconIdentifier: string }[] {
    const slots: { label: string, text: string, iconIdentifier: string }[] = [];
    const seen = new Set<string>();
    const commands = GameCharacter.buildIacharaPalette(characterData);

    for (let rawLine of commands.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || /^\/\//.test(line)) continue;
      if (!/^(CCB|CC|RES|CBR|FAR|BMR|BMS|FCL|FCM|PH|MA)\b/i.test(line)) continue;
      const slot = GameCharacter.commandToHotbarSlot(line);
      if (!slot || seen.has(slot.text)) continue;
      slots.push(slot);
      seen.add(slot.text);
      if (slots.length >= 60) return slots;
    }

    return slots;
  }

  private static extractIacharaNamedValues(items: any): Map<string, number> {
    const values = new Map<string, number>();
    const list = Array.isArray(items) ? items : [];
    for (let item of list) {
      if (!item || item.label == null || item.value == null) continue;
      const label = String(item.label).trim();
      const value = Number(item.value);
      if (!label || Number.isNaN(value)) continue;
      values.set(label, value);
    }
    return values;
  }

  private static extractIacharaSkillValues(characterData: any): Map<string, number> {
    const skills = new Map<string, number>();
    const abilityValues = GameCharacter.extractIacharaNamedValues(characterData && characterData.params);
    const statusValues = GameCharacter.extractIacharaNamedValues(characterData && characterData.status);
    const commands = String(characterData && characterData.commands ? characterData.commands : '');
    for (let rawLine of commands.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || /^\/\//.test(line)) continue;
      const parsed = GameCharacter.parseIacharaCheckCommand(line);
      if (!parsed || !parsed.label || parsed.fixedTarget == null) continue;
      if (abilityValues.has(parsed.label) || statusValues.has(parsed.label)) continue;
      if (!skills.has(parsed.label)) skills.set(parsed.label, parsed.fixedTarget);
    }
    return skills;
  }

  private static parseIacharaCheckCommand(line: string): { head: string, target: string, rest: string, label: string, fixedTarget: number } {
    const match = /^((?:CCB|CC)(?:[-+]?\d+)?)<=([^\s]+)\s*(.*)$/i.exec(line);
    if (!match) return null;
    const rest = (match[3] || '').trim();
    const labelMatch = /[【\[]([^】\]]+)[】\]]/.exec(rest);
    const label = labelMatch ? labelMatch[1].trim() : '';
    const target = match[2].trim();
    const fixedTarget = /^\d+$/.test(target) ? Number(target) : null;
    return { head: match[1], target, rest, label, fixedTarget };
  }

  private static convertIacharaCommandToReference(line: string, dicebot: string, abilityValues: Map<string, number>, skillValues: Map<string, number>): string {
    const parsed = GameCharacter.parseIacharaCheckCommand(line);
    if (!parsed || !parsed.label) return line;

    const isAbility = abilityValues.has(parsed.label);
    const isSkill = skillValues.has(parsed.label);
    if (!isAbility && !isSkill) return line;

    let target = parsed.target;
    let note = `{${parsed.label}}`;
    if (isAbility) {
      const abilityValue = abilityValues.get(parsed.label);
      const shouldUseFiveTimes = dicebot === 'Cthulhu' && abilityValue <= 30;
      target = shouldUseFiveTimes ? `{${parsed.label}}*5` : `{${parsed.label}}`;
      note = shouldUseFiveTimes ? `{${parsed.label}}×5` : `{${parsed.label}}`;
    } else if (isSkill) {
      target = `{${parsed.label}}`;
    }

    let rest = parsed.rest || `【${parsed.label}】`;
    if (!/[（(][^（）()]*[）)]\s*$/.test(rest)) rest = `${rest}(${note})`;
    return `${parsed.head}<=${target} ${rest}`.trim();
  }

  private static iACharaCommandDedupKey(line: string): string {
    const parsed = GameCharacter.parseIacharaCheckCommand(line);
    if (!parsed || !parsed.label) return line;
    return `${parsed.head.toUpperCase()}:${parsed.label}`;
  }

  private static commandToHotbarSlot(line: string): { label: string, text: string, iconIdentifier: string } {
    const labelMatch = /[【\[]([^】\]]+)[】\]]/.exec(line);
    let label = labelMatch ? labelMatch[1].trim() : line.replace(/^(CCB|CC|RES|CBR|FAR|BMR|BMS|FCL|FCM|PH|MA)\S*\s*/i, '').trim();
    label = label.replace(/^[:：\-\s]+/, '').slice(0, 16) || line.slice(0, 16);
    return { label, text: line, iconIdentifier: '' };
  }

  private static detectIacharaDicebot(characterData: any): string {
    const commands = characterData && characterData.commands ? characterData.commands : '';
    const params = Array.isArray(characterData && characterData.params) ? characterData.params : [];

    if (/\b(CCB|RESB?|CBRB?)\b/i.test(commands)) return 'Cthulhu';
    if (/\b(FAR|BMR|BMS|FCL|FCM|PH|MA)\b/i.test(commands)) return 'Cthulhu7th';

    const abilityValues = params
      .map(param => Number(param && param.value))
      .filter(value => !Number.isNaN(value));
    if (abilityValues.some(value => 30 < value)) return 'Cthulhu7th';
    if (0 < abilityValues.length && abilityValues.every(value => 1 <= value && value <= 30)) return 'Cthulhu';

    if (/\bCC(?:[-+]?\d+)?<=/i.test(commands)) return 'Cthulhu7th';
    return 'DiceBot';
  }

  private static toNumberOrString(value: any): number | string {
    if (value == null) return '';
    const numberValue = Number(value);
    return Number.isNaN(numberValue) || value === '' ? value : numberValue;
  }

  addExtendData(){

    this.addBuffDataElement();

    // 既存キャラクターにイニシアチブフィールドがなかったら追加（マイグレーション）
    if (this.commonDataElement) {
      let initElm = this.commonDataElement.getElementsByName('initiative');
      if (initElm.length === 0) {
        this.commonDataElement.appendChild(
          DataElement.create('initiative', 0, {}, 'initiative_' + this.identifier)
        );
      }
      let formulaElm = this.commonDataElement.getElementsByName('initiativeFormula');
      if (formulaElm.length === 0) {
        this.commonDataElement.appendChild(
          DataElement.create('initiativeFormula', '', {}, 'initiativeFormula_' + this.identifier)
        );
      }
    }

    let istachie = this.detailDataElement.getElementsByName('立ち絵位置');
    if( istachie.length == 0 ){
      let testElement: DataElement = DataElement.create('立ち絵位置', '', {}, '立ち絵位置' + this.identifier);
      this.detailDataElement.appendChild(testElement);
      testElement.appendChild(DataElement.create('POS', 11, { 'type': 'numberResource', 'currentValue': '0' }, 'POS_' + this.identifier));
    }

    let iconNum = this.detailDataElement.getElementsByName('コマ画像');
    if( iconNum.length == 0 ){
      let elementKoma: DataElement = DataElement.create('コマ画像', '', {}, 'コマ画像' + this.identifier);
      this.detailDataElement.appendChild(elementKoma);

      //コマ画像作成時は立ち絵の次に差し込み
      let tachies = this.detailDataElement.getElementsByName('立ち絵位置');
      if( tachies.length != 0 ){
        let parentElement = tachies[0].parent;
        let index: number = parentElement.children.indexOf(tachies[0]);
        console.log("立ち絵の次に差し込み INdex" + index);
        if (index < parentElement.children.length - 1) {
          let nextElement = parentElement.children[index + 1];
          console.log("立ち絵の次に差し込み nextElement" + nextElement);
          
          parentElement.insertBefore(elementKoma, nextElement);
        }
      }
      elementKoma.appendChild(DataElement.create(
        'ICON',
        this.imageDataElement.children.length - 1,
        { 'type': 'numberResource', 'currentValue': 0 },
        'ICON_' + this.identifier
      ));
    }

    let isbuff = this.buffDataElement.getElementsByName('バフ/デバフ');
    if( isbuff.length == 0 ){
      let buffElement: DataElement = DataElement.create('バフ/デバフ', '', {}, 'バフ/デバフ' + this.identifier);
      this.buffDataElement.appendChild(buffElement);
    }
    if( this.remoteController == null){
      let controller: BuffPalette = new BuffPalette('RemotController_' + this.identifier);
      controller.setPalette(`コントローラ入力例：
マッスルベアー DB+2 3
クリティカルレイ A 18
セイクリッドウェポン 命+1攻+2 18`);
      controller.initialize();
      this.appendChild(controller);
    }
  }

  clone() :this {
    let cloneObject = super.clone();

    let objectname:string;
    let reg = new RegExp('^(.*)_([0-9]+)$');
    let res = cloneObject.name.match(reg);

    let cloneNumber:number = 0;
    if(res != null && res.length == 3) {
      objectname = res[1];
      cloneNumber = parseInt(res[2]) + 1;
    } else {
      objectname = cloneObject.name ;
      cloneNumber = 2;
    }

    let list = ObjectStore.instance.getObjects(GameCharacter);
    for (let character of list ) {
      if( character.location.name == 'graveyard' ) continue;

      res = character.name.match(reg);
      if(res != null && res.length == 3 && res[1] == objectname) {
        let numberChk = parseInt(res[2]) + 1 ;
        if( cloneNumber <= numberChk ){
          cloneNumber = numberChk
        }
      }
    }

    cloneObject.name = objectname + '_' + cloneNumber;
    cloneObject.update();

    return cloneObject;

  }

  createTestGameDataElement(name: string, size: number, imageIdentifier: string) {
    this.createDataElements();

    let nameElement: DataElement = DataElement.create('name', name, {}, 'name_' + this.identifier);
    let sizeElement: DataElement = DataElement.create('size', size, {}, 'size_' + this.identifier);
    let altitudeElement: DataElement = DataElement.create('altitude', 0, {}, 'altitude_' + this.identifier);
    let initiativeElement: DataElement = DataElement.create('initiative', 0, {}, 'initiative_' + this.identifier);
    let initiativeFormulaElement: DataElement = DataElement.create('initiativeFormula', '', {}, 'initiativeFormula_' + this.identifier);

    if (this.imageDataElement.getFirstElementByName('imageIdentifier')) {
      this.imageDataElement.getFirstElementByName('imageIdentifier').value = imageIdentifier;
    }

    let resourceElement: DataElement = DataElement.create('リソース', '', {}, 'リソース' + this.identifier);
    let hpElement: DataElement = DataElement.create('HP', 200, { 'type': 'numberResource', 'currentValue': '200' }, 'HP_' + this.identifier);
    let mpElement: DataElement = DataElement.create('MP', 100, { 'type': 'numberResource', 'currentValue': '100' }, 'MP_' + this.identifier);
//    let sanElement: DataElement = DataElement.create('SAN', 60, { 'type': 'numberResource', 'currentValue': '48' }, 'SAN_' + this.identifier);

    this.commonDataElement.appendChild(nameElement);
    this.commonDataElement.appendChild(sizeElement);
    this.commonDataElement.appendChild(altitudeElement);
    this.commonDataElement.appendChild(initiativeElement);
    this.commonDataElement.appendChild(initiativeFormulaElement);

    this.detailDataElement.appendChild(resourceElement);
    resourceElement.appendChild(hpElement);
    resourceElement.appendChild(mpElement);
//    resourceElement.appendChild(sanElement);

    //TEST
    let testElement: DataElement = DataElement.create('情報', '', {}, '情報' + this.identifier);
    this.detailDataElement.appendChild(testElement);
    testElement.appendChild(DataElement.create('説明', 'ここに説明を書く\nあいうえお', { 'type': 'note' }, '説明' + this.identifier));
    testElement.appendChild(DataElement.create('メモ', '任意の文字列\n１\n２\n３\n４\n５', { 'type': 'note' }, 'メモ' + this.identifier));

    //TEST
    testElement = DataElement.create('能力', '', {}, '能力' + this.identifier);
    this.detailDataElement.appendChild(testElement);
    testElement.appendChild(DataElement.create('器用度', 24, {}, '器用度' + this.identifier));
    testElement.appendChild(DataElement.create('敏捷度', 24, {}, '敏捷度' + this.identifier));
    testElement.appendChild(DataElement.create('筋力', 24, {}, '筋力' + this.identifier));
    testElement.appendChild(DataElement.create('生命力', 24, {}, '生命力' + this.identifier));
    testElement.appendChild(DataElement.create('知力', 24, {}, '知力' + this.identifier));
    testElement.appendChild(DataElement.create('精神力', 24, {}, '精神力' + this.identifier));

    //TEST
    testElement = DataElement.create('戦闘特技', '', {}, '戦闘特技' + this.identifier);
    this.detailDataElement.appendChild(testElement);
    testElement.appendChild(DataElement.create('Lv1', '全力攻撃', {}, 'Lv1' + this.identifier));
    testElement.appendChild(DataElement.create('Lv3', '武器習熟/ソード', {}, 'Lv3' + this.identifier));
    testElement.appendChild(DataElement.create('Lv5', '武器習熟/ソードⅡ', {}, 'Lv5' + this.identifier));
    testElement.appendChild(DataElement.create('Lv7', '頑強', {}, 'Lv7' + this.identifier));
    testElement.appendChild(DataElement.create('Lv9', '薙ぎ払い', {}, 'Lv9' + this.identifier));
    testElement.appendChild(DataElement.create('自動', '治癒適正', {}, '自動' + this.identifier));

    //
    let domParser: DOMParser = new DOMParser();
    let gameCharacterXMLDocument: Document = domParser.parseFromString(this.rootDataElement.toXml(), 'application/xml');

    let palette: ChatPalette = new ChatPalette('ChatPalette_' + this.identifier);
    palette.setPalette(`チャットパレット入力例：
2d6+1 ダイスロール
１ｄ２０＋{敏捷}＋｛格闘｝　{name}の格闘！

自己バフ、リソース操作コマンド例：
&マッスルベアー/筋B+2/3
:MP-3
&マッスルベアー/筋B+2/3:MP-3

//敏捷=10+{敏捷A}
//敏捷A=10
//格闘＝１`);
    palette.initialize();
    this.appendChild(palette);

    this.addExtendData();
  }

  createTestGameDataElementCheckTable(name: string, size: number, imageIdentifier: string) {
    this.createDataElements();

    let nameElement: DataElement = DataElement.create('name', name, {}, 'name_' + this.identifier);
    let sizeElement: DataElement = DataElement.create('size', size, {}, 'size_' + this.identifier);
    let altitudeElement: DataElement = DataElement.create('altitude', 0, {}, 'altitude_' + this.identifier);
    let initiativeElement: DataElement = DataElement.create('initiative', 0, {}, 'initiative_' + this.identifier);

    if (this.imageDataElement.getFirstElementByName('imageIdentifier')) {
      this.imageDataElement.getFirstElementByName('imageIdentifier').value = imageIdentifier;
    }

    let resourceElement: DataElement = DataElement.create('リソース', '', {}, 'リソース' + this.identifier);
    let hpElement: DataElement = DataElement.create('HP', 200, { 'type': 'numberResource', 'currentValue': '200' }, 'HP_' + this.identifier);
    let mpElement: DataElement = DataElement.create('MP', 100, { 'type': 'numberResource', 'currentValue': '100' }, 'MP_' + this.identifier);

    this.commonDataElement.appendChild(nameElement);
    this.commonDataElement.appendChild(sizeElement);
    this.commonDataElement.appendChild(altitudeElement);
    this.commonDataElement.appendChild(initiativeElement);

    this.detailDataElement.appendChild(resourceElement);
    resourceElement.appendChild(hpElement);
    resourceElement.appendChild(mpElement);

    //TEST
    let testElement: DataElement = DataElement.create('情報', '', {}, '情報' + this.identifier);
    this.detailDataElement.appendChild(testElement);

    let textMarkDown =`テーブル表
|[]|[]器術|[]|[]体術|[]|[]忍術|[]|[]謀術|[]|[]戦術|[]|[]妖術||
|　|[]絡繰術|　|[]騎乗術|　|[]生存術|　|[]医術|　|[]兵糧術|　|[]異形化|2|
|　|[]火術|　|[]砲術|　|[]潜伏術|　|[]毒術|　|[]鳥獣術|　|[]召喚術|3|
|　|[]水術|　|[]手裏剣術|　|[]遁走術|　|[]罠術|　|[]野戦術|　|[]死霊術|4|
|　|[]針術|　|[]手練|　|[]盗聴術|　|[]調査術|　|[]地の利|　|[]結界術|5|
|　|[]仕込み|　|[]身体操術|　|[]腹話術|　|[]詐術|　|[]意気|　|[]封術|6|
|　|[]衣装術|　|[]歩法|　|[]隠形術|　|[]対人術|　|[]用兵術|　|[]言霊術|7|
|　|[]縄術|　|[]走法|　|[]変装術|　|[]遊芸|　|[]記憶術|　|[]幻術|8|
|　|[]登術|　|[]飛術|　|[]香術|　|[]九ノ一の術|　|[]見敵術|　|[]瞳術|9|
|　|[]拷問術|　|[]骨法術|　|[]分身の術|　|[]傀儡の術|　|[]暗号術|　|[]千里眼の術|10|
|　|[]壊器術|　|[]刀術|　|[]隠蔽術|　|[]流言の術|　|[]伝達術|　|[]憑依術|11|
|　|[]掘削術|　|[]怪力|　|[]第六感|　|[]経済力|　|[]人脈|　|[]呪術|12|
`
    testElement.appendChild(DataElement.create('忍術', textMarkDown, { 'type': 'markdown' }, '忍術' + this.identifier));

    let textMarkDownNecro =
`|損傷|使用|タイミング|コスト|射程|効果|
|[]こぶし|[]|アクション|2|0|肉弾攻撃1|
|[]うで|[]|ジャッジ|1|0|支援1|`

    testElement.appendChild(DataElement.create('ネクロニカ的パーツ', textMarkDownNecro, { 'type': 'markdown' }, 'ネクロニカ的パーツ' + this.identifier));

    testElement.appendChild(DataElement.create('宝物への依存', '[][][][] 幼児退行', { 'type': 'markdown' }, 'ネクロニカ的未練' + this.identifier));

    this.overViewWidth = 800;
    this.overViewMaxHeight = 620;

    //TEST
    testElement = DataElement.create('能力', '', {}, '能力' + this.identifier);
    this.detailDataElement.appendChild(testElement);
    testElement.appendChild(DataElement.create('器用度', 24, {}, '器用度' + this.identifier));
    testElement.appendChild(DataElement.create('敏捷度', 24, {}, '敏捷度' + this.identifier));
    testElement.appendChild(DataElement.create('筋力', 24, {}, '筋力' + this.identifier));
    testElement.appendChild(DataElement.create('生命力', 24, {}, '生命力' + this.identifier));
    testElement.appendChild(DataElement.create('知力', 24, {}, '知力' + this.identifier));
    testElement.appendChild(DataElement.create('精神力', 24, {}, '精神力' + this.identifier));

    //TEST
    testElement = DataElement.create('戦闘特技', '', {}, '戦闘特技' + this.identifier);
    this.detailDataElement.appendChild(testElement);
    testElement.appendChild(DataElement.create('Lv1', '全力攻撃', {}, 'Lv1' + this.identifier));
    testElement.appendChild(DataElement.create('Lv3', '武器習熟/ソード', {}, 'Lv3' + this.identifier));
    testElement.appendChild(DataElement.create('Lv5', '武器習熟/ソードⅡ', {}, 'Lv5' + this.identifier));
    testElement.appendChild(DataElement.create('Lv7', '頑強', {}, 'Lv7' + this.identifier));
    testElement.appendChild(DataElement.create('Lv9', '薙ぎ払い', {}, 'Lv9' + this.identifier));
    testElement.appendChild(DataElement.create('自動', '治癒適正', {}, '自動' + this.identifier));

    //
    let domParser: DOMParser = new DOMParser();
    let gameCharacterXMLDocument: Document = domParser.parseFromString(this.rootDataElement.toXml(), 'application/xml');

    let palette: ChatPalette = new ChatPalette('ChatPalette_' + this.identifier);
    palette.setPalette(`チャットパレット入力例：
2d6+1 ダイスロール
１ｄ２０＋{敏捷}＋｛格闘｝　{name}の格闘！

自己バフ、リソース操作コマンド例：
&マッスルベアー/筋B+2/3
:MP-3
&マッスルベアー/筋B+2/3:MP-3

//敏捷=10+{敏捷A}
//敏捷A=10
//格闘＝１`);
    palette.initialize();
    this.appendChild(palette);

    this.addExtendData();
  }


  createTestGameDataElementExtendSample(name: string, size: number, imageIdentifier: string) {
    this.createDataElements();

    let nameElement: DataElement = DataElement.create('name', name, {}, 'name_' + this.identifier);
    let sizeElement: DataElement = DataElement.create('size', size, {}, 'size_' + this.identifier);
    let altitudeElement: DataElement = DataElement.create('altitude', 0, {}, 'altitude_' + this.identifier);
    let initiativeElement: DataElement = DataElement.create('initiative', 0, {}, 'initiative_' + this.identifier);

    if (this.imageDataElement.getFirstElementByName('imageIdentifier')) {
      this.imageDataElement.getFirstElementByName('imageIdentifier').value = imageIdentifier;
    }

//    let resourceElement: DataElement = DataElement.create('リソース', '', {}, 'リソース' + this.identifier);
//    let hpElement: DataElement = DataElement.create('HP', 200, { 'type': 'numberResource', 'currentValue': '200' }, 'HP_' + this.identifier);
//    let mpElement: DataElement = DataElement.create('MP', 100, { 'type': 'numberResource', 'currentValue': '100' }, 'MP_' + this.identifier);

    this.commonDataElement.appendChild(nameElement);
    this.commonDataElement.appendChild(sizeElement);
    this.commonDataElement.appendChild(altitudeElement);
    this.commonDataElement.appendChild(initiativeElement);

//    this.detailDataElement.appendChild(resourceElement);
//    resourceElement.appendChild(hpElement);
//    resourceElement.appendChild(mpElement);

    //TEST
    let testElement: DataElement = DataElement.create('情報', '', {}, '情報' + this.identifier);
    this.detailDataElement.appendChild(testElement);
    testElement.appendChild(DataElement.create('説明',
`このキャラクターはキャラクターBの補助用のコマを作るときのサンプルです。
まず、このキャラクターはキャラクターシートの設定で「テーブルインベントリ非表示」「発言をしない」のチェックが入っています。
このように設定したキャラクターは「非表示」で足元のサークルの色が青に変わり、テーブルインベントリやリリィ追加機能のカウンターリモコンに表示されなくなります。
戦闘非参加キャラを立ち絵やコマのためにテーブルに出したい場合に使用できます。
また、プロフ等の追加情報を表示するためのコマ等、発言が不要な場合、「発言をしない」のチェックを入れることでチャットタブ等のリストに表示されなくなります。
部位数が10あるモンスターの駒を出したけど頭だけ喋ればいい、等の場合に使います。このチェックをONにするとコマの上のキャラ名が白地に黒文字に変わります。
次に、ポップアップのサイズ設定です。リリィではキャラクターシートからポップアップの横幅、最大縦幅を変更可能な様に拡張しています。
これで遊ぶ仲間が許してくれれば、数千文字のプロフィールを書いても大丈夫です。\n
なお、ポップアップする項目の設定は インベントリ＞設定＞表示項目 で行います。
リリィでは説明のため初期の項目に情報をに追加しているので、情報の子項目のこの文章である「説明」と「持ち物」が表示されています。
定義されていても持っていない項目は表示されないのでこのコマからはHPや能力値を削っています。
ゲームごとに使いやすいように使ってください。
`, { 'type': 'note' }, '説明' + this.identifier));
    testElement.appendChild(DataElement.create('持ち物',
`こういった文章も見やすくなります。
アイテム1：3個　効果〇〇
アイテム2：3個　効果パーティ内一人のHPをXXする
アイテム3：3個　効果敵一人の魔法を△する
アイテム4：3個　効果A
アイテム5：3個　効果B`,
 { 'type': 'note' }, '持ち物' + this.identifier));

    let domParser: DOMParser = new DOMParser();
    let gameCharacterXMLDocument: Document = domParser.parseFromString(this.rootDataElement.toXml(), 'application/xml');

    let palette: ChatPalette = new ChatPalette('ChatPalette_' + this.identifier);
    palette.setPalette(`チャットパレット入力例：
2d6+1 ダイスロール
１ｄ２０＋{敏捷}＋｛格闘｝　{name}の格闘！
//敏捷=10+{敏捷A}
//敏捷A=10
//格闘＝１`);
    palette.initialize();
    this.appendChild(palette);
    this.addExtendData();
  }

  deleteBuff(name: string):boolean{
    if (this.buffDataElement.children){
      const dataElm = this.buffDataElement.children[0];
      const data = (dataElm as DataElement).getFirstElementByName(name);
      if(!data)return false;
      data.destroy();
      return true;
    }
    return false;
  }

  decreaseBuffRound(timing?: BuffExpireTiming, triggerIdentifier?: string){
    if (this.buffDataElement.children){
      const dataElm = this.buffDataElement.children[0];
      for (const data  of dataElm.children){
        // タイミングフィルタ: expireTiming属性がない場合はround_endとして扱う
        // 旧タイミング値（user_turn_start, target_turn_start, user_turn_end）もround_end扱い
        const rawTiming = (data.getAttribute('expireTiming') as string) || 'round_end';
        const elTiming: BuffExpireTiming = (rawTiming === 'user_turn_start' || rawTiming === 'target_turn_start' || rawTiming === 'user_turn_end') ? 'round_end' : rawTiming as BuffExpireTiming;
        const elTrigger = (data.getAttribute('triggerIdentifier') as string) || (data.getAttribute('sourceIdentifier') as string) || '';
        if (timing && elTiming !== timing) continue;
        if (triggerIdentifier && elTrigger !== triggerIdentifier) continue;
        let oldNumS = '';
        let sum: number;
        oldNumS = (data.value as string);
        sum = parseInt(oldNumS);
        sum = sum - 1;
        data.value = sum;
      }
    }
  }

  increaseBuffRound(){
    if (this.buffDataElement.children){
      const dataElm = this.buffDataElement.children[0];
      for (const data  of dataElm.children){
        let oldNumS = '';
        let sum: number;
        oldNumS = (data.value as string);
        sum = parseInt(oldNumS);
        sum = sum + 1;
        data.value = sum;
      }
    }
  }

  deleteZeroRoundBuff(){
    if (this.buffDataElement.children){
      const dataElm = this.buffDataElement.children[0];
      for (const data  of dataElm.children){
        let oldNumS = '';
        let num: number;
        oldNumS = (data.value as string);
        num = parseInt(oldNumS);
        if ( num <= 0){
        data.destroy();
        }
      }
    }
  }

  addBuffRound(name: string, _info?: string , _round?: number){
    let info = '';
    let round = 3;
    if(_info ){
      info = _info;
    }
    if(_round != null){
      round = _round;
    }
    if(this.buffDataElement.children){
      let dataElm = this.buffDataElement.children[0];
      let data = this.buffDataElement.getFirstElementByName( name );
      if ( data ){
        data.value = round;
        data.currentValue = info;
      }else{
        dataElm.appendChild(DataElement.create(name, round , { type: 'numberResource', currentValue: info }, ));
      }
    }
  }


  chkChangeStatusName(name: string): boolean{
    const data = this.detailDataElement.getFirstElementByName(name);
    if(!data)return false;
    if(data.type == 'numberResource'){ return true;}
    if(data.type == ''){ return true;}
    if(data.type == 'note'){ return true;}
    return false;
  }

  chkChangeStatus(name: string, nowOrMax: string): boolean{
    const data = this.detailDataElement.getFirstElementByName(name);
    if(!data)return false;
    if(data.type == 'numberResource'){
      if(nowOrMax == 'now' || nowOrMax =='max'){
        return true;
      }
    }else if(data.type == ''){
      if(nowOrMax == 'now'){
        return true;
      }
    }else if(data.type == 'note'){
      if(nowOrMax == 'now'){
        return true;
      }
    }
    return false;
  }

  getStatusType(name: string, nowOrMax: string): string{
    let type = '';
    const data = this.detailDataElement.getFirstElementByName(name);
    if(!data)return null;
    
    if(data.type == 'numberResource'){
      if(nowOrMax == 'now'){
        type = 'currentValue';
      }else if(nowOrMax == 'max'){
        type = 'value';
      }
    }else if(data.type == ''){
      if(nowOrMax == 'now'){
        type = 'value';
      }else{
        return null;
      }
    }else{
      return null;
    }
    return type;
  }

  getStatusTextType(name: string): string{
    let type = '';
    const data = this.detailDataElement.getFirstElementByName(name);
    if(!data)return null;
    
    if(data.type == 'numberResource'){
      type = 'currentValue';
    }else{
      type = 'value';
    }
    return type;
  }

  getStatusValue(name: string, nowOrMax: string): number{
    const data = this.detailDataElement.getFirstElementByName(name);
    if(!data)return null;
    let type = this.getStatusType(name, nowOrMax);
    if(type == null) return null;

    let oldNumS = '';
    let newNum: number;
    let sum: number;
    console.log('getStatusValue type' + type);

    if ( type == 'value') {
      oldNumS = (data.value as string);
    }
    if ( type == 'currentValue'){
      oldNumS = (data.currentValue as string);
    }
    return parseInt(oldNumS);
  }

  setStatusValue(name: string, nowOrMax: string, setValue: number): boolean{
    const data = this.detailDataElement.getFirstElementByName(name);
    if(!data)return false;
    let type = this.getStatusType(name, nowOrMax);
    if(type == null) return false;

    if ( type == 'value') {
      data.value = setValue;
    }
    if ( type == 'currentValue'){
      data.currentValue = setValue;
    }
    return true;
  }

  setStatusText(name: string, text: string): boolean{
    const data = this.detailDataElement.getFirstElementByName(name);
    if(!data)return false;
    let type = this.getStatusTextType(name);
    if(type == null) return false;
    if ( type == 'value') {
      data.value = text;
    }
    if ( type == 'currentValue'){
      data.currentValue = text;
    }
    return true;
  }


  changeStatusValue(name: string, nowOrMax: string, addValue: number, limitMin ?: boolean ,limitMax ?: boolean ): string{
    const data = this.detailDataElement.getFirstElementByName(name);
    let text = '';
    let type = this.getStatusType(name, nowOrMax);
    if(!data)return text;

    let newNum: number;
    let oldNum :number = this.getStatusValue(name,nowOrMax);
    if(oldNum == null) return text;
    let sum = oldNum + addValue;

    let maxRecoveryMess = '';
    if ( type == 'value') {
      if ( limitMin && sum <= 0 && limitMin){
        maxRecoveryMess = '(最小)';
        sum = 0;
      }
      this.setStatusValue(name, nowOrMax, sum);
    }
    if ( type == 'currentValue'){
      if ( sum >= data.value && limitMax){
        maxRecoveryMess = '(最大)';
        sum = this.getStatusValue(name,'max');
      }
      if ( limitMin && sum <= 0 && limitMin){
        maxRecoveryMess = '(最小)';
        sum = 0;
      }
      this.setStatusValue(name, nowOrMax, sum);
    }
    text = text + '[' + this.name + ' ' + oldNum + '>' + sum + maxRecoveryMess + '] ';
    return text;
  }

  // ===== 自動計算バフ（アドバンスモード用） =====

  getAutoBuffs(): AutoBuffEntry[] {
    try {
      return JSON.parse(this.autoBuffsJson || '[]');
    } catch { return []; }
  }

  private saveAutoBuffs(buffs: AutoBuffEntry[]) {
    this.autoBuffsJson = JSON.stringify(buffs);
    this.update();
  }

  /**
   * 自動計算バフを追加・適用する
   * operation:
   *   'add'      = 現在値に加算（バフ解除で減算して戻す）
   *   'append'   = 最大値に加算（バフ解除で減算して戻す）
   *   'current'  = 現状記録（付与時の現在値を記録し、解除で記録値に戻す）
   *   'replace'  = 現在値を置き換え（バフ解除で元の値に戻す）
   *   'create'   = 新規要素を追加（バフ解除で要素を削除）
   */
  applyAutoBuff(name: string, targetStat: string, operation: AutoBuffOperation, value: number, rounds: number, targetGroup: string = 'リソース', newElementType: 'numberResource' | '' = 'numberResource', triggerIdentifier?: string, triggerName?: string, expireTiming?: BuffExpireTiming): string | null {
    const data = operation === 'create' || operation === 'palette' ? null : this.detailDataElement.getFirstElementByName(targetStat);
    if (operation !== 'create' && operation !== 'palette' && !data) return null;

    const buffs = this.getAutoBuffs();
    const entry: AutoBuffEntry = {
      id: UUID.generateUuid(),
      name,
      targetStat,
      operation,
      value,
      rounds,
      snapshotCurrent: operation === 'create' ? null : this.getStatusValue(targetStat, 'now'),
      snapshotMax: data && data.type === 'numberResource' ? parseInt(data.value as string) : null,
      targetGroup,
      newElementType,
      createdElementId: null,
      triggerIdentifier: triggerIdentifier || '',
      triggerName: triggerName || '',
      expireTiming: expireTiming || 'round_end',
    };

    // 即時適用
    this._applyBuffEffect(entry);
    buffs.push(entry);
    this.saveAutoBuffs(buffs);
    return entry.id;
  }

  /** バフ効果をステータスに反映 */
  private _applyBuffEffect(entry: AutoBuffEntry) {
    if (entry.operation === 'palette') return; // チャパレはステータス変更なし
    if (entry.operation === 'create') {
      this._createAutoBuffElement(entry);
      return;
    }
    const data = this.detailDataElement.getFirstElementByName(entry.targetStat);
    if (!data) return;
    if (entry.operation === 'add') {
      const cur = this.getStatusValue(entry.targetStat, 'now');
      if (cur != null) this.setStatusValue(entry.targetStat, 'now', cur + entry.value);
    } else if (entry.operation === 'append') {
      if (data.type === 'numberResource') {
        const max = parseInt(data.value as string);
        data.value = max + entry.value;
        // 現在値も上限分増やす
        const cur = this.getStatusValue(entry.targetStat, 'now');
        if (cur != null) this.setStatusValue(entry.targetStat, 'now', cur + entry.value);
      }
    } else if (entry.operation === 'replace') {
      this.setStatusValue(entry.targetStat, 'now', entry.value);
    }
    // 'current'（現状記録）は適用時に値変更なし（記録のみ）
  }

  /** 自動計算バフ用の新規要素を作成 */
  private _createAutoBuffElement(entry: AutoBuffEntry) {
    const groupName = entry.targetGroup || 'リソース';
    let group = this.detailDataElement.getFirstElementByName(groupName);
    if (!group) {
      group = DataElement.create(groupName, '', {});
      this.detailDataElement.appendChild(group);
    }

    let elementName = entry.targetStat || entry.name || '一時効果';
    if (this.detailDataElement.getFirstElementByName(elementName)) {
      const baseName = elementName + '(バフ)';
      elementName = baseName;
      let index = 2;
      while (this.detailDataElement.getFirstElementByName(elementName)) {
        elementName = `${baseName}${index}`;
        index++;
      }
    }

    const element = entry.newElementType === ''
      ? DataElement.create(elementName, entry.value, {})
      : DataElement.create(elementName, entry.value, { type: 'numberResource', currentValue: entry.value });
    group.appendChild(element);
    entry.targetStat = elementName;
    entry.createdElementId = element.identifier;
  }

  /** バフ効果を巻き戻す（削除時） */
  private _revertBuffEffect(entry: AutoBuffEntry) {
    if (entry.operation === 'palette') return; // チャパレは巻き戻し不要
    if (entry.operation === 'create') {
      const created = entry.createdElementId ? ObjectStore.instance.get<DataElement>(entry.createdElementId) : null;
      if (created) {
        created.destroy();
      } else {
        const fallback = this.detailDataElement.getFirstElementByName(entry.targetStat);
        if (fallback) fallback.destroy();
      }
      return;
    }
    const data = this.detailDataElement.getFirstElementByName(entry.targetStat);
    if (!data) return;
    if (entry.operation === 'add') {
      const cur = this.getStatusValue(entry.targetStat, 'now');
      if (cur != null) this.setStatusValue(entry.targetStat, 'now', cur - entry.value);
    } else if (entry.operation === 'append') {
      if (data.type === 'numberResource') {
        const max = parseInt(data.value as string);
        data.value = max - entry.value;
        const cur = this.getStatusValue(entry.targetStat, 'now');
        if (cur != null) {
          // 元の最大値を超えていたら最大値にクランプ
          const restored = cur - entry.value;
          const newMax = max - entry.value;
          this.setStatusValue(entry.targetStat, 'now', Math.min(restored, newMax));
        }
      }
    } else if (entry.operation === 'replace' || entry.operation === 'current') {
      // snapshotCurrentに戻す
      if (entry.snapshotCurrent != null) {
        this.setStatusValue(entry.targetStat, 'now', entry.snapshotCurrent);
      }
    }
  }

  /** 指定IDの自動計算バフを削除（効果を巻き戻す） */
  removeAutoBuff(id: string) {
    const buffs = this.getAutoBuffs();
    const idx = buffs.findIndex(b => b.id === id);
    if (idx < 0) return;
    this._revertBuffEffect(buffs[idx]);
    buffs.splice(idx, 1);
    this.saveAutoBuffs(buffs);
  }

  /** 全自動計算バフのRを減少（ラウンド終了時: round_end タイミングのみ） */
  decreaseAutoBuffRounds() {
    const buffs = this.getAutoBuffs();
    if (buffs.length === 0) return;
    // 旧タイミング（user_turn_start等）もround_end扱いで処理
    const targetBuffs = buffs.filter(b => {
      const t = String(b.expireTiming || 'round_end');
      return t === 'round_end' || t === 'user_turn_start' || t === 'target_turn_start' || t === 'user_turn_end';
    });
    if (targetBuffs.length === 0) return;
    for (const b of targetBuffs) {
      b.rounds--;
    }
    // R切れのバフを削除（効果巻き戻し）
    const expired = targetBuffs.filter(b => b.rounds <= 0);
    for (const e of expired) {
      this._revertBuffEffect(e);
    }
    const remaining = buffs.filter(b => b.rounds > 0);
    this.saveAutoBuffs(remaining);
  }

  /** 指定トリガーキャラの手番で発動するバフのRを減少 */
  decreaseAutoBuffRoundsByTrigger(triggerIdentifier: string, timing: 'turn_start' | 'turn_end') {
    const buffs = this.getAutoBuffs();
    if (buffs.length === 0) return;
    // 旧タイミング（user_turn_start, target_turn_start, user_turn_end）は round_end として扱うためここでは対象外
    const targetBuffs = buffs.filter(b => {
      const t = String(b.expireTiming || 'round_end');
      if (t === 'user_turn_start' || t === 'target_turn_start' || t === 'user_turn_end') return false;
      return t === timing && b.triggerIdentifier === triggerIdentifier;
    });
    if (targetBuffs.length === 0) return;
    for (const b of targetBuffs) b.rounds--;
    const expired = targetBuffs.filter(b => b.rounds <= 0);
    for (const e of expired) this._revertBuffEffect(e);
    const remaining = buffs.filter(b => b.rounds > 0);
    this.saveAutoBuffs(remaining);
  }

  /** 指定ステータスが自動計算バフで変更されているか */
  getAutoBuffEffect(statName: string): { netDelta: number; isModified: boolean } {
    const buffs = this.getAutoBuffs();
    let netDelta = 0;
    let isModified = false;
    for (const b of buffs) {
      if (b.targetStat !== statName) continue;
      if (b.operation === 'palette') continue;
      isModified = true;
      if (b.operation === 'add' || b.operation === 'append') {
        netDelta += b.value;
      } else if (b.operation === 'replace' && b.snapshotCurrent != null) {
        netDelta += (b.value - b.snapshotCurrent);
      }
    }
    return { netDelta, isModified };
  }

}

/** 自動計算バフの操作タイプ */
export type AutoBuffOperation = 'add' | 'append' | 'current' | 'replace' | 'create' | 'palette'; // current はUI上「現状記録」, palette はUI上「チャパレ」

/** バフの消失タイミング */
export type BuffExpireTiming = 'round_end' | 'turn_start' | 'turn_end';

/** 自動計算バフのエントリ */
export interface AutoBuffEntry {
  id: string;
  name: string;
  targetStat: string;
  operation: AutoBuffOperation;
  value: number;
  rounds: number;
  snapshotCurrent: number | null;  // 適用時の現在値
  snapshotMax: number | null;      // 適用時の最大値
  targetGroup?: string;            // create時の追加先カテゴリ
  newElementType?: 'numberResource' | ''; // create時の要素種別
  createdElementId?: string | null; // create時に作成したDataElement ID
  paletteCommand?: string;         // チャパレコマンド（空以外ならボタン表示、クリックでダイスロール）
  triggerIdentifier?: string;      // どのキャラの手番で発動するか（turn_start/turn_end用）
  triggerName?: string;            // トリガーキャラ名（表示用）
  expireTiming?: BuffExpireTiming; // 消失タイミング（デフォルト: 'round_end'）
}
