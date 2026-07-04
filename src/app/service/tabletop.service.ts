import { Injectable } from '@angular/core';
import { Card } from '@udonarium/card';
import { CardStack } from '@udonarium/card-stack';
import { ChatTab } from '@udonarium/chat-tab';
import { ChatTabList } from '@udonarium/chat-tab-list';
import { ObjectSerializer } from '@udonarium/core/synchronize-object/object-serializer';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { EventSystem, Network } from '@udonarium/core/system';
import { DiceSymbol } from '@udonarium/dice-symbol';
import { AutoBuffOperation, GameCharacter } from '@udonarium/game-character';
import { GameCharacterGroup } from '@udonarium/game-character-group';
import { GameTable } from '@udonarium/game-table';
import { GameTableMask } from '@udonarium/game-table-mask';
import { GameTableScratchMask } from '@udonarium/game-table-scratch-mask';
import { PeerCursor } from '@udonarium/peer-cursor';
import { PresetSound, SoundEffect } from '@udonarium/sound-effect';
import { TableSelecter } from '@udonarium/table-selecter';
import { TabletopObject } from '@udonarium/tabletop-object';
import { RangeArea } from '@udonarium/range';
import { Terrain } from '@udonarium/terrain';
import { TextNote } from '@udonarium/text-note';
import { Logger } from '../class/core/system/util/logger';

import { CoordinateService } from './coordinate.service';
//本家PR #92より
import { ImageTag } from '@udonarium/image-tag';
//
import { DataElement } from '@udonarium/data-element';
import { DiceTable } from '@udonarium/dice-table';
import { DiceTablePalette } from '@udonarium/chat-palette';
type ObjectIdentifier = string;
type LocationName = string;

@Injectable()
export class TabletopService {
  private _emptyTable: GameTable = new GameTable('');
  get tableSelecter(): TableSelecter { return TableSelecter.instance; }
  get currentTable(): GameTable {
    let table = this.tableSelecter.viewTable;
    return table ? table : this._emptyTable;
  }

  private locationMap: Map<ObjectIdentifier, LocationName> = new Map();
  private parentMap: Map<ObjectIdentifier, ObjectIdentifier> = new Map();
  private characterCache = new TabletopCache<GameCharacter>(() => ObjectStore.instance.getObjects(GameCharacter).filter(obj => obj.isVisibleOnTable));
  // GameCharacterGroup は aliasName='character-group' で別バケットのため個別キャッシュ
  private characterGroupCache = new TabletopCache<GameCharacterGroup>(() => ObjectStore.instance.getObjects(GameCharacterGroup).filter(obj => obj.isVisibleOnTable));
  private cardCache = new TabletopCache<Card>(() => ObjectStore.instance.getObjects(Card).filter(obj => obj.isVisibleOnTable));
  private cardStackCache = new TabletopCache<CardStack>(() => ObjectStore.instance.getObjects(CardStack).filter(obj => obj.isVisibleOnTable));
  private tableMaskCache = new TabletopCache<GameTableMask>(() => {
    let viewTable = this.tableSelecter.viewTable;
    return viewTable ? viewTable.masks : [];
  });
  private tableScratchMaskCache = new TabletopCache<GameTableScratchMask>(() => {
    let viewTable = this.tableSelecter.viewTable;
    return viewTable ? viewTable.scratchMasks : [];
  });
  private rangeCache = new TabletopCache<RangeArea>(() => ObjectStore.instance.getObjects(RangeArea).filter(obj => obj.isVisibleOnTable));
  private terrainCache = new TabletopCache<Terrain>(() => {
    let viewTable = this.tableSelecter.viewTable;
    return viewTable ? viewTable.terrains : [];
  });
  private textNoteCache = new TabletopCache<TextNote>(() => ObjectStore.instance.getObjects(TextNote));
  private diceSymbolCache = new TabletopCache<DiceSymbol>(() => ObjectStore.instance.getObjects(DiceSymbol));

  get characters(): GameCharacter[] { return this.characterCache.objects; }
  get characterGroups(): GameCharacterGroup[] { return this.characterGroupCache.objects; }
  get cards(): Card[] { return this.cardCache.objects; }
  get cardStacks(): CardStack[] { return this.cardStackCache.objects; }
  get tableMasks(): GameTableMask[] { return this.tableMaskCache.objects; }
  get tableScratchMasks(): GameTableScratchMask[] { return this.tableScratchMaskCache.objects; }
  get ranges(): RangeArea[] { return this.rangeCache.objects; }
  get terrains(): Terrain[] { return this.terrainCache.objects; }
  get textNotes(): TextNote[] { return this.textNoteCache.objects; }
  get diceSymbols(): DiceSymbol[] { return this.diceSymbolCache.objects; }
  get peerCursors(): PeerCursor[] { return ObjectStore.instance.getObjects<PeerCursor>(PeerCursor); }

  constructor(
    private coordinateService: CoordinateService
  ) {
    this.initialize();
  }

  private initialize() {
    this.refreshCacheAll();
    EventSystem.register(this)
      .on('UPDATE_GAME_OBJECT', event => {
        if (event.data.identifier === this.currentTable.identifier || event.data.identifier === this.tableSelecter.identifier) {
          this.refreshCache(GameTableMask.aliasName);
          this.refreshCache(GameTableScratchMask.aliasName);
          this.refreshCache(Terrain.aliasName);
          return;
        }

        let object = ObjectStore.instance.get(event.data.identifier);
        if (!object || !(object instanceof TabletopObject)) {
          this.refreshCache(event.data.aliasName);
        } else if (this.shouldRefreshCache(object)) {
          this.refreshCache(event.data.aliasName);
          this.updateMap(object);
        }

        this.updateAreaBuffsIfNeeded(event.data.aliasName);
      })
      .on('DELETE_GAME_OBJECT', event => {
        let aliasName = event.data.aliasName;
        if (!aliasName) {
          this.refreshCacheAll();
        } else {
          this.refreshCache(aliasName);
        }
      })
      .on('XML_LOADED', event => {
        let xmlElement: Element = event.data.xmlElement;
        // todo:立体地形の上にドロップした時の挙動
        Logger.debug('parseXml todo:立体地形の上にドロップした時の挙動');

        let gameObject = ObjectSerializer.instance.parseXml(xmlElement);
        
        if (gameObject instanceof TabletopObject) {
          Logger.debug('TabletopObject 追加');
          let pointer = this.coordinateService.calcTabletopLocalCoordinate();
          gameObject.location.x = pointer.x - 25;
          gameObject.location.y = pointer.y - 25;
          gameObject.posZ = pointer.z;
          this.placeToTabletop(gameObject);
          if (gameObject instanceof GameCharacter) this.offerAdvancedRoomOwnership(gameObject);
          SoundEffect.play(PresetSound.piecePut);
        } else if (gameObject instanceof ChatTab) {

          ChatTabList.instance.addChatTab(gameObject);

        } 

        //通常版データが投下されたときに、追加が必要な要素を追加
        let objects: TabletopObject[] = ObjectStore.instance.getObjects(GameCharacter);
        for (let gameObject of objects) {
          if (gameObject instanceof GameCharacter) {
            Logger.debug('GameCharacter Load 追加データ確認');
            let gameCharacter:GameCharacter =  gameObject;
            gameCharacter.addExtendData();
          }
        }

      });
  }

  /** アドバンス部屋の範囲バフを更新 */
  private updateAreaBuffsIfNeeded(aliasName?: string) {
    if (this.currentTable?.roomMode !== 'advanced') return;
    if (aliasName && !['character', 'range'].includes(aliasName)) return;
    this.updateAreaBuffs();
  }

  /** 全範囲バフを再評価し、入場で付与・退出で解除する */
  updateAreaBuffs() {
    if (this.currentTable?.roomMode !== 'advanced') return;
    for (const range of this.ranges) {
      if (!range.areaBuffEnabled || !range.areaBuffConfirmed) continue;
      this.updateAreaBuff(range);
    }
  }

  clearAreaBuff(range: RangeArea) {
    const applied = this.parseAreaBuffApplied(range);
    for (const characterId of Object.keys(applied)) {
      const character = ObjectStore.instance.get<GameCharacter>(characterId);
      if (!character) continue;
      this.removeAreaBuffFromCharacter(range, character, applied[characterId]);
    }
    range.areaBuffAppliedJson = '{}';
    range.update();
  }

  private updateAreaBuff(range: RangeArea) {
    const applied = this.parseAreaBuffApplied(range);
    let changed = false;
    const alive = new Set<string>();
    for (const character of this.characters) {
      if (!character || character.location.name !== 'table') continue;
      const inside = this.isCharacterInsideRange(range, character);
      if (inside) alive.add(character.identifier);
      if (inside && !applied[character.identifier]) {
        const info = this.applyAreaBuffToCharacter(range, character);
        if (info) {
          applied[character.identifier] = info;
          changed = true;
        }
      } else if (!inside && applied[character.identifier]) {
        this.removeAreaBuffFromCharacter(range, character, applied[character.identifier]);
        delete applied[character.identifier];
        changed = true;
      }
    }

    // 消えた/非表示になったコマ分も掃除
    for (const characterId of Object.keys(applied)) {
      if (alive.has(characterId)) continue;
      const character = ObjectStore.instance.get<GameCharacter>(characterId);
      if (character) this.removeAreaBuffFromCharacter(range, character, applied[characterId]);
      delete applied[characterId];
      changed = true;
    }

    if (changed) {
      range.areaBuffAppliedJson = JSON.stringify(applied);
      range.update();
    }
  }

  private parseAreaBuffApplied(range: RangeArea): { [characterId: string]: { textName?: string; autoBuffId?: string } } {
    try { return JSON.parse(range.areaBuffAppliedJson || '{}'); } catch { return {}; }
  }

  private applyAreaBuffToCharacter(range: RangeArea, character: GameCharacter): { textName?: string; autoBuffId?: string } | null {
    if (range.areaBuffKind === 'palette') {
      const paletteCommand = range.areaBuffPaletteCommand || '';
      if (!paletteCommand) return null;
      const name = `[範囲] ${range.areaBuffAutoName || range.name || 'ダイス'}`;
      const id = character.applyAutoBuff(name, '', 'palette', 0, range.areaBuffRounds || 1);
      if (id) {
        const buffs = character.getAutoBuffs();
        const entry = buffs.find(b => b.id === id);
        if (entry) { entry.paletteCommand = paletteCommand; character['saveAutoBuffs'](buffs); }
      }
      return id ? { autoBuffId: id } : null;
    }
    if (range.areaBuffKind === 'text') {
      const textName = `[範囲] ${range.areaBuffTextName || range.name || '範囲効果'}`;
      character.addBuffRound(textName, range.areaBuffTextValue || '', range.areaBuffRounds || 1);
      return { textName };
    }
    // auto
    const id = character.applyAutoBuff(
      `[範囲] ${range.areaBuffAutoName || range.name || '範囲効果'}`,
      range.areaBuffAutoTargetStat,
      range.areaBuffAutoOperation as AutoBuffOperation,
      range.areaBuffAutoValue,
      range.areaBuffRounds || 1,
      range.areaBuffAutoTargetGroup || 'リソース',
      range.areaBuffAutoNewElementType || 'numberResource',
      range.areaBuffTriggerIdentifier || '',
      range.areaBuffTriggerName || '',
      range.areaBuffExpireTiming || 'round_end'
    );
    return id ? { autoBuffId: id } : null;
  }

  private removeAreaBuffFromCharacter(range: RangeArea, character: GameCharacter, info: { textName?: string; autoBuffId?: string }) {
    if (info.autoBuffId) character.removeAutoBuff(info.autoBuffId);
    if (info.textName) character.deleteBuff(info.textName);
  }

  private isCharacterInsideRange(range: RangeArea, character: GameCharacter): boolean {
    if (!range.areaBuffIncludeFlying && Math.abs(character.altitude || 0) >= 0.5) return false;
    const grid = this.currentTable?.gridSize || 50;
    const cx = character.location.x + (character.size || 1) * grid / 2;
    const cy = character.location.y + (character.size || 1) * grid / 2;
    const rx = range.location.x;
    const ry = range.location.y;
    const dx = cx - rx;
    const dy = cy - ry;
    const rot = -((range.rotate || 0) * Math.PI / 180);
    const lx = dx * Math.cos(rot) - dy * Math.sin(rot);
    const ly = dx * Math.sin(rot) + dy * Math.cos(rot);
    const length = Math.max(1, range.length || 1) * grid;
    const width = Math.max(1, range.width || 1) * grid;
    switch (range.type) {
      case 'CIRCLE':
        return Math.hypot(dx, dy) <= length;
      case 'SQUARE':
        return Math.abs(lx) <= length / 2 && Math.abs(ly) <= width / 2;
      case 'DIAMOND':
        return (Math.abs(lx) / Math.max(1, length / 2)) + (Math.abs(ly) / Math.max(1, width / 2)) <= 1;
      case 'LINE':
        return lx >= 0 && lx <= length && Math.abs(ly) <= width / 2;
      case 'CORN':
      default: {
        if (lx < 0 || lx > length) return false;
        const halfWidthAtX = (width / 2) * (lx / Math.max(1, length));
        return Math.abs(ly) <= halfWidthAtX;
      }
    }
  }

  private findCache(aliasName: string): TabletopCache<any> {
    switch (aliasName) {
      case GameCharacter.aliasName:
        return this.characterCache;
      case GameCharacterGroup.aliasName:
        return this.characterGroupCache;
      case Card.aliasName:
        return this.cardCache;
      case CardStack.aliasName:
        return this.cardStackCache;
      case GameTableMask.aliasName:
        return this.tableMaskCache;
      case GameTableScratchMask.aliasName:
        return this.tableScratchMaskCache;
      case RangeArea.aliasName:
        return this.rangeCache;
      case Terrain.aliasName:
        return this.terrainCache;
      case TextNote.aliasName:
        return this.textNoteCache;
      case DiceSymbol.aliasName:
        return this.diceSymbolCache;
      default:
        return null;
    }
  }

  private refreshCache(aliasName: string) {
    let cache = this.findCache(aliasName);
    if (cache) cache.refresh();
  }

  private refreshCacheAll() {
    this.characterCache.refresh();
    this.characterGroupCache.refresh();
    this.cardCache.refresh();
    this.cardStackCache.refresh();
    this.tableMaskCache.refresh();
    this.tableScratchMaskCache.refresh();
    this.rangeCache.refresh();
    this.terrainCache.refresh();
    this.textNoteCache.refresh();
    this.diceSymbolCache.refresh();
    this.clearMap();
  }

  private shouldRefreshCache(object: TabletopObject): boolean {
    return this.locationMap.get(object.identifier) !== object.location.name || this.parentMap.get(object.identifier) !== object.parentId;
  }

  private updateMap(object: TabletopObject) {
    this.locationMap.set(object.identifier, object.location.name);
    this.parentMap.set(object.identifier, object.parentId);
  }

  private clearMap() {
    this.locationMap.clear();
    this.parentMap.clear();
  }

  private placeToTabletop(gameObject: TabletopObject) {
    switch (gameObject.aliasName) {
      case GameTableMask.aliasName:
        if (gameObject instanceof GameTableMask) gameObject.isLock = false;
      case Terrain.aliasName:
        if (gameObject instanceof Terrain) gameObject.isLocked = false;
        if (!this.tableSelecter || !this.tableSelecter.viewTable) return;
        this.tableSelecter.viewTable.appendChild(gameObject);
        break;
      default:
        gameObject.setLocation('table');
        break;
    }
  }

  private offerAdvancedRoomOwnership(character: GameCharacter) {
    if (this.currentTable?.roomMode !== 'advanced') return;
    if (this.hasJsonId(character.ownerPeerIds, Network.peerId) || this.hasJsonId(character.ownerUserIds, Network.peerContext?.userId)) return;

    const name = character.name || 'このコマ';
    if (!window.confirm(`${name}を自分のコマにしますか？\n自分のコマにすると、このコマの視界が自分の盤面に反映されます。`)) return;

    character.ownerPeerIds = this.setJsonId(character.ownerPeerIds, Network.peerId, true);
    character.ownerUserIds = this.setJsonId(character.ownerUserIds, Network.peerContext?.userId, true);
    if (!character.sightEnabled) character.sightEnabled = true;
    character.update();
  }

  private hasJsonId(raw: string, id: string): boolean {
    if (!id) return false;
    try {
      const ids = JSON.parse(raw || '[]');
      return Array.isArray(ids) && ids.map(value => String(value)).includes(id);
    } catch (e) {
      return false;
    }
  }

  private setJsonId(raw: string, id: string, enabled: boolean): string {
    if (!id) return raw || '[]';
    let ids: string[] = [];
    try {
      const parsed = JSON.parse(raw || '[]');
      ids = Array.isArray(parsed) ? parsed.map(value => String(value)).filter(value => 0 < value.length) : [];
    } catch (e) {
      ids = [];
    }

    const next = new Set(ids);
    if (enabled) next.add(id);
    else next.delete(id);
    return JSON.stringify(Array.from(next));
  }
}

class TabletopCache<T extends TabletopObject> {
  private needsRefresh: boolean = true;

  private _objects: T[] = [];
  get objects(): T[] {
    if (this.needsRefresh) {
      this._objects = this.refreshCollector();
      this._objects = this._objects ? this._objects : [];
      this.needsRefresh = false;
    }
    return this._objects;
  }

  constructor(
    readonly refreshCollector: () => T[]
  ) { }

  refresh() {
    this.needsRefresh = true;
  }
}
