import { AfterViewInit, Directive, ElementRef, EventEmitter, Input, NgZone, OnDestroy, Output } from '@angular/core';
import { EventSystem } from '@udonarium/core/system';
import { TableSelecter } from '@udonarium/table-selecter';
import { TabletopObject } from '@udonarium/tabletop-object';
import { BatchService } from 'service/batch.service';
import { CoordinateService } from 'service/coordinate.service';
import { PointerCoordinate, PointerDeviceService } from 'service/pointer-device.service';
import { TabletopUndoService } from 'service/tabletop-undo.service';
import { TabletopSelectionService } from 'service/tabletop-selection.service';
import { TabletopService } from 'service/tabletop.service';

import { InputHandler } from './input-handler';

export interface MovableOption {
  readonly tabletopObject?: TabletopObject;
  readonly layerName?: string;
  readonly colideLayers?: string[];
  readonly transformCssOffset?: string;
}

interface GroupMoveTarget {
  object: TabletopObject;
  startX: number;
  startY: number;
  startZ: number;
}

@Directive({
  selector: '[appMovable]'
})
export class MovableDirective implements AfterViewInit, OnDestroy {
  private static layerHash: { [layerName: string]: MovableDirective[] } = {};

  private tabletopObject: TabletopObject;
  private layerName: string = '';
  private colideLayers: string[] = [];
  private transformCssOffset: string = '';

  @Input('movable.option') set option(option: MovableOption) {
    this.tabletopObject = option.tabletopObject != null ? option.tabletopObject : this.tabletopObject;
    this.layerName = option.layerName != null ? option.layerName : this.layerName;
    this.colideLayers = option.colideLayers != null ? option.colideLayers : this.colideLayers;
    this.transformCssOffset = option.transformCssOffset != null ? option.transformCssOffset : this.transformCssOffset;
  }
  @Input('movable.disable') isDisable: boolean = false;
  @Input('movable.scratch_owner') isScratcOwner: boolean = false;

  @Output('movable.onstart') onstart: EventEmitter<PointerEvent> = new EventEmitter();
  @Output('movable.ondragstart') ondragstart: EventEmitter<PointerEvent> = new EventEmitter();
  @Output('movable.ondrag') ondrag: EventEmitter<PointerEvent> = new EventEmitter();
  @Output('movable.ondragend') ondragend: EventEmitter<PointerEvent> = new EventEmitter();
  @Output('movable.onend') onend: EventEmitter<PointerEvent> = new EventEmitter();

  private get nativeElement(): HTMLElement { return this.elementRef.nativeElement; }

  private _posX: number = 0;
  private _posY: number = 0;
  private _posZ: number = 0;
/*
  get posX(): number { return this._posX; }
  set posX(posX: number) { this._posX = posX; this.setUpdateTimer(); }
  get posY(): number { return this._posY; }
  set posY(posY: number) { this._posY = posY; this.setUpdateTimer(); }
  get posZ(): number { return this._posZ; }
  set posZ(posZ: number) { this._posZ = posZ; this.setUpdateTimer(); }
*/

  private mathFloor: boolean = true;
/*
  get posX(): number { return this._posX; }
  set posX(posX: number) { this._posX = Math.floor(posX); this.setUpdateTimer(); }
  get posY(): number { return this._posY; }
  set posY(posY: number) { this._posY = Math.floor(posY); this.setUpdateTimer(); }
  get posZ(): number { return this._posZ; }
  set posZ(posZ: number) { this._posZ = Math.floor(posZ); this.setUpdateTimer(); }
*/

  get posX(): number { return this._posX; }
  set posX(posX: number) { this._posX = this.mathFloor? Math.floor(posX):posX; this.setUpdateTimer(); }
  get posY(): number { return this._posY; }
  set posY(posY: number) { this._posY = this.mathFloor? Math.floor(posY):posY; this.setUpdateTimer(); }
  get posZ(): number { return this._posZ; }
  set posZ(posZ: number) { this._posZ = this.mathFloor? Math.floor(posZ*8)/8:posZ; this.setUpdateTimer(); }


  private pointerOffset2d: PointerCoordinate = { x: 0, y: 0, z: 0 };
  private pointerStart3d: PointerCoordinate = { x: 0, y: 0, z: 0 };

  private targetStartRect: DOMRect;
  private groupMoveTargets: GroupMoveTarget[] = [];
  private isGroupMove: boolean = false;

  private height: number = 0;
  private width: number = 0;
  private ratio: number = 1.0;

  private updateTimer: NodeJS.Timer = null;
  private collidableElements: HTMLElement[] = [];
  private input: InputHandler = null;

  private get isGridSnap(): boolean { return TableSelecter.instance.gridSnap; }

  constructor(
    private ngZone: NgZone,
    private elementRef: ElementRef,
    private batchService: BatchService,
    private pointerDeviceService: PointerDeviceService,
    private coordinateService: CoordinateService,
    private tabletopUndoService: TabletopUndoService,
    private tabletopSelectionService: TabletopSelectionService,
    private tabletopService: TabletopService,
  ) { }

  ngAfterViewInit() {
    this.batchService.add(() => this.initialize(), this.elementRef);
    this.setPosition(this.tabletopObject);
  }

  ngOnDestroy() {
    this.cancel();
    this.input.destroy();
    this.unregister();
    EventSystem.unregister(this);
    this.batchService.remove(this);
    this.batchService.remove(this.elementRef);
  }

  initialize() {
    this.input = new InputHandler(this.nativeElement);
    this.input.onStart = this.onInputStart.bind(this);
    this.input.onMove = this.onInputMove.bind(this);
    this.input.onEnd = this.onInputEnd.bind(this);
    this.input.onContextMenu = this.onContextMenu.bind(this);

    EventSystem.register(this)
      .on('UPDATE_GAME_OBJECT', event => {
        if ((event.isSendFromSelf && this.input.isGrabbing) || event.data.identifier !== this.tabletopObject.identifier || !this.shouldTransition(this.tabletopObject)) return;
        this.batchService.add(() => {
          if (this.input.isGrabbing) {
            this.cancel();
          } else {
            this.setAnimatedTransition(true);
          }
          this.stopTransition();
          this.setPosition(this.tabletopObject);
        }, this);
      });
    if (this.layerName.length < 1 && this.tabletopObject) this.layerName = this.tabletopObject.aliasName;
    this.register();
    this.findCollidableElements();
    this.setPosition(this.tabletopObject);
  }

  cancel() {
    this.input.cancel();
    this.setPointerEvents(true);
    this.setAnimatedTransition(true);
    this.setCollidableLayer(false);
  }

  scratchObjectPosition(start: boolean){

    let pointerScratch2d = {
      x: this.input.pointer.x,
      y: this.input.pointer.y,
      z: 0,
    };
    pointerScratch2d.x = Math.min(window.innerWidth - 0.1, Math.max(pointerScratch2d.x, 0.1));
    pointerScratch2d.y = Math.min(window.innerHeight - 0.1, Math.max(pointerScratch2d.y, 0.1));

    let elementScratch = document.elementFromPoint(pointerScratch2d.x, pointerScratch2d.y) as HTMLElement;
    if (elementScratch == null) return;

    let pointerSchratch3d = this.coordinateService.calcTabletopLocalCoordinate(pointerScratch2d, elementScratch);

    pointerSchratch3d.x -= this.posX;
    pointerSchratch3d.y -= this.posY;

    EventSystem.trigger('SCRATCH_POINTER_XYZ', { x: pointerSchratch3d.x, y: pointerSchratch3d.y, z: pointerSchratch3d.z, identifier: this.tabletopObject.identifier, start: start});
  }

  onInputStart(e: MouseEvent | TouchEvent) {
    this.callSelectedEvent();
    if (this.collidableElements.length < 1) this.findCollidableElements(); // 稀にcollidableElementsの取得に失敗している

    if ((this.isDisable && !this.isScratcOwner )|| (e as MouseEvent).button === 1 || (e as MouseEvent).button === 2) return this.cancel();
    this.prepareGroupMove();
    this.tabletopUndoService.beginMoveGroup(this.getUndoMoveObjects());
    this.onstart.emit(e as PointerEvent);

    this.setPointerEvents(false);
    this.setAnimatedTransition(false);
    this.setCollidableLayer(true);

    this.width = this.nativeElement.clientWidth;
    this.height = this.nativeElement.clientHeight;

    let target3d = {
      x: this.posX + (this.width / 2),
      y: this.posY + (this.height / 2),
      z: this.posZ,
    };
    let target2d = this.coordinateService.convertToGlobal(target3d, this.coordinateService.tabletopOriginElement);

    this.setPointerEvents(true);

    this.pointerOffset2d.x = target2d.x - this.input.pointer.x;
    this.pointerOffset2d.y = target2d.y - this.input.pointer.y;
    this.pointerOffset2d.z = target2d.z - this.input.pointer.z;

    this.pointerStart3d.x = target3d.x;
    this.pointerStart3d.y = target3d.y;
    this.pointerStart3d.z = target3d.z;

    this.targetStartRect = this.nativeElement.getBoundingClientRect();
    
    if(this.isScratcOwner){
      this.scratchObjectPosition(true);
    }

    this.ratio = 1.0;
  }

  onInputMove(e: MouseEvent | TouchEvent) {
    if (this.input.isGrabbing && !this.pointerDeviceService.isDragging) {
      return this.cancel(); // todo
    }

    if ((this.isDisable && !this.isScratcOwner) || !this.input.isGrabbing) return this.cancel();
    
    if (e.cancelable) e.preventDefault();

    if (!this.input.isDragging) this.setPointerEvents(false);

    let pointer2d = {
      x: this.input.pointer.x + (this.pointerOffset2d.x * this.ratio),
      y: this.input.pointer.y + (this.pointerOffset2d.y * this.ratio),
      z: 0,
    };

    pointer2d.x = Math.min(window.innerWidth - 0.1, Math.max(pointer2d.x, 0.1));
    pointer2d.y = Math.min(window.innerHeight - 0.1, Math.max(pointer2d.y, 0.1));

    let element = document.elementFromPoint(pointer2d.x, pointer2d.y) as HTMLElement;
    if (element == null) return;

    let pointer3d = this.coordinateService.calcTabletopLocalCoordinate(pointer2d, element);
    pointer3d.x -= this.width / 2;
    pointer3d.y -= this.height / 2;

    // Z座標: 3DパースペクティブZを使う。
    // 地形の上では自然にZが上がる。地面に戻した時はZが0に戻る。
    // pointerStart3d.zより下には落とさない制限は地形上のみ適用し、
    // pointer3d.zが0の場合（地面）はそちらを優先する。
    let newZ: number;
    if (pointer3d.z > 0) {
      // 3D Z > 0: 地形上または空中 → 開始Zより下には落とさない
      newZ = pointer3d.z > this.pointerStart3d.z ? pointer3d.z : this.pointerStart3d.z;
    } else {
      // 3D Z = 0: 地面に戻った
      newZ = 0;
    }
    if (this.posX === pointer3d.x && this.posY === pointer3d.y && this.posZ === newZ) return;

    if (!this.input.isDragging) this.ondragstart.emit(e as PointerEvent);
    this.ondrag.emit(e as PointerEvent);

    let targetRect = this.nativeElement.getBoundingClientRect();
    let ratio = targetRect.width / this.targetStartRect.width;
    if (ratio < this.ratio) {
      this.ratio += (ratio - this.ratio) * 0.1;
    }

    if(!this.isScratcOwner){
      this.posX = pointer3d.x;
      this.posY = pointer3d.y;
      this.posZ = newZ;
      this.updateGroupMoveTargets();
    }else{
      this.scratchObjectPosition(false);
    }
  }

  onInputEnd(e: MouseEvent | TouchEvent) {
    if (this.isDisable) return this.cancel();
    if (this.input.isDragging) this.ondragend.emit(e as PointerEvent);
    if (this.isGridSnap && this.input.isDragging && !this.isScratcOwner) this.snapToGrid();
    if (this.input.isDragging && !this.isScratcOwner) {
      if (this.updateTimer !== null) {
        clearTimeout(this.updateTimer);
        this.updateTimer = null;
      }
      this.tabletopObject.location.x = this.posX;
      this.tabletopObject.location.y = this.posY;
      this.tabletopObject.posZ = this.posZ;
      this.updateGroupMoveTargets();
      this.tabletopUndoService.endMoveGroup(this.getUndoMoveObjects());
    }
    this.groupMoveTargets = [];
    this.isGroupMove = false;
    this.cancel();
    this.onend.emit(e as PointerEvent);
  }

  onContextMenu(e: MouseEvent | TouchEvent) {
    if (this.isDisable) return this.cancel();
    if (e.cancelable) e.preventDefault();

    if (this.isGridSnap && this.input.isDragging) this.snapToGrid();

    let needsDispatch = this.input.isGrabbing && e.isTrusted;
    this.cancel();

    if (needsDispatch) {
      // ロングプレスによるタッチ操作でコンテキストメニューを開く場合、イベントを適切なDOMに伝搬させる
      e.stopPropagation();
      let ev = new MouseEvent(e.type, e);
      this.ngZone.run(() => this.nativeElement.dispatchEvent(ev));
    }
  }

  private prepareGroupMove() {
    this.groupMoveTargets = [];
    this.isGroupMove = false;
    if (!this.tabletopObject || this.isScratcOwner) return;

    const selectedObjects = this.tabletopSelectionService.getSelectedTabletopObjects(this.tabletopObject);
    if (selectedObjects.length < 1) return;

    this.groupMoveTargets = selectedObjects.map(object => ({
      object,
      startX: object.location.x,
      startY: object.location.y,
      startZ: object.posZ
    }));
    this.isGroupMove = true;
  }

  private getUndoMoveObjects(): TabletopObject[] {
    if (!this.tabletopObject) return [];
    return this.isGroupMove
      ? [this.tabletopObject].concat(this.groupMoveTargets.map(target => target.object))
      : [this.tabletopObject];
  }

  /**
   * 指定したXY座標の下にある地形の最上面Z座標を計算する。
   * 地形がない場合は元のZ座標を返す。
   * @param posX オブジェクトのX位置
   * @param posY オブジェクトのY位置
   * @param originalZ 元のZ位置（地形がない場合のフォールバック）
   */
  private getTerrainTopZ(posX: number, posY: number, originalZ: number): number {
    try {
      const terrains = this.tabletopService.terrains;
      if (!terrains || terrains.length === 0) return originalZ;

      // 自分自身（Terrain）を除外する
      const selfId = this.tabletopObject ? this.tabletopObject.identifier : null;

      const gridSize = this.tabletopService.currentTable.gridSize || 50;
      let maxTopZ = -Infinity;
      let foundTerrain = false;

      for (const terrain of terrains) {
        // 自分自身は判定から除外
        if (selfId && terrain.identifier === selfId) continue;

        const tX = terrain.location.x;
        const tY = terrain.location.y;
        const tW = terrain.width;
        const tH = terrain.depth;
        const tHeight = terrain.height;
        const tAltitude = terrain.altitude || 0;

        const halfW = (tW * gridSize) / 2;
        const halfH = (tH * gridSize) / 2;
        if (posX >= tX - halfW && posX <= tX + halfW &&
            posY >= tY - halfH && posY <= tY + halfH) {
          // 地形の最上面Z = altitude * gridSize + height * gridSize
          const terrainTopZ = (terrain.posZ || 0) + (tAltitude + tHeight) * gridSize;
          if (terrainTopZ > maxTopZ) {
            maxTopZ = terrainTopZ;
            foundTerrain = true;
          }
        }
      }

      return foundTerrain ? maxTopZ : originalZ;
    } catch (e) {
      return originalZ;
    }
  }

  private updateGroupMoveTargets() {
    if (!this.isGroupMove || this.groupMoveTargets.length < 1) return;
    const dx = this.posX - this.pointerStart3d.x + (this.width / 2);
    const dy = this.posY - this.pointerStart3d.y + (this.height / 2);
    const dz = this.posZ - this.pointerStart3d.z;
    for (const target of this.groupMoveTargets) {
      target.object.location.x = target.startX + dx;
      target.object.location.y = target.startY + dy;
      target.object.posZ = target.startZ + dz;
    }
  }

  private callSelectedEvent() {
    if (this.tabletopObject)
      EventSystem.trigger('SELECT_TABLETOP_OBJECT', { identifier: this.tabletopObject.identifier, className: this.tabletopObject.aliasName });
  }

  snapToGrid(gridSize: number = 25) {
    this.posX = this.calcSnapNum(this.posX, gridSize);
    this.posY = this.calcSnapNum(this.posY, gridSize);
  }

  private calcSnapNum(num: number, interval: number): number {
    if (interval <= 0) return num;
    num = num < 0 ? num - interval / 2 : num + interval / 2;
    return num - (num % interval);
  }

  private setPosition(object: TabletopObject) {
/*
    this._posX = object.location.x;
    this._posY = object.location.y;
    this._posZ = object.posZ;


    this._posX = Math.floor(object.location.x);
    this._posY = Math.floor(object.location.y);
    this._posZ = Math.floor(object.posZ);
*/
    this._posX = this.mathFloor? Math.floor(object.location.x):object.location.x;
    this._posY = this.mathFloor? Math.floor(object.location.y):object.location.y;
    this._posZ = this.mathFloor? Math.floor(object.posZ*8)/8:object.posZ;

    this.updateTransformCss();
  }

  private setUpdateTimer() {
    if (this.updateTimer === null && this.tabletopObject) {
      this.updateTimer = setTimeout(() => {
        this.tabletopObject.location.x = this.posX;
        this.tabletopObject.location.y = this.posY;
        this.tabletopObject.posZ = this.posZ;
        this.updateTimer = null;
      }, 66);
    }
    this.updateTransformCss();
  }

  private findCollidableElements() {
    this.collidableElements = [];
    if (getComputedStyle(this.nativeElement).pointerEvents !== 'none') {
      this.collidableElements = [this.nativeElement];
      return;
    }
    this.findNestedCollidableElements(this.nativeElement);
  }

  private findNestedCollidableElements(element: HTMLElement) {
    // TODO:不完全
    let children = element.children;
    for (let i = 0; i < children.length; i++) {
      let child = children[i]
      if (!(child instanceof HTMLElement)) continue;
      if (getComputedStyle(child).pointerEvents !== 'none') {
        this.collidableElements.push(child);
      }
    }
    if (this.collidableElements.length < 1) {
      for (let i = 0; i < children.length; i++) {
        let child = children[i]
        if (!(child instanceof HTMLElement)) continue;
        this.findNestedCollidableElements(child);
      }
    }
  }

  private setPointerEvents(isEnable: boolean) {
    let css = isEnable ? 'auto' : 'none';
    this.collidableElements.forEach(element => element.style.pointerEvents = css);
  }

  private setAnimatedTransition(isEnable: boolean) {
    this.nativeElement.style.transition = isEnable ? 'transform 132ms linear' : '';
  }

  private shouldTransition(object: TabletopObject): boolean {
    return object.location.x !== this.posX || object.location.y !== this.posY || object.posZ !== this.posZ;
  }

  private stopTransition() {
    this.nativeElement.style.transform = window.getComputedStyle(this.nativeElement).transform;
  }

  private updateTransformCss() {
//    let css = this.transformCssOffset + ' translateX(' + this.posX + 'px) translateY(' + this.posY + 'px) translateZ(' + this.posZ + 'px)';
//    let css = 'translateX(' + this.posX + 'px) translateY(' + this.posY + 'px) translateZ(' + this.posZ + 'px)';
    let css = 'translate3d(' + this.posX + 'px,' + this.posY + 'px,' + this.posZ + 'px) ' + this.transformCssOffset;
//    let css = 'translate3d(' + this.posX + 'px,' + this.posY + 'px,' + this.posZ + 'px) ' + ' translate3d(0px,0px,1px) translate3d(0px,0px,1px)  translate3d(0px,0px,1px) translate3d(0px,0px,1px) translate3d(0px,0px,1px)';

//    let css = 'translate3d(' + this.posX + 'px,' + this.posY + 'px,' + (this.posZ +100 )+ 'px) ';
//    console.log(css);
    this.nativeElement.style.transform = css;
  }

  private setCollidableLayer(isCollidable: boolean) {
    // todo
    let isEnable = isCollidable;
    for (let layerName in MovableDirective.layerHash) {
      if (-1 < this.colideLayers.indexOf(layerName)) {
        isEnable = this.input.isGrabbing ? isCollidable : true;
      } else {
        isEnable = !isCollidable;
      }
      MovableDirective.layerHash[layerName].forEach(movable => {
        if (movable === this || movable.input.isGrabbing) return;
        movable.setPointerEvents(isEnable);
      });
    }
  }

  private register() {
    if (!(this.layerName in MovableDirective.layerHash)) MovableDirective.layerHash[this.layerName] = [];
    let index = MovableDirective.layerHash[this.layerName].indexOf(this);
    if (index < 0) MovableDirective.layerHash[this.layerName].push(this);
  }

  private unregister() {
    if (!(this.layerName in MovableDirective.layerHash)) return;
    let index = MovableDirective.layerHash[this.layerName].indexOf(this);
    if (-1 < index) MovableDirective.layerHash[this.layerName].splice(index, 1);
  }
}
