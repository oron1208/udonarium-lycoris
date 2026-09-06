import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, HostListener, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { Logger } from '../../class/core/system/util/logger';

import { Card } from '@udonarium/card';
import { CardStack } from '@udonarium/card-stack';
import { ImageFile } from '@udonarium/core/file-storage/image-file';
import { GameObject } from '@udonarium/core/synchronize-object/game-object';
import { EventSystem, Network } from '@udonarium/core/system';
import { DiceSymbol } from '@udonarium/dice-symbol';
import { GameCharacter } from '@udonarium/game-character';
import { GameCharacterGroup } from '@udonarium/game-character-group';
import { FilterType, GameTable, GridType } from '@udonarium/game-table';
import { GameTableMask } from '@udonarium/game-table-mask';
import { GameTableScratchMask } from '@udonarium/game-table-scratch-mask';
import { PeerCursor } from '@udonarium/peer-cursor';
import { PresetSound, SoundEffect } from '@udonarium/sound-effect';
import { TableSelecter } from '@udonarium/table-selecter';
import { RangeArea } from '@udonarium/range';
import { Terrain } from '@udonarium/terrain';
import { TextNote } from '@udonarium/text-note';

import { GameTableSettingComponent } from 'component/game-table-setting/game-table-setting.component';
import { ContextMenuAction, ContextMenuSeparator, ContextMenuService } from 'service/context-menu.service';
import { CoordinateService } from 'service/coordinate.service';
import { ImageService } from 'service/image.service';
import { ModalService } from 'service/modal.service';
import { GmModeService } from 'service/gm-mode.service';
import { PointerDeviceService } from 'service/pointer-device.service';
import { TabletopActionService } from 'service/tabletop-action.service';
import { TabletopService } from 'service/tabletop.service';
import { TabletopUndoService } from 'service/tabletop-undo.service';
import { TabletopSelectionService } from 'service/tabletop-selection.service';

import { GridLineRender } from './grid-line-render';
import { TableMouseGesture } from './table-mouse-gesture';
import { TableTouchGesture } from './table-touch-gesture';

import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { Config } from '@udonarium/config';

type TableDrawingTool = 'pen' | 'line' | 'rect' | 'ellipse' | 'triangle';
type TableDrawingLayer = 'drawing' | 'wall';

export type TableLayerVisibility = {
  background: boolean;
  tableImage: boolean;
  grid: boolean;
  terrain: boolean;
  mask: boolean;
  textNote: boolean;
  card: boolean;
  range: boolean;
  dice: boolean;
  character: boolean;
  cursor: boolean;
  drawing: boolean;
  wallDrawing: boolean;
  lighting: boolean;
};

interface TableDrawingStroke {
  color: string;
  width: number;
  mode: 'pen' | 'eraser';
  tool?: TableDrawingTool;
  fill?: boolean;
  points: number[];
}

interface TableLightSource {
  x: number;
  y: number;
  r: number;
  intensity: number;
  color: string;
  type: string;
  shape: string;
  coneAngle: number;
  direction: number;
  flat: boolean;
  coneCoreRadius: number;
}

type WallGrid = {
  grid: Uint8Array; cellSize: number; cols: number; rows: number;
  version: number;
  rects: { x1: number; y1: number; x2: number; y2: number }[]; // 壁AABB（px座標・高速パス/ブロッカー描画用）
  hasPen: boolean; // ペン描き壁あり（AABB高速パス不可）
};

@Component({
  selector: 'game-table',
  templateUrl: './game-table.component.html',
  styleUrls: ['./game-table.component.css'],
})
export class GameTableComponent implements OnInit, OnDestroy, AfterViewInit {
  static readonly DEFAULT_LAYER_VISIBILITY: TableLayerVisibility = {
    background: true,
    tableImage: true,
    grid: true,
    terrain: true,
    mask: true,
    textNote: true,
    card: true,
    range: true,
    dice: true,
    character: true,
    cursor: true,
    drawing: true,
    wallDrawing: true,
    lighting: true,
  };
  private static readonly LAYER_VISIBILITY_KEY = 'udonarium.advanced.layerVisibility.v1';

  @ViewChild('root', { static: true }) rootElementRef!: ElementRef<HTMLElement>;
  @ViewChild('gameTable', { static: true }) gameTable!: ElementRef<HTMLElement>;
  @ViewChild('gameObjects', { static: true }) gameObjects!: ElementRef<HTMLElement>;
  @ViewChild('gridCanvas', { static: true }) gridCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('drawingCanvas', { static: true }) drawingCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('lightingCanvas', { static: true }) lightingCanvas!: ElementRef<HTMLCanvasElement>;

  get tableSelecter(): TableSelecter { return this.tabletopService.tableSelecter; }
  get currentTable(): GameTable { return this.tabletopService.currentTable; }

  get tableImage(): ImageFile {
    return this.imageService.getSkeletonOr(this.currentTable.imageIdentifier);
  }

  get backgroundImage(): ImageFile {
    return this.imageService.getEmptyOr(this.currentTable.backgroundImageIdentifier);
  }

  get backgroundFilterType(): FilterType {
    return this.currentTable.backgroundFilterType;
  }

  get roomGridDispAlways(): boolean { 
    let conf = ObjectStore.instance.get<Config>('Config');
    return conf? conf.roomGridDispAlways : false ;
  }

  set roomGridDispAlways(disp: boolean){
    let conf = ObjectStore.instance.get<Config>('Config');
    if(conf) conf.roomGridDispAlways = disp;
  }

  private isTableTransformMode: boolean = false;
  private isTableTransformed: boolean = false;

  get isPointerDragging(): boolean { return this.pointerDeviceService.isDragging; }

  private viewPotisonX: number = 100;
  private viewPotisonY: number = 0;
  private viewPotisonZ: number = 0;

  private viewRotateX: number = 50;
  private viewRotateY: number = 0;
  private viewRotateZ: number = 10;
  isFlatMode: boolean = false;
  isTableViewResetting: boolean = false;
  private saved3dViewRotate: { x: number, y: number, z: number } = null;
  flatViewScale: number = 1;

  private mouseGesture: TableMouseGesture = null;
  private touchGesture: TableTouchGesture = null;

  isDrawingToolOpen: boolean = false;
  isDrawingMode: boolean = false;
  isDrawingEraser: boolean = false;
  drawingLayer: TableDrawingLayer = 'drawing';
  layerVisibility: TableLayerVisibility = GameTableComponent.loadLayerVisibility();
  drawingTool: TableDrawingTool = 'pen';
  drawingFill: boolean = false;
  drawingColor: string = '#ff3333';
  drawingLineWidth: number = 5;
  private isDrawing: boolean = false;
  private currentDrawingStroke: TableDrawingStroke = null;

  get selectedCharacterIds(): Set<string> { return this.tabletopSelectionService.selectedCharacterIds; }
  set selectedCharacterIds(selectedCharacterIds: Set<string>) { this.tabletopSelectionService.selectedCharacterIds = selectedCharacterIds; }
  isRangeSelecting: boolean = false;

  // 照明
  private lightingAnimFrame: number = 0;
  private flickerPhase: number = 0;
  private cachedWallGrid: WallGrid | null = null;
  private wallGridDirty: boolean = true;
  private wallGridTableId: string = '';
  private wallGridCacheBuilt: boolean = false;
  private wallGridTableSize: string = '';
  private static readonly LIGHTING_MIN_INTERVAL = 66; // ms（アニメ光源がある場合の描画間隔 ≈15fps）
  private static readonly LIGHTING_SCALE = 0.75; // 照明canvasの解像度スケール
  private lightingDirty: boolean = true;
  private lightingNeedsAnimation: boolean = false;
  private lightingInactiveClean: boolean = false;
  private lastLightingRender: number = 0;
  private lastLightingTs: number = 0;
  private objectGeneration: number = 0;
  private collectionCache: { key: string; lights: TableLightSource[]; superior: TableLightSource[]; sightChars: GameCharacter[] } = null;
  private jsonIdCache: Map<string, boolean> = new Map();
  private visibilityPathCache: Map<string, Path2D> = new Map();
  private static readonly VISIBILITY_PATH_MAX = 96;
  private blockerPathCache: Path2D = null;
  private blockerPathVersion: string = '';
  private lastWallGridVersion: number = -1;
  private wallGridVersionCounter: number = 0;
  private lightingAnimFlagCache: { gen: number; value: boolean } = { gen: -1, value: false };
  private scratchMasks: HTMLCanvasElement[] = [];
  private wallPenCache: { raw: string; canvas: HTMLCanvasElement } = null;
  get isLightingActive(): boolean {
    return this.currentTable?.lightingEnabled && this.currentTable?.lightingNightMode;
  }
  get isAdvancedVisionActive(): boolean {
    return this.currentTable?.roomMode === 'advanced' && this.currentTable?.visionEnabled && this.getMySightCharacters().length > 0;
  }
  get isGmMode(): boolean { return this.gmModeService.isGm; }
  rangeSelectionStyle: { [key: string]: string } = {};
  private rangeSelectionStart: { x: number, y: number } = null;
  private rangeSelectionCurrent: { x: number, y: number } = null;

  get characters(): GameCharacter[] { return this.tabletopService.characters; }
  get visibleCharacters(): GameCharacter[] { return this.characters.filter(character => this.canSeeCharacterInAdvancedMode(character)); }
  get characterGroups(): GameCharacterGroup[] { return this.tabletopService.characterGroups; }
  // 注意: 名前ラベルは game-character.component と game-table.component (side-name-label) の2箇所で描画されている。
  // gmOnlyコマのフィルタリングは両方で行うこと。片方だけ直してもラベルが残るバグが発生する。
  // game-character.component側は canDisplayByRole で制御。game-table側はこの getter で制御。
  get sideLabelCharacters(): GameCharacter[] {
    return this.visibleCharacters.filter(character => {
      const vis = character.visibility || 'public';
      if (vis === 'gmOnly') return this.gmModeService.isGm;
      return true;
    });
  }
  get isCharacterSimpleMode(): boolean { return false; }
  get tableMasks(): GameTableMask[] { return this.tabletopService.tableMasks; }
  get tableScratchMasks(): GameTableScratchMask[] { return this.tabletopService.tableScratchMasks; }
  get cards(): Card[] { return this.tabletopService.cards; }
  get cardStacks(): CardStack[] { return this.tabletopService.cardStacks; }
  get ranges(): RangeArea[] { return this.tabletopService.ranges; }
  get terrains(): Terrain[] { return this.tabletopService.terrains; }
  get textNotes(): TextNote[] { return this.tabletopService.textNotes; }
  get diceSymbols(): DiceSymbol[] { return this.tabletopService.diceSymbols; }
  get peerCursors(): PeerCursor[] { return this.tabletopService.peerCursors; }
  get isSideNameLabelMode(): boolean {
    try { if (localStorage.getItem('udonarium.nameLabel.side.v1') === '0') return false; } catch (_) { }
    if (this.isFlatMode) return false;
    const normalizedZ = ((this.viewRotateZ % 360) + 360) % 360;
    const normalizedY = ((this.viewRotateY % 360) + 360) % 360;
    const isSideView = (72 <= normalizedZ && normalizedZ <= 108) || (252 <= normalizedZ && normalizedZ <= 288);
    const isBackView = (162 <= normalizedZ && normalizedZ <= 198) || (162 <= normalizedY && normalizedY <= 198);
    return isSideView || isBackView || 72 <= this.viewRotateX;
  }

  constructor(
    private changeDetector: ChangeDetectorRef,
    private ngZone: NgZone,
    private contextMenuService: ContextMenuService,
    private pointerDeviceService: PointerDeviceService,
    private coordinateService: CoordinateService,
    private imageService: ImageService,
    private tabletopService: TabletopService,
    private tabletopActionService: TabletopActionService,
    private modalService: ModalService,
    private tabletopUndoService: TabletopUndoService,
    private tabletopSelectionService: TabletopSelectionService,
    private gmModeService: GmModeService,
  ) { }

  ngOnInit() {
    EventSystem.register(this)
      .on('UPDATE_GAME_OBJECT', event => {
        const updated = ObjectStore.instance.get(event.data.identifier);
        if (updated instanceof GameCharacter || updated instanceof Terrain || updated instanceof GameTableMask) {
          this.objectGeneration++;
          this.invalidateLighting();
          if (!(updated instanceof GameCharacter)) this.invalidateWallGrid();
        }
        if (event.data.identifier !== this.currentTable.identifier && event.data.identifier !== this.tableSelecter.identifier) return;
        Logger.debug('UPDATE_GAME_OBJECT GameTableComponent ' + this.currentTable.identifier);
        this.setGameTableGrid(this.currentTable.width, this.currentTable.height, this.currentTable.gridSize, this.currentTable.gridType, this.currentTable.gridColor);
        this.redrawDrawingCanvas();
        this.invalidateWallGrid();
        this.invalidateLighting();
      })
      .on('DELETE_GAME_OBJECT', event => {
        // 削除済みオブジェクトはidentifierから引けないのでaliasNameで判定する
        const alias = (event.data as any)?.aliasName;
        if (alias === GameCharacter.aliasName || alias === Terrain.aliasName || alias === GameTableMask.aliasName) {
          this.objectGeneration++;
          this.invalidateLighting();
          if (alias !== GameCharacter.aliasName) this.invalidateWallGrid();
        }
      })
      .on('RE_DRAW_TABLE', event => {
        Logger.debug("テーブル再描画");
        this.invalidateLighting();
        this.changeDetector.detectChanges();
        this.changeDetector.markForCheck();
      })
      .on('NAME_LABEL_VISIBILITY_CHANGED', event => {
        this.changeDetector.markForCheck();
      })
      .on('GM_MODE_CHANGED', event => {
        this.invalidateLighting();
        this.changeDetector.markForCheck();
      })
      .on('CHK_TARGET_CHANGE', event => {
        this.changeDetector.markForCheck();
      })
      .on('TABLE_LAYER_VISIBILITY_CHANGED', event => {
        this.ngZone.run(() => {
          this.layerVisibility = {
            ...GameTableComponent.DEFAULT_LAYER_VISIBILITY,
            ...(event.data?.visibility || {})
          };
          try { localStorage.setItem(GameTableComponent.LAYER_VISIBILITY_KEY, JSON.stringify(this.layerVisibility)); } catch (_) { }
          this.redrawDrawingCanvas();
          this.invalidateWallGrid();
          this.invalidateLighting();
          this.renderLighting();
          this.changeDetector.markForCheck();
        });
      })
      .on('DRAG_LOCKED_OBJECT', event => {
        this.isTableTransformMode = true;
        this.pointerDeviceService.isDragging = false;
        let opacity: number = this.tableSelecter.gridShow ? 1.0 : 0.0;
        if(this.roomGridDispAlways){
          opacity = 1.0;
        }
        this.gridCanvas.nativeElement.style.opacity = opacity + '';
      })
      .on('FOCUS_TO_TABLETOP_COORDINATE', event => {
        setTimeout(() => {
          Logger.debug(`move table to focus (${event.data.x}, ${event.data.y})`);
          this.gameTable.nativeElement.style.transition = '0.2s ease-out';
          setTimeout(() => {
            this.gameTable.nativeElement.style.transition = null;
          }, 100);
          // 座標変換
          let centerX = this.gridCanvas.nativeElement.clientWidth / 2;
          let centerY = this.gridCanvas.nativeElement.clientHeight / 2;
          let movedX = event.data.x - centerX;
          let movedY = event.data.y - centerY;
          // z軸回転
          let rotateZRad = this.viewRotateZ / 180 * Math.PI;
          let rotatedMovedX = movedX * Math.cos(rotateZRad) - movedY * Math.sin(rotateZRad);
          let zRotatedMovedY = movedX * Math.sin(rotateZRad) + movedY * Math.cos(rotateZRad);
          // x軸回転
          let rotateXRad = this.viewRotateX / 180 * Math.PI;
          let rotatedMovedY = zRotatedMovedY * Math.cos(rotateXRad);
          let rotatedMovedZ = zRotatedMovedY * Math.sin(rotateXRad);
          // 移動
          this.setTransform(
            100 - rotatedMovedX - this.viewPotisonX, -rotatedMovedY - this.viewPotisonY, -rotatedMovedZ - this.viewPotisonZ, 0, 0, 0
          );
        }, 50);
      })
      .on('RESET_CAMERA', event => {
        this.ngZone.run(() => {
          this.viewPotisonX = 100;
          this.viewPotisonY = 0;
          this.viewPotisonZ = 0;
          this.viewRotateX = 50;
          this.viewRotateY = 0;
          this.viewRotateZ = 10;
          this.gameTable.nativeElement.style.transition = '0.3s ease-out';
          this.setTransform(0, 0, 0, 0, 0, 0);
          setTimeout(() => { this.gameTable.nativeElement.style.transition = null; }, 350);
          EventSystem.trigger('TABLE_VIEW_ROTATE', { x: this.viewRotateX, y: this.viewRotateY, z: this.viewRotateZ });
        });
      });
    this.tabletopActionService.makeDefaultTable();
    this.tabletopActionService.makeDefaultTabletopObjects();
    this.tabletopActionService.initAprilDiceImage();
  }

  ngAfterViewInit() {
    this.ngZone.runOutsideAngular(() => {
      this.initializeTableTouchGesture();
      this.initializeTableMouseGesture();
    });
    this.cancelInput();

    this.setGameTableGrid(this.currentTable.width, this.currentTable.height, this.currentTable.gridSize, this.currentTable.gridType, this.currentTable.gridColor);
    this.redrawDrawingCanvas();
    this.setTransform(0, 0, 0, 0, 0, 0);
    this.coordinateService.tabletopOriginElement = this.gameObjects.nativeElement;
    this.ngZone.runOutsideAngular(() => this.startLightingLoop());
  }

  private static loadLayerVisibility(): TableLayerVisibility {
    try {
      const raw = localStorage.getItem(GameTableComponent.LAYER_VISIBILITY_KEY);
      const saved = raw ? JSON.parse(raw) : {};
      return { ...GameTableComponent.DEFAULT_LAYER_VISIBILITY, ...(saved || {}) };
    } catch (_) {
      return { ...GameTableComponent.DEFAULT_LAYER_VISIBILITY };
    }
  }

  isLayerPanelOpen: boolean = false;

  toggleLayerVisibility(key: keyof TableLayerVisibility) {
    this.layerVisibility[key] = !this.layerVisibility[key];
    try { localStorage.setItem(GameTableComponent.LAYER_VISIBILITY_KEY, JSON.stringify(this.layerVisibility)); } catch (_) {}
    this.redrawDrawingCanvas();
    this.renderLighting();
    this.changeDetector.markForCheck();
  }

  ngOnDestroy() {
    EventSystem.unregister(this);
    this.mouseGesture.destroy();
    this.touchGesture.destroy();
    if (this.lightingAnimFrame) cancelAnimationFrame(this.lightingAnimFrame);
  }

  initializeTableTouchGesture() {
    this.touchGesture = new TableTouchGesture(this.rootElementRef.nativeElement, this.ngZone);
    this.touchGesture.onstart = this.onTableTouchStart.bind(this);
    this.touchGesture.onend = this.onTableTouchEnd.bind(this);
    this.touchGesture.ongesture = this.onTableTouchGesture.bind(this);
    this.touchGesture.ontransform = this.onTableTouchTransform.bind(this);
  }

  initializeTableMouseGesture() {
    this.mouseGesture = new TableMouseGesture(this.rootElementRef.nativeElement);
    this.mouseGesture.onstart = this.onTableMouseStart.bind(this);
    this.mouseGesture.onend = this.onTableMouseEnd.bind(this);
    this.mouseGesture.ontransform = this.onTableMouseTransform.bind(this);
  }

  onTableTouchStart() {
    this.mouseGesture.cancel();
  }

  onTableTouchEnd() {
    this.cancelInput();
  }

  onTableTouchGesture() {
    this.cancelInput();
  }

  onTableTouchTransform(transformX: number, transformY: number, transformZ: number, rotateX: number, rotateY: number, rotateZ: number, event: string, srcEvent: TouchEvent | MouseEvent | PointerEvent) {
    if (!this.isTableTransformMode || document.body !== document.activeElement) return;

    if (!this.pointerDeviceService.isAllowedToOpenContextMenu && this.contextMenuService.isShow) {
      this.ngZone.run(() => this.contextMenuService.close());
    }

    if (srcEvent.cancelable) srcEvent.preventDefault();

    //
    let scale = (1000 + Math.abs(this.viewPotisonZ)) / 1000;
    transformX *= scale;
    transformY *= scale;
    if (80 < rotateX + this.viewRotateX) rotateX += 80 - (rotateX + this.viewRotateX);
    if (rotateX + this.viewRotateX < 0) rotateX += 0 - (rotateX + this.viewRotateX);
    if (750 < transformZ + this.viewPotisonZ) transformZ += 750 - (transformZ + this.viewPotisonZ);

    this.setTransform(transformX, transformY, transformZ, rotateX, rotateY, rotateZ);
    this.isTableTransformed = true;
  }

  onTableMouseStart(e: any) {
    if (e.shiftKey && e.button !== 1 && e.button !== 2) {
      this.startRangeSelection(e);
      return;
    }

    if (e.target.contains(this.gameObjects.nativeElement) || e.button === 1 || e.button === 2) {
      this.isTableTransformMode = true;
    } else {
      this.isTableTransformMode = false;
      this.pointerDeviceService.isDragging = true;
      this.gridCanvas.nativeElement.style.opacity = 1.0 + '';
      EventSystem.trigger('DISP_TERRAIN_GRID', {});
    }
    if (!document.activeElement.contains(e.target)) {
      this.removeSelectionRanges();
      this.removeFocus();
    }
  }

  onTableMouseEnd(e: any) {
    if (this.isRangeSelecting) return;
    this.cancelInput();
    EventSystem.trigger('DISP_TERRAIN_GRID_END', {});
  }

  onTableMouseTransform(transformX: number, transformY: number, transformZ: number, rotateX: number, rotateY: number, rotateZ: number, event: string, srcEvent: TouchEvent | MouseEvent | PointerEvent) {
    if (this.isRangeSelecting) return;
    if (!this.isTableTransformMode || document.body !== document.activeElement) return;

    if (!this.pointerDeviceService.isAllowedToOpenContextMenu && this.contextMenuService.isShow) {
      this.ngZone.run(() => this.contextMenuService.close());
    }

    if (srcEvent.cancelable) srcEvent.preventDefault();

    //
    let scale = (1000 + Math.abs(this.viewPotisonZ)) / 1000;
    transformX *= scale;
    transformY *= scale;

    this.setTransform(transformX, transformY, transformZ, rotateX, rotateY, rotateZ);
    this.isTableTransformed = true;
  }

  cancelInput() {
    if (this.isDrawing) return;
    this.mouseGesture.cancel();
    this.isTableTransformMode = true;
    this.pointerDeviceService.isDragging = false;
    let opacity: number = this.tableSelecter.gridShow ? 1.0 : 0.0;
    if(this.roomGridDispAlways){
      opacity = 1.0;
    }
    this.gridCanvas.nativeElement.style.opacity = opacity + '';
  }

  @HostListener('contextmenu', ['$event'])
  onContextMenu(e: any) {
    if (!document.activeElement.contains(this.gameObjects.nativeElement)) return;
    e.preventDefault();

    if (!this.pointerDeviceService.isAllowedToOpenContextMenu) return;

    let menuPosition = this.pointerDeviceService.pointers[0];
    let objectPosition = this.coordinateService.calcTabletopLocalCoordinate();
    let menuActions: ContextMenuAction[] = [];

    Array.prototype.push.apply(menuActions, this.tabletopActionService.makeDefaultContextMenuActions(objectPosition));
    menuActions.push(ContextMenuSeparator);
    menuActions.push({
      name: this.isFlatMode ? '立体モードに戻す' : '平面モードにする', action: () => {
        this.toggleFlatMode();
      }
    });
    menuActions.push({
      name: 'テーブル設定', action: () => {
        this.modalService.open(GameTableSettingComponent, { width: 1200 });
      }
    });
    this.contextMenuService.open(menuPosition, menuActions, this.currentTable.name);
  }
  @HostListener('document:mousedown', ['$event'])
  onDocumentMouseDown(e: MouseEvent) {
    this.isTableTransformed = false;
  }

  @HostListener('document:touchstart', ['$event'])
  onDocumentTouchStart(e: TouchEvent) {
    this.isTableTransformed = false;
  }

  @HostListener('document:contextmenu', ['$event'])
  onDocumentContextMenu(e: MouseEvent) {
    if (this.isTableTransformed && !this.pointerDeviceService.isAllowedToOpenContextMenu) e.preventDefault();
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && this.selectedCharacterIds.size > 0) {
      this.clearRangeSelection();
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if ((!e.ctrlKey && !e.metaKey) || e.key.toLowerCase() !== 'z' || e.shiftKey || e.altKey) return;
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement || (active instanceof HTMLElement && active.isContentEditable)) return;
    if (this.tabletopUndoService.undoLastMove()) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  zoomFlatMode(delta: number) {
    if (!this.isFlatMode) this.toggleFlatMode();
    const nextScale = Math.max(0.35, Math.min(3, +(this.flatViewScale + delta).toFixed(2)));
    if (nextScale === this.flatViewScale) return;
    this.flatViewScale = nextScale;
    this.applyTableTransform();
  }

  resetFlatZoom() {
    this.flatViewScale = 1;
    this.applyTableTransform();
  }

  @HostListener('wheel', ['$event'])
  onWheel(event: WheelEvent) {
    if (!this.isFlatMode || this.isDrawingMode) return;
    event.preventDefault();
    this.zoomFlatMode(event.deltaY < 0 ? 0.1 : -0.1);
  }

  private setTransform(transformX: number, transformY: number, transformZ: number, rotateX: number, rotateY: number, rotateZ: number) {
    if (this.isFlatMode) {
      rotateX = 0;
      rotateY = 0;
      rotateZ = 0;
      transformZ = 0;
      this.viewRotateX = 0;
      this.viewRotateY = 0;
      this.viewRotateZ = 0;
    }

    this.viewRotateX += rotateX;
    this.viewRotateY += rotateY;
    this.viewRotateZ += rotateZ;

    this.viewPotisonX += transformX;
    this.viewPotisonY += transformY;
    this.viewPotisonZ += transformZ;
    if (this.isFlatMode) this.viewPotisonZ = 0;

    if (rotateX != 0 || rotateY != 0 || rotateZ != 0) this.emitTableViewRotate();

    this.applyTableTransform();
  }

  toggleFlatMode() {
    const nextFlatMode = !this.isFlatMode;
    this.isFlatMode = nextFlatMode;
    if (this.isFlatMode) {
      this.saved3dViewRotate = { x: this.viewRotateX, y: this.viewRotateY, z: this.viewRotateZ };
      this.viewRotateX = 0;
      this.viewRotateY = 0;
      this.viewRotateZ = 0;
    } else if (this.saved3dViewRotate) {
      this.viewRotateX = this.saved3dViewRotate.x;
      this.viewRotateY = this.saved3dViewRotate.y;
      this.viewRotateZ = this.saved3dViewRotate.z;
      this.saved3dViewRotate = null;
    }
    this.emitTableViewRotate();
    this.applyTableTransform();
    if (!nextFlatMode) this.resetTabletopObjectViews();
    this.changeDetector.markForCheck();
  }

  private resetTabletopObjectViews() {
    EventSystem.trigger('TABLE_VIEW_SOFT_RESET_START', {});
    this.isTableViewResetting = true;
    this.changeDetector.detectChanges();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.ngZone.run(() => {
          this.isTableViewResetting = false;
          this.coordinateService.tabletopOriginElement = this.gameObjects.nativeElement;
          this.applyTableTransform();
          this.redrawDrawingCanvas();
          this.changeDetector.detectChanges();
        });
      });
    });
  }

  private emitTableViewRotate() {
    this.ngZone.run(() => {
      EventSystem.trigger('TABLE_VIEW_ROTATE', {
        x: this.viewRotateX,
        y: this.viewRotateY,
        z: this.viewRotateZ
      });
    });
  }

  private applyTableTransform() {
    const scale = this.isFlatMode ? ` scale(${this.flatViewScale.toFixed(4)})` : '';
    this.gameTable.nativeElement.style.transform = `translateZ(${this.viewPotisonZ.toFixed(4)}px) translateY(${this.viewPotisonY.toFixed(4)}px) translateX(${this.viewPotisonX.toFixed(4)}px) rotateY(${this.viewRotateY.toFixed(4)}deg) rotateX(${this.viewRotateX.toFixed(4) + 'deg) rotateZ(' + this.viewRotateZ.toFixed(4)}deg)${scale}`;
  }

  private setGameTableGrid(width: number, height: number, gridSize: number = 50, gridType: GridType = GridType.SQUARE, gridColor: string = '#000000e6') {
    
    this.gameTable.nativeElement.style.width = width * gridSize + 'px';
    this.gameTable.nativeElement.style.height = height * gridSize + 'px';

    let render = new GridLineRender(this.gridCanvas.nativeElement);
    render.render(width, height, gridSize, gridType, gridColor);

    this.resizeDrawingCanvas(width * gridSize, height * gridSize);

    setTimeout(() => { // 他PL操作で表示条件変更時、情報更新されてからUpdate処理をするため
      let opacity: number = this.tableSelecter.gridShow ? 1.0 : 0.0;
      if(this.roomGridDispAlways){
        opacity = 1.0;
      }
      this.gridCanvas.nativeElement.style.opacity = opacity + '';
      Logger.debug('グリッド描画');
    },0);
  }

  toggleDrawingTool() {
    this.isDrawingToolOpen = !this.isDrawingToolOpen;
    if (!this.isDrawingToolOpen) this.isDrawingMode = false;
  }

  toggleDrawingMode() {
    this.isDrawingMode = !this.isDrawingMode;
    if (this.isDrawingMode) this.isTableTransformMode = false;
  }

  clearDrawing() {
    const layerName = this.drawingLayer === 'wall' ? '壁ペン' : '描画ペン';
    if (!window.confirm(`${layerName}を全消ししますか？`)) return;
    this.setDrawingDataForLayer(this.drawingLayer, []);
    this.currentTable.update();
    this.redrawDrawingCanvas();
  }

  onDrawingPointerDown(event: PointerEvent) {
    if (!this.isDrawingMode) return;
    event.preventDefault();
    event.stopPropagation();
    this.contextMenuService.close();
    this.isDrawing = true;
    this.isTableTransformMode = false;
    const point = this.getDrawingPoint(event);
    this.currentDrawingStroke = {
      color: this.drawingColor,
      width: Math.max(1, Number(this.drawingLineWidth) || 1),
      mode: this.isDrawingEraser ? 'eraser' : 'pen',
      tool: this.drawingTool,
      fill: this.drawingFill,
      points: [point.x, point.y]
    };
    this.drawStroke(this.currentDrawingStroke);
  }

  onDrawingPointerMove(event: PointerEvent) {
    if (!this.isDrawing || !this.currentDrawingStroke) return;
    event.preventDefault();
    event.stopPropagation();
    const point = this.getDrawingPoint(event);
    if ((this.currentDrawingStroke.tool || 'pen') === 'pen') {
      this.currentDrawingStroke.points.push(point.x, point.y);
    } else {
      this.currentDrawingStroke.points = [this.currentDrawingStroke.points[0], this.currentDrawingStroke.points[1], point.x, point.y];
    }
    this.redrawDrawingCanvas(this.currentDrawingStroke);
  }

  @HostListener('document:pointermove', ['$event'])
  onDocumentPointerMove(event: PointerEvent) {
    if (!this.isRangeSelecting) return;
    event.preventDefault();
    this.rangeSelectionCurrent = { x: event.clientX, y: event.clientY };
    this.updateRangeSelectionStyle();
  }

  @HostListener('document:pointerup', ['$event'])
  onDocumentPointerUp(event: PointerEvent) {
    if (this.isRangeSelecting) {
      event.preventDefault();
      this.finishRangeSelection(event);
      return;
    }

    if (!this.isDrawing || !this.currentDrawingStroke) return;
    event.preventDefault();
    const strokes = this.getDrawingStrokes(this.drawingLayer);
    strokes.push(this.currentDrawingStroke);
    this.setDrawingDataForLayer(this.drawingLayer, strokes.slice(-1000));
    this.currentTable.update();
    this.currentDrawingStroke = null;
    this.isDrawing = false;
  }

  private resizeDrawingCanvas(width: number, height: number) {
    const canvas = this.drawingCanvas.nativeElement;
    if (canvas.width === width && canvas.height === height) return;
    canvas.width = width;
    canvas.height = height;
    this.redrawDrawingCanvas();
  }

  private get drawingStrokes(): TableDrawingStroke[] {
    return this.getDrawingStrokes('drawing');
  }

  private get wallDrawingStrokes(): TableDrawingStroke[] {
    return this.getDrawingStrokes('wall');
  }

  private getDrawingStrokes(layer: TableDrawingLayer): TableDrawingStroke[] {
    try {
      const raw = layer === 'wall' ? this.currentTable.wallDrawingData : this.currentTable.drawingData;
      const data = JSON.parse(raw || '[]');
      return Array.isArray(data) ? data.filter(stroke => stroke && Array.isArray(stroke.points)) : [];
    } catch (e) {
      return [];
    }
  }

  private setDrawingDataForLayer(layer: TableDrawingLayer, strokes: TableDrawingStroke[]) {
    if (layer === 'wall') this.currentTable.wallDrawingData = JSON.stringify(strokes);
    else this.currentTable.drawingData = JSON.stringify(strokes);
  }

  private getDrawingPoint(event: PointerEvent): { x: number, y: number } {
    const point = this.coordinateService.calcTabletopLocalCoordinate({ x: event.clientX, y: event.clientY, z: 0 }, event.target as HTMLElement);
    return { x: Math.round(point.x), y: Math.round(point.y) };
  }

  private redrawDrawingCanvas(extraStroke?: TableDrawingStroke) {
    if (!this.drawingCanvas) return;
    const canvas = this.drawingCanvas.nativeElement;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (this.layerVisibility.drawing) {
      for (const stroke of this.drawingStrokes) this.drawStroke(stroke);
    }
    if (this.layerVisibility.wallDrawing) {
      for (const stroke of this.wallDrawingStrokes) this.drawStroke(stroke);
    }
    if (extraStroke) this.drawStroke(extraStroke);
  }

  private drawStroke(stroke: TableDrawingStroke) {
    if (!stroke || stroke.points.length < 2) return;
    const canvas = this.drawingCanvas.nativeElement;
    this.drawStrokeOnCanvas(canvas, stroke);
  }

  private drawStrokeOnCanvas(canvas: HTMLCanvasElement, stroke: TableDrawingStroke) {
    if (!stroke || stroke.points.length < 2) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const tool = stroke.tool || 'pen';
    context.save();
    context.globalCompositeOperation = stroke.mode === 'eraser' ? 'destination-out' : 'source-over';
    context.strokeStyle = stroke.color || '#ff3333';
    context.fillStyle = stroke.color || '#ff3333';
    context.lineWidth = Math.max(1, Number(stroke.width) || 1);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();

    if (tool === 'line') {
      if (stroke.points.length < 4) { context.restore(); return; }
      context.moveTo(stroke.points[0], stroke.points[1]);
      context.lineTo(stroke.points[2], stroke.points[3]);
      context.stroke();
    } else if (tool === 'rect') {
      if (stroke.points.length < 4) { context.restore(); return; }
      const rect = this.getDrawingRect(stroke.points);
      if (stroke.fill) context.fillRect(rect.x, rect.y, rect.width, rect.height);
      context.strokeRect(rect.x, rect.y, rect.width, rect.height);
    } else if (tool === 'ellipse') {
      if (stroke.points.length < 4) { context.restore(); return; }
      const rect = this.getDrawingRect(stroke.points);
      context.ellipse(rect.x + rect.width / 2, rect.y + rect.height / 2, Math.abs(rect.width / 2), Math.abs(rect.height / 2), 0, 0, Math.PI * 2);
      if (stroke.fill) context.fill();
      context.stroke();
    } else if (tool === 'triangle') {
      if (stroke.points.length < 4) { context.restore(); return; }
      const rect = this.getDrawingRect(stroke.points);
      context.moveTo(rect.x + rect.width / 2, rect.y);
      context.lineTo(rect.x + rect.width, rect.y + rect.height);
      context.lineTo(rect.x, rect.y + rect.height);
      context.closePath();
      if (stroke.fill) context.fill();
      context.stroke();
    } else {
      context.moveTo(stroke.points[0], stroke.points[1]);
      for (let i = 2; i < stroke.points.length; i += 2) {
        context.lineTo(stroke.points[i], stroke.points[i + 1]);
      }
      context.stroke();
    }
    context.restore();
  }

  private getDrawingRect(points: number[]): { x: number, y: number, width: number, height: number } {
    const x1 = points[0];
    const y1 = points[1];
    const x2 = points[2];
    const y2 = points[3];
    return {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1)
    };
  }

  isCharacterRangeSelected(character: GameCharacter): boolean {
    return !!character && this.selectedCharacterIds.has(character.identifier);
  }

  get selectedCharacters(): GameCharacter[] {
    return this.characters.filter(character => this.selectedCharacterIds.has(character.identifier) && character.location.name === 'table');
  }

  get targetedCharacters(): GameCharacter[] {
    return this.characters.filter(character => character.targeted && character.location.name === 'table');
  }

  get targetedCharacterCount(): number {
    return this.targetedCharacters.length;
  }

  clearAllTargets() {
    const targets = this.targetedCharacters;
    if (targets.length < 1) return;
    for (const character of targets) {
      character.targeted = false;
      EventSystem.trigger('CHK_TARGET_CHANGE', { identifier: character.identifier, className: character.aliasName });
    }
    SoundEffect.play(PresetSound.sweep);
    this.changeDetector.markForCheck();
  }

  clearRangeSelection() {
    this.selectedCharacterIds.clear();
    this.changeDetector.markForCheck();
  }

  moveSelectedCharactersToGraveyard() {
    const targets = this.selectedCharacters;
    if (targets.length < 1) return;
    if (!window.confirm(`${targets.length}体のコマを墓場に移動しますか？`)) return;
    for (const character of targets) this.tabletopUndoService.moveToLocation(character, 'graveyard');
    this.selectedCharacterIds.clear();
    SoundEffect.play(PresetSound.sweep);
    this.changeDetector.markForCheck();
  }

  setSelectedCharactersTargeted(targeted: boolean) {
    const targets = this.selectedCharacters;
    if (targets.length < 1) return;
    for (const character of targets) {
      character.targeted = targeted;
      EventSystem.trigger('CHK_TARGET_CHANGE', { identifier: character.identifier, className: character.aliasName });
    }
    SoundEffect.play(PresetSound.sweep);
    this.changeDetector.markForCheck();
  }

  invertSelectedCharactersTargeted() {
    const targets = this.selectedCharacters;
    if (targets.length < 1) return;
    for (const character of targets) {
      character.targeted = !character.targeted;
      EventSystem.trigger('CHK_TARGET_CHANGE', { identifier: character.identifier, className: character.aliasName });
    }
    SoundEffect.play(PresetSound.sweep);
    this.changeDetector.markForCheck();
  }

  private startRangeSelection(event: PointerEvent | MouseEvent) {
    if (this.isDrawingMode) return;
    event.preventDefault();
    event.stopPropagation();
    this.contextMenuService.close();
    this.isRangeSelecting = true;
    this.isTableTransformMode = false;
    this.pointerDeviceService.isDragging = false;
    this.rangeSelectionStart = { x: event.clientX, y: event.clientY };
    this.rangeSelectionCurrent = { x: event.clientX, y: event.clientY };
    this.updateRangeSelectionStyle();
  }

  private finishRangeSelection(event: PointerEvent) {
    this.rangeSelectionCurrent = { x: event.clientX, y: event.clientY };
    const rect = this.getScreenSelectionRect();
    const nextSelection = new Set<string>();
    for (const character of this.characters) {
      if (character.location.name !== 'table') continue;
      if (this.isCharacterInScreenRect(character, rect)) nextSelection.add(character.identifier);
    }
    this.selectedCharacterIds = nextSelection;
    this.isRangeSelecting = false;
    this.rangeSelectionStart = null;
    this.rangeSelectionCurrent = null;
    this.rangeSelectionStyle = {};
    this.cancelInput();
    EventSystem.trigger('DISP_TERRAIN_GRID_END', {});
    this.changeDetector.detectChanges();
  }

  private updateRangeSelectionStyle() {
    const rect = this.getScreenSelectionRect();
    this.rangeSelectionStyle = {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.right - rect.left}px`,
      height: `${rect.bottom - rect.top}px`
    };
    this.changeDetector.detectChanges();
  }

  private getScreenSelectionRect(): { left: number, top: number, right: number, bottom: number } {
    const start = this.rangeSelectionStart || { x: 0, y: 0 };
    const current = this.rangeSelectionCurrent || start;
    return {
      left: Math.min(start.x, current.x),
      top: Math.min(start.y, current.y),
      right: Math.max(start.x, current.x),
      bottom: Math.max(start.y, current.y)
    };
  }

  getSideNameLabelStyle(character: GameCharacter): { [key: string]: string } {
    const gridSize = this.currentTable.gridSize || 50;
    const size = Math.max(1, character.size || 1) * gridSize;
    const center = this.coordinateService.convertToGlobal({
      x: character.location.x + size / 2,
      y: character.location.y + size / 2,
      z: character.posZ || 0
    }, this.gameObjects.nativeElement);
    return {
      left: `${center.x}px`,
      top: `${center.y + 24}px`,
      width: `${Math.max(92, Math.min(180, size + 36))}px`
    };
  }

  private isCharacterInScreenRect(character: GameCharacter, rect: { left: number, top: number, right: number, bottom: number }): boolean {
    const size = Math.max(1, character.size || 1) * (this.currentTable.gridSize || 50);
    const left = character.location.x;
    const top = character.location.y;
    const corners = [
      this.coordinateService.convertToGlobal({ x: left, y: top, z: character.posZ || 0 }, this.gameObjects.nativeElement),
      this.coordinateService.convertToGlobal({ x: left + size, y: top, z: character.posZ || 0 }, this.gameObjects.nativeElement),
      this.coordinateService.convertToGlobal({ x: left, y: top + size, z: character.posZ || 0 }, this.gameObjects.nativeElement),
      this.coordinateService.convertToGlobal({ x: left + size, y: top + size, z: character.posZ || 0 }, this.gameObjects.nativeElement)
    ];
    const objectRect = {
      left: Math.min(...corners.map(point => point.x)),
      top: Math.min(...corners.map(point => point.y)),
      right: Math.max(...corners.map(point => point.x)),
      bottom: Math.max(...corners.map(point => point.y))
    };
    return objectRect.left <= rect.right && rect.left <= objectRect.right && objectRect.top <= rect.bottom && rect.top <= objectRect.bottom;
  }

  private canSeeCharacterInAdvancedMode(character: GameCharacter): boolean {
    if (this.currentTable?.roomMode !== 'advanced' || !this.currentTable?.visionEnabled || this.gmModeService.isGm) return true;
    if (this.includesJsonId(character.ownerPeerIds, Network.peerId) || this.includesJsonId(character.ownerUserIds, Network.peerContext?.userId)) return true;

    const sightCharacters = this.getMySightCharacters();
    if (sightCharacters.length < 1) return false;

    const gridSize = this.currentTable.gridSize || 50;
    const target = this.getCharacterCenter(character, gridSize);
    const wallGrid = this.buildWallGrid(gridSize, this.currentTable.width * gridSize, this.currentTable.height * gridSize);
    const isLit = this.isPointLit(target.x, target.y, gridSize, wallGrid);
    const isInSuperiorDarkness = this.isPointInSuperiorDarkness(target.x, target.y, gridSize, wallGrid);
    for (const sightCharacter of sightCharacters) {
      const mode = sightCharacter.sightMode || 'normal';
      if (isInSuperiorDarkness && mode !== 'superiorDarkvision') continue;
      if (mode === 'normal' && !isLit) continue;
      if (this.isPointInSightOfCharacter(target.x, target.y, sightCharacter, gridSize, wallGrid)) return true;
    }
    return false;
  }

  private getCharacterCenter(character: GameCharacter, gridSize: number): { x: number; y: number } {
    const size = Math.max(1, character.size || 1) * gridSize;
    return { x: character.location.x + size / 2, y: character.location.y + size / 2 };
  }

  private isPointInSightOfCharacter(x: number, y: number, character: GameCharacter, gridSize: number, wallGrid: WallGrid | null): boolean {
    const origin = this.getCharacterCenter(character, gridSize);
    const radius = Math.max(1, character.sightRadius || 1) * gridSize;
    if (!character.sightUnlimited && Math.hypot(x - origin.x, y - origin.y) > radius) return false;
    return !this.isRayBlocked(origin.x, origin.y, x, y, wallGrid);
  }

  private isPointLit(x: number, y: number, gridSize: number, wallGrid: WallGrid | null): boolean {
    if (this.isAmbientLightEnabled()) return true;
    if (!this.currentTable.lightingEnabled || !this.currentTable.lightingNightMode) return false;
    const sources = this.collectLightSourcesForPointCheck(gridSize);
    for (const light of sources) {
      if (!this.isPointInsideLightShape(x, y, light)) continue;
      if (!this.isRayBlocked(light.x, light.y, x, y, wallGrid)) return true;
    }
    return false;
  }

  private collectLightSourcesForPointCheck(gridSize: number): TableLightSource[] {
    return this.getLightingCollections(gridSize).lights;
  }

  private isPointInsideLightShape(x: number, y: number, light: TableLightSource): boolean {
    const dx = x - light.x;
    const dy = y - light.y;
    const distance = Math.hypot(dx, dy);
    if (distance > light.r) return false;
    if (this.isLaserLight(light)) {
      const angle = this.degreesToRadians(light.direction || 0);
      const forward = dx * Math.cos(angle) + dy * Math.sin(angle);
      if (forward < 0 || forward > light.r) return false;
      const side = Math.abs(-dx * Math.sin(angle) + dy * Math.cos(angle));
      return side <= this.getLaserWidth(light) * 1.5 || distance <= (light.coneCoreRadius || 0);
    }
    if (light.shape !== 'cone') return true;
    const pointAngle = Math.atan2(dy, dx);
    const centerAngle = this.degreesToRadians(light.direction || 0);
    const diff = Math.abs(Math.atan2(Math.sin(pointAngle - centerAngle), Math.cos(pointAngle - centerAngle)));
    return diff <= this.degreesToRadians(light.coneAngle || 60) / 2 || distance <= (light.coneCoreRadius || 0);
  }

  private isRayBlocked(fromX: number, fromY: number, toX: number, toY: number, wallGrid: WallGrid | null): boolean {
    if (!wallGrid) return false;
    const { grid, cellSize, cols, rows } = wallGrid;
    const distance = Math.hypot(toX - fromX, toY - fromY);
    if (distance <= cellSize) return false;
    const dx = (toX - fromX) / distance;
    const dy = (toY - fromY) / distance;
    for (let d = cellSize; d < distance; d += cellSize) {
      const gx = Math.floor((fromX + dx * d) / cellSize);
      const gy = Math.floor((fromY + dy * d) / cellSize);
      if (gx < 0 || gy < 0 || gx >= cols || gy >= rows) return true;
      if (grid[gy * cols + gx]) return true;
    }
    return false;
  }

  private removeSelectionRanges() {
    let selection = window.getSelection();
    if (!selection.isCollapsed) {
      selection.removeAllRanges();
    }
  }

  private removeFocus() {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }

  trackByGameObject(index: number, gameObject: GameObject) {
    return gameObject.identifier;
  }

  // ===== 照明 =====

  private startLightingLoop() {
    const render = (ts: number) => {
      this.renderLighting(ts);
      this.lightingAnimFrame = requestAnimationFrame(render);
    };
    this.lightingAnimFrame = requestAnimationFrame(render);
  }

  private invalidateLighting() {
    this.lightingDirty = true;
  }

  /** 光源ゆらぎ（松明・焚き火・魔法のソナー）などアニメが必要な光源が卓にあるか */
  private detectLightingAnimation(): boolean {
    if (this.lightingAnimFlagCache.gen === this.objectGeneration) return this.lightingAnimFlagCache.value;
    const scan = (objects: { lightType?: string }[]) => {
      for (const o of objects) {
        const t = o.lightType;
        if (t === 'torch' || t === 'campfire' || t === 'magic') return true;
      }
      return false;
    };
    const value = scan(ObjectStore.instance.getObjects<GameCharacter>(GameCharacter)) ||
      scan(ObjectStore.instance.getObjects<Terrain>(Terrain));
    this.lightingAnimFlagCache = { gen: this.objectGeneration, value };
    return value;
  }

  /** 壁グリッドの版本が変わったらジオメトリ系キャッシュを捨てる */
  private refreshLightingCaches(wallGrid: WallGrid | null) {
    if (this.lastWallGridVersion === this.wallGridVersionCounter) return;
    this.lastWallGridVersion = this.wallGridVersionCounter;
    this.visibilityPathCache.clear();
    this.blockerPathCache = null;
    this.blockerPathVersion = '';
  }

  /**
   * 光源・至暗・視界キャラクタの一括収集。
   * オブジェクト更新世代（objectGeneration）が同じならキャッシュを返すので、
   * 1フレーム内の多重スキャンと毎フレームの全収集を省略できる。
   */
  private getLightingCollections(gridSize: number): { lights: TableLightSource[]; superior: TableLightSource[]; sightChars: GameCharacter[] } {
    const key = gridSize + ':' + this.objectGeneration;
    if (this.collectionCache && this.collectionCache.key === key) return this.collectionCache;

    const lights: TableLightSource[] = [];
    for (const c of ObjectStore.instance.getObjects<GameCharacter>(GameCharacter)) {
      if (!c.lightSourceEnabled || c.location.name !== 'table') continue;
      const center = this.getCharacterCenter(c, gridSize);
      lights.push(this.makeLightSource(center.x, center.y, c.lightRadius, c.lightIntensity, c.lightColor, c.lightType,
        c.lightShape, c.lightConeAngle, c.rotate, gridSize));
    }
    for (const t of ObjectStore.instance.getObjects<Terrain>(Terrain)) {
      if (!t.lightSourceEnabled || t.location.name !== 'table') continue;
      lights.push(this.makeLightSource(
        t.location.x + (t.width || 1) * gridSize / 2,
        t.location.y + (t.depth || 1) * gridSize / 2,
        t.lightRadius, t.lightIntensity, t.lightColor, t.lightType, t.lightShape, t.lightConeAngle, t.rotate, gridSize));
    }

    const superior: TableLightSource[] = [];
    for (const c of ObjectStore.instance.getObjects<GameCharacter>(GameCharacter)) {
      if (!c.superiorDarknessEnabled || c.location.name !== 'table') continue;
      const center = this.getCharacterCenter(c, gridSize);
      superior.push({
        x: center.x, y: center.y,
        r: Math.max(10, (c.superiorDarknessRadius || 3) * gridSize),
        intensity: 1, color: '#000000', type: 'superiorDarkness',
        shape: 'circle', coneAngle: 360, direction: 0, flat: true, coneCoreRadius: 0
      });
    }

    const sightChars: GameCharacter[] = [];
    if (this.currentTable?.roomMode === 'advanced') {
      const peerId = Network.peerId;
      const userId = Network.peerContext?.userId;
      for (const c of ObjectStore.instance.getObjects<GameCharacter>(GameCharacter)) {
        if (c.location.name !== 'table' || !c.sightEnabled) continue;
        if (this.includesJsonId(c.ownerPeerIds, peerId) || this.includesJsonId(c.ownerUserIds, userId)) sightChars.push(c);
      }
    }

    this.collectionCache = { key, lights, superior, sightChars };
    return this.collectionCache;
  }

  private makeLightSource(x: number, y: number, radius: number, intensity: number, color: string,
    type: string, shape: string, coneAngle: number, rotate: number, gridSize: number): TableLightSource {
    const lightType: string = type || 'none';
    return {
      x, y,
      r: Math.max(10, radius * gridSize),
      intensity, color: color,
      type: lightType,
      shape: lightType === 'laser' ? 'laser' : (shape || 'circle'),
      coneAngle: coneAngle || 60,
      direction: this.normalizeAngle((rotate || 0) + 90),
      flat: lightType === 'flashlight',
      coneCoreRadius: (lightType === 'flashlight' || lightType === 'laser' || shape === 'laser') ? gridSize * 0.5 : gridSize
    };
  }

  /** 松明・焚き火のゆらぎ（intensityのみ。ジオメトリは変わらないのでキャッシュと両立する） */
  private applyFlicker(light: TableLightSource): TableLightSource {
    if (light.type !== 'torch' && light.type !== 'campfire') return light;
    const flicker = Math.sin(this.flickerPhase * 3 + light.x * 0.01) * 0.08
      + Math.sin(this.flickerPhase * 7 + light.y * 0.02) * 0.05;
    return { ...light, intensity: Math.min(1, Math.max(0, light.intensity + flicker)) };
  }

  private renderLighting(now: number = performance.now()) {
    const canvas = this.lightingCanvas?.nativeElement;
    if (!canvas) return;

    const table = this.currentTable;
    if (!table) return;

    const active = this.layerVisibility.lighting && ((table.lightingEnabled && table.lightingNightMode) || this.isAdvancedVisionActive);
    if (!active) {
      if (!this.lightingInactiveClean) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        canvas.style.display = 'none';
        this.lightingInactiveClean = true;
      }
      return;
    }
    this.lightingInactiveClean = false;
    canvas.style.display = 'block';

    const gridSize = table.gridSize || 50;
    const w = table.width * gridSize;
    const h = table.height * gridSize;
    const scale = GameTableComponent.LIGHTING_SCALE;
    const bw = Math.max(1, Math.floor(w * scale));
    const bh = Math.max(1, Math.floor(h * scale));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    if (canvas.style.width !== w + 'px' || canvas.style.height !== h + 'px') {
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
    }

    this.lightingNeedsAnimation = this.detectLightingAnimation();

    if (!this.lightingDirty && this.lightingNeedsAnimation) {
      const elapsed = now - this.lastLightingTs;
      if (elapsed < GameTableComponent.LIGHTING_MIN_INTERVAL) return;
    }
    if (!this.lightingDirty && !this.lightingNeedsAnimation) return;

    this.lastLightingTs = now;
    this.lightingDirty = false;

    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, bw, bh);
    // 内部解像度が違うので、テーブル座標→canvas座標へスケール変換して描く
    ctx.scale(scale, scale);

    const darkness = table.lightingEnabled && table.lightingNightMode ? table.lightingIntensity : 0.82;
    const isGm = this.gmModeService.isGm;
    this.updateFlickerPhase(now);

    // GMモードでは暗幕を描かない
    if (!isGm) {
      ctx.fillStyle = `rgba(0, 0, 0, ${darkness})`;
      ctx.fillRect(0, 0, w, h);
    }

    // 壁グリッド構築
    const wallGrid = this.buildWallGrid(gridSize, w, h);
    this.refreshLightingCaches(wallGrid);

    // 光源の穴を開ける（レイキャスト or 通常）
    // GMモードでは暗幕がないので、光源のグローだけ描く
    if (isGm) {
      this.drawLightGlow(ctx, gridSize);
      return;
    }

    ctx.globalCompositeOperation = 'destination-out';

    if (table.roomMode === 'advanced') {
      this.drawAdvancedVisibility(ctx, gridSize, wallGrid, w, h);
    } else {
      this.drawAmbientLight(ctx, w, h);
      this.drawLightSources(ctx, gridSize, wallGrid);
    }

    ctx.globalCompositeOperation = 'source-over';

    // 壁の表面を暗く戻す
    this.drawLightBlockers(ctx, gridSize);

    // 光源/視覚の色づけ
    ctx.globalCompositeOperation = 'source-atop';
    this.drawLightColors(ctx, gridSize);
    if (table.roomMode === 'advanced') this.drawSightColors(ctx, gridSize);
    ctx.globalCompositeOperation = 'source-over';
  }

  /** 時間ベースでゆらぎ位相を進める（フレームレートに依存しない） */
  private updateFlickerPhase(now: number) {
    if (!this.lastLightingRender) this.lastLightingRender = now;
    const dt = Math.min(100, now - this.lastLightingRender);
    this.lastLightingRender = now;
    this.flickerPhase += dt * 0.0018;
  }

  private drawAdvancedVisibility(ctx: CanvasRenderingContext2D, gridSize: number, wallGrid: WallGrid | null, w: number, h: number) {
    const normalSight = this.getScratchMask(0, w, h);
    const normalCtx = normalSight.getContext('2d');
    this.drawSightSources(normalCtx, gridSize, wallGrid, ['normal']);

    if (this.isAmbientLightEnabled()) {
      // 環境光がある時は、通常視界を「明るい場所」として扱う。
    } else if (this.currentTable.lightingEnabled && this.currentTable.lightingNightMode) {
      const lightMask = this.getScratchMask(1, w, h);
      const lightCtx = lightMask.getContext('2d');
      this.drawLightSources(lightCtx, gridSize, wallGrid);
      normalCtx.globalCompositeOperation = 'destination-in';
      normalCtx.drawImage(lightMask, 0, 0);
      normalCtx.globalCompositeOperation = 'source-over';
    } else {
      normalCtx.clearRect(0, 0, w, h);
    }
    this.subtractSuperiorDarkness(normalCtx, gridSize, wallGrid);

    const darkvisionSight = this.getScratchMask(2, w, h);
    const darkvisionCtx = darkvisionSight.getContext('2d');
    this.drawSightSources(darkvisionCtx, gridSize, wallGrid, ['darkvision']);
    this.subtractSuperiorDarkness(darkvisionCtx, gridSize, wallGrid);

    const superiorDarkvisionSight = this.getScratchMask(3, w, h);
    const superiorDarkvisionCtx = superiorDarkvisionSight.getContext('2d');
    this.drawSightSources(superiorDarkvisionCtx, gridSize, wallGrid, ['superiorDarkvision']);

    ctx.drawImage(normalSight, 0, 0, w, h);
    ctx.drawImage(darkvisionSight, 0, 0, w, h);
    ctx.drawImage(superiorDarkvisionSight, 0, 0, w, h);
  }

  /** 全面マスクcanvasをプールから取得（サイズ変化時のみ再確保。毎フレームのallocを避ける） */
  private getScratchMask(index: number, w: number, h: number): HTMLCanvasElement {
    let canvas = this.scratchMasks[index];
    if (!canvas) {
      canvas = document.createElement('canvas');
      this.scratchMasks[index] = canvas;
    }
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    } else {
      canvas.getContext('2d').clearRect(0, 0, w, h);
    }
    return canvas;
  }

  private getMySightCharacters(): GameCharacter[] {
    if (this.currentTable?.roomMode !== 'advanced') return [];
    const peerId = Network.peerId;
    const userId = Network.peerContext?.userId;
    const gridSize = this.currentTable?.gridSize || 50;
    return this.getLightingCollections(gridSize).sightChars;
  }

  private includesJsonId(raw: string, id: string): boolean {
    if (!id) return false;
    const key = raw + '\u0000' + id;
    const cached = this.jsonIdCache.get(key);
    if (cached !== undefined) return cached;
    let result = false;
    try {
      const ids = JSON.parse(raw || '[]');
      result = Array.isArray(ids) && ids.some(value => String(value) === id);
    } catch (e) {
      result = false;
    }
    this.jsonIdCache.set(key, result);
    if (this.jsonIdCache.size > 1024) {
      // 古いエントリから捨てる（Mapは挿入順を保持する）
      const it = this.jsonIdCache.keys();
      for (let i = 0; i < 256; i++) {
        const k = it.next();
        if (k.done) break;
        this.jsonIdCache.delete(k.value);
      }
    }
    return result;
  }

  private createSightSource(character: GameCharacter, gridSize: number): TableLightSource {
    const mode = character.sightMode || 'normal';
    const radius = Math.max(1, character.sightRadius || (mode === 'superiorDarkvision' ? 24 : mode === 'darkvision' ? 12 : 6));
    const table = this.currentTable;
    const unlimitedRadius = table ? Math.hypot(table.width * gridSize, table.height * gridSize) / gridSize : radius;
    const intensity = mode === 'superiorDarkvision' ? 0.78 : mode === 'darkvision' ? 0.58 : 0.92;
    const color = mode === 'superiorDarkvision' ? '#8fd3ff' : mode === 'darkvision' ? '#9fb2c8' : '#fff7d6';
    return {
      x: character.location.x + Math.max(1, character.size || 1) * gridSize / 2,
      y: character.location.y + Math.max(1, character.size || 1) * gridSize / 2,
      r: Math.max(10, (character.sightUnlimited ? unlimitedRadius : radius) * gridSize),
      intensity,
      color,
      type: `sight-${mode}`,
      shape: 'circle',
      coneAngle: 360,
      direction: this.normalizeAngle((character.rotate || 0) + 90),
      flat: false,
      coneCoreRadius: 0
    };
  }

  private drawSightSources(ctx: CanvasRenderingContext2D, gridSize: number, wallGrid: WallGrid | null, modes: string[] = null) {
    if (this.currentTable?.roomMode !== 'advanced') return;
    for (const character of this.getMySightCharacters()) {
      const mode = character.sightMode || 'normal';
      if (modes && !modes.includes(mode)) continue;
      const sight = this.createSightSource(character, gridSize);
      if (wallGrid) this.drawLightWithRaycast(ctx, sight, wallGrid);
      else this.drawLightFill(ctx, sight, false);
    }
  }

  private drawSightColors(ctx: CanvasRenderingContext2D, gridSize: number) {
    if (this.currentTable?.roomMode !== 'advanced') return;
    for (const character of this.getMySightCharacters()) {
      const sight = this.createSightSource(character, gridSize);
      const alpha = sight.type === 'sight-normal' ? 0.08 : sight.type === 'sight-superiorDarkvision' ? 0.16 : 0.12;
      const hex = Math.round(alpha * 255).toString(16).padStart(2, '0');
      this.drawColoredLightFill(ctx, sight, hex);
    }
  }

  private drawLightSources(ctx: CanvasRenderingContext2D, gridSize: number, wallGrid: WallGrid | null) {
    // 収集は getLightingCollections でキャッシュ。ここではゆらぎ（intensity）だけ毎フレーム載せる
    for (const base of this.getLightingCollections(gridSize).lights) {
      const light = this.applyFlicker(base);
      if (wallGrid) {
        this.drawLightWithRaycast(ctx, light, wallGrid);
      } else {
        this.drawLightFill(ctx, light);
      }
    }
  }

  private collectSuperiorDarknessSources(gridSize: number): TableLightSource[] {
    return this.getLightingCollections(gridSize).superior;
  }

  private drawSuperiorDarknessSources(ctx: CanvasRenderingContext2D, gridSize: number, wallGrid: WallGrid | null) {
    for (const darkness of this.collectSuperiorDarknessSources(gridSize)) {
      if (wallGrid) this.drawLightWithRaycast(ctx, darkness, wallGrid);
      else this.drawLightFill(ctx, darkness, false);
    }
  }

  private subtractSuperiorDarkness(ctx: CanvasRenderingContext2D, gridSize: number, wallGrid: WallGrid | null) {
    const sources = this.collectSuperiorDarknessSources(gridSize);
    if (sources.length < 1) return;
    ctx.globalCompositeOperation = 'destination-out';
    for (const darkness of sources) {
      if (wallGrid) this.drawLightWithRaycast(ctx, darkness, wallGrid);
      else this.drawLightFill(ctx, darkness, false);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  private isPointInSuperiorDarkness(x: number, y: number, gridSize: number, wallGrid: WallGrid | null): boolean {
    for (const darkness of this.collectSuperiorDarknessSources(gridSize)) {
      if (!this.isPointInsideLightShape(x, y, darkness)) continue;
      if (!this.isRayBlocked(darkness.x, darkness.y, x, y, wallGrid)) return true;
    }
    return false;
  }

  private isAmbientLightEnabled(): boolean {
    const table = this.currentTable;
    return !!table?.lightingAmbientLight && 0 < (table.lightingAmbientIntensity || 0);
  }

  private drawAmbientLight(ctx: CanvasRenderingContext2D, w: number, h: number) {
    if (!this.isAmbientLightEnabled()) return;
    const alpha = Math.max(0, Math.min(1, this.currentTable.lightingAmbientIntensity || 0));
    ctx.fillStyle = `rgba(0, 0, 0, ${alpha})`;
    ctx.fillRect(0, 0, w, h);
  }

  /** GMモード用: 暗幕なしで光源のグローだけ描く */
  private drawLightGlow(ctx: CanvasRenderingContext2D, gridSize: number) {
    const allSources: TableLightSource[] = [];
    const characters = ObjectStore.instance.getObjects<GameCharacter>(GameCharacter);
    for (const c of characters) {
      if (!c.lightSourceEnabled || c.location.name !== 'table') continue;
      allSources.push({
        x: c.location.x + gridSize / 2, y: c.location.y + gridSize / 2,
        r: c.lightRadius * gridSize, color: c.lightColor, intensity: c.lightIntensity,
        type: c.lightType, shape: c.lightType === 'laser' ? 'laser' : (c.lightShape || 'circle'), coneAngle: c.lightConeAngle || 60,
        direction: this.normalizeAngle((c.rotate || 0) + 90), flat: c.lightType === 'flashlight', coneCoreRadius: (c.lightType === 'flashlight' || c.lightType === 'laser' || c.lightShape === 'laser') ? gridSize * 0.5 : gridSize
      });
    }
    const terrains = ObjectStore.instance.getObjects<Terrain>(Terrain);
    for (const t of terrains) {
      if (!t.lightSourceEnabled || t.location.name !== 'table') continue;
      allSources.push({
        x: t.location.x + (t.width || 1) * gridSize / 2, y: t.location.y + (t.depth || 1) * gridSize / 2,
        r: t.lightRadius * gridSize, color: t.lightColor, intensity: t.lightIntensity,
        type: t.lightType, shape: t.lightType === 'laser' ? 'laser' : (t.lightShape || 'circle'), coneAngle: t.lightConeAngle || 60,
        direction: this.normalizeAngle((t.rotate || 0) + 90), flat: t.lightType === 'flashlight', coneCoreRadius: (t.lightType === 'flashlight' || t.lightType === 'laser' || t.lightShape === 'laser') ? gridSize * 0.5 : gridSize
      });
    }
    for (const light of allSources) {
      const r = Math.max(10, light.r) * 0.7;
      const alpha = light.intensity * 0.3;
      const hex = Math.round(alpha * 255).toString(16).padStart(2, '0');
      this.drawColoredLightFill(ctx, { ...light, r }, hex);
    }
  }

  private drawLightColors(ctx: CanvasRenderingContext2D, gridSize: number) {
    for (const base of this.getLightingCollections(gridSize).lights) {
      const light = this.applyFlicker(base);
      const r = Math.max(10, light.r) * 0.7;
      const alpha = light.intensity * 0.3;
      const hex = Math.round(alpha * 255).toString(16).padStart(2, '0');
      this.drawColoredLightFill(ctx, { ...light, r }, hex);
    }
  }

  private normalizeAngle(degrees: number): number {
    const normalized = degrees % 360;
    return normalized < 0 ? normalized + 360 : normalized;
  }

  private degreesToRadians(degrees: number): number {
    return degrees * Math.PI / 180;
  }

  private getConeBounds(light: TableLightSource): { start: number; end: number; span: number } {
    const span = this.degreesToRadians(light.coneAngle || 60);
    const center = this.degreesToRadians(light.direction || 0);
    return { start: center - span / 2, end: center + span / 2, span };
  }

  private drawLightFill(ctx: CanvasRenderingContext2D, light: TableLightSource, includeConeCore: boolean = true) {
    if (this.isLaserLight(light)) {
      this.drawLaserLightFill(ctx, light);
      if (includeConeCore) this.drawConeCoreLightFill(ctx, light);
      return;
    }

    ctx.save();
    if (light.shape === 'cone') this.clipCone(ctx, light);

    this.fillLightGradient(ctx, light);
    ctx.restore();

    if (includeConeCore) this.drawConeCoreLightFill(ctx, light);
  }

  private drawColoredLightFill(ctx: CanvasRenderingContext2D, light: TableLightSource, alphaHex: string) {
    if (this.isLaserLight(light)) {
      this.drawLaserColoredLightFill(ctx, light, alphaHex);
      this.drawConeCoreColoredLightFill(ctx, light, alphaHex);
      return;
    }

    ctx.save();
    if (light.shape === 'cone') this.clipCone(ctx, light);

    this.fillColoredLightGradient(ctx, light, alphaHex);
    ctx.restore();

    if (light.type === 'magic') this.drawMagicSonarColor(ctx, light, alphaHex);
    this.drawConeCoreColoredLightFill(ctx, light, alphaHex);
  }

  private fillLightGradient(ctx: CanvasRenderingContext2D, light: TableLightSource) {
    if (light.flat) {
      ctx.fillStyle = `rgba(0, 0, 0, ${light.intensity})`;
      if (light.shape === 'cone') {
        ctx.fillRect(light.x - light.r, light.y - light.r, light.r * 2, light.r * 2);
      } else {
        ctx.beginPath();
        ctx.arc(light.x, light.y, light.r, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }

    const grad = ctx.createRadialGradient(light.x, light.y, 0, light.x, light.y, light.r);
    grad.addColorStop(0, `rgba(0, 0, 0, ${light.intensity})`);
    grad.addColorStop(0.5, `rgba(0, 0, 0, ${light.intensity * 0.6})`);
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(light.x - light.r, light.y - light.r, light.r * 2, light.r * 2);
  }

  private fillColoredLightGradient(ctx: CanvasRenderingContext2D, light: TableLightSource, alphaHex: string) {
    if (light.flat) {
      ctx.fillStyle = light.color + alphaHex;
      if (light.shape === 'cone') {
        ctx.fillRect(light.x - light.r, light.y - light.r, light.r * 2, light.r * 2);
      } else {
        ctx.beginPath();
        ctx.arc(light.x, light.y, light.r, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }

    const grad = ctx.createRadialGradient(light.x, light.y, 0, light.x, light.y, light.r);
    grad.addColorStop(0, light.color + alphaHex);
    grad.addColorStop(1, light.color + '00');
    ctx.fillStyle = grad;
    ctx.fillRect(light.x - light.r, light.y - light.r, light.r * 2, light.r * 2);
  }

  private drawMagicSonarColor(ctx: CanvasRenderingContext2D, light: TableLightSource, alphaHex: string) {
    const maxRadius = Math.max(1, light.r);
    const phase = (this.flickerPhase * 0.9) % 1;
    const baseAlpha = Math.max(parseInt(alphaHex || '00', 16) / 255, light.intensity * 0.45, 0.25);
    ctx.save();
    if (light.shape === 'cone') this.clipCone(ctx, light);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = light.color;
    ctx.shadowBlur = Math.max(6, maxRadius * 0.035);

    for (let i = 0; i < 4; i++) {
      const t = (phase + i / 4) % 1;
      const radius = maxRadius * (0.18 + t * 0.82);
      const alpha = Math.max(0, (1 - t) * baseAlpha * 0.9);
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = light.color;
      ctx.lineWidth = Math.max(2, maxRadius * 0.012 * (1 - t * 0.35));
      ctx.beginPath();
      ctx.arc(light.x, light.y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.globalAlpha = Math.min(0.7, baseAlpha);
    ctx.strokeStyle = light.color;
    ctx.lineWidth = Math.max(1, maxRadius * 0.006);
    ctx.beginPath();
    ctx.arc(light.x, light.y, maxRadius * 0.08, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private drawConeCoreLightFill(ctx: CanvasRenderingContext2D, light: TableLightSource) {
    if ((light.shape !== 'cone' && !this.isLaserLight(light)) || !light.coneCoreRadius) return;
    const coreRadius = Math.min(light.coneCoreRadius, light.r);
    ctx.save();
    ctx.beginPath();
    ctx.arc(light.x, light.y, coreRadius, 0, Math.PI * 2);
    ctx.clip();
    this.fillLightGradient(ctx, { ...light, shape: 'circle' });
    ctx.restore();
  }

  private drawConeCoreColoredLightFill(ctx: CanvasRenderingContext2D, light: TableLightSource, alphaHex: string) {
    if ((light.shape !== 'cone' && !this.isLaserLight(light)) || !light.coneCoreRadius) return;
    const coreRadius = Math.min(light.coneCoreRadius, light.r);
    ctx.save();
    ctx.beginPath();
    ctx.arc(light.x, light.y, coreRadius, 0, Math.PI * 2);
    ctx.clip();
    this.fillColoredLightGradient(ctx, { ...light, shape: 'circle' }, alphaHex);
    ctx.restore();
  }

  private isLaserLight(light: TableLightSource): boolean {
    return light.shape === 'laser' || light.type === 'laser';
  }

  private getLaserWidth(light: TableLightSource): number {
    return Math.max(3, (light.coneCoreRadius || 50) * 0.18);
  }

  private drawLaserLightFill(ctx: CanvasRenderingContext2D, light: TableLightSource, distance: number = light.r) {
    const angle = this.degreesToRadians(light.direction || 0);
    const endX = light.x + Math.cos(angle) * distance;
    const endY = light.y + Math.sin(angle) * distance;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = this.getLaserWidth(light);
    if (light.flat) {
      ctx.strokeStyle = `rgba(0, 0, 0, ${light.intensity})`;
    } else {
      const grad = ctx.createLinearGradient(light.x, light.y, endX, endY);
      grad.addColorStop(0, `rgba(0, 0, 0, ${light.intensity})`);
      grad.addColorStop(1, `rgba(0, 0, 0, ${light.intensity * 0.9})`);
      ctx.strokeStyle = grad;
    }
    ctx.beginPath();
    ctx.moveTo(light.x, light.y);
    ctx.lineTo(endX, endY);
    ctx.stroke();
    ctx.restore();
  }

  private drawLaserColoredLightFill(ctx: CanvasRenderingContext2D, light: TableLightSource, alphaHex: string, distance: number = light.r) {
    const angle = this.degreesToRadians(light.direction || 0);
    const endX = light.x + Math.cos(angle) * distance;
    const endY = light.y + Math.sin(angle) * distance;
    const colorAlphaHex = this.laserColorAlphaHex(light, alphaHex);
    const laserWidth = this.getLaserWidth(light);

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // レーザーは通常の色付き光より彩度を強く、線幅は細く出す。
    // 控えめな色グロー + 細い高濃度コアの2層で描く。
    ctx.lineWidth = laserWidth * 1.8;
    ctx.strokeStyle = light.color + colorAlphaHex;
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.moveTo(light.x, light.y);
    ctx.lineTo(endX, endY);
    ctx.stroke();

    ctx.globalAlpha = 1;
    ctx.lineWidth = Math.max(2, laserWidth * 0.55);
    ctx.strokeStyle = light.color + colorAlphaHex;
    ctx.beginPath();
    ctx.moveTo(light.x, light.y);
    ctx.lineTo(endX, endY);
    ctx.stroke();
    ctx.restore();
  }

  private laserColorAlphaHex(light: TableLightSource, fallbackAlphaHex: string): string {
    const alpha = Math.max(light.intensity * 0.95, parseInt(fallbackAlphaHex || '00', 16) / 255, 0.65);
    return Math.round(Math.min(1, alpha) * 255).toString(16).padStart(2, '0');
  }

  private clipCone(ctx: CanvasRenderingContext2D, light: TableLightSource) {
    const cone = this.getConeBounds(light);
    ctx.beginPath();
    ctx.moveTo(light.x, light.y);
    ctx.arc(light.x, light.y, light.r, cone.start, cone.end);
    ctx.closePath();
    ctx.clip();
  }

  private drawLightBlockers(ctx: CanvasRenderingContext2D, gridSize: number) {
    const table = this.currentTable;
    if (!table) return;
    const darkness = table.lightingEnabled && table.lightingNightMode ? table.lightingIntensity : 0.82;
    const versionKey = this.wallGridVersionCounter + ':' + darkness + ':' + gridSize;
    if (!this.blockerPathCache || this.blockerPathVersion !== versionKey) {
      const path = new Path2D();
      // Terrain（壁）＋マップマスクの遮断矩形をまとめて焼く
      const terrains = ObjectStore.instance.getObjects<Terrain>(Terrain);
      for (const t of terrains) {
        if (!t.lightBlocking || t.location.name !== 'table') continue;
        path.rect(t.location.x, t.location.y, (t.width || 1) * gridSize, (t.depth || 1) * gridSize);
      }
      const masks = ObjectStore.instance.getObjects<GameTableMask>(GameTableMask);
      for (const m of masks) {
        if (!m.lightBlocking || m.location.name !== 'table') continue;
        path.rect(m.location.x, m.location.y, (m.width || 1) * gridSize, (m.height || 1) * gridSize);
      }
      this.blockerPathCache = path;
      this.blockerPathVersion = versionKey;
    }
    ctx.fillStyle = `rgba(0, 0, 0, ${darkness})`;
    ctx.fill(this.blockerPathCache);
  }

  private buildWallGrid(gridSize: number, canvasW: number, canvasH: number): WallGrid | null {
    const tableId = this.currentTable?.identifier || '';
    const sizeKey = canvasW + 'x' + canvasH;
    // ダーティ・テーブル切替・サイズ変更時のみ再構築（TTLなし: イベント駆動で無効化される）
    if (!this.wallGridDirty && this.wallGridTableId === tableId && this.wallGridTableSize === sizeKey && this.wallGridCacheBuilt) {
      return this.cachedWallGrid;
    }
    const prev = this.cachedWallGrid;
    const result = this._buildWallGrid(gridSize, canvasW, canvasH);
    // 中身が同じなら版本を上げない（キャッシュ thrash 防止）
    let changed = true;
    if (this.wallGridCacheBuilt && prev && result && prev.cols === result.cols && prev.rows === result.rows) {
      changed = !this.equalsBytes(prev.grid, result.grid);
    } else if (this.wallGridCacheBuilt && !prev && !result) {
      changed = false;
    }
    if (changed) this.wallGridVersionCounter++;
    this.cachedWallGrid = result;
    this.wallGridDirty = false;
    this.wallGridTableId = tableId;
    this.wallGridTableSize = sizeKey;
    this.wallGridCacheBuilt = true;
    return result;
  }

  private equalsBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  private invalidateWallGrid() {
    this.wallGridDirty = true;
  }

  private _buildWallGrid(gridSize: number, canvasW: number, canvasH: number): WallGrid | null {
    const cellSize = 4;
    const cols = Math.ceil(canvasW / cellSize);
    const rows = Math.ceil(canvasH / cellSize);
    const grid = new Uint8Array(cols * rows);
    const rects: { x1: number; y1: number; x2: number; y2: number }[] = [];
    let hasWalls = false;

    // Terrain壁
    const terrains = ObjectStore.instance.getObjects<Terrain>(Terrain);
    for (const t of terrains) {
      if (!t.lightBlocking || t.location.name !== 'table') continue;
      hasWalls = true;
      const px1 = t.location.x;
      const py1 = t.location.y;
      const px2 = px1 + (t.width || 1) * gridSize;
      const py2 = py1 + (t.depth || 1) * gridSize;
      rects.push({ x1: px1, y1: py1, x2: px2, y2: py2 });
      const x1 = Math.max(0, Math.floor(px1 / cellSize));
      const y1 = Math.max(0, Math.floor(py1 / cellSize));
      const x2 = Math.min(cols, Math.ceil(px2 / cellSize));
      const y2 = Math.min(rows, Math.ceil(py2 / cellSize));
      for (let gy = y1; gy < y2; gy++)
        for (let gx = x1; gx < x2; gx++)
          grid[gy * cols + gx] = 1;
    }

    // マスク壁
    const masks = ObjectStore.instance.getObjects<GameTableMask>(GameTableMask);
    for (const m of masks) {
      if (!m.lightBlocking || m.location.name !== 'table') continue;
      hasWalls = true;
      const px1 = m.location.x;
      const py1 = m.location.y;
      const px2 = px1 + (m.width || 1) * gridSize;
      const py2 = py1 + (m.height || 1) * gridSize;
      rects.push({ x1: px1, y1: py1, x2: px2, y2: py2 });
      const x1 = Math.max(0, Math.floor(px1 / cellSize));
      const y1 = Math.max(0, Math.floor(py1 / cellSize));
      const x2 = Math.min(cols, Math.ceil(px2 / cellSize));
      const y2 = Math.min(rows, Math.ceil(py2 / cellSize));
      for (let gy = y1; gy < y2; gy++)
        for (let gx = x1; gx < x2; gx++)
          grid[gy * cols + gx] = 1;
    }

    // 壁ペン描画壁（縮小サンプリング）
    const wallCanvas = this.createWallDrawingCanvas(canvasW, canvasH);
    if (wallCanvas) {
        const hasPen = true;
        const dCtx = wallCanvas.getContext('2d');
        const imgData = dCtx.getImageData(0, 0, wallCanvas.width, wallCanvas.height);
        const pixels = imgData.data;
        const dw = wallCanvas.width;
        for (let gy = 0; gy < rows; gy++) {
          for (let gx = 0; gx < cols; gx++) {
            const px = Math.min(gx * cellSize, dw - 1);
            const py = Math.min(gy * cellSize, wallCanvas.height - 1);
            if (pixels[(py * dw + px) * 4 + 3] > 10) {
              grid[gy * cols + gx] = 1;
              hasWalls = true;
            }
          }
        }
        return hasWalls ? { grid, cellSize, cols, rows, version: this.wallGridVersionCounter, rects, hasPen } : null;
    }

    return hasWalls ? { grid, cellSize, cols, rows, version: this.wallGridVersionCounter, rects, hasPen: false } : null;
  }

  private createWallDrawingCanvas(width: number, height: number): HTMLCanvasElement | null {
    if (!this.layerVisibility.wallDrawing) return null;
    const raw = this.currentTable?.wallDrawingData || '';
    const cacheKey = raw + '\u0000' + width + 'x' + height;
    if (this.wallPenCache && this.wallPenCache.raw === cacheKey) return this.wallPenCache.canvas;
    const strokes = this.wallDrawingStrokes;
    let canvas: HTMLCanvasElement = null;
    if (strokes.length > 0) {
      canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      for (const stroke of strokes) this.drawStrokeOnCanvas(canvas, stroke);
    }
    this.wallPenCache = { raw: cacheKey, canvas };
    return canvas;
  }

  private drawLaserWithRaycast(
    ctx: CanvasRenderingContext2D,
    light: TableLightSource,
    wallGrid: WallGrid
  ) {
    const { grid, cellSize, cols, rows } = wallGrid;
    const angle = this.degreesToRadians(light.direction || 0);
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let hitDist = light.r;

    // 光源の円がどの壁AABBとも交差しないならレイキャスト不要（フル到達）
    if (!wallGrid.hasPen && wallGrid.rects.length > 0 && this.circleMissesAllRects(light.x, light.y, light.r, wallGrid.rects)) {
      // hitDist = light.r のまま
    } else if (!wallGrid.hasPen && wallGrid.rects.length < 1) {
      // 壁なし（ペンもなし）→ フル到達
    } else {
      for (let d = cellSize; d <= light.r; d += cellSize) {
        const gx = Math.floor((light.x + dx * d) / cellSize);
        const gy = Math.floor((light.y + dy * d) / cellSize);
        if (gx < 0 || gy < 0 || gx >= cols || gy >= rows) {
          hitDist = d;
          break;
        }
        if (grid[gy * cols + gx]) {
          hitDist = d;
          break;
        }
      }
    }

    this.drawLaserLightFill(ctx, light, hitDist);
    this.drawConeCoreLightFill(ctx, light);
  }

  /** 円(cx,cy,r)が全てのAABBの外にあるならtrue（高速パス用） */
  private circleMissesAllRects(cx: number, cy: number, r: number, rects: { x1: number; y1: number; x2: number; y2: number }[]): boolean {
    for (const rc of rects) {
      const nearestX = Math.max(rc.x1, Math.min(cx, rc.x2));
      const nearestY = Math.max(rc.y1, Math.min(cy, rc.y2));
      const dx = cx - nearestX;
      const dy = cy - nearestY;
      if (dx * dx + dy * dy < r * r) return false;
    }
    return true;
  }

  private drawLightWithRaycast(
    ctx: CanvasRenderingContext2D,
    light: TableLightSource,
    wallGrid: WallGrid
  ) {
    if (this.isLaserLight(light)) {
      this.drawLaserWithRaycast(ctx, light, wallGrid);
      return;
    }

    // 可視ポリゴンは壁配置×光源ジオメトリのみで決まるのでキャッシュする
    const path = this.getVisibilityPath(light, wallGrid);

    // 可視ポリゴンをclipしてグラデーション描画
    ctx.save();
    ctx.clip(path);

    this.drawLightFill(ctx, light, false);

    ctx.restore();

    this.drawConeCoreLightFill(ctx, light);
  }

  /** 光源の可視ポリゴンPath2Dを取得（量子化キーでキャッシュ） */
  private getVisibilityPath(light: TableLightSource, wallGrid: WallGrid): Path2D {
    const quant = 4; // px量子化
    const key = wallGrid.version + '|' + light.shape + '|' + Math.round(light.x / quant) + ',' + Math.round(light.y / quant)
      + '|' + Math.round(light.r) + '|' + Math.round(light.coneAngle || 0) + '|' + Math.round((light.direction || 0) / 2);
    const cached = this.visibilityPathCache.get(key);
    if (cached) return cached;

    const { grid, cellSize, cols, rows } = wallGrid;
    const cx = light.x;
    const cy = light.y;
    const radius = light.r;
    const path = new Path2D();

    // 高速パス: 光源円がどの壁AABBとも交差しない（ペン壁なし）ならレイキャスト不要
    const noWallHit = !wallGrid.hasPen && (wallGrid.rects.length < 1 || this.circleMissesAllRects(cx, cy, radius, wallGrid.rects));
    if (noWallHit) {
      if (light.shape === 'cone') {
        const cone = this.getConeBounds(light);
        path.moveTo(cx, cy);
        path.arc(cx, cy, radius, cone.start, cone.end);
        path.closePath();
      } else {
        path.arc(cx, cy, radius, 0, Math.PI * 2);
        path.closePath();
      }
    } else {
      const isCone = light.shape === 'cone';
      const cone = this.getConeBounds(light);
      const RAYS = isCone ? Math.max(24, Math.ceil((light.coneAngle || 60) / 2)) : 180;

      if (isCone) path.moveTo(cx, cy);
      let started = !isCone;

      for (let i = 0; i < RAYS; i++) {
        const angle = isCone
          ? cone.start + (cone.span * i / Math.max(1, RAYS - 1))
          : (i / RAYS) * Math.PI * 2;
        const dx = Math.cos(angle);
        const dy = Math.sin(angle);

        let hitDist = radius;
        for (let d = cellSize; d <= radius; d += cellSize) {
          const gx = Math.floor((cx + dx * d) / cellSize);
          const gy = Math.floor((cy + dy * d) / cellSize);

          if (gx < 0 || gy < 0 || gx >= cols || gy >= rows) {
            hitDist = d;
            break;
          }
          if (grid[gy * cols + gx]) {
            hitDist = d;
            break;
          }
        }

        const px = cx + dx * hitDist;
        const py = cy + dy * hitDist;
        if (started) path.lineTo(px, py);
        else { path.moveTo(px, py); started = true; }
      }
      path.closePath();
    }

    if (this.visibilityPathCache.size >= GameTableComponent.VISIBILITY_PATH_MAX) {
      // 古いものから捨てる（Mapは挿入順保持）
      const it = this.visibilityPathCache.keys();
      for (let i = 0; i < 32; i++) {
        const k = it.next();
        if (k.done) break;
        this.visibilityPathCache.delete(k.value);
      }
    }
    this.visibilityPathCache.set(key, path);
    return path;
  }
}
