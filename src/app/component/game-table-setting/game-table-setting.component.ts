import { AfterViewInit, Component, EventEmitter, Input, Output, OnDestroy, OnInit } from '@angular/core';
import GameSystemClass from 'bcdice/lib/game_system';
import { Logger } from '../../class/core/system/util/logger';

import { ImageFile } from '@udonarium/core/file-storage/image-file';
import { AudioFile } from '@udonarium/core/file-storage/audio-file';
import { AudioStorage } from '@udonarium/core/file-storage/audio-storage';
import { ObjectSerializer } from '@udonarium/core/synchronize-object/object-serializer';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { EventSystem, Network } from '@udonarium/core/system';
import { FilterType, GameTable, GridType } from '@udonarium/game-table';
import { Jukebox, TableAudioLayerSetting } from '@udonarium/Jukebox';
import { TableSelecter } from '@udonarium/table-selecter';

import { FileSelecterComponent } from 'component/file-selecter/file-selecter.component';
import { ImageService } from 'service/image.service';
import { ModalService } from 'service/modal.service';
import { PanelService } from 'service/panel.service';
import { TabletopService } from 'service/tabletop.service';
import { SaveDataService } from 'service/save-data.service';
import { BatchService } from 'service/batch.service';

import { DiceBot } from '@udonarium/dice-bot';
import { Config } from '@udonarium/config';
import { AudioLibraryService, ServerAudioTrack } from 'service/audio-library.service';

@Component({
  selector: 'game-table-setting',
  templateUrl: './game-table-setting.component.html',
  styleUrls: ['./game-table-setting.component.css']
})
export class GameTableSettingComponent implements OnInit, OnDestroy, AfterViewInit {

  @Input('gameType') _gameType: string = '';
  @Output() gameTypeChange = new EventEmitter<string>();
  get gameType(): string { return this.config.defaultDiceBot };
  set gameType(gameType: string) { this.config.defaultDiceBot = gameType; }
  loadDiceBot(gameType: string) {
    Logger.debug('changeDiceBot ready');
    DiceBot.getHelpMessage(gameType).then(help => {
     Logger.debug('onChangeGameType done\n' + help);
    });
  }

  get roomGridDispAlways(): boolean { 
    let conf = ObjectStore.instance.get<Config>('Config');
    return conf? conf.roomGridDispAlways : false ;
  }

  set roomGridDispAlways(disp: boolean){
    let conf = ObjectStore.instance.get<Config>('Config');
    this.tableGridDummy = !this.tableGridDummy;
    if(conf) conf.roomGridDispAlways = disp;
  }

  get config(): Config { return ObjectStore.instance.get<Config>('Config')};

  minSize: number = 1;
  maxSize: number = 100;

  get diceBotInfos() { return DiceBot.diceBotInfos }
  get audios(): AudioFile[] { return AudioStorage.instance.audios.filter(audio => !audio.isHidden); }

  get libraryTracks(): ServerAudioTrack[] {
    // ピン留め（選択中）の曲のみ表示
    const jukebox = ObjectStore.instance.get<Jukebox>('Jukebox');
    if (!jukebox) return [];
    const pinnedIds = jukebox.getPinnedLibraryTrackIds();
    return pinnedIds
      .map(id => this.audioLibraryService.getTrack(id))
      .filter(t => t !== null) as ServerAudioTrack[];
  }

  get tableBackgroundImage(): ImageFile {
    return this.imageService.getEmptyOr(this.selectedTable ? this.selectedTable.imageIdentifier : null);
  }

  get tableDistanceviewImage(): ImageFile {
    return this.imageService.getEmptyOr(this.selectedTable ? this.selectedTable.backgroundImageIdentifier : null);
  }

  // 全体強制ONしたときのグリッド表示信号発行のためのダミー
  get tableGridDummy(): boolean { return this.tableSelecter.tableGridDummy; }
  set tableGridDummy(dummy: boolean) { this.tableSelecter.tableGridDummy = dummy; }

  get tableName(): string { return this.selectedTable.name; }
  set tableName(tableName: string) { if (this.isEditable) this.selectedTable.name = tableName; }

  get tableWidth(): number { return this.selectedTable.width; }
  set tableWidth(tableWidth: number) { if (this.isEditable) this.selectedTable.width = tableWidth; }

  get tableHeight(): number { return this.selectedTable.height; }
  set tableHeight(tableHeight: number) { if (this.isEditable) this.selectedTable.height = tableHeight; }

  get tableGridColor(): string { return this.selectedTable.gridColor.substring(0, 7); }
  set tableGridColor(tableGridColor: string) { if (this.isEditable) this.selectedTable.gridColor = tableGridColor + "e6"; }

  get tableGridShow(): boolean { return this.tableSelecter.gridShow; }
  set tableGridShow(tableGridShow: boolean) {
    this.tableSelecter.gridShow = tableGridShow;
    if (tableGridShow) this.tableSelecter.viewTable.gridClipRect = null;
    EventSystem.trigger('UPDATE_GAME_OBJECT', this.tableSelecter.toContext()); // 自分にだけイベントを発行してグリッド更新を誘発
  }

  get tableGridSnap(): boolean { return this.tableSelecter.gridSnap; }
  set tableGridSnap(tableGridSnap: boolean) {
    this.tableSelecter.gridSnap = tableGridSnap;
  }

  get tableGridType(): GridType { return this.selectedTable.gridType; }
  set tableGridType(gridType: GridType) { if (this.isEditable) this.selectedTable.gridType = Number(gridType); }

  get tableDistanceviewFilter(): FilterType { return this.selectedTable.backgroundFilterType; }
  set tableDistanceviewFilter(filterType: FilterType) { if (this.isEditable) this.selectedTable.backgroundFilterType = filterType; }

  get tableSelecter(): TableSelecter { return TableSelecter.instance; }

  selectedTable: GameTable = null;
  selectedTableXml: string = '';
  tableAudioLayers: TableAudioLayerSetting[] = [];

  private readonly tableOrderAttribute = 'lycorisTableOrder';

  get isEmpty(): boolean { return this.tableSelecter ? (this.tableSelecter.viewTable ? false : true) : true; }
  get isDeleted(): boolean {
    if (!this.selectedTable) return true;
    return ObjectStore.instance.get<GameTable>(this.selectedTable.identifier) == null;
  }
  get isEditable(): boolean {
    return !this.isEmpty && !this.isDeleted;
  }

  isSaveing: boolean = false;
  progresPercent: number = 0;

  constructor(
    private modalService: ModalService,
    private saveDataService: SaveDataService,
    private imageService: ImageService,
    private panelService: PanelService,
    private tabletopService: TabletopService,
    private audioLibraryService: AudioLibraryService
  ) { }

  ngOnInit() {
    Promise.resolve().then(() => this.modalService.title = this.panelService.title = 'テーブル設定');
    this.ensureTableOrders();
    this.selectedTable = this.tableSelecter.viewTable;
    this.loadTableAudioLayers();
    EventSystem.register(this)
      .on('DELETE_GAME_OBJECT', 2000, event => {
        if (!this.selectedTable || event.data.identifier !== this.selectedTable.identifier) return;
        let object = ObjectStore.instance.get(event.data.identifier);
        if (object !== null) {
          this.selectedTableXml = object.toXml();
        }
      });
  }

  ngAfterViewInit() { }

  ngOnDestroy() {
    EventSystem.unregister(this);
  }

  selectGameTable(identifier: string) {
    EventSystem.call('SELECT_GAME_TABLE', { identifier: identifier }, Network.peerId);
    this.selectedTable = ObjectStore.instance.get<GameTable>(identifier);
    this.selectedTableXml = '';
    this.loadTableAudioLayers();
  }

  loadTableAudioLayers() {
    this.tableAudioLayers = Jukebox.getTableAudioLayers(this.selectedTable);
  }

  saveTableAudioLayers() {
    if (!this.selectedTable || this.isDeleted) return;
    Jukebox.setTableAudioLayers(this.selectedTable, this.tableAudioLayers);
  }

  addTableAudioLayer(mode: 'loop' | 'once' = 'loop') {
    if (!this.selectedTable || this.isDeleted) return;
    this.tableAudioLayers.push({
      name: mode === 'loop' ? `BGM ${this.tableAudioLayers.length + 1}` : `環境音 ${this.tableAudioLayers.length + 1}`,
      audioIdentifier: '',
      mode: mode,
      volume: 0.5,
      enabled: true
    });
    this.saveTableAudioLayers();
  }

  removeTableAudioLayer(index: number) {
    this.tableAudioLayers.splice(index, 1);
    this.saveTableAudioLayers();
  }

  moveTableAudioLayer(index: number, delta: number) {
    const nextIndex = index + delta;
    if (index < 0 || nextIndex < 0 || this.tableAudioLayers.length <= nextIndex) return;
    const layer = this.tableAudioLayers[index];
    this.tableAudioLayers[index] = this.tableAudioLayers[nextIndex];
    this.tableAudioLayers[nextIndex] = layer;
    this.saveTableAudioLayers();
  }

  playSelectedTableAudioNow() {
    if (this.selectedTable) {
      EventSystem.call('TABLE_AUDIO_PLAY', { identifier: this.selectedTable.identifier });
    }
  }

  stopTableAudioNow() {
    EventSystem.call('TABLE_AUDIO_STOP', {});
  }

  getGameTables(): GameTable[] {
    return ObjectStore.instance.getObjects(GameTable)
      .sort((a, b) => this.getTableOrder(a) - this.getTableOrder(b));
  }

  copySelectedTable() {
    if (!this.selectedTable || this.isDeleted) return;
    const source = this.selectedTable;
    const copiedTable = source.clone();
    copiedTable.name = this.makeCopyName(source.name);
    copiedTable.selected = false;
    copiedTable.setAttribute(this.tableOrderAttribute, (this.getGameTables().length + 1) + '');
    copiedTable.update();
    this.selectGameTable(copiedTable.identifier);
  }

  moveTable(table: GameTable, delta: number) {
    if (!table) return;
    const tables = this.getGameTables();
    const index = tables.indexOf(table);
    const nextIndex = index + delta;
    if (index < 0 || nextIndex < 0 || tables.length <= nextIndex) return;
    const swap = tables[nextIndex];
    const tableOrder = this.getTableOrder(table);
    table.setAttribute(this.tableOrderAttribute, this.getTableOrder(swap) + '');
    swap.setAttribute(this.tableOrderAttribute, tableOrder + '');
  }

  isFirstTable(table: GameTable): boolean {
    return this.getGameTables()[0] === table;
  }

  isLastTable(table: GameTable): boolean {
    const tables = this.getGameTables();
    return tables[tables.length - 1] === table;
  }

  private ensureTableOrders() {
    const tables = ObjectStore.instance.getObjects(GameTable);
    for (let i = 0; i < tables.length; i++) {
      if (!tables[i].getAttribute(this.tableOrderAttribute)) {
        tables[i].setAttribute(this.tableOrderAttribute, (i + 1) + '');
      }
    }
  }

  private getTableOrder(table: GameTable): number {
    const raw = table ? table.getAttribute(this.tableOrderAttribute) : '';
    const order = parseFloat(raw);
    if (Number.isFinite(order)) return order;
    const fallbackIndex = ObjectStore.instance.getObjects(GameTable).indexOf(table);
    return fallbackIndex < 0 ? Number.MAX_SAFE_INTEGER : fallbackIndex + 1;
  }

  private makeCopyName(sourceName: string): string {
    const baseName = `${sourceName || 'テーブル'} コピー`;
    const names = new Set(ObjectStore.instance.getObjects(GameTable).map(table => table.name));
    if (!names.has(baseName)) return baseName;
    let index = 2;
    while (names.has(`${baseName}${index}`)) index++;
    return `${baseName}${index}`;
  }

  createGameTable() {
    let gameTable = new GameTable();
    gameTable.name = '白紙のテーブル';
    gameTable.imageIdentifier = 'testTableBackgroundImage_image';
    // 現在のテーブルの部屋モードを引き継ぐ
    const currentTable = this.tabletopService.currentTable;
    if (currentTable) {
      gameTable.roomMode = currentTable.roomMode;
    }
    gameTable.initialize();
    gameTable.setAttribute(this.tableOrderAttribute, (this.getGameTables().length + 1) + '');
    this.selectGameTable(gameTable.identifier);
  }

  async save() {
    if (!this.selectedTable || this.isSaveing) return;
    this.isSaveing = true;
    this.progresPercent = 0;

    this.selectedTable.selected = true;
    await this.saveDataService.saveGameObjectAsync(this.selectedTable, 'map_' + this.selectedTable.name, percent => {
      this.progresPercent = percent;
    });

    setTimeout(() => {
      this.isSaveing = false;
      this.progresPercent = 0;
    }, 500);
  }

  delete() {
    if (!this.isEmpty && this.selectedTable) {
      this.selectedTableXml = this.selectedTable.toXml();
      this.selectedTable.destroy();
    }
  }

  restore() {
    if (this.selectedTable && this.selectedTableXml) {
      let restoreTable = ObjectSerializer.instance.parseXml(this.selectedTableXml);
      this.selectGameTable(restoreTable.identifier);
      this.selectedTableXml = '';
    }
  }

  openBgImageModal() {
    if (this.isDeleted) return;
    this.modalService.open<string>(FileSelecterComponent).then(value => {
      if (!this.selectedTable || !value) return;
      this.selectedTable.imageIdentifier = value;
    });
  }

  openDistanceViewImageModal() {
    if (this.isDeleted) return;
    this.modalService.open<string>(FileSelecterComponent, { isAllowedEmpty: true }).then(value => {
      if (!this.selectedTable || !value) return;
      this.selectedTable.backgroundImageIdentifier = value;
    });
  }
}
