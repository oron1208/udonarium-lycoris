import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, HostListener, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';

import { Card } from '@udonarium/card';
import { CardStack } from '@udonarium/card-stack';
import { ImageFile } from '@udonarium/core/file-storage/image-file';
import { GameObject } from '@udonarium/core/synchronize-object/game-object';
import { EventSystem } from '@udonarium/core/system';
import { DiceSymbol } from '@udonarium/dice-symbol';
import { GameCharacter } from '@udonarium/game-character';
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

interface TableDrawingStroke {
  color: string;
  width: number;
  mode: 'pen' | 'eraser';
  tool?: TableDrawingTool;
  fill?: boolean;
  points: number[];
}

@Component({
  selector: 'game-table',
  templateUrl: './game-table.component.html',
  styleUrls: ['./game-table.component.css'],
})
export class GameTableComponent implements OnInit, OnDestroy, AfterViewInit {
  @ViewChild('root', { static: true }) rootElementRef: ElementRef<HTMLElement>;
  @ViewChild('gameTable', { static: true }) gameTable: ElementRef<HTMLElement>;
  @ViewChild('gameObjects', { static: true }) gameObjects: ElementRef<HTMLElement>;
  @ViewChild('gridCanvas', { static: true }) gridCanvas: ElementRef<HTMLCanvasElement>;
  @ViewChild('drawingCanvas', { static: true }) drawingCanvas: ElementRef<HTMLCanvasElement>;
  @ViewChild('lightingCanvas', { static: true }) lightingCanvas: ElementRef<HTMLCanvasElement>;

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
  get isLightingActive(): boolean {
    return this.currentTable?.lightingEnabled && this.currentTable?.lightingNightMode;
  }
  get isGmMode(): boolean { return this.gmModeService.isGm; }
  rangeSelectionStyle: { [key: string]: string } = {};
  private rangeSelectionStart: { x: number, y: number } = null;
  private rangeSelectionCurrent: { x: number, y: number } = null;

  get characters(): GameCharacter[] { return this.tabletopService.characters; }
  get isCharacterSimpleMode(): boolean { return 60 <= this.characters.length; }
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
        if (event.data.identifier !== this.currentTable.identifier && event.data.identifier !== this.tableSelecter.identifier) return;
        console.log('UPDATE_GAME_OBJECT GameTableComponent ' + this.currentTable.identifier);
        this.setGameTableGrid(this.currentTable.width, this.currentTable.height, this.currentTable.gridSize, this.currentTable.gridType, this.currentTable.gridColor);
        this.redrawDrawingCanvas();
      })
      .on('RE_DRAW_TABLE', event => {
        console.log("テーブル再描画");
        this.changeDetector.detectChanges();
        this.changeDetector.markForCheck();
      })
      .on('NAME_LABEL_VISIBILITY_CHANGED', event => {
        this.changeDetector.markForCheck();
      })
      .on('GM_MODE_CHANGED', event => {
        this.changeDetector.markForCheck();
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
          console.log(`move table to focus (${event.data.x}, ${event.data.y})`);
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
    this.startLightingLoop();
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
    if (!event.ctrlKey && !event.metaKey) return;
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
      console.log('グリッド描画');
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
    if (!window.confirm('テーブルのお絵描きを全消ししますか？')) return;
    this.currentTable.drawingData = '[]';
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
    const strokes = this.drawingStrokes;
    strokes.push(this.currentDrawingStroke);
    this.currentTable.drawingData = JSON.stringify(strokes.slice(-1000));
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
    try {
      const data = JSON.parse(this.currentTable.drawingData || '[]');
      return Array.isArray(data) ? data.filter(stroke => stroke && Array.isArray(stroke.points)) : [];
    } catch (e) {
      return [];
    }
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
    for (const stroke of this.drawingStrokes) this.drawStroke(stroke);
    if (extraStroke) this.drawStroke(extraStroke);
  }

  private drawStroke(stroke: TableDrawingStroke) {
    if (!stroke || stroke.points.length < 2) return;
    const canvas = this.drawingCanvas.nativeElement;
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
    const render = () => {
      this.renderLighting();
      this.lightingAnimFrame = requestAnimationFrame(render);
    };
    this.lightingAnimFrame = requestAnimationFrame(render);
  }

  private renderLighting() {
    const canvas = this.lightingCanvas?.nativeElement;
    if (!canvas) return;

    const table = this.currentTable;
    if (!table) return;

    const active = table.lightingEnabled && table.lightingNightMode;
    if (!active) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      canvas.style.display = 'none';
      return;
    }
    canvas.style.display = 'block';

    const gridSize = table.gridSize || 50;
    const w = table.width * gridSize;
    const h = table.height * gridSize;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    const darkness = table.lightingIntensity;
    const isGm = this.gmModeService.isGm;
    this.flickerPhase += 0.03;

    // GMモードでは暗幕を描かない
    if (!isGm) {
      ctx.fillStyle = `rgba(0, 0, 0, ${darkness})`;
      ctx.fillRect(0, 0, w, h);
    }

    // 壁グリッド構築
    const wallGrid = this.buildWallGrid(gridSize, w, h);

    // 光源の穴を開ける（レイキャスト or 通常）
    // GMモードでは暗幕がないので、光源のグローだけ描く
    if (isGm) {
      this.drawLightGlow(ctx, gridSize);
      return;
    }

    ctx.globalCompositeOperation = 'destination-out';

    this.drawLightSources(ctx, gridSize, wallGrid);

    ctx.globalCompositeOperation = 'source-over';

    // 壁の表面を暗く戻す
    this.drawLightBlockers(ctx, gridSize);

    // 光源の色づけ
    ctx.globalCompositeOperation = 'source-atop';
    this.drawLightColors(ctx, gridSize);
    ctx.globalCompositeOperation = 'source-over';
  }

  private drawLightSources(ctx: CanvasRenderingContext2D, gridSize: number, wallGrid: { grid: Uint8Array; cellSize: number; cols: number; rows: number } | null) {
    const allLights: { x: number; y: number; r: number; intensity: number; color: string; type: string }[] = [];

    const characters = ObjectStore.instance.getObjects<GameCharacter>(GameCharacter);
    for (const c of characters) {
      if (!c.lightSourceEnabled || c.location.name !== 'table') continue;
      const x = c.location.x + gridSize / 2;
      const y = c.location.y + gridSize / 2;
      const r = Math.max(10, c.lightRadius * gridSize);
      const flicker = (c.lightType === 'torch' || c.lightType === 'campfire')
        ? Math.sin(this.flickerPhase * 3 + x * 0.01) * 0.08 + Math.sin(this.flickerPhase * 7 + y * 0.02) * 0.05
        : 0;
      allLights.push({ x, y, r, intensity: Math.min(1, c.lightIntensity + flicker), color: c.lightColor, type: c.lightType });
    }

    const terrains = ObjectStore.instance.getObjects<Terrain>(Terrain);
    for (const t of terrains) {
      if (!t.lightSourceEnabled || t.location.name !== 'table') continue;
      const x = t.location.x + (t.width || 1) * gridSize / 2;
      const y = t.location.y + (t.depth || 1) * gridSize / 2;
      const r = Math.max(10, t.lightRadius * gridSize);
      const flicker = (t.lightType === 'torch' || t.lightType === 'campfire')
        ? Math.sin(this.flickerPhase * 3 + x * 0.01) * 0.08 + Math.sin(this.flickerPhase * 7 + y * 0.02) * 0.05
        : 0;
      allLights.push({ x, y, r, intensity: Math.min(1, t.lightIntensity + flicker), color: t.lightColor, type: t.lightType });
    }

    for (const light of allLights) {
      if (wallGrid) {
        this.drawLightWithRaycast(ctx, light.x, light.y, light.r, light.intensity, wallGrid);
      } else {
        const grad = ctx.createRadialGradient(light.x, light.y, 0, light.x, light.y, light.r);
        grad.addColorStop(0, `rgba(0, 0, 0, ${light.intensity})`);
        grad.addColorStop(0.5, `rgba(0, 0, 0, ${light.intensity * 0.6})`);
        grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(light.x - light.r, light.y - light.r, light.r * 2, light.r * 2);
      }
    }
  }

  /** GMモード用: 暗幕なしで光源のグローだけ描く */
  private drawLightGlow(ctx: CanvasRenderingContext2D, gridSize: number) {
    const allSources: { x: number; y: number; r: number; color: string; intensity: number }[] = [];
    const characters = ObjectStore.instance.getObjects<GameCharacter>(GameCharacter);
    for (const c of characters) {
      if (!c.lightSourceEnabled || c.location.name !== 'table') continue;
      allSources.push({
        x: c.location.x + gridSize / 2, y: c.location.y + gridSize / 2,
        r: c.lightRadius * gridSize, color: c.lightColor, intensity: c.lightIntensity
      });
    }
    const terrains = ObjectStore.instance.getObjects<Terrain>(Terrain);
    for (const t of terrains) {
      if (!t.lightSourceEnabled || t.location.name !== 'table') continue;
      allSources.push({
        x: t.location.x + (t.width || 1) * gridSize / 2, y: t.location.y + (t.depth || 1) * gridSize / 2,
        r: t.lightRadius * gridSize, color: t.lightColor, intensity: t.lightIntensity
      });
    }
    for (const light of allSources) {
      const r = Math.max(10, light.r) * 0.7;
      const alpha = light.intensity * 0.3;
      const hex = Math.round(alpha * 255).toString(16).padStart(2, '0');
      const grad = ctx.createRadialGradient(light.x, light.y, 0, light.x, light.y, r);
      grad.addColorStop(0, light.color + hex);
      grad.addColorStop(1, light.color + '00');
      ctx.fillStyle = grad;
      ctx.fillRect(light.x - r, light.y - r, r * 2, r * 2);
    }
  }

  private drawLightColors(ctx: CanvasRenderingContext2D, gridSize: number) {
    const allSources: {x:number, y:number, r:number, color:string, intensity:number, type:string}[] = [];

    const characters = ObjectStore.instance.getObjects<GameCharacter>(GameCharacter);
    for (const c of characters) {
      if (!c.lightSourceEnabled || c.location.name !== 'table') continue;
      allSources.push({
        x: c.location.x + gridSize / 2,
        y: c.location.y + gridSize / 2,
        r: c.lightRadius * gridSize,
        color: c.lightColor,
        intensity: c.lightIntensity,
        type: c.lightType
      });
    }

    const terrains = ObjectStore.instance.getObjects<Terrain>(Terrain);
    for (const t of terrains) {
      if (!t.lightSourceEnabled || t.location.name !== 'table') continue;
      allSources.push({
        x: t.location.x + (t.width || 1) * gridSize / 2,
        y: t.location.y + (t.depth || 1) * gridSize / 2,
        r: t.lightRadius * gridSize,
        color: t.lightColor,
        intensity: t.lightIntensity,
        type: t.lightType
      });
    }

    for (const light of allSources) {
      const r = Math.max(10, light.r) * 0.7;
      const alpha = light.intensity * 0.3;
      const hex = Math.round(alpha * 255).toString(16).padStart(2, '0');
      const grad = ctx.createRadialGradient(light.x, light.y, 0, light.x, light.y, r);
      grad.addColorStop(0, light.color + hex);
      grad.addColorStop(1, light.color + '00');
      ctx.fillStyle = grad;
      ctx.fillRect(light.x - r, light.y - r, r * 2, r * 2);
    }
  }

  private drawLightBlockers(ctx: CanvasRenderingContext2D, gridSize: number) {
    const table = this.currentTable;
    if (!table) return;
    const darkness = table.lightingIntensity;

    // Terrain（壁）で光を遮断
    const terrains = ObjectStore.instance.getObjects<Terrain>(Terrain);
    for (const t of terrains) {
      if (!t.lightBlocking || t.location.name !== 'table') continue;
      const x = t.location.x;
      const y = t.location.y;
      const w = (t.width || 1) * gridSize;
      const h = (t.depth || 1) * gridSize;
      ctx.fillStyle = `rgba(0, 0, 0, ${darkness})`;
      ctx.fillRect(x, y, w, h);
    }

    // マップマスクで光を遮断
    const masks = ObjectStore.instance.getObjects<GameTableMask>(GameTableMask);
    for (const m of masks) {
      if (!m.lightBlocking || m.location.name !== 'table') continue;
      const x = m.location.x;
      const y = m.location.y;
      const w = (m.width || 1) * gridSize;
      const h = (m.height || 1) * gridSize;
      ctx.fillStyle = `rgba(0, 0, 0, ${darkness})`;
      ctx.fillRect(x, y, w, h);
    }
  }

  private buildWallGrid(gridSize: number, canvasW: number, canvasH: number): { grid: Uint8Array; cellSize: number; cols: number; rows: number } | null {
    const cellSize = 4;
    const cols = Math.ceil(canvasW / cellSize);
    const rows = Math.ceil(canvasH / cellSize);
    const grid = new Uint8Array(cols * rows);
    let hasWalls = false;

    // Terrain壁
    const terrains = ObjectStore.instance.getObjects<Terrain>(Terrain);
    for (const t of terrains) {
      if (!t.lightBlocking || t.location.name !== 'table') continue;
      hasWalls = true;
      const x1 = Math.max(0, Math.floor(t.location.x / cellSize));
      const y1 = Math.max(0, Math.floor(t.location.y / cellSize));
      const x2 = Math.min(cols, Math.ceil((t.location.x + (t.width || 1) * gridSize) / cellSize));
      const y2 = Math.min(rows, Math.ceil((t.location.y + (t.depth || 1) * gridSize) / cellSize));
      for (let gy = y1; gy < y2; gy++)
        for (let gx = x1; gx < x2; gx++)
          grid[gy * cols + gx] = 1;
    }

    // マスク壁
    const masks = ObjectStore.instance.getObjects<GameTableMask>(GameTableMask);
    for (const m of masks) {
      if (!m.lightBlocking || m.location.name !== 'table') continue;
      hasWalls = true;
      const x1 = Math.max(0, Math.floor(m.location.x / cellSize));
      const y1 = Math.max(0, Math.floor(m.location.y / cellSize));
      const x2 = Math.min(cols, Math.ceil((m.location.x + (m.width || 1) * gridSize) / cellSize));
      const y2 = Math.min(rows, Math.ceil((m.location.y + (m.height || 1) * gridSize) / cellSize));
      for (let gy = y1; gy < y2; gy++)
        for (let gx = x1; gx < x2; gx++)
          grid[gy * cols + gx] = 1;
    }

    // ペン描画壁（縮小サンプリング）
    const table = this.currentTable;
    if (table?.drawingAsWall) {
      const drawingCanvas = this.drawingCanvas?.nativeElement;
      if (drawingCanvas && drawingCanvas.width > 0 && drawingCanvas.height > 0) {
        const dCtx = drawingCanvas.getContext('2d');
        const imgData = dCtx.getImageData(0, 0, drawingCanvas.width, drawingCanvas.height);
        const pixels = imgData.data;
        const dw = drawingCanvas.width;
        for (let gy = 0; gy < rows; gy++) {
          for (let gx = 0; gx < cols; gx++) {
            const px = Math.min(gx * cellSize, dw - 1);
            const py = Math.min(gy * cellSize, drawingCanvas.height - 1);
            if (pixels[(py * dw + px) * 4 + 3] > 10) {
              grid[gy * cols + gx] = 1;
              hasWalls = true;
            }
          }
        }
      }
    }

    return hasWalls ? { grid, cellSize, cols, rows } : null;
  }

  private drawLightWithRaycast(
    ctx: CanvasRenderingContext2D,
    cx: number, cy: number, radius: number, intensity: number,
    wallGrid: { grid: Uint8Array; cellSize: number; cols: number; rows: number }
  ) {
    const { grid, cellSize, cols, rows } = wallGrid;
    const RAYS = 180;
    const points: { x: number; y: number }[] = [];

    for (let i = 0; i < RAYS; i++) {
      const angle = (i / RAYS) * Math.PI * 2;
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

      points.push({ x: cx + dx * hitDist, y: cy + dy * hitDist });
    }

    // 可視ポリゴンをclipしてグラデーション描画
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.closePath();
    ctx.clip();

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    grad.addColorStop(0, `rgba(0, 0, 0, ${intensity})`);
    grad.addColorStop(0.5, `rgba(0, 0, 0, ${intensity * 0.6})`);
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);

    ctx.restore();
  }
}
