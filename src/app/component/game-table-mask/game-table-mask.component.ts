import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  Input,
  NgZone,
  OnChanges,
  OnDestroy,
  OnInit,
  ViewChild,
  
} from '@angular/core';
import { Logger } from '../../class/core/system/util/logger';

import { ImageFile } from '@udonarium/core/file-storage/image-file';
import { ObjectNode } from '@udonarium/core/synchronize-object/object-node';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { EventSystem, Network } from '@udonarium/core/system';

import { GameCharacter } from '@udonarium/game-character';
import { GameTableMask } from '@udonarium/game-table-mask';
import { PresetSound, SoundEffect } from '@udonarium/sound-effect';
import { GameCharacterSheetComponent } from 'component/game-character-sheet/game-character-sheet.component';
import { OpenUrlComponent } from 'component/open-url/open-url.component';
import { InputHandler } from 'directive/input-handler';
import { MovableOption } from 'directive/movable.directive';
import { ModalService } from 'service/modal.service';
import { ContextMenuAction, ContextMenuSeparator, ContextMenuService } from 'service/context-menu.service';
import { CoordinateService } from 'service/coordinate.service';
import { PanelOption, PanelService } from 'service/panel.service';
import { PointerDeviceService } from 'service/pointer-device.service';
import { GmModeService } from 'service/gm-mode.service';
import { UUID } from '@udonarium/core/system/util/uuid';
import { animate, keyframes, style, transition, trigger } from '@angular/animations';
import { TableSelecter } from '@udonarium/table-selecter';
import { TabletopActionService } from 'service/tabletop-action.service';
import { xor } from 'lodash';

type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';

@Component({
  selector: 'game-table-mask',
  templateUrl: './game-table-mask.component.html',
  styleUrls: ['./game-table-mask.component.css'],
  animations: [
    trigger('fadeInOut', [
    
      transition('void => *', [
        animate('132ms ease-out', keyframes([
          style({ opacity: 0, offset: 0 }),
          style({ opacity: 1, offset: 1.0 })
        ]))
      ]),
      transition('* => void', [
        animate('132ms ease-in', keyframes([
          style({ opacity: 1, offset: 0 }),
          style({ opacity: 0, offset: 1.0 })
        ]))
      ])

    ]),
    trigger('rotateInOut', [

      transition('scrached<=>restore', [
        animate('132ms ease-in-out', keyframes([
          style({ transform: 'rotateY(0deg)', offset: 0.0 }),
          style({ transform: 'rotateY(-90deg)', offset: 1.0 })
        ]))
      ])

    ]),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush
})

export class GameTableMaskComponent implements OnChanges, OnDestroy, AfterViewInit {
//  @ViewChild('elementToDetach') elementToDetach: ElementRef;
  @ViewChild('maskCanvas') maskCanvas!: ElementRef<HTMLCanvasElement>;

  @Input() gameTableMask: GameTableMask = null;
  @Input() is3D: boolean = false;

  get dispLockMark(): boolean { return this.gameTableMask.dispLockMark; }
  set dispLockMark(disp: boolean) { this.gameTableMask.dispLockMark = disp; }

  get name(): string { return this.gameTableMask.name; }
  get width(): number { return this.adjustMinBounds(this.gameTableMask.width); }
  get height(): number { return this.adjustMinBounds(this.gameTableMask.height); }
  get opacity(): number { return this.gameTableMask.opacity; }
  get imageFile(): ImageFile { return this.gameTableMask.imageFile; }
  get isLock(): boolean { return this.gameTableMask.isLock; }
  set isLock(isLock: boolean) { this.gameTableMask.isLock = isLock; }
  get visibility(): string { return this.gameTableMask.visibility || 'public'; }
  set visibility(visibility: string) { this.gameTableMask.visibility = visibility; }
  get isGmOnly(): boolean { return this.visibility === 'gmOnly'; }
  get isPlOnly(): boolean { return this.visibility === 'plOnly'; }
  get isLightReactiveMask(): boolean { return this.gameTableMask && this.gameTableMask.isLightReactiveMask; }
  get isLightAreaMask(): boolean { return this.gameTableMask && this.gameTableMask.isLightAreaMask; }
  get canDisplayByRole(): boolean { return true; }
  get canResizeMask(): boolean { return !!this.gameTableMask && !this.isLock && !this.isScratching; }
  get isLightweight(): boolean { return !!this.gameTableMask.isLightweight; }
  set isLightweight(isLightweight: boolean) { this.gameTableMask.isLightweight = isLightweight; }
  get needsCanvasMask(): boolean { return true; }
  get lightweightBackgroundColor(): string { return this.bgcolor || this.color || '#555555'; }
/*
  get blendType(): number { return this.gameTableMask.blendType; }
  set blendType(blendType: number) { this.gameTableMask.blendType = blendType; }
*/

  get color(): string { return this.gameTableMask.color; }
  set color(color: string) { this.gameTableMask.color = color; }
  get bgcolor(): string { return this.gameTableMask.bgcolor; }
  set bgcolor(bgcolor: string) { this.gameTableMask.bgcolor = bgcolor; }

  get isPreview(): boolean { return this.gameTableMask.isPreview; }
  set isPreview(isPreview: boolean) { this.gameTableMask.isPreview = isPreview; }
  get isPreviewMode(): boolean {
    if (!this.gameTableMask) return false;
    return this.isPreview && this.gameTableMask.isMine;
    return false;
  }

  get gameTableMaskAltitude(): number {
    return +this.altitude.toFixed(1); 
  }

  get scratchedGrids() {
    return this.gameTableMask.scratchedGrids;
  }
  set scratchedGrids(scratchedGrids: string) {
    this.gameTableMask.scratchedGrids = scratchedGrids;
  }

  get scratchingGrids() {
    return this.gameTableMask.scratchingGrids;
  }
  set scratchingGrids(scratchingGrids: string) {
    this.gameTableMask.scratchingGrids = scratchingGrids;
  }

  get isNonScratched(): boolean {
    return !this.gameTableMask.scratchedGrids;
  }

  get isNonScratching(): boolean {
    return !(this.gameTableMask.scratchingGrids || this._currentScratchingSet);
  }

  get masksCss(): string {
    if (!this.isPreviewMode && this.isNonScratched) return '';
    const masks: string[] = [];
    const scratchedSet: Set<string> = new Set(this.scratchedGrids.split(/,/g));
    const scratchingSet: Set<string> = this._currentScratchingSet ? this._currentScratchingSet : new Set(this.scratchingGrids.split(/,/g));
    for (let x = 0; x < this.width; x++) {
      for (let y = 0; y < this.height; y++) {
        const gridStr = `${x}:${y}`;
        if (this.isPreviewMode) {
          if (scratchedSet.has(gridStr) && !scratchingSet.has(gridStr)) continue;
          if (scratchingSet.has(gridStr) && !scratchedSet.has(gridStr)) continue;
        } else {
          if (scratchedSet.has(gridStr)) continue;
        }
        masks.push(`radial-gradient(#000, #000) ${ x * this.gridSize - 1 }px ${ y * this.gridSize -1 }px / ${ this.gridSize + 2 }px ${ this.gridSize + 2 }px no-repeat`);
      }
    }
    return masks.length ? masks.join(',') : 'radial-gradient(#000, #000) 0px 0px / 0px 0px no-repeat';
  }

  get scratchingGridInfos(): {x: number, y: number, state: string}[] {
    const ret: {x: number, y: number, state: string}[] = [];
    if (!this.gameTableMask || (this.isNonScratching && this.isNonScratched)) return ret;
    const scratchingGridSet: Set<string> = this._currentScratchingSet ? this._currentScratchingSet : new Set(this.scratchingGrids.split(/,/g));
    const scratchedGridSet: Set<string> = new Set(this.scratchedGrids.split(/,/g));
    for (let x = 0; x < Math.ceil(this.width); x++) {
      for (let y = 0; y < Math.ceil(this.height); y++) {
        const gridStr = `${x}:${y}`;
        if (scratchingGridSet.has(gridStr) || scratchedGridSet.has(gridStr)) ret.push({ 
          x: x, 
          y: y, 
          state: !scratchingGridSet.has(gridStr) ? 'scrached' : 
            !scratchedGridSet.has(gridStr) ? 'scraching' 
            : 'restore'
        });
      }
    }
    return ret;
  }

  get operateOpacity(): number {
    if (this.isLightAreaMask) {
      return this.gmModeService.isGm ? 0.25 : 0.12;
    }

    if (this.isLightReactiveMask) {
      const roleRate = this.gmModeService.isGm ? 0.35 : 1;
      const ret = this.opacity * ((this.gameTableMask.isMine) ? 0.6 : 1) * roleRate;
      return (ret < 0.4 && this.isScratching) ? 0.4 : ret;
    }

    // GM mode: GM sees masks semi-transparent so they can peek through.
    // PL/non-GM always sees masks as solid black/opaque.
    // Per-mask gmOnly/plOnly labels are kept for compatibility, but GM mode wins here.
    const roleRate = this.gmModeService.isGm ? 0.35 : 1;
    const ret = this.opacity * ((this.gameTableMask.isMine) ? 0.6 : 1) * roleRate;
    return (ret < 0.4 && this.isScratching) ? 0.4 : ret;
  }

  get altitude(): number { return this.gameTableMask.altitude; }
  set altitude(altitude: number) { this.gameTableMask.altitude = altitude; }

  get isAltitudeIndicate(): boolean { return this.gameTableMask.isAltitudeIndicate; }
  set isAltitudeIndicate(isAltitudeIndicate: boolean) { this.gameTableMask.isAltitudeIndicate = isAltitudeIndicate; }

/*
  get rubiedText(): string {
    return StringUtil.rubyToHtml(StringUtil.escapeHtml(this.text));
  }
*/
/*
  get isInverse(): boolean {
    return 90 < Math.abs(this.viewRotateZ) % 360 && Math.abs(this.viewRotateZ) % 360 < 270
  }
*/

//  get isGMMode(): boolean { return this.gameTableMask.isGMMode; }
  get isScratching(): boolean { return !!this.gameTableMask.owner; }

  get hasOwner(): boolean { return this.gameTableMask.hasOwner; }
  get ownerIsOnline(): boolean { return this.gameTableMask.ownerIsOnline; }
  get ownerName(): string { return this.gameTableMask.ownerName; }
  get ownerColor(): string { return this.gameTableMask.ownerColor; }

  panelId;

  gridSize: number = 50;
  math = Math;
  viewRotateZ = 10;

  movableOption: MovableOption = {};

  private input: InputHandler = null;
  private canvasRenderTimer: any = null;
  private canvasImage: HTMLImageElement = null;
  private canvasImageUrl: string = '';
  private followLightTimer: any = null;
  private resizingCorner: ResizeCorner = null;
  private resizeStartBounds: { left: number, top: number, right: number, bottom: number, width: number, height: number } = null;


  constructor(
    private ngZone: NgZone,
    private tabletopActionService: TabletopActionService,
    private contextMenuService: ContextMenuService,
    private elementRef: ElementRef<HTMLElement>,
    private panelService: PanelService,
    private changeDetector: ChangeDetectorRef,
//    private selectionService: TabletopSelectionService,
    private pointerDeviceService: PointerDeviceService,
    private modalService: ModalService,
    private coordinateService: CoordinateService,
    public gmModeService: GmModeService,
//    private chatMessageService: ChatMessageService

  ) { }

/*
  ngOnInit() {
    EventSystem.register(this)
      .on('UPDATE_GAME_OBJECT', event => {
        let object = ObjectStore.instance.get(event.data.identifier);
        if (!this.gameTableMask || !object) return;
        if (this.gameTableMask === object || (object instanceof ObjectNode && this.gameTableMask.contains(object))) {
          this.changeDetector.markForCheck();
        }
      })
      .on('CHANGE_GM_MODE', event => {
        this.changeDetector.markForCheck();
      })
      .on('SYNCHRONIZE_FILE_LIST', event => {
        this.changeDetector.markForCheck();
      })
      .on('UPDATE_FILE_RESOURE', event => {
        this.changeDetector.markForCheck();
      })
      .on<object>('TABLE_VIEW_ROTATE', -1000, event => {
        this.ngZone.run(() => {
          this.viewRotateZ = event.data['z'];
          this.changeDetector.markForCheck();
        });
      })
      .on(`UPDATE_SELECTION/identifier/${this.gameTableMask?.identifier}`, event => {
        this.changeDetector.markForCheck();
      });
    this.movableOption = {
      tabletopObject: this.gameTableMask,
      transformCssOffset: 'translateZ(0.10px)',
      colideLayers: ['terrain']
    };
    this.panelId = UUID.generateUuid();
  }

  ngOnChanges(): void {
  }

*/
  ngOnChanges(): void {
    EventSystem.unregister(this);
    EventSystem.register(this)
      .on(`UPDATE_GAME_OBJECT/identifier/${this.gameTableMask?.identifier}`, event => {
        this.scheduleCanvasRender();
        this.followAttachedCharacter();
        this.changeDetector.markForCheck();
      })
      .on('UPDATE_GAME_OBJECT', event => {
        if (this.isLightReactiveMask || this.isLightAreaMask) {
          this.followAttachedCharacter();
          this.scheduleCanvasRender();
          this.changeDetector.markForCheck();
        }
      })
      .on(`UPDATE_OBJECT_CHILDREN/identifier/${this.gameTableMask?.identifier}`, event => {
        this.scheduleCanvasRender();
        this.changeDetector.markForCheck();
      })
      .on('GM_MODE_CHANGED', event => {
        this.changeDetector.markForCheck();
      })
      .on('SYNCHRONIZE_FILE_LIST', event => {
        this.scheduleCanvasRender();
        this.changeDetector.markForCheck();
      })
      .on('UPDATE_FILE_RESOURE', event => {
        this.scheduleCanvasRender();
        this.changeDetector.markForCheck();
      })
      .on<object>('TABLE_VIEW_ROTATE', -1000, event => {
        this.ngZone.run(() => {
          this.viewRotateZ = event.data['z'];
          this.changeDetector.markForCheck();
        });
      })
      .on(`UPDATE_SELECTION/identifier/${this.gameTableMask?.identifier}`, event => {
        this.changeDetector.markForCheck();
      });
    this.movableOption = {
      tabletopObject: this.gameTableMask,
      transformCssOffset: 'translateZ(0.10px)',
      colideLayers: ['terrain']
    };
    this.panelId = UUID.generateUuid();
    this.scheduleCanvasRender();
    this.setupLightAreaFollowTimer();
  }

  ngAfterViewInit() {
    this.ngZone.runOutsideAngular(() => {
      this.input = new InputHandler(this.elementRef.nativeElement);
    });
    this.scheduleCanvasRender();
    this.input.onStart = this.onInputStart.bind(this);
    this.input.onMove = this.onInputMove.bind(this);
  }

  ngOnDestroy() {
    this.input.destroy();
    EventSystem.unregister(this);
    clearTimeout(this._scratchingTimerId);
    clearInterval(this.followLightTimer);
    if (this.canvasRenderTimer) cancelAnimationFrame(this.canvasRenderTimer);
  }

  private setupLightAreaFollowTimer() {
    clearInterval(this.followLightTimer);
    if (!this.isLightAreaMask) return;
    this.followLightTimer = setInterval(() => {
      this.followAttachedCharacter();
      this.changeDetector.markForCheck();
    }, 250);
    this.followAttachedCharacter();
  }

  private followAttachedCharacter() {
    if (!this.isLightAreaMask || !this.gameTableMask.attachedCharacterIdentifier) return;
    const character = ObjectStore.instance.get(this.gameTableMask.attachedCharacterIdentifier);
    if (!(character instanceof GameCharacter) || character.location.name !== 'table') return;

    const nextX = Math.round(character.location.x + (character.size * this.gridSize / 2) - (this.width * this.gridSize / 2));
    const nextY = Math.round(character.location.y + (character.size * this.gridSize / 2) - (this.height * this.gridSize / 2));
    if (Math.abs(this.gameTableMask.location.x - nextX) < 1 && Math.abs(this.gameTableMask.location.y - nextY) < 1) return;

    this.gameTableMask.location.x = nextX;
    this.gameTableMask.location.y = nextY;
    this.gameTableMask.update();
  }

  private isOverlappedByLightArea(): boolean {
    if (!this.gameTableMask) return false;
    const masks = ObjectStore.instance.getObjects<GameTableMask>(GameTableMask);
    for (const mask of masks) {
      if (mask === this.gameTableMask || !mask.isLightAreaMask || mask.location.name !== 'table') continue;
      if (this.rectsOverlap(this.maskBounds(this.gameTableMask), this.maskBounds(mask))) return true;
    }
    return false;
  }

  private lightAreaIntersections(): {left: number, top: number, right: number, bottom: number, mask: GameTableMask}[] {
    if (!this.gameTableMask) return [];
    const base = this.maskBounds(this.gameTableMask);
    const intersections: {left: number, top: number, right: number, bottom: number, mask: GameTableMask}[] = [];
    const masks = ObjectStore.instance.getObjects<GameTableMask>(GameTableMask);
    for (const mask of masks) {
      if (mask === this.gameTableMask || !mask.isLightAreaMask || mask.location.name !== 'table') continue;
      const light = this.maskBounds(mask);
      if (!this.rectsOverlap(base, light)) continue;
      intersections.push({
        left: Math.max(base.left, light.left),
        top: Math.max(base.top, light.top),
        right: Math.min(base.right, light.right),
        bottom: Math.min(base.bottom, light.bottom),
        mask: mask
      });
    }
    return intersections;
  }

  private maskBounds(mask: GameTableMask): {left: number, top: number, right: number, bottom: number} {
    return {
      left: mask.location.x,
      top: mask.location.y,
      right: mask.location.x + Math.max(0, mask.width) * this.gridSize,
      bottom: mask.location.y + Math.max(0, mask.height) * this.gridSize
    };
  }

  private rectsOverlap(a: {left: number, top: number, right: number, bottom: number}, b: {left: number, top: number, right: number, bottom: number}): boolean {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  private targetedGameCharacterList(): GameCharacter[] {
    return ObjectStore.instance
      .getObjects<GameCharacter>(GameCharacter)
      .filter(character => character.location.name === 'table' && character.targeted);
  }

  private scheduleCanvasRender() {
    if (this.canvasRenderTimer) return;
    this.canvasRenderTimer = requestAnimationFrame(() => {
      this.canvasRenderTimer = null;
      this.renderMaskCanvas();
    });
  }

  private renderMaskCanvas() {
    if (!this.needsCanvasMask) return;
    const canvas = this.maskCanvas ? this.maskCanvas.nativeElement : null;
    if (!canvas || !this.gameTableMask) return;

    const width = Math.ceil(this.width);
    const height = Math.ceil(this.height);
    const lightweightBlockSize = 2;
    const blockSize = this.isLightweight ? lightweightBlockSize : 1;
    const renderScale = this.isLightweight ? 1 : this.gridSize;
    const pixelWidth = Math.max(1, this.isLightweight ? Math.ceil(width / blockSize) : width * renderScale);
    const pixelHeight = Math.max(1, this.isLightweight ? Math.ceil(height / blockSize) : height * renderScale);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = !this.isLightweight;
    ctx.clearRect(0, 0, pixelWidth, pixelHeight);

    const url = !this.isLightweight && this.imageFile && this.imageFile.url ? this.imageFile.url : '';
    if (url) {
      if (!this.canvasImage || this.canvasImageUrl !== url) {
        this.canvasImageUrl = url;
        this.canvasImage = new Image();
        this.canvasImage.onload = () => this.scheduleCanvasRender();
        this.canvasImage.src = url;
        ctx.fillStyle = this.bgcolor || this.color || '#555555';
        ctx.fillRect(0, 0, pixelWidth, pixelHeight);
      } else if (this.canvasImage.complete && this.canvasImage.naturalWidth > 0) {
        ctx.drawImage(this.canvasImage, 0, 0, pixelWidth, pixelHeight);
      } else {
        ctx.fillStyle = this.bgcolor || this.color || '#555555';
        ctx.fillRect(0, 0, pixelWidth, pixelHeight);
      }
    } else {
      ctx.fillStyle = this.bgcolor || this.color || '#555555';
      ctx.fillRect(0, 0, pixelWidth, pixelHeight);
    }

    if (this.isLightAreaMask) {
      this.clipLightAreaCanvas(ctx, pixelWidth, pixelHeight);
    }

    const scratchedSet: Set<string> = new Set(this.scratchedGrids.split(/,/g));
    const scratchingSet: Set<string> = this._currentScratchingSet ? this._currentScratchingSet : new Set(this.scratchingGrids.split(/,/g));

    for (let x = 0; x < width; x += blockSize) {
      for (let y = 0; y < height; y += blockSize) {
        let isCovered = true;
        for (let dx = 0; dx < blockSize && x + dx < width; dx++) {
          for (let dy = 0; dy < blockSize && y + dy < height; dy++) {
            const gridStr = `${x + dx}:${y + dy}`;
            if (this.isPreviewMode) {
              if (scratchedSet.has(gridStr) && !scratchingSet.has(gridStr)) isCovered = false;
              if (scratchingSet.has(gridStr) && !scratchedSet.has(gridStr)) isCovered = false;
            } else if (scratchedSet.has(gridStr)) {
              isCovered = false;
            }
          }
        }
        if (!isCovered) {
          const drawX = this.isLightweight ? Math.floor(x / blockSize) : x * renderScale;
          const drawY = this.isLightweight ? Math.floor(y / blockSize) : y * renderScale;
          ctx.clearRect(drawX, drawY, renderScale, renderScale);
        }
      }
    }

    this.renderLightAreaReveal(ctx, blockSize);
  }

  private renderLightAreaReveal(ctx: CanvasRenderingContext2D, blockSize: number) {
    if (!this.isLightReactiveMask || this.gmModeService.isGm) return;

    const intersections = this.lightAreaIntersections();
    if (!intersections.length) return;

    const scale = this.isLightweight ? 1 / (this.gridSize * blockSize) : 1;
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
    for (const rect of intersections) this.drawLightAreaShape(ctx, rect.mask, scale);
    ctx.restore();
  }

  private clipLightAreaCanvas(ctx: CanvasRenderingContext2D, pixelWidth: number, pixelHeight: number) {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = '#000';
    const scale = this.isLightweight ? pixelWidth / Math.max(1, this.width * this.gridSize) : 1;
    this.drawLightAreaShape(ctx, this.gameTableMask, scale, true);
    ctx.restore();
  }

  private drawLightAreaShape(ctx: CanvasRenderingContext2D, lightArea: GameTableMask, scale: number, local: boolean = false) {
    const left = local ? 0 : (lightArea.location.x - this.gameTableMask.location.x);
    const top = local ? 0 : (lightArea.location.y - this.gameTableMask.location.y);
    const width = lightArea.width * this.gridSize;
    const height = lightArea.height * this.gridSize;
    const x = left * scale;
    const y = top * scale;
    const w = Math.max(1, width * scale);
    const h = Math.max(1, height * scale);
    const cx = x + w / 2;
    const cy = y + h / 2;
    const radius = Math.max(w, h) / 2;

    ctx.beginPath();
    switch (lightArea.lightShape || 'rect') {
      case 'circle':
        ctx.arc(cx, cy, Math.min(w, h) / 2, 0, Math.PI * 2);
        break;
      case 'cone': {
        const angle = (lightArea.lightAngle || 0) * Math.PI / 180;
        const arc = ((lightArea.lightArc || 90) * Math.PI / 180) / 2;
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, radius, angle - arc, angle + arc);
        ctx.closePath();
        break;
      }
      default:
        ctx.rect(x, y, w, h);
        break;
    }
    ctx.fill();
  }

  @HostListener('dragstart', ['$event'])
  onDragstart(e) {
    e.stopPropagation();
    e.preventDefault();
  }

  onInputStart(e: any) {
    if (!this.isScratching || !this.gameTableMask.isMine) { 
      this.input.cancel();
    } else if (!window.PointerEvent && e.button < 2 && e.buttons < 2) {
      this.scratching(true);
    }
    //Logger.debug(e)
    // TODO:もっと良い方法考える
    if ((this.isLock && !this.isScratching) || (this.isScratching && !this.gameTableMask.isMine)) {
      EventSystem.trigger('DRAG_LOCKED_OBJECT', { srcEvent: e });
    }
  }

  @HostListener('pointerdown', ['$event'])
  onInputStartPointer(e: PointerEvent) {
    if (!this.isScratching || !this.gameTableMask.isMine) { 
      //this.input.cancel();
    } else if (e.button < 2 && e.buttons < 2) {
      if (e.shiftKey) {
        this._isRangeSelect = true;
        this._rangeStartGridX = -1;
        this._rangeStartGridY = -1;
        this.rangeSelectStart({offsetX: e.offsetX, offsetY: e.offsetY});
      } else {
        this.scratching(true, {offsetX: e.offsetX, offsetY: e.offsetY});
      }
    }
  }

  @HostListener('pointerup', ['$event'])
  onPointerUp(e: PointerEvent) {
    if (this._isRangeSelect && this._rangeStartGridX >= 0) {
      this.rangeSelectApply({offsetX: e.offsetX, offsetY: e.offsetY});
    }
    this._isRangeSelect = false;
    this._rangeStartGridX = -1;
    this._rangeStartGridY = -1;
  }

  private resolveGridXY(position: {offsetX: number, offsetY: number}): {gridX: number, gridY: number} | null {
    const tableSelecter = TableSelecter.instance;
    if (!tableSelecter.gridShow) tableSelecter.viewTable.gridClipRect = {
        top: 0, right: 0, bottom: 0, left: 0
    };
    let offsetX: number, offsetY: number;
    if (position) {
      offsetX = position.offsetX;
      offsetY = position.offsetY;
    } else {
      const scratchingPosition = this.coordinateService.calcTabletopLocalCoordinate(this.pointerDeviceService.pointers[0], this.elementRef.nativeElement);
      offsetX = scratchingPosition.x - this.gameTableMask.location.x;
      offsetY = scratchingPosition.y - this.gameTableMask.location.y;
    }
    if (offsetX < 0 || this.gameTableMask.width * this.gridSize <= offsetX || offsetY < 0 || this.gameTableMask.height * this.gridSize <= offsetY) return null;
    return { gridX: Math.floor(offsetX / this.gridSize), gridY: Math.floor(offsetY / this.gridSize) };
  }

  private rangeSelectStart(position: {offsetX: number, offsetY: number}) {
    const g = this.resolveGridXY(position);
    if (!g) return;
    this._rangeStartGridX = g.gridX;
    this._rangeStartGridY = g.gridY;
    if (!this._currentScratchingSet) this._currentScratchingSet = new Set(this.scratchingGrids.split(/,/g));
  }

  private rangeSelectPreview(position: {offsetX: number, offsetY: number}) {
    // preview: no-op for now, just update cursor
  }

  private rangeSelectApply(position: {offsetX: number, offsetY: number}) {
    const g = this.resolveGridXY(position);
    if (!g || this._rangeStartGridX < 0) return;
    if (!this._currentScratchingSet) this._currentScratchingSet = new Set(this.scratchingGrids.split(/,/g));

    const x1 = Math.min(this._rangeStartGridX, g.gridX);
    const y1 = Math.min(this._rangeStartGridY, g.gridY);
    const x2 = Math.max(this._rangeStartGridX, g.gridX);
    const y2 = Math.max(this._rangeStartGridY, g.gridY);

    const blockSize = this.isLightweight ? 2 : 1;
    const snappedX1 = Math.floor(x1 / blockSize) * blockSize;
    const snappedY1 = Math.floor(y1 / blockSize) * blockSize;
    const snappedX2 = (Math.floor(x2 / blockSize) + 1) * blockSize - 1;
    const snappedY2 = (Math.floor(y2 / blockSize) + 1) * blockSize - 1;

    // Check if most cells in range are already scratched → toggle direction
    const allGrids: string[] = [];
    for (let x = snappedX1; x <= snappedX2 && x < Math.ceil(this.width); x++) {
      for (let y = snappedY1; y <= snappedY2 && y < Math.ceil(this.height); y++) {
        allGrids.push(`${x}:${y}`);
      }
    }
    const alreadyCount = allGrids.filter(g => this._currentScratchingSet.has(g)).length;
    const shouldRemove = alreadyCount > allGrids.length / 2;

    for (const grid of allGrids) {
      if (shouldRemove) {
        this._currentScratchingSet.delete(grid);
      } else {
        this._currentScratchingSet.add(grid);
      }
    }

    this.scheduleCanvasRender();
    clearTimeout(this._scratchingTimerId);
    this._scratchingTimerId = setTimeout(() => {
      this.scratchingGrids = Array.from(this._currentScratchingSet).filter(grid => grid && /^\d+:\d+$/.test(grid)).sort().join(',');
      this._currentScratchingSet = null;
      this.scheduleCanvasRender();
    }, 250);
  }

  private _scratchingGridX = -1;
  private _scratchingGridY = -1;
  private _rangeStartGridX = -1;
  private _rangeStartGridY = -1;
  private _isRangeSelect = false;

  onInputMove(e: any) {
    if (!window.PointerEvent && this.isScratching && this.gameTableMask.isMine && this.input.isDragging) {
      this.scratching(false);
    }
  }

  @HostListener('pointermove', ['$event'])
  onInputMovePointer(e: PointerEvent) {
    if (this.isScratching && this.gameTableMask.isMine && this.input.isDragging && e.buttons < 2) {
      if (e.shiftKey && this._rangeStartGridX >= 0) {
        this.rangeSelectPreview({offsetX: e.offsetX, offsetY: e.offsetY});
      } else {
        this.scratching(false, {offsetX: e.offsetX, offsetY: e.offsetY});
      }
    }
    e.stopPropagation();
    e.preventDefault();
  }

  private _currentScratchingSet!: Set<string>;
  private _scratchingTimerId;
  scratching(isStart: boolean, position: {offsetX: number, offsetY: number} = null) {
    if (!this.gameTableMask.isMine) return;
    // とりあえず、本当は周辺を表示したい。
    const tableSelecter = TableSelecter.instance;
    
    if (!tableSelecter.gridShow) tableSelecter.viewTable.gridClipRect = {
        top: 0,
        right: 0,
        bottom: 0,
        left: 0
      };
    //viewTable.gridHeight = this.gameTableMask.posZ + this.gameTableMask.altitude * this.gridSize + 0.5;
    let offsetX
    let offsetY;
    if (position) {
      offsetX = position.offsetX;
      offsetY = position.offsetY;
    } else {
      const scratchingPosition = this.coordinateService.calcTabletopLocalCoordinate(this.pointerDeviceService.pointers[0], this.elementRef.nativeElement);
      offsetX = scratchingPosition.x - this.gameTableMask.location.x;
      offsetY = scratchingPosition.y - this.gameTableMask.location.y;
    }
    if (offsetX < 0 || this.gameTableMask.width * this.gridSize <= offsetX || offsetY < 0 || this.gameTableMask.height * this.gridSize <= offsetY) return;
    const gridX = Math.floor(offsetX / this.gridSize);
    const gridY = Math.floor(offsetY / this.gridSize);

    if (!isStart && this._scratchingGridX === gridX && this._scratchingGridY === gridY) return;
    this._scratchingGridX = gridX;
    this._scratchingGridY = gridY;
    if (!this._currentScratchingSet) this._currentScratchingSet = new Set(this.scratchingGrids.split(/,/g));

    if (this.isLightweight) {
      const baseX = Math.floor(gridX / 2) * 2;
      const baseY = Math.floor(gridY / 2) * 2;
      const blockGrids: string[] = [];
      for (let dx = 0; dx < 2 && baseX + dx < Math.ceil(this.width); dx++) {
        for (let dy = 0; dy < 2 && baseY + dy < Math.ceil(this.height); dy++) {
          blockGrids.push(`${baseX + dx}:${baseY + dy}`);
        }
      }
      const shouldRestore = blockGrids.some(grid => this._currentScratchingSet.has(grid));
      for (let grid of blockGrids) {
        if (shouldRestore) {
          this._currentScratchingSet.delete(grid);
        } else {
          this._currentScratchingSet.add(grid);
        }
      }
    } else {
      const tempScratching = `${gridX}:${gridY}`;
      if (this._currentScratchingSet.has(tempScratching)) {
        this._currentScratchingSet.delete(tempScratching);
      } else {
        this._currentScratchingSet.add(tempScratching);
      }
    }
    this.scheduleCanvasRender();
    clearTimeout(this._scratchingTimerId);
    this._scratchingTimerId = setTimeout(() => {
      this.scratchingGrids = Array.from(this._currentScratchingSet).filter(grid => grid && /^\d+:\d+$/.test(grid)).sort().join(',');
      this._currentScratchingSet = null;
      this.scheduleCanvasRender();
    }, 250);
  }

  scratched() {
    const currentScratchedAry: string[] = this.scratchedGrids.split(/,/g);
    if (this._currentScratchingSet) {
      clearTimeout(this._scratchingTimerId);
      this.scratchingGrids = Array.from(this._currentScratchingSet).filter(grid => grid && /^\d+:\d+$/.test(grid)).sort().join(',');
      this._currentScratchingSet = null;
    }
    const currentScratchingAry: string[] = this.scratchingGrids.split(/,/g);
    this.scratchedGrids = xor(currentScratchedAry, currentScratchingAry).filter(grid => grid && /^\d+:\d+$/.test(grid)).sort().join(',');
    this.scheduleCanvasRender();
  }

  @HostListener('contextmenu', ['$event'])
  onContextMenu(e: Event) {

    e.stopPropagation();
    e.preventDefault();

    if (!this.pointerDeviceService.isAllowedToOpenContextMenu) return;
    let menuPosition = this.pointerDeviceService.pointers[0];
    let objectPosition = this.coordinateService.calcTabletopLocalCoordinate();
    let menuArray = [];
    menuArray.push(
      {
        name: '高度設定', action: null, subActions: [
          {
            name: '高度を0にする', action: () => {
              if (this.altitude != 0) {
                this.altitude = 0;
                SoundEffect.play(PresetSound.sweep);
              }
            },
            altitudeHande: this.gameTableMask
          },
          (this.isAltitudeIndicate
            ? {
              name: '☑ 高度の表示', action: () => {
                this.isAltitudeIndicate = false;
                SoundEffect.play(PresetSound.sweep);
                EventSystem.trigger('UPDATE_INVENTORY', null);
              }
            } : {
              name: '☐ 高度の表示', action: () => {
                this.isAltitudeIndicate = true;
                SoundEffect.play(PresetSound.sweep);
                EventSystem.trigger('UPDATE_INVENTORY', null);
              }
            })
        ]
      },
      ContextMenuSeparator,
      this.isLock
        ? {
          name: '固定解除', action: () => {
            this.isLock = false;
            this.dispLockMark = true;
            SoundEffect.play(PresetSound.unlock);
          }
        }
        : {
          name: '固定する', action: () => {
            this.isLock = true;
            SoundEffect.play(PresetSound.lock);
          }
        }
      )
      if (this.isLock){
        menuArray.push(
        this.dispLockMark
          ? {
            name: '固定マーク消去', action: () => {
              this.dispLockMark = false;
              SoundEffect.play(PresetSound.lock);
            }
          }
          : {
            name: '固定マーク表示', action: () => {
              this.dispLockMark = true;
              SoundEffect.play(PresetSound.lock);
            }
          }
        );
      }
      menuArray.push(ContextMenuSeparator);
      menuArray.push({
        name: '照明マスク設定', action: null, subActions: [
          {
            name: (this.gameTableMask.maskType === 'normal' ? '☑ ' : '☐ ') + '通常マスク', action: () => {
              this.gameTableMask.maskType = 'normal';
              this.gameTableMask.attachedCharacterIdentifier = '';
              this.gameTableMask.update();
              this.setupLightAreaFollowTimer();
              this.changeDetector.markForCheck();
              SoundEffect.play(PresetSound.sweep);
            }
          },
          {
            name: (this.isLightReactiveMask ? '☑ ' : '☐ ') + '照明反応マスク', action: () => {
              this.gameTableMask.maskType = 'lightReactive';
              this.gameTableMask.attachedCharacterIdentifier = '';
              this.gameTableMask.update();
              this.setupLightAreaFollowTimer();
              this.changeDetector.markForCheck();
              SoundEffect.play(PresetSound.sweep);
            }
          },
          {
            name: (this.isLightAreaMask ? '☑ ' : '☐ ') + '照明エリア', action: () => {
              this.gameTableMask.maskType = 'lightArea';
              this.gameTableMask.update();
              this.setupLightAreaFollowTimer();
              this.changeDetector.markForCheck();
              SoundEffect.play(PresetSound.sweep);
            }
          },
          ContextMenuSeparator,
          {
            name: 'Alt対象コマに追従', action: () => {
              const character = this.targetedGameCharacterList()[0];
              if (!character) return;
              this.gameTableMask.maskType = 'lightArea';
              this.gameTableMask.attachedCharacterIdentifier = character.identifier;
              this.followAttachedCharacter();
              this.gameTableMask.update();
              this.setupLightAreaFollowTimer();
              this.changeDetector.markForCheck();
              SoundEffect.play(PresetSound.sweep);
            }
          },
          {
            name: '追従解除', action: () => {
              this.gameTableMask.attachedCharacterIdentifier = '';
              this.gameTableMask.update();
              SoundEffect.play(PresetSound.sweep);
            }
          },
          ContextMenuSeparator,
          {
            name: '照明エリア形状', action: null, subActions: [
              {
                name: (this.gameTableMask.lightShape === 'rect' ? '☑ ' : '☐ ') + '矩形', action: () => {
                  this.gameTableMask.lightShape = 'rect';
                  this.gameTableMask.update();
                  this.scheduleCanvasRender();
                  SoundEffect.play(PresetSound.sweep);
                }
              },
              {
                name: (this.gameTableMask.lightShape === 'circle' ? '☑ ' : '☐ ') + '円形', action: () => {
                  this.gameTableMask.lightShape = 'circle';
                  this.gameTableMask.update();
                  this.scheduleCanvasRender();
                  SoundEffect.play(PresetSound.sweep);
                }
              },
              {
                name: (this.gameTableMask.lightShape === 'cone' ? '☑ ' : '☐ ') + 'コーン', action: () => {
                  this.gameTableMask.lightShape = 'cone';
                  this.gameTableMask.update();
                  this.scheduleCanvasRender();
                  SoundEffect.play(PresetSound.sweep);
                }
              }
            ]
          },
          {
            name: 'コーン方向', action: null, subActions: [
              {
                name: (this.gameTableMask.lightAngle === 0 ? '☑ ' : '☐ ') + '右', action: () => {
                  this.gameTableMask.lightShape = 'cone';
                  this.gameTableMask.lightAngle = 0;
                  this.gameTableMask.update();
                  this.scheduleCanvasRender();
                  SoundEffect.play(PresetSound.sweep);
                }
              },
              {
                name: (this.gameTableMask.lightAngle === 90 ? '☑ ' : '☐ ') + '下', action: () => {
                  this.gameTableMask.lightShape = 'cone';
                  this.gameTableMask.lightAngle = 90;
                  this.gameTableMask.update();
                  this.scheduleCanvasRender();
                  SoundEffect.play(PresetSound.sweep);
                }
              },
              {
                name: (this.gameTableMask.lightAngle === 180 ? '☑ ' : '☐ ') + '左', action: () => {
                  this.gameTableMask.lightShape = 'cone';
                  this.gameTableMask.lightAngle = 180;
                  this.gameTableMask.update();
                  this.scheduleCanvasRender();
                  SoundEffect.play(PresetSound.sweep);
                }
              },
              {
                name: (this.gameTableMask.lightAngle === 270 ? '☑ ' : '☐ ') + '上', action: () => {
                  this.gameTableMask.lightShape = 'cone';
                  this.gameTableMask.lightAngle = 270;
                  this.gameTableMask.update();
                  this.scheduleCanvasRender();
                  SoundEffect.play(PresetSound.sweep);
                }
              }
            ]
          }
        ]
      });
      menuArray.push(ContextMenuSeparator);
      menuArray.push(this.isLightweight
        ? {
          name: '☑ 軽量マスク（黒・低解像度）', action: () => {
            this.isLightweight = false;
            this.gameTableMask.update();
            this.scheduleCanvasRender();
            SoundEffect.play(PresetSound.sweep);
          }
        }
        : {
          name: '☐ 軽量マスク（黒・低解像度）', action: () => {
            this.isLightweight = true;
            this.gameTableMask.update();
            this.scheduleCanvasRender();
            SoundEffect.play(PresetSound.sweep);
          }
        });
      // Visibility submenu
      const visItems: ContextMenuAction[] = [
        {
          name: (this.visibility === 'public' ? '☑ ' : '☐ ') + '全員に見える',
          action: () => { this.visibility = 'public'; this.gameTableMask.update(); SoundEffect.play(PresetSound.sweep); }
        },
        {
          name: (this.isGmOnly ? '☑ ' : '☐ ') + 'GMだけ半透明で見える',
          action: () => { this.visibility = 'gmOnly'; this.gameTableMask.update(); SoundEffect.play(PresetSound.sweep); }
        },
        {
          name: (this.isPlOnly ? '☑ ' : '☐ ') + 'PLだけ半透明で見える',
          action: () => { this.visibility = 'plOnly'; this.gameTableMask.update(); SoundEffect.play(PresetSound.sweep); }
        },
      ];
      menuArray.push({ name: '表示設定', subMenu: visItems });
      menuArray.push(ContextMenuSeparator);
      if (!this.gameTableMask.isMine) {
        menuArray.push({
          name: 'スクラッチ開始', action: () => {
            if (this.gameTableMask.owner != '') {
              this.isPreview = false;
              clearTimeout(this._scratchingTimerId);
              this._currentScratchingSet = null;
            }
//            this.isPreview = true;
            SoundEffect.play(PresetSound.cardDraw);
            this.gameTableMask.owner = Network.peerContext.userId;
            this._scratchingGridX = -1;
            this._scratchingGridY = -1;
            SoundEffect.play(PresetSound.lock);
          }
        });
      }else{
        menuArray.push({
          name: 'スクラッチ確定', action: () => {
            this.scratchDone();
            this.isPreview = false;
            this.gameTableMask.owner = '';
          }
        });
      }
      if (this.gameTableMask.isMine){
        menuArray.push(
            {
            name: 'スクラッチキャンセル', action: () => {
//              this.isScratch = false;
              SoundEffect.play(PresetSound.cardDraw);
              this.gameTableMask.owner = '';
            }
          }
        );
      }
      
      menuArray.push( ContextMenuSeparator);
      menuArray.push( 
        { name: 'マスクを編集', action: () => { this.showDetail(this.gameTableMask); } }
      );
      menuArray.push( 
        {name: 'コピーを作る', action: () => {
          let cloneObject = this.gameTableMask.clone();
          Logger.debug('コピー', cloneObject);
          cloneObject.location.x += this.gridSize;
          cloneObject.location.y += this.gridSize;
          cloneObject.isLock = false;
          if (this.gameTableMask.parent) this.gameTableMask.parent.appendChild(cloneObject);
          SoundEffect.play(PresetSound.cardPut);
        }
      }
      );
      menuArray.push( 
      {
        name: '削除する', action: () => {
          this.gameTableMask.destroy();
          SoundEffect.play(PresetSound.sweep);
        }
      }
      );
      menuArray.push( ContextMenuSeparator);
      menuArray.push( 
        { name: 'オブジェクト作成', action: null, subActions: this.tabletopActionService.makeDefaultContextMenuActions(objectPosition) }
      );
    this.contextMenuService.open(menuPosition, menuArray, this.name);
  }

  onMove() {
    SoundEffect.play(PresetSound.cardPick);
  }

  onMoved() {
    SoundEffect.play(PresetSound.cardPut);
  }

  onResizeHandlePointerDown(e: PointerEvent, corner: ResizeCorner) {
    if (!this.canResizeMask || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    this.resizingCorner = corner;
    this.resizeStartBounds = {
      left: this.gameTableMask.location.x,
      top: this.gameTableMask.location.y,
      right: this.gameTableMask.location.x + this.width * this.gridSize,
      bottom: this.gameTableMask.location.y + this.height * this.gridSize,
      width: this.width,
      height: this.height
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    SoundEffect.play(PresetSound.cardPick);
  }

  onResizeHandlePointerMove(e: PointerEvent) {
    if (!this.resizingCorner || !this.resizeStartBounds) return;
    e.preventDefault();
    e.stopPropagation();

    const pointer = this.coordinateService.calcTabletopLocalCoordinate({ x: e.clientX, y: e.clientY, z: 0 }, this.coordinateService.tabletopOriginElement);
    const bounds = this.resizeStartBounds;
    let nextLeft = bounds.left;
    let nextTop = bounds.top;
    let nextWidth = bounds.width;
    let nextHeight = bounds.height;

    if (this.resizingCorner.indexOf('e') >= 0) {
      nextWidth = this.snapMaskSize((pointer.x - bounds.left) / this.gridSize);
    }
    if (this.resizingCorner.indexOf('s') >= 0) {
      nextHeight = this.snapMaskSize((pointer.y - bounds.top) / this.gridSize);
    }
    if (this.resizingCorner.indexOf('w') >= 0) {
      nextWidth = this.snapMaskSize((bounds.right - pointer.x) / this.gridSize);
      nextLeft = bounds.right - nextWidth * this.gridSize;
    }
    if (this.resizingCorner.indexOf('n') >= 0) {
      nextHeight = this.snapMaskSize((bounds.bottom - pointer.y) / this.gridSize);
      nextTop = bounds.bottom - nextHeight * this.gridSize;
    }

    if (this.gameTableMask.location.x === nextLeft && this.gameTableMask.location.y === nextTop && this.gameTableMask.width === nextWidth && this.gameTableMask.height === nextHeight) return;
    this.gameTableMask.location.x = nextLeft;
    this.gameTableMask.location.y = nextTop;
    this.gameTableMask.width = nextWidth;
    this.gameTableMask.height = nextHeight;
    this.scheduleCanvasRender();
    this.changeDetector.markForCheck();
  }

  onResizeHandlePointerUp(e: PointerEvent) {
    if (!this.resizingCorner) return;
    e.preventDefault();
    e.stopPropagation();
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch (ex) { /* noop */ }
    this.gameTableMask.update();
    this.resizingCorner = null;
    this.resizeStartBounds = null;
    SoundEffect.play(PresetSound.cardPut);
  }

  private snapMaskSize(value: number): number {
    return Math.max(1, Math.round(value));
  }


  scratchDone(e: Event=null) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (!this.gameTableMask.isMine) return false;
    this.ngZone.run(() => {
      this.scratched();
      this.gameTableMask.owner = '';
      this.scratchingGrids = '';
      this.isPreview = false;
    });
    this._scratchingGridX = -1;
    this._scratchingGridY = -1;
    SoundEffect.play(PresetSound.cardPut);
//    this.chatMessageService.sendOperationLog(`${ this.gameTableMask.name == '' ? '(無名のマップマスク)' : this.gameTableMask.name } のスクラッチを終了した`);
    return false;
  }

  scratchCancel(e: Event=null) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (!this.gameTableMask.isMine && this.ownerIsOnline) return false;
    this.ngZone.run(() => {
      this.gameTableMask.owner = '';
      this.scratchingGrids = '';
      this.isPreview = false;
    });
    this._scratchingGridX = -1;
    this._scratchingGridY = -1;
    SoundEffect.play(PresetSound.unlock);
//    this.chatMessageService.sendOperationLog(`${ this.gameTableMask.name == '' ? '(無名のマップマスク)' : this.gameTableMask.name } のスクラッチを終了した`);
    return false;
  }

  prevent(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  private adjustMinBounds(value: number, min: number = 0): number {
    return value < min ? min : value;
  }

  private showDetail(gameObject: GameTableMask) {
    let coordinate = this.pointerDeviceService.pointers[0];
    let title = 'マップマスク設定';
    if (gameObject.name.length) title += ' - ' + gameObject.name;
    let option: PanelOption = { title: title, left: coordinate.x - 200, top: coordinate.y - 150, width: 400, height: 300 };
    let component = this.panelService.open<GameCharacterSheetComponent>(GameCharacterSheetComponent, option);
    component.tabletopObject = gameObject;
  }
}
