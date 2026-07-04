import { AfterViewInit, Component, Input, OnDestroy, OnInit, ViewChild, ElementRef, ChangeDetectorRef } from '@angular/core';
import { Logger } from '../../class/core/system/util/logger';

import { EventSystem, Network } from '@udonarium/core/system';
import { DataElement } from '@udonarium/data-element';
import { PresetSound, SoundEffect } from '@udonarium/sound-effect';
import { TabletopObject } from '@udonarium/tabletop-object';

import { PointerDeviceService } from 'service/pointer-device.service';

import { FileSelecterComponent } from 'component/file-selecter/file-selecter.component';
import { ImportCharacterImgComponent } from 'component/import-character-img/import-character-img.component';

import { ModalService } from 'service/modal.service';
import { PanelOption, PanelService } from 'service/panel.service';
import { SaveDataService } from 'service/save-data.service';
import { TabletopService } from 'service/tabletop.service';
import { InitiativeService } from 'service/initiative.service';

import { GameCharacter } from '@udonarium/game-character';
import { AutoSoundTrigger } from '@udonarium/game-character';
import { ImageStorage } from '@udonarium/core/file-storage/image-storage';
import { AudioStorage } from '@udonarium/core/file-storage/audio-storage';
import { AudioLibraryService } from 'service/audio-library.service';
import { Jukebox } from '@udonarium/Jukebox';
import { DiceSymbol } from '@udonarium/dice-symbol';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';

import { RangeArea } from '@udonarium/range';
import { GameTableScratchMask } from '@udonarium/game-table-scratch-mask';

@Component({
  selector: 'game-character-sheet',
  templateUrl: './game-character-sheet.component.html',
  styleUrls: ['./game-character-sheet.component.css']
})
export class GameCharacterSheetComponent implements OnInit, OnDestroy, AfterViewInit {

  @Input() tabletopObject: TabletopObject = null;
  isEdit: boolean = false;

  networkService = Network;

  isSaveing: boolean = false;
  progresPercent: number = 0;

  constructor(
    private saveDataService: SaveDataService,
    private panelService: PanelService,
    private modalService: ModalService,
    private pointerDeviceService: PointerDeviceService,
    private tabletopService: TabletopService,
    private initiativeService: InitiativeService,
    private changeDetector: ChangeDetectorRef,
    public audioLibrary: AudioLibraryService
  ) { }

  get isAdvancedRoom(): boolean { return this.tabletopService.currentTable?.roomMode === 'advanced'; }

  characterSheetTab: 'basic' | 'display' | 'advanced' = 'basic';

  // ===== 自動効果音・アニメーショントリガー =====
  private _autoSoundTriggers: AutoSoundTrigger[] = [];
  private _autoSoundTriggersJsonCache: string = '';

  getAutoSoundTriggers(): AutoSoundTrigger[] {
    if (!this.character) return [];
    const json = this.character.autoSoundTriggersJson || '[]';
    if (json !== this._autoSoundTriggersJsonCache) {
      this._autoSoundTriggersJsonCache = json;
      try { this._autoSoundTriggers = JSON.parse(json); } catch { this._autoSoundTriggers = []; }
    }
    return this._autoSoundTriggers;
  }
  addAutoSoundTrigger() {
    if (!this.character) return;
    const newTrigger: AutoSoundTrigger = {
      id: 'trigger-' + Date.now().toString(36),
      keyword: '',
      audioIdentifier: '',
      animation: ''
    };
    this.character.addAutoSoundTrigger(newTrigger);
    this.character.update();
    // ローカルキャッシュも即時更新
    this._autoSoundTriggers = [...this._autoSoundTriggers, newTrigger];
    this._autoSoundTriggersJsonCache = this.character.autoSoundTriggersJson;
    setTimeout(() => this.changeDetector.markForCheck(), 0);
  }
  removeAutoSoundTrigger(index: number) {
    if (!this.character) return;
    this.character.removeAutoSoundTrigger(index);
    this.character.update();
    // ローカルキャッシュも即時更新
    this._autoSoundTriggers = this._autoSoundTriggers.filter((_, i) => i !== index);
    this._autoSoundTriggersJsonCache = this.character.autoSoundTriggersJson;
    setTimeout(() => this.changeDetector.markForCheck(), 0);
  }
  updateAutoSoundTrigger(index: number, trigger: AutoSoundTrigger) {
    if (!this.character) return;
    this.character.updateAutoSoundTrigger(index, trigger);
    // update()は呼ばない - ngModelChangeで毎呼び出しされるため
    // パネルを閉じる時やフォーカスが外れた時に同期される
  }
  commitAutoSoundTrigger(index: number) {
    if (!this.character) return;
    // ローカルキャッシュの内容をSyncVarへ書き戻す
    this.character.saveAutoSoundTriggers(this._autoSoundTriggers);
    this.character.update();
    this._autoSoundTriggersJsonCache = this.character.autoSoundTriggersJson;
  }
  get audioStorage() { return AudioStorage.instance; }

  get availableAudios() {
    return AudioStorage.instance.audios.filter(a =>
      a.identifier && !a.identifier.startsWith('./assets/')
    );
  }

  get pinnedLibraryTracks() {
    const jukebox = ObjectStore.instance.get<Jukebox>('Jukebox');
    if (!jukebox) return [];
    const ids = jukebox.getPinnedLibraryTrackIds();
    return this.audioLibrary.tracks.filter(t => ids.includes(t.id));
  }
  get isCharacter(): boolean { return this.tabletopObject instanceof GameCharacter; }
  get character(): GameCharacter { return this.tabletopObject as GameCharacter; }
  get isRangeArea(): boolean { return this.tabletopObject instanceof RangeArea; }
  get rangeArea(): RangeArea { return this.tabletopObject as RangeArea; }
  get rangeBuffGroups(): string[] { return ['リソース', '能力値', '技能', '情報']; }

  get rangeBuffCandidateStats(): string[] {
    const stats = new Set<string>();
    for (const character of this.tabletopService.characters) {
      const collect = (parent: any) => {
        if (!parent || !parent.children) return;
        for (const child of parent.children) {
          if (child instanceof DataElement) {
            if (child.children.length === 0 && (child.type === 'numberResource' || child.type === '')) stats.add(child.name);
            else collect(child);
          }
        }
      };
      collect(character.detailDataElement);
    }
    return [...stats].sort();
  }

  get combatCharacters(): { id: string; name: string }[] {
    const chars = this.tabletopService.characters;
    return chars.filter(c => c.location.name === 'table' && !c.hideInventory)
      .map(c => ({ id: c.identifier, name: c.name }));
  }

  get currentTurnCharId(): string {
    const order = this.initiativeService.getCombatOrder();
    const idx = this.initiativeService.currentTurnIndex;
    return order[idx] || '';
  }

  get currentTurnCharName(): string {
    const id = this.currentTurnCharId;
    if (!id) return '';
    const char = ObjectStore.instance.get<GameCharacter>(id);
    return char ? char.name : '';
  }

  /** トリガーキャラの有効なID（未設定なら現在の手番キャラ） */
  get effectiveTriggerId(): string {
    return this.rangeTriggerAsCurrent ? this.currentTurnCharId : this.rangeArea.areaBuffTriggerIdentifier;
  }

  /** トリガーキャラの有効な名前 */
  get effectiveTriggerName(): string {
    const id = this.effectiveTriggerId;
    if (!id) return '';
    const char = ObjectStore.instance.get<GameCharacter>(id);
    return char ? char.name : '';
  }

  /** 現在手番キャラをトリガーとするか（デフォルトtrue） */
  rangeTriggerAsCurrent: boolean = true;

  onTriggerCharChanged() {
    if (!this.isRangeArea) return;
    const id = this.rangeArea.areaBuffTriggerIdentifier;
    const char = this.tabletopService.characters.find(c => c.identifier === id);
    this.rangeArea.areaBuffTriggerName = char ? char.name : '';
    this.onRangeBuffChanged();
    this.changeDetector.markForCheck();
  }

  /** 消失タイミング変更時 */
  onExpireTimingChanged() {
    if (!this.isRangeArea) return;
    if (this.rangeArea.areaBuffExpireTiming !== 'round_end') {
      // turn_start/turn_endの時: チェックONなら手番キャラを、OFFなら選択中キャラを使う
      if (this.rangeTriggerAsCurrent) {
        this.rangeArea.areaBuffTriggerIdentifier = this.currentTurnCharId;
        this.rangeArea.areaBuffTriggerName = this.currentTurnCharName;
      } else if (!this.rangeArea.areaBuffTriggerIdentifier) {
        // 未選択なら現在の手番キャラを初期値に
        this.rangeArea.areaBuffTriggerIdentifier = this.currentTurnCharId;
        this.rangeArea.areaBuffTriggerName = this.currentTurnCharName;
      }
    }
    this.onRangeBuffChanged();
    this.changeDetector.markForCheck();
  }

  /** チェックボックス切替時 */
  onTriggerAsCurrentChanged() {
    if (!this.isRangeArea) return;
    if (this.rangeTriggerAsCurrent) {
      this.rangeArea.areaBuffTriggerIdentifier = this.currentTurnCharId;
      this.rangeArea.areaBuffTriggerName = this.currentTurnCharName;
    } else {
      if (!this.rangeArea.areaBuffTriggerIdentifier) {
        this.rangeArea.areaBuffTriggerIdentifier = this.currentTurnCharId;
        this.rangeArea.areaBuffTriggerName = this.currentTurnCharName;
      }
    }
    this.onRangeBuffChanged();
    this.changeDetector.markForCheck();
  }

  onRangeBuffChanged() {
    if (!this.isRangeArea) return;
    if (!this.rangeArea.areaBuffEnabled) {
      this.rangeArea.areaBuffConfirmed = false;
      this.tabletopService.clearAreaBuff(this.rangeArea);
    } else {
      // 設定編集中は付与済み効果を掃除し、新規反映は確定ボタンまで待つ
      this.rangeArea.areaBuffConfirmed = false;
      this.tabletopService.clearAreaBuff(this.rangeArea);
    }
    this.rangeArea.update();
  }

  confirmRangeBuff() {
    if (!this.isRangeArea || !this.rangeArea.areaBuffEnabled) return;
    // 旧設定で付与済みの効果を一度掃除してから、新設定を確定・即時反映
    this.tabletopService.clearAreaBuff(this.rangeArea);
    this.rangeArea.areaBuffConfirmed = true;
    this.rangeArea.update();
    this.tabletopService.updateAreaBuffs();
  }

  get isMyPiece(): boolean {
    if (!this.isCharacter) return false;
    return this.hasCurrentPeer(this.character.ownerPeerIds, Network.peerId) || this.hasCurrentPeer(this.character.ownerUserIds, Network.peerContext?.userId);
  }

  toggleMyPiece() {
    if (!this.isCharacter) return;
    if (this.isMyPiece) {
      this.character.ownerPeerIds = this.removeCurrentPeer(this.character.ownerPeerIds, Network.peerId);
      this.character.ownerUserIds = this.removeCurrentPeer(this.character.ownerUserIds, Network.peerContext?.userId);
    } else {
      this.character.ownerPeerIds = this.addCurrentPeer(this.character.ownerPeerIds, Network.peerId);
      this.character.ownerUserIds = this.addCurrentPeer(this.character.ownerUserIds, Network.peerContext?.userId);
      if (!this.character.sightEnabled) this.character.sightEnabled = true;
    }
    this.character.update();
  }

  setSightMode(mode: string) {
    if (!this.isCharacter) return;
    this.character.sightMode = mode;
    if (mode === 'normal') this.character.sightRadius = 6;
    if (mode === 'darkvision') this.character.sightRadius = 12;
    if (mode === 'superiorDarkvision') this.character.sightRadius = 24;
    this.character.update();
  }

  private parseIds(raw: string): string[] {
    try {
      const ids = JSON.parse(raw || '[]');
      return Array.isArray(ids) ? ids.map(id => String(id)).filter(id => 0 < id.length) : [];
    } catch (e) {
      return [];
    }
  }

  private hasCurrentPeer(raw: string, id: string): boolean {
    return !!id && this.parseIds(raw).includes(id);
  }

  private addCurrentPeer(raw: string, id: string): string {
    const ids = this.parseIds(raw);
    if (id && !ids.includes(id)) ids.push(id);
    return JSON.stringify(ids);
  }

  private removeCurrentPeer(raw: string, id: string): string {
    if (!id) return raw || '[]';
    return JSON.stringify(this.parseIds(raw).filter(value => value !== id));
  }

  ngOnInit() {
    if (this.isRangeArea && this.rangeArea.areaBuffEnabled && this.rangeArea.areaBuffExpireTiming !== 'round_end' && !this.rangeArea.areaBuffTriggerIdentifier) {
      this.rangeArea.areaBuffTriggerIdentifier = this.currentTurnCharId;
      this.rangeArea.areaBuffTriggerName = this.currentTurnCharName;
    }
    EventSystem.register(this)
      .on('DELETE_GAME_OBJECT', event => {
        if (this.tabletopObject && this.tabletopObject.identifier === event.data.identifier) {
          this.panelService.close();
        }
      });
  }

  ngAfterViewInit() {
  }

  ngOnDestroy() {
    EventSystem.unregister(this);
  }

  toggleEditMode() {
    this.isEdit = this.isEdit ? false : true;
  }

  addDataElement() {
    if (this.tabletopObject.detailDataElement) {
      let title = DataElement.create('見出し', '', {});
      let tag = DataElement.create('タグ', '', {});
      title.appendChild(tag);
      this.tabletopObject.detailDataElement.appendChild(title);
    }
  }

  clone() {
    let cloneObject = this.tabletopObject.clone();
    cloneObject.location.x += 50;
    cloneObject.location.y += 50;
    if (this.tabletopObject.parent) this.tabletopObject.parent.appendChild(cloneObject);
    cloneObject.update();
    switch (this.tabletopObject.aliasName) {
      case 'terrain':
        SoundEffect.play(PresetSound.blockPut);
        (cloneObject as any).isLocked = false;
        break;
      case 'card':
      case 'card-stack':
        (cloneObject as any).owner = '';
        (cloneObject as any).toTopmost();
      case 'table-mask':
        (cloneObject as any).isLock = false;
        SoundEffect.play(PresetSound.cardPut);
        break;
      case 'text-note':
        (cloneObject as any).toTopmost();
        SoundEffect.play(PresetSound.cardPut);
        break;
      case 'dice-symbol':
        SoundEffect.play(PresetSound.dicePut);
      default:
        SoundEffect.play(PresetSound.piecePut);
        break;
    }
  }
  
  clickHide(){
    //処理なし
  }

  clickNoTalk(){
    //処理なし
  }

  clickImageFlag(){
    //処理なし
  }

  clickGrid(){
    //処理なし
  }

  showImportImages() {
    let coordinate = this.pointerDeviceService.pointers[0];
    let option: PanelOption = { left: coordinate.x - 250, top: coordinate.y - 175, width: 350, height: 250 };
    option.title = (<GameCharacter>this.tabletopObject).name + 'への画像複製';
    let component = this.panelService.open<ImportCharacterImgComponent>(ImportCharacterImgComponent, option);
    component.tabletopObject = <GameCharacter>this.tabletopObject;
  }

  @ViewChild('bulkFileInput') bulkFileInput!: ElementRef<HTMLInputElement>;

  async onBulkFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input || !input.files || input.files.length < 1) return;
    const files = Array.from(input.files).filter(f => f.type.startsWith('image/'));
    input.value = '';
    if (files.length < 1) return;

    const confirmed = confirm(`${files.length}枚の画像が見つかりました。すべて登録しますか？`);
    if (!confirmed) return;

    const character = <GameCharacter>this.tabletopObject;
    if (!character.imageDataElement) return;
    const MAX_BYTES = 2 * 1024 * 1024;

    for (const file of files) {
      let processFile: Blob = file;
      const baseName = file.name.replace(/\.[^.]+$/, '');

      if (file.size > MAX_BYTES) {
        alert(`${baseName} は2MBを超えているため自動圧縮します。`);
        try {
          processFile = await this.compressImage(file);
        } catch (e) {
          Logger.error('compress failed', e);
          alert(`${baseName} の圧縮に失敗しました。スキップします。`);
          continue;
        }
      }

      try {
        const imageFile = await ImageStorage.instance.addAsync(processFile as File);
        if (imageFile && imageFile.identifier) {
          const child = DataElement.create('imageIdentifier', imageFile.identifier, { type: 'image' });
          child.name = baseName;
          child.currentValue = baseName;
          character.imageDataElement.appendChild(child);
        }
      } catch (e) {
        Logger.error('add failed', e);
        alert(`${baseName} の登録に失敗しました。`);
      }
    }
  }

  private compressImage(file: File, maxDim: number = 1920, quality: number = 0.85): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          let w = img.width;
          let h = img.height;
          if (w > maxDim || h > maxDim) {
            const ratio = Math.min(maxDim / w, maxDim / h);
            w = Math.round(w * ratio);
            h = Math.round(h * ratio);
          }
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(img, 0, 0, w, h);
          canvas.toBlob(blob => {
            if (blob) resolve(blob);
            else reject(new Error('canvas toBlob failed'));
          }, 'image/jpeg', quality);
        };
        img.onerror = reject;
        img.src = reader.result as string;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  clickRangeOffSetX(){
    // 処理なし
  }

  clickRangeOffSetY(){
    // 処理なし
  }

  fillOutLine(){
    // 処理なし
  }

  subDivisionSnapPolygonal(){
    // 処理なし
  }

  clickLimitHeight(){
    //高さが更新されない場合があるので雑だがこの方法で処理する
    setTimeout(() => { 
      EventSystem.trigger('RESIZE_NOTE_OBJECT', {identifier :this.tabletopObject.identifier })
    }, 100);
  }

  chkKomaSize( height ){
    let character = <GameCharacter>this.tabletopObject;
    if( height < 50 )
      height = 50 ;
    if( height > 750 )
      height = 750 ;
    character.komaImageHeignt = height;
  }

  chkDiceKomaSize( height ){
    let character = <DiceSymbol>this.tabletopObject;
    if( height < 50 )
      height = 50 ;
    if( height > 750 )
      height = 750 ;
    character.komaImageHeignt = height;
  }

  chkPopWidth( width ){
    let character = <GameCharacter>this.tabletopObject;
    if( width < 270 )
      width = 270 ;
    if( width > 800 )
      width = 800 ;
    character.overViewWidth = width;
  }

  chkPopMaxHeight( maxHeight ){
    let character = <GameCharacter>this.tabletopObject;
    if( maxHeight < 250 )
      maxHeight = 250 ;
    if( maxHeight > 1000 )
      maxHeight = 1000 ;
    character.overViewMaxHeight = maxHeight;
  }  async saveToXML() {
    if (!this.tabletopObject || this.isSaveing) return;
    this.isSaveing = true;
    this.progresPercent = 0;
    let element = this.tabletopObject.commonDataElement.getFirstElementByName('name');
    let objectName: string = element ? <string>element.value : '';

    await this.saveDataService.saveGameObjectAsync(this.tabletopObject, 'xml_' + objectName, percent => {
      this.progresPercent = percent;
    });

    setTimeout(() => {
      this.isSaveing = false;
      this.progresPercent = 0;
    }, 500);
  }

  setLocation(locationName: string) {
    this.tabletopObject.setLocation(locationName);
  }

  openModal(name: string = '', isAllowedEmpty: boolean = false) {
    this.modalService.open<string>(FileSelecterComponent, { isAllowedEmpty: isAllowedEmpty }).then(value => {
      if (!this.tabletopObject || !this.tabletopObject.imageDataElement || !value) return;
      let element = this.tabletopObject.imageDataElement.getFirstElementByName(name);
      if (!element) return;
      element.value = value;
    });
  }

  changeMaskFillColor( event ){
    if( this.tabletopObject ){
      let mask: GameTableScratchMask = <GameTableScratchMask>this.tabletopObject;
      mask.color = event;
    }
  }

  changeMaskChangeColor( event ){
    if( this.tabletopObject ){
      let mask: GameTableScratchMask = <GameTableScratchMask>this.tabletopObject;
      mask.changeColor = event;
    }
  }

  changeGridColor( event ){
    if( this.tabletopObject ){
      let range: RangeArea = <RangeArea>this.tabletopObject;
      range.gridColor = event;
    }
  }

  changeRangeColor( event ){
    if( this.tabletopObject ){
      let range: RangeArea = <RangeArea>this.tabletopObject;
      range.rangeColor = event;
    }
  }

}
