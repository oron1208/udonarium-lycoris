import { animate, keyframes, style, transition, trigger } from '@angular/animations';
import { Logger } from '../../class/core/system/util/logger';
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
  ViewChild
} from '@angular/core';
import { GameObject } from '@udonarium/core/synchronize-object/game-object';
import { ImageFile } from '@udonarium/core/file-storage/image-file';
import { ImageRenderCache } from '@udonarium/core/file-storage/image-render-cache';
import { ObjectNode } from '@udonarium/core/synchronize-object/object-node';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { ChatTabList } from '@udonarium/chat-tab-list';
import { Config } from '@udonarium/config';
import { DiceBot } from '@udonarium/dice-bot';
import { EventSystem, Network } from '@udonarium/core/system';
import { GameCharacter, AutoBuffEntry, AutoBuffOperation } from '@udonarium/game-character';
import { GameCharacterGroup } from '@udonarium/game-character-group';
import { DataElement } from '@udonarium/data-element';
import { GameTable } from '@udonarium/game-table';
import { PresetSound, SoundEffect } from '@udonarium/sound-effect';
import { ChatPaletteComponent } from 'component/chat-palette/chat-palette.component';
import { GameCharacterSheetComponent } from 'component/game-character-sheet/game-character-sheet.component';
import { CharacterGroupPartsPanelComponent } from 'component/character-group-parts/character-group-parts.component';
import { InputHandler } from 'directive/input-handler';
import { MovableOption } from 'directive/movable.directive';
import { RotableOption } from 'directive/rotable.directive';
import { ContextMenuAction, ContextMenuSeparator, ContextMenuService } from 'service/context-menu.service';
import { PanelOption, PanelService } from 'service/panel.service';
import { InitiativeDiceRollerComponent } from 'component/initiative-dice-roller/initiative-dice-roller.component';
import { BatchDiceRollerComponent } from 'component/batch-dice-roller/batch-dice-roller.component';
import { BatchDamagePanelComponent } from 'component/batch-damage-panel/batch-damage-panel.component';
import { PointerDeviceService } from 'service/pointer-device.service';
import { GmModeService } from 'service/gm-mode.service';
import { RemoteControllerComponent } from 'component/remote-controller/remote-controller.component';
import { GameCharacterBuffViewComponent } from 'component/game-character-buff-view/game-character-buff-view.component';
import { findStatusMarkerDefinition, parseStatusMarkerIds, StatusMarkerDefinition } from '@udonarium/status-marker-dictionary';
import { TabletopService } from 'service/tabletop.service';
import { TabletopUndoService } from 'service/tabletop-undo.service';
import { TabletopSelectionService } from 'service/tabletop-selection.service';
import { InitiativeService } from 'service/initiative.service';
import { ChatMessageService } from 'service/chat-message.service';

@Component({
  selector: 'character-group',
  templateUrl: './character-group.component.html',
  styleUrls: ['./character-group.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [
    trigger('bounceInOut', [
      transition('void => *', [
        animate('600ms ease', keyframes([
          style({ transform: 'scale3d(0, 0, 0)', offset: 0 }),
          style({ transform: 'scale3d(1.5, 1.5, 1.5)', offset: 0.5 }),
          style({ transform: 'scale3d(0.75, 0.75, 0.75)', offset: 0.75 }),
          style({ transform: 'scale3d(1.125, 1.125, 1.125)', offset: 0.875 }),
          style({ transform: 'scale3d(1.0, 1.0, 1.0)', offset: 1.0 })
        ]))
      ]),
      transition('* => void', [
        animate(100, style({ transform: 'scale3d(0, 0, 0)' }))
      ])
    ])
  ]
})
export class CharacterGroupComponent implements OnInit, OnDestroy, AfterViewInit, OnChanges {
  private static readonly SIMPLE_VIEW_FULL_STORAGE_KEY = 'udonarium.character.simpleView.full.v1';
  private static simpleViewFullIdentifiers: Set<string> = CharacterGroupComponent.loadSimpleViewFullIdentifiers();

  @Input() characterGroup: GameCharacterGroup = null;
  @Input() is3D: boolean = false;
  @Input() isSimpleView: boolean = false;
  @Input() isFlatMode: boolean = false;
  @Input() isRangeSelected: boolean = false;
  @ViewChild('root') rootElementRef!: ElementRef<HTMLElement>;

  get isLock(): boolean { return this.characterGroup.isLock; }
  get isCurrentCombatTurn(): boolean {
    return this.initiativeService.isCombatActive &&
      this.initiativeService.getCurrentTurnIdentifier() === this.characterGroup.identifier;
  }
  get isTurnMarkerVisible(): boolean {
    const tables = ObjectStore.instance.getObjects<GameTable>(GameTable);
    const table = tables.find(t => t.combatActive) || tables.find(t => t.selected) || tables[0];
    return table ? table.combatTurnMarkerVisible : true;
  }
  get turnMarker3dOffset(): number {
    const base = this.characterGroup.specifyKomaImageFlag
      ? Number(this.characterGroup.komaImageHeignt || this.size * this.gridSize)
      : this.size * this.gridSize;
    return Math.max(52, base + 24);
  }
  set isLock(isLock: boolean) { this.characterGroup.isLock = isLock; }

  get name(): string { return this.characterGroup.name; }
  get size(): number { return this.adjustMinBounds(this.characterGroup.size); }
  get altitude(): number { return this.characterGroup.altitude; }
  set altitude(altitude: number) { this.characterGroup.altitude = altitude; }
  get imageFile(): ImageFile { return this.characterGroup.imageFile; }
  get rotate(): number { return this.characterGroup.rotate; }
  set rotate(rotate: number) { this.characterGroup.rotate = rotate; }
  get roll(): number { return this.characterGroup.roll; }
  set roll(roll: number) { this.characterGroup.roll = roll; }
  get isDropShadow(): boolean { return this.characterGroup.isDropShadow; }
  _showSideNameLabel: boolean = true;
  // 注意: 名前ラベルは game-character.component と game-table.component (side-name-label) の2箇所で描画されている。
  // gmOnlyコマのフィルタリングは両方で行うこと。詳細は game-table.component.ts の sideLabelCharacters を参照。
  get showSideNameLabel(): boolean { return this._showSideNameLabel; }
  set isDropShadow(isDropShadow: boolean) { this.characterGroup.isDropShadow = isDropShadow; }
  get isAltitudeIndicate(): boolean { return this.characterGroup.isAltitudeIndicate; }
  set isAltitudeIndicate(isAltitudeIndicate: boolean) { this.characterGroup.isAltitudeIndicate = isAltitudeIndicate; }
  get visibility(): string { return this.characterGroup.visibility || 'public'; }
  set visibility(visibility: string) { this.characterGroup.visibility = visibility; }
  get isGmOnly(): boolean { return this.visibility === 'gmOnly'; }
  get isSecretDetails(): boolean { return !!this.characterGroup.secretDetails; }
  set isSecretDetails(secret: boolean) { this.characterGroup.secretDetails = secret; }
  get isSecretDetailsHidden(): boolean { return this.isSecretDetails && !this.gmModeService.isGm; }
  get isAdvancedRoom(): boolean { return this.tabletopService.currentTable?.roomMode === 'advanced'; }
  get isMyPiece(): boolean {
    return this.isAdvancedRoom && (this.hasOwnerId(this.characterGroup.ownerPeerIds, Network.peerId) || this.hasOwnerId(this.characterGroup.ownerUserIds, Network.peerContext?.userId));
  }
  get canDisplayByRole(): boolean { return !this.isGmOnly || this.gmModeService.isGm; }
  get canUseVnStageButton(): boolean {
    if (!this.isVnBoardButtonVisible) return false;
    if (!this.characterGroup || this.characterGroup.nonTalkFlag) return false;
    if (this.isGmOnly && !this.gmModeService.isGm) return false;
    if (this.isSecretDetailsHidden) return false;
    return true;
  }
  get isSimpleViewForcedFull(): boolean { return CharacterGroupComponent.simpleViewFullIdentifiers.has(this.characterGroup.identifier); }
  get shouldUseFlatIcon(): boolean { return this.isFlatMode; }
  get shouldUseSimpleView(): boolean { return !this.shouldUseFlatIcon && this.isSimpleView && !this.characterGroup.targeted && !this.isSimpleViewForcedFull; }
  get isTopDownView(): boolean { return !this.isFlatMode && !this.shouldUseSimpleView && !this.shouldUseFlatIcon && this.viewRotateX <= 16; }
  _showTopDownNameLabel: boolean = true;
  _showDirectionMarker: boolean = false;
  get shouldShowTopDownNameTag(): boolean { return this.canDisplayByRole && this.isTopDownView && 0 < this.name.length && this._showTopDownNameLabel; }
  get shouldShowTopDownIcon(): boolean { return this.isTopDownView; }
  get shouldShowDirectionMarker(): boolean { return this._showDirectionMarker; }
  get canRotateByDirectionMarker(): boolean { return this.isFlatMode && !this.isLock; }
  get directionMarkerTransform(): string {
    const radius = Math.max(this.size * this.gridSize / 2 + 18, 34);
    const direction = this.normalizeAngle((this.rotate || 0) + 90);
    return `translate(-50%, -50%) rotate(${direction}deg) translateX(${radius}px)`;
  }
  get perspectiveAssistTransform(): string {
    return 'translateZ(2.05px)';
  }
  get perspectiveAssistNameTransform(): string {
    return 'translateX(-50%) translateZ(2.2px)';
  }
  get simpleInitial(): string { return (this.name || '?').trim().charAt(0) || '?'; }
  get statusMarkers(): StatusMarkerDefinition[] { return parseStatusMarkerIds(this.characterGroup.statusMarkerIds).map(id => findStatusMarkerDefinition(id, this.tabletopService.currentTable.statusMarkerDictionary)).filter(marker => !!marker); }

  private foldingBuff: boolean = false;
  private foldingBuffAutoCollapse: boolean = true;
  isVnBoardButtonVisible: boolean = false;
  gridSize: number = 50;

  // ホバー部位パネル（body直下に追加してtransformの影響を受けないようにする）
  isHoverPanelVisible: boolean = false;
  private hoverPanelEl: HTMLElement | null = null;
  private hoverHideTimer: any = null;
  private static readonly HOVER_DELAY_MS = 350;
  math = Math;

  viewRotateX = 50;
  viewRotateY = 0;
  viewRotateZ = 10;

  movableOption: MovableOption = {};
  private input: InputHandler = null;

  rotableOption: RotableOption = {};

  private highlightTimer!: NodeJS.Timer;
  private unhighlightTimer!: NodeJS.Timer;
  private animationTimer!: NodeJS.Timer;
  private isDirectionMarkerRotating: boolean = false;
  private directionMarkerRotated: boolean = false;
  private flatIconNaturalWidth: number = 0;
  private flatIconNaturalHeight: number = 0;
  private highQualityKomaImageUrl: string = '';
  private highQualityKomaImageSource: string = '';
  private highQualityKomaImageKey: string = '';

  get komaDisplayImageUrl(): string {
    const sourceUrl = this.imageFile?.url || '';
    if (sourceUrl !== this.highQualityKomaImageSource) {
      this.highQualityKomaImageUrl = '';
      this.highQualityKomaImageSource = sourceUrl;
      this.highQualityKomaImageKey = '';
    }
    return this.highQualityKomaImageUrl || sourceUrl;
  }


  get flatIconImageStyle(): { [key: string]: string } {
    const mode = this.resolveFlatIconFitMode();
    const zoom = this.normalizeFlatIconZoom(this.characterGroup?.flatIconZoom);
    const offsetX = this.normalizeFlatIconOffset(this.characterGroup?.flatIconOffsetX);
    const offsetY = this.normalizeFlatIconOffset(this.characterGroup?.flatIconOffsetY);

    const style: { [key: string]: string } = {
      'object-fit': mode === 'contain' ? 'contain' : 'cover',
      'object-position': `${offsetX}% ${offsetY}%`,
      'transform': `scale(${zoom / 100})`,
      'transform-origin': `${offsetX}% ${offsetY}%`
    };

    if ((this.characterGroup?.flatIconFitMode || 'auto') === 'auto') {
      if (mode === 'top') {
        style['object-position'] = '50% 18%';
        style['transform'] = `scale(${Math.min(zoom, 96) / 100})`;
        style['transform-origin'] = '50% 18%';
      } else if (mode === 'contain') {
        style['object-position'] = '50% 50%';
        style['transform'] = 'scale(1)';
        style['transform-origin'] = '50% 50%';
      }
    }
    return style;
  }

  onFlatIconImageLoad(event: Event) {
    const img = event.target as HTMLImageElement;
    if (!img) return;
    this.flatIconNaturalWidth = img.naturalWidth || img.width || 0;
    this.flatIconNaturalHeight = img.naturalHeight || img.height || 0;
    this.changeDetector.markForCheck();
  }

  async onKomaImageLoad(event: Event) {
    const img = event.target as HTMLImageElement;
    const sourceUrl = this.imageFile?.url || '';
    if (!img || !sourceUrl || img.currentSrc !== sourceUrl) return;

    const naturalWidth = img.naturalWidth || img.width || 0;
    const naturalHeight = img.naturalHeight || img.height || 0;
    if (naturalWidth <= 0 || naturalHeight <= 0) return;

    const cssSize = this.resolveKomaImageCssSize(naturalWidth, naturalHeight);
    if (!cssSize || !ImageRenderCache.shouldDownscale(naturalWidth, naturalHeight, cssSize.width, cssSize.height)) return;

    const cacheKey = `${sourceUrl}|${Math.round(cssSize.width)}x${Math.round(cssSize.height)}`;
    if (this.highQualityKomaImageKey === cacheKey && this.highQualityKomaImageUrl) return;
    this.highQualityKomaImageKey = cacheKey;

    const renderUrl = await ImageRenderCache.get(sourceUrl, cssSize.width, cssSize.height);
    if (!renderUrl || this.imageFile?.url !== sourceUrl || this.highQualityKomaImageKey !== cacheKey) return;

    this.highQualityKomaImageUrl = renderUrl;
    this.changeDetector.markForCheck();
  }

  private resolveKomaImageCssSize(naturalWidth: number, naturalHeight: number): { width: number; height: number } {
    const tokenWidth = Math.max(1, this.size * this.gridSize);
    if (this.characterGroup.specifyKomaImageFlag) {
      const height = Math.max(1, Number(this.characterGroup.komaImageHeignt || tokenWidth));
      return { width: Math.max(1, naturalWidth * height / naturalHeight), height };
    }
    return { width: tokenWidth, height: Math.max(1, naturalHeight * tokenWidth / naturalWidth) };
  }

  private resolveFlatIconFitMode(): 'center' | 'top' | 'contain' {
    const mode = this.characterGroup?.flatIconFitMode || 'auto';
    if (mode === 'contain') return 'contain';
    if (mode === 'top') return 'top';
    if (mode === 'center') return 'center';

    const w = this.flatIconNaturalWidth;
    const h = this.flatIconNaturalHeight;
    if (w > 0 && h > 0) {
      if (h / w >= 1.25) return 'top';
      if (w / h >= 1.45) return 'contain';
    }
    return 'center';
  }

  private normalizeFlatIconZoom(value: number): number {
    const num = Number(value);
    if (!Number.isFinite(num)) return 100;
    return Math.max(50, Math.min(180, num));
  }

  private normalizeFlatIconOffset(value: number): number {
    const num = Number(value);
    if (!Number.isFinite(num)) return 50;
    return Math.max(0, Math.min(100, num));
  }

  get elevation(): number {
    return +((this.characterGroup.posZ + (this.altitude * this.gridSize)) / this.gridSize).toFixed(1);
  }

  get chatBubbleAltitude(): number {
    /*
    let cos =  Math.cos(this.roll * Math.PI / 180);
    let sin = Math.abs(Math.sin(this.roll * Math.PI / 180));
    if (cos < 0.5) cos = 0.5;
    if (sin < 0.5) sin = 0.5;
    const altitude1 = (this.characterImageHeight + (this.name != '' ? 24 : 0)) * cos + 4;
    const altitude2 = (this.characterImageWidth / 2) * sin + 4 + this.characterImageWidth / 2;
    let ret = altitude1 > altitude2 ? altitude1 : altitude2;
    this.characterGroup.chatBubbleAltitude = ret;
*/
    let ret = 0;
    return ret;
  }

  constructor(
    private ngZone: NgZone,
    private contextMenuService: ContextMenuService,
    private elementRef: ElementRef<HTMLElement>,
    private panelService: PanelService,
    private changeDetector: ChangeDetectorRef,
    private pointerDeviceService: PointerDeviceService,
    public gmModeService: GmModeService,
    private tabletopService: TabletopService,
    private tabletopUndoService: TabletopUndoService,
    private tabletopSelectionService: TabletopSelectionService,
    private initiativeService: InitiativeService,
    private chatMessageService: ChatMessageService,
  ) { }

  ngOnChanges() {
    this.movableOption = {
      tabletopObject: this.characterGroup,
      transformCssOffset: 'translateZ(1.0px)',
      colideLayers: ['terrain'],
      isFlatMode: this.isFlatMode
    };
    this.rotableOption = {
      tabletopObject: this.characterGroup
    };
  }

  selectForVnStage(event: Event) {
    event.preventDefault();
    event.stopPropagation();
    if (!this.canUseVnStageButton) return;
    EventSystem.trigger('VN_STAGE_SELECT_CHARACTER', { characterId: this.characterGroup.identifier });
  }

  ngOnInit() {
    try { this.foldingBuffAutoCollapse = localStorage.getItem('udonarium.buffTower.collapsed.v1') !== 'false'; } catch (_) { }
    try { this.isVnBoardButtonVisible = localStorage.getItem('udonarium.vnStage.boardButton.visible.v1') === '1'; } catch (_) { }
    try { this._showSideNameLabel = localStorage.getItem('udonarium.nameLabel.side.v1') !== '0'; } catch (_) { }
    try { this._showTopDownNameLabel = localStorage.getItem('udonarium.nameLabel.topdown.v1') !== '0'; } catch (_) { }
    try { this._showDirectionMarker = localStorage.getItem('udonarium.character.directionMarker.visible.v1') === '1'; } catch (_) { }
    if (this.foldingBuffAutoCollapse) this.foldingBuff = true;

    EventSystem.register(this)
      .on('UPDATE_GAME_OBJECT', event => {
        let object = ObjectStore.instance.get(event.data.identifier);
        if (!this.characterGroup || !object) return;
        if (this.characterGroup === object || (object instanceof ObjectNode && this.characterGroup.contains(object))) {
          this.changeDetector.markForCheck();
        }
        // GameTableの戦闘状態変更時も再描画（イニシアチブ同期用）
        if (object instanceof GameTable) {
          this.changeDetector.markForCheck();
        }
      })
      .on('SYNCHRONIZE_FILE_LIST', event => {
        this.changeDetector.markForCheck();
      })
      .on('UPDATE_FILE_RESOURE', event => {
        this.changeDetector.markForCheck();
      })
      .on<object>('TABLE_VIEW_ROTATE', -1000, event => {
        this.ngZone.run(() => {
          this.viewRotateX = event.data['x'];
          this.viewRotateY = event.data['y'];
          this.viewRotateZ = event.data['z'];
          this.changeDetector.markForCheck();
        });
      })
      .on('GM_MODE_CHANGED', event => {
        this.changeDetector.markForCheck();
      })
      .on('BUFF_TOWER_COLLAPSE_CHANGED', event => {
        this.ngZone.run(() => {
          this.foldingBuffAutoCollapse = !!event.data?.collapsed;
          if (this.foldingBuffAutoCollapse) this.foldingBuff = true;
          this.changeDetector.markForCheck();
        });
      })
      .on('VN_STAGE_BOARD_BUTTON_VISIBILITY_CHANGED', event => {
        this.ngZone.run(() => {
          this.isVnBoardButtonVisible = !!event.data?.visible;
          this.changeDetector.markForCheck();
        });
      })
      .on('NAME_LABEL_VISIBILITY_CHANGED', event => {
        this.ngZone.run(() => {
          if (event.data?.side !== undefined) this._showSideNameLabel = !!event.data.side;
          if (event.data?.topdown !== undefined) this._showTopDownNameLabel = !!event.data.topdown;
          this.changeDetector.markForCheck();
        });
      })
      .on('CHARACTER_DIRECTION_MARKER_VISIBILITY_CHANGED', event => {
        this.ngZone.run(() => {
          this._showDirectionMarker = !!event.data?.visible;
          this.changeDetector.markForCheck();
        });
      })
      .on('CHK_TARGET_CHANGE', -1000, event => {
        let objct = ObjectStore.instance.get(event.data.identifier);
        if (objct == this.characterGroup) {
          this.changeDetector.detectChanges();
        }
      })
      .on('COMBAT_STATE_CHANGED', event => {
        this.changeDetector.markForCheck();
      })
      .on('CHARACTER_ANIMATION', event => {
        if (!this.characterGroup || this.characterGroup.identifier !== event.data.characterIdentifier) return;
        const anim = event.data.animation;
        if (!anim) return;
        this.playCharacterAnimation(anim);
      })

      .on('HIGHTLIGHT_TABLETOP_OBJECT', event => {
        if (this.characterGroup.identifier !== event.data.identifier) { return; }
        if (this.characterGroup.location.name != "table") { return; }

        Logger.debug(`recv focus event to ${this.characterGroup.name}`);
        // アニメーション開始のタイマーが既にあってアニメーション開始前（ごくわずかな間）ならば何もしない
        if (this.highlightTimer != null) { return; }

        // アニメーション中であればアニメーションを初期化
        if (this.rootElementRef.nativeElement.classList.contains('focused')) {
          clearTimeout(this.unhighlightTimer);
          this.rootElementRef.nativeElement.classList.remove('focused');
        }

        // アニメーション開始処理タイマー
        this.highlightTimer = setTimeout(() => {
          this.highlightTimer = null;
          this.rootElementRef.nativeElement.classList.add('focused');
        }, 0);

        // アニメーション終了処理タイマー
        this.unhighlightTimer = setTimeout(() => {
          this.unhighlightTimer = null;
          this.rootElementRef.nativeElement.classList.remove('focused');
        }, 1010);
      });
    this.movableOption = {
      tabletopObject: this.characterGroup,
      transformCssOffset: 'translateZ(1.0px)',
      colideLayers: ['terrain'],
      isFlatMode: this.isFlatMode
    };
    this.rotableOption = {
      tabletopObject: this.characterGroup
    };
  }

  private playCharacterAnimation(animation: string) {
    if (!this.rootElementRef?.nativeElement) return;
    const root = this.rootElementRef.nativeElement;
    const contentEl = root.querySelector('.component-content') as HTMLElement;
    if (!contentEl) return;
    const className = `char-anim-${animation}`;
    contentEl.classList.remove('char-anim-shake', 'char-anim-jump', 'char-anim-spin', 'char-anim-lunge', 'char-anim-flash');
    void contentEl.offsetWidth; // reflow
    contentEl.classList.add(className);
    if (this.animationTimer) clearTimeout(this.animationTimer);
    this.animationTimer = setTimeout(() => {
      contentEl.classList.remove(className);
      this.animationTimer = null;
    }, 800);
  }

  ngAfterViewInit() {
    this.ngZone.runOutsideAngular(() => {
      this.input = new InputHandler(this.elementRef.nativeElement);
    });
    this.input.onStart = this.onInputStart.bind(this);
  }


  private releaseHighQualityKomaImageSource() {
    if (!this.highQualityKomaImageSource) return;
    this.highQualityKomaImageUrl = '';
    this.highQualityKomaImageSource = '';
    this.highQualityKomaImageKey = '';
  }

  ngOnDestroy() {
    this.releaseHighQualityKomaImageSource();
    this.stopDirectionMarkerRotate();
    this.input.destroy();
    this.hideHoverPanel();
    EventSystem.unregister(this);
  }

  @HostListener('dragstart', ['$event'])
  onDragstart(e: any) {
    Logger.debug('Dragstart Cancel !!!!');
    e.stopPropagation();
    e.preventDefault();
  }


  onInputStart(e: any) {
    this.input.cancel();

    // TODO:もっと良い方法考える
    if (this.isLock) {
      EventSystem.trigger('DRAG_LOCKED_OBJECT', {});
    }
  }


  @HostListener('contextmenu', ['$event'])
  onContextMenu(e: Event) {
    e.stopPropagation();
    e.preventDefault();

    if (!this.pointerDeviceService.isAllowedToOpenContextMenu) return;

    let position = this.pointerDeviceService.pointers[0];
    const selectedCharacters = this.getSelectedCharactersForBatch();
    if (selectedCharacters.length >= 2) {
      this.openBatchContextMenu(position, selectedCharacters);
      return;
    }

    this.contextMenuService.open(position, [
      ...(this.isAdvancedRoom ? [
        (this.isMyPiece
          ? { name: '☑ 自分のコマ', action: () => this.toggleMyPiece(false) }
          : { name: '☐ 自分のコマにする', action: () => this.toggleMyPiece(true) }),
        ContextMenuSeparator
      ] : []),
      (this.isSimpleViewForcedFull
        ? {
          name: '簡略表示に戻す', action: () => {
            this.setSimpleViewForcedFull(false);
          }
        } : {
          name: '簡易モードでもこのコマは通常表示', action: () => {
            this.setSimpleViewForcedFull(true);
          }
        }),
      ContextMenuSeparator,
      { 
        name: '高度・サイズ設定', action: null, subActions: [
          {
            name: '高度を0にする', action: () => {
              if (this.altitude != 0) {
                this.altitude = 0;
                SoundEffect.play(PresetSound.sweep);
              }
            },
            altitudeHande: this.characterGroup
          },
          {
            name: 'サイズ調整',
            action: null,
            sizeHande: this.characterGroup
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
            }),
          (this.isDropShadow
            ? {
              name: '☑ 影の表示', action: () => {
                this.isDropShadow = false;
                SoundEffect.play(PresetSound.sweep);
                EventSystem.trigger('UPDATE_INVENTORY', null);
              }
            } : {
              name: '☐ 影の表示', action: () => {
                this.isDropShadow = true;
                SoundEffect.play(PresetSound.sweep);
                EventSystem.trigger('UPDATE_INVENTORY', null);
              },
            })
        ]
      },
      ContextMenuSeparator,
      { name: this.isSecretDetailsHidden ? '詳細は秘匿中' : '詳細を表示', action: () => { if (!this.isSecretDetailsHidden) this.showDetail(this.characterGroup); } },
      { name: this.isSecretDetailsHidden ? 'チャットパレットは秘匿中' : 'チャットパレットを表示', action: () => { if (!this.isSecretDetailsHidden) this.showChatPalette(this.characterGroup) } },
      { name: this.isSecretDetailsHidden ? 'リモコンは秘匿中' : 'リモコンを表示', action: () => { if (!this.isSecretDetailsHidden) this.showRemoteController(this.characterGroup) } },
      { name: this.isSecretDetailsHidden ? 'バフ編集は秘匿中' : 'バフ編集', action: () => { if (!this.isSecretDetailsHidden) this.showBuffEdit(this.characterGroup) } },
      ContextMenuSeparator,
      {
        name: '共有イベントリに移動', action: () => {
          this.tabletopUndoService.moveToLocation(this.characterGroup, 'common');
          SoundEffect.play(PresetSound.piecePut);
        }
      },
      {
        name: '個人イベントリに移動', action: () => {
          this.tabletopUndoService.moveToLocation(this.characterGroup, Network.peerId);
          SoundEffect.play(PresetSound.piecePut);
        }
      },
      {
        name: '墓場に移動', action: () => {
          this.tabletopUndoService.moveToLocation(this.characterGroup, 'graveyard');
          SoundEffect.play(PresetSound.sweep);
        }
      },
      /*
      {
        name: '削除', action: () => {
          Logger.debug("円柱_削除実行_キャラコマ");
          this.characterGroup.setLocation('graveyard');
          this.deleteGameObject(this.characterGroup);
          ObjectStore.instance.clearDeleteHistory();
        }
      },
*/
      ContextMenuSeparator,
      (this.isGmOnly
        ? {
          name: '☑ GMだけに見せる', action: () => {
            this.visibility = 'public';
            this.characterGroup.update();
            SoundEffect.play(PresetSound.sweep);
          }
        } : {
          name: '☐ GMだけに見せる', action: () => {
            this.visibility = 'gmOnly';
            this.characterGroup.update();
            SoundEffect.play(PresetSound.sweep);
          }
        }),
      (this.isSecretDetails
        ? {
          name: '☑ PLに詳細を隠す', action: () => {
            this.isSecretDetails = false;
            this.characterGroup.update();
            SoundEffect.play(PresetSound.sweep);
          }
        } : {
          name: '☐ PLに詳細を隠す', action: () => {
            this.isSecretDetails = true;
            this.characterGroup.update();
            SoundEffect.play(PresetSound.sweep);
          }
        }),
      ContextMenuSeparator,
      (this.isLock
        ? {
          name: '固定解除', action: () => {
            this.isLock = false;
            SoundEffect.play(PresetSound.unlock);
          }
        } : {
          name: '固定する', action: () => {
            this.isLock = true;
            SoundEffect.play(PresetSound.lock);
          }
        }),
      ContextMenuSeparator,
      {
        name: 'コピーを作る', action: null, subActions: [
          {
            name: '1体コピー', action: () => {
              this.cloneCharacters(1);
            }
          },
          {
            name: '数を指定してコピー', action: () => {
              const input = window.prompt('コピーする数を入力してください（1〜100）', '10');
              if (input == null) return;
              const count = Math.max(1, Math.min(100, Math.floor(Number(input))));
              if (!Number.isFinite(count)) return;
              this.cloneCharacters(count);
            }
          }
        ]
      },
      ...(this.isAdvancedRoom ? [
        ContextMenuSeparator,
        {
          name: '🎲 イニシアチブ', action: null, subActions: [
            { name: '📋 登録式でロール', action: () => this.rollInitiativeByFormula() },
            { name: '✏️ 手入力でロール...', action: () => this.openInitiativeDiceRoller([this.characterGroup]) },
          ]
        },
        ContextMenuSeparator,
        {
          name: '⚔️ 一括判定ダメージ', action: () => this.openBatchDamagePanel()
        },
      ] : []),
    ], this.name);
  }

  private cloneCharacters(count: number) {
    const columns = Math.ceil(Math.sqrt(count));
    const cloneObjects: GameCharacter[] = [];
    for (let i = 0; i < count; i++) {
      const cloneObject = this.characterGroup.clone();
      const col = i % columns;
      const row = Math.floor(i / columns);
      cloneObject.location.x += this.gridSize * (col + 1);
      cloneObject.location.y += this.gridSize * (row + 1);
      cloneObject.update();
      cloneObjects.push(cloneObject);
    }
    this.tabletopUndoService.recordCreate(cloneObjects);
    SoundEffect.play(PresetSound.piecePut);
  }

  private toggleMyPiece(owned: boolean) {
    this.characterGroup.ownerPeerIds = this.setOwnerId(this.characterGroup.ownerPeerIds, Network.peerId, owned);
    this.characterGroup.ownerUserIds = this.setOwnerId(this.characterGroup.ownerUserIds, Network.peerContext?.userId, owned);
    if (owned && !this.characterGroup.sightEnabled) this.characterGroup.sightEnabled = true;
    this.characterGroup.update();
    SoundEffect.play(PresetSound.sweep);
  }

  private hasOwnerId(raw: string, id: string): boolean {
    return !!id && this.parseOwnerIds(raw).includes(id);
  }

  private setOwnerId(raw: string, id: string, owned: boolean): string {
    const ids = this.parseOwnerIds(raw);
    if (id) {
      const index = ids.indexOf(id);
      if (owned && index < 0) ids.push(id);
      if (!owned && 0 <= index) ids.splice(index, 1);
    }
    return JSON.stringify(ids);
  }

  private parseOwnerIds(raw: string): string[] {
    try {
      const ids = JSON.parse(raw || '[]');
      return Array.isArray(ids) ? ids.map(id => String(id)).filter(id => 0 < id.length) : [];
    } catch (e) {
      return [];
    }
  }

  private getSelectedCharactersForBatch(): GameCharacter[] {
    if (!this.characterGroup || !this.tabletopSelectionService.isSelected(this.characterGroup.identifier)) return [];
    if (this.tabletopSelectionService.selectedCharacterIds.size < 2) return [];

    const locationName = this.characterGroup.location?.name;
    const characters: GameCharacter[] = [];
    for (const identifier of this.tabletopSelectionService.selectedCharacterIds) {
      const object = ObjectStore.instance.get<GameCharacter>(identifier);
      if (!(object instanceof GameCharacter)) continue;
      if (object.location?.name !== locationName) continue;
      characters.push(object);
    }
    characters.sort((a, b) => a.identifier === this.characterGroup.identifier ? -1 : b.identifier === this.characterGroup.identifier ? 1 : 0);
    return characters;
  }

  private openBatchContextMenu(position: any, characters: GameCharacter[]) {
    const allGmOnly = characters.every(character => (character.visibility || 'public') === 'gmOnly');
    const allSecretDetails = characters.every(character => !!character.secretDetails);
    const allLocked = characters.every(character => !!character.isLock);
    const allAltitudeIndicate = characters.every(character => !!character.isAltitudeIndicate);
    const allDropShadow = characters.every(character => !!character.isDropShadow);
    const altitudeHandle = this.createBatchAltitudeHandle(characters);
    const sizeHandle = this.createBatchSizeHandle(characters);

    const actions: ContextMenuAction[] = [
      {
        name: '高度・サイズ設定', action: null, subActions: [
          {
            name: '高度を0にする', action: () => {
              for (const character of characters) character.altitude = 0;
              this.updateBatchCharacters(characters, PresetSound.sweep);
            },
            altitudeHande: altitudeHandle as any
          },
          {
            name: 'サイズ調整',
            action: null,
            sizeHande: sizeHandle as any
          },
          (allAltitudeIndicate
            ? {
              name: '☑ 高度の表示', action: () => {
                for (const character of characters) character.isAltitudeIndicate = false;
                this.updateBatchCharacters(characters, PresetSound.sweep);
              }
            } : {
              name: '☐ 高度の表示', action: () => {
                for (const character of characters) character.isAltitudeIndicate = true;
                this.updateBatchCharacters(characters, PresetSound.sweep);
              }
            }),
          (allDropShadow
            ? {
              name: '☑ 影の表示', action: () => {
                for (const character of characters) character.isDropShadow = false;
                this.updateBatchCharacters(characters, PresetSound.sweep);
              }
            } : {
              name: '☐ 影の表示', action: () => {
                for (const character of characters) character.isDropShadow = true;
                this.updateBatchCharacters(characters, PresetSound.sweep);
              }
            })
        ]
      },
      ContextMenuSeparator,
      {
        name: '共有インベントリに移動', action: () => this.moveBatchToLocation(characters, 'common', PresetSound.piecePut)
      },
      {
        name: '個人インベントリに移動', action: () => this.moveBatchToLocation(characters, Network.peerId, PresetSound.piecePut)
      },
      {
        name: '墓場に移動', action: () => this.moveBatchToLocation(characters, 'graveyard', PresetSound.sweep)
      },
      ContextMenuSeparator,
      (allGmOnly
        ? {
          name: '☑ GMだけに見せる', action: () => {
            for (const character of characters) character.visibility = 'public';
            this.updateBatchCharacters(characters, PresetSound.sweep);
          }
        } : {
          name: '☐ GMだけに見せる', action: () => {
            for (const character of characters) character.visibility = 'gmOnly';
            this.updateBatchCharacters(characters, PresetSound.sweep);
          }
        }),
      (allSecretDetails
        ? {
          name: '☑ PL詳細を隠す', action: () => {
            for (const character of characters) character.secretDetails = false;
            this.updateBatchCharacters(characters, PresetSound.sweep);
          }
        } : {
          name: '☐ PL詳細を隠す', action: () => {
            for (const character of characters) character.secretDetails = true;
            this.updateBatchCharacters(characters, PresetSound.sweep);
          }
        }),
      ContextMenuSeparator,
      (allLocked
        ? {
          name: '固定解除', action: () => {
            for (const character of characters) character.isLock = false;
            this.updateBatchCharacters(characters, PresetSound.unlock);
          }
        } : {
          name: '固定する', action: () => {
            for (const character of characters) character.isLock = true;
            this.updateBatchCharacters(characters, PresetSound.lock);
          }
        }),
      ContextMenuSeparator,
      {
        name: 'コピーを作る', action: () => this.cloneBatchCharacters(characters)
      },
      ContextMenuSeparator,
      ...(this.isAdvancedRoom ? [
        {
          name: '🎲 イニシアチブロール', action: null, subActions: [
            { name: '📋 登録式でロール', action: () => this.rollInitiativeBatchByFormula(characters) },
            { name: '✏️ 手入力でロール...', action: () => this.openInitiativeDiceRoller(characters) },
          ]
        },
        ContextMenuSeparator,
        {
          name: '🎲 ダイス一括ロール', action: () => this.openBatchDiceRoller(characters)
        },
      ] : []),
    ];

    this.contextMenuService.open(position, actions, `${characters.length}体選択中`);
  }

  private createBatchAltitudeHandle(characters: GameCharacter[]): { altitude: number } {
    let altitude = characters[0]?.altitude || 0;
    return Object.defineProperty({}, 'altitude', {
      get: () => altitude,
      set: (value: number) => {
        altitude = Number(value);
        for (const character of characters) {
          character.altitude = altitude;
          character.update();
        }
        EventSystem.trigger('UPDATE_INVENTORY', null);
      },
      enumerable: true,
      configurable: true
    }) as { altitude: number };
  }

  private createBatchSizeHandle(characters: GameCharacter[]): { size: number } {
    let size = characters[0]?.size || 1;
    return Object.defineProperty({}, 'size', {
      get: () => size,
      set: (value: number) => {
        size = Number(value);
        for (const character of characters) {
          character.size = size;
          character.update();
        }
        EventSystem.trigger('UPDATE_INVENTORY', null);
      },
      enumerable: true,
      configurable: true
    }) as { size: number };
  }

  private moveBatchToLocation(characters: GameCharacter[], location: string, sound: string) {
    this.tabletopUndoService.beginMoveGroup(characters);
    for (const character of characters) character.setLocation(location);
    this.tabletopUndoService.endMoveGroup(characters);
    this.tabletopSelectionService.clear();
    SoundEffect.play(sound);
    EventSystem.trigger('UPDATE_INVENTORY', null);
    this.changeDetector.markForCheck();
  }

  private updateBatchCharacters(characters: GameCharacter[], sound: string) {
    for (const character of characters) character.update();
    SoundEffect.play(sound);
    EventSystem.trigger('UPDATE_INVENTORY', null);
    this.changeDetector.markForCheck();
  }

  private async rollInitiativeBatch(characters: GameCharacter[], diceSize: number) {
    const visibleResults: string[] = [];
    const gmResults: string[] = [];
    for (const character of characters) {
      const formulaResult = await this.initiativeService.rollInitiativeFormulaAsync(character);
      let roll: number;
      let detail: string;
      if (formulaResult) {
        roll = formulaResult.value;
        detail = formulaResult.detail;
      } else {
        roll = Math.floor(Math.random() * diceSize) + 1;
        detail = `1d${diceSize}`;
      }
      character.initiative = roll;
      const isGmOnly = (character.visibility || 'public') === 'gmOnly';
      const line = `${character.name}: ${roll} (${detail})`;
      if (isGmOnly) {
        gmResults.push(line);
      } else {
        visibleResults.push(line);
      }
    }
    this.updateBatchCharacters(characters, PresetSound.diceRoll1);
    EventSystem.trigger('COMBAT_STATE_CHANGED', {});

    // チャットログに送信
    const diceNotation = `1d${diceSize}`;
    if (visibleResults.length > 0) {
      this.sendInitiativeChat(`🎲 イニシアチブロール（${diceNotation}）`, visibleResults, false);
    }
    if (gmResults.length > 0) {
      this.sendInitiativeChat(`🎲 イニシアチブロール（${diceNotation}）【GM限定】`, gmResults, true);
    }
  }

  private promptInitiativeBatch(characters: GameCharacter[]) {
    const input = prompt(`${characters.length}体のキャラクターのイニシアチブを設定\nカンマ区切りで入力してください\n例: 15,12,8,3`);
    if (!input) return;
    const values = input.split(',').map(v => parseInt(v.trim())).filter(v => !isNaN(v));
    if (values.length === 0) return;
    const visibleResults: string[] = [];
    const gmResults: string[] = [];
    for (let i = 0; i < characters.length && i < values.length; i++) {
      characters[i].initiative = values[i];
      const isGmOnly = (characters[i].visibility || 'public') === 'gmOnly';
      const line = `${characters[i].name}: ${values[i]}`;
      if (isGmOnly) {
        gmResults.push(line);
      } else {
        visibleResults.push(line);
      }
    }
    this.updateBatchCharacters(characters, PresetSound.sweep);
    EventSystem.trigger('COMBAT_STATE_CHANGED', {});

    if (visibleResults.length > 0) {
      this.sendInitiativeChat('✏️ イニシアチブ設定', visibleResults, false);
    }
    if (gmResults.length > 0) {
      this.sendInitiativeChat('✏️ イニシアチブ設定【GM限定】', gmResults, true);
    }
  }

  private openInitiativeDiceRoller(characters: GameCharacter[]) {
    const option: PanelOption = { width: 400, height: 220, left: 200, top: 200, title: 'イニシアチブロール' };
    const component = this.panelService.open<InitiativeDiceRollerComponent>(InitiativeDiceRollerComponent, option);
    if (component) {
      component.characters = characters;
    }
  }

  private sendInitiativeChat(title: string, lines: string[], secret: boolean) {
    const text = `${title}\n${lines.join(' / ')}`;
    const chatTabList = ObjectStore.instance.get<ChatTabList>('ChatTabList');
    const sysTab = chatTabList ? chatTabList.systemMessageTab : null;
    this.chatMessageService.sendSystemMessage(sysTab, text, '#4B0082', secret);
  }

  private openBatchDiceRoller(characters: GameCharacter[]) {
    const option: PanelOption = { width: 450, height: 500, left: 200, top: 150, title: 'ダイス一括ロール' };
    const component = this.panelService.open<BatchDiceRollerComponent>(BatchDiceRollerComponent, option);
    if (component) {
      component.characters = characters;
    }
  }

  private openBatchDamagePanel() {
    const targeted = ObjectStore.instance.getObjects<GameCharacter>(GameCharacter)
      .filter(c => c.targeted && c.location.name === this.characterGroup.location.name);
    if (targeted.length === 0) {
      alert('ターゲット指定されたコマがいません。\nコマを右クリック → 対象指定 してください。');
      return;
    }
    const option: PanelOption = { width: 480, height: 600, left: 200, top: 100, title: '⚔️ 一括判定ダメージ' };
    const component = this.panelService.open<BatchDamagePanelComponent>(BatchDamagePanelComponent, option);
    if (component) {
      component.attacker = this.characterGroup;
    }
  }

  private async rollInitiativeSingle(diceSize: number) {
    const char = this.characterGroup;
    const formulaResult = await this.initiativeService.rollInitiativeFormulaAsync(char);
    let roll: number;
    let detail: string;
    if (formulaResult) {
      roll = formulaResult.value;
      detail = formulaResult.detail;
    } else {
      roll = Math.floor(Math.random() * diceSize) + 1;
      detail = `1d${diceSize}`;
    }
    char.initiative = roll;
    char.update();
    SoundEffect.play(PresetSound.diceRoll1);
    this.initiativeService.resortCombatByInitiative();

    const isGmOnly = (char.visibility || 'public') === 'gmOnly';
    const line = `${char.name}: ${roll} (${detail})`;
    const title = `🎲 イニシアチブロール`;
    this.sendInitiativeChat(isGmOnly ? `${title}【GM限定】` : title, [line], isGmOnly);
  }

  private async rollInitiativeByFormula() {
    const char = this.characterGroup;
    const formulaResult = await this.initiativeService.rollInitiativeFormulaAsync(char);
    if (!formulaResult) {
      const input = prompt(`${char.name}のイニシアチブ計算式が登録されていません。\n共通データの「initiativeFormula」に式を入力してください。\n例: 1d20+{敏捷度}`);
      return;
    }
    char.initiative = formulaResult.value;
    char.update();
    SoundEffect.play(PresetSound.diceRoll1);
    this.initiativeService.resortCombatByInitiative();

    const isGmOnly = (char.visibility || 'public') === 'gmOnly';
    const line = `${char.name}: ${formulaResult.value} (${formulaResult.detail})`;
    const title = `🎲 イニシアチブロール（登録式）`;
    this.sendInitiativeChat(isGmOnly ? `${title}【GM限定】` : title, [line], isGmOnly);
  }

  private async rollInitiativeBatchByFormula(characters: GameCharacter[]) {
    const visibleResults: string[] = [];
    const gmResults: string[] = [];
    let hasNoFormula = false;
    for (const character of characters) {
      const formulaResult = await this.initiativeService.rollInitiativeFormulaAsync(character);
      if (!formulaResult) {
        hasNoFormula = true;
        continue;
      }
      character.initiative = formulaResult.value;
      const isGmOnly = (character.visibility || 'public') === 'gmOnly';
      const line = `${character.name}: ${formulaResult.value} (${formulaResult.detail})`;
      if (isGmOnly) {
        gmResults.push(line);
      } else {
        visibleResults.push(line);
      }
    }
    this.updateBatchCharacters(characters, PresetSound.diceRoll1);
    this.initiativeService.resortCombatByInitiative();

    if (visibleResults.length > 0) {
      this.sendInitiativeChat('🎲 イニシアチブロール（登録式）', visibleResults, false);
    }
    if (gmResults.length > 0) {
      this.sendInitiativeChat('🎲 イニシアチブロール（登録式）【GM限定】', gmResults, true);
    }
    if (hasNoFormula) {
      alert('計算式が未登録のコマがあります。\n共通データの「initiativeFormula」に式を入力してください。');
    }
  }

  private promptInitiativeSingle() {
    const char = this.characterGroup;
    const input = prompt(`${char.name}のイニシアチブを入力`);
    if (!input) return;
    const value = parseInt(input.trim());
    if (isNaN(value)) return;
    char.initiative = value;
    char.update();
    SoundEffect.play(PresetSound.sweep);
    EventSystem.trigger('COMBAT_STATE_CHANGED', {});

    const isGmOnly = (char.visibility || 'public') === 'gmOnly';
    const line = `${char.name}: ${value}`;
    const title = '✏️ イニシアチブ設定';
    this.sendInitiativeChat(isGmOnly ? `${title}【GM限定】` : title, [line], isGmOnly);
  }

  private cloneBatchCharacters(characters: GameCharacter[]) {
    const cloneObjects: GameCharacter[] = [];
    for (const character of characters) {
      const cloneObject = character.clone();
      cloneObject.location.x += this.gridSize;
      cloneObject.location.y += this.gridSize;
      cloneObject.update();
      cloneObjects.push(cloneObject);
    }
    this.tabletopUndoService.recordCreate(cloneObjects);
    SoundEffect.play(PresetSound.piecePut);
  }

  forceFullView(event?: Event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    this.setSimpleViewForcedFull(true);
  }

  markerRingTransform(index: number, total: number): string {
    const safeTotal = Math.max(1, total);
    const span = Math.min(220, Math.max(0, (safeTotal - 1) * 36));
    const markerStartOffset = -90;
    const angle = safeTotal === 1 ? 180 + markerStartOffset : 180 + markerStartOffset - (span / 2) + (span * index / (safeTotal - 1));
    const radius = Math.max(18, (this.size * this.gridSize / 2) + 8);
    return `translate(-50%, -50%) rotate(${angle}deg) translate(${radius}px) rotate(${-angle}deg)`;
  }

  startDirectionMarkerRotate(event: MouseEvent | TouchEvent) {
    if (!this.canRotateByDirectionMarker) return;
    if ((event as MouseEvent).button === 1 || (event as MouseEvent).button === 2) return;
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();

    this.isDirectionMarkerRotating = true;
    this.directionMarkerRotated = false;
    this.onMove();
    this.updateRotateByDirectionMarkerEvent(event);

    document.addEventListener('mousemove', this.onDirectionMarkerMouseMove, { passive: false });
    document.addEventListener('mouseup', this.onDirectionMarkerMouseUp, { passive: false });
    document.addEventListener('touchmove', this.onDirectionMarkerTouchMove, { passive: false });
    document.addEventListener('touchend', this.onDirectionMarkerTouchEnd, { passive: false });
    document.addEventListener('touchcancel', this.onDirectionMarkerTouchEnd, { passive: false });
  }

  private onDirectionMarkerMouseMove = (event: MouseEvent) => this.moveDirectionMarkerRotate(event);
  private onDirectionMarkerTouchMove = (event: TouchEvent) => this.moveDirectionMarkerRotate(event);
  private onDirectionMarkerMouseUp = (event: MouseEvent) => this.endDirectionMarkerRotate(event);
  private onDirectionMarkerTouchEnd = (event: TouchEvent) => this.endDirectionMarkerRotate(event);

  private moveDirectionMarkerRotate(event: MouseEvent | TouchEvent) {
    if (!this.isDirectionMarkerRotating) return;
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    this.updateRotateByDirectionMarkerEvent(event);
  }

  private endDirectionMarkerRotate(event?: MouseEvent | TouchEvent) {
    if (!this.isDirectionMarkerRotating) return;
    if (event) {
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
    }
    this.stopDirectionMarkerRotate();
    this.snapRotateToPolygonal();
    this.characterGroup.update();
    if (this.directionMarkerRotated) this.onMoved();
    this.changeDetector.markForCheck();
  }

  private stopDirectionMarkerRotate() {
    this.isDirectionMarkerRotating = false;
    document.removeEventListener('mousemove', this.onDirectionMarkerMouseMove);
    document.removeEventListener('mouseup', this.onDirectionMarkerMouseUp);
    document.removeEventListener('touchmove', this.onDirectionMarkerTouchMove);
    document.removeEventListener('touchend', this.onDirectionMarkerTouchEnd);
    document.removeEventListener('touchcancel', this.onDirectionMarkerTouchEnd);
  }

  private updateRotateByDirectionMarkerEvent(event: MouseEvent | TouchEvent) {
    const point = this.getClientPoint(event);
    if (!point) return;
    const rect = this.rootElementRef?.nativeElement?.getBoundingClientRect();
    if (!rect) return;
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const angle = Math.atan2(point.y - centerY, point.x - centerX) * 180 / Math.PI;
    this.rotate = this.normalizeAngle(angle - 90);
    this.directionMarkerRotated = true;
    this.changeDetector.markForCheck();
  }

  private getClientPoint(event: MouseEvent | TouchEvent): { x: number, y: number } | null {
    if (event instanceof MouseEvent) return { x: event.clientX, y: event.clientY };
    const touch = event.touches && event.touches.length ? event.touches[0] : (event.changedTouches && event.changedTouches.length ? event.changedTouches[0] : null);
    return touch ? { x: touch.clientX, y: touch.clientY } : null;
  }

  private snapRotateToPolygonal(polygonal: number = 24) {
    if (polygonal <= 1) return;
    let rotate = this.rotate;
    rotate = rotate < 0 ? rotate - (180 / polygonal) : rotate + (180 / polygonal);
    rotate -= rotate % (360 / polygonal);
    this.rotate = this.normalizeAngle(rotate);
  }

  private normalizeAngle(degrees: number): number {
    const normalized = degrees % 360;
    return normalized < 0 ? normalized + 360 : normalized;
  }

  private setSimpleViewForcedFull(forceFull: boolean) {
    if (forceFull) {
      CharacterGroupComponent.simpleViewFullIdentifiers.add(this.characterGroup.identifier);
    } else {
      CharacterGroupComponent.simpleViewFullIdentifiers.delete(this.characterGroup.identifier);
    }
    CharacterGroupComponent.saveSimpleViewFullIdentifiers();
    this.changeDetector.markForCheck();
  }

  private static loadSimpleViewFullIdentifiers(): Set<string> {
    try {
      const raw = localStorage.getItem(CharacterGroupComponent.SIMPLE_VIEW_FULL_STORAGE_KEY);
      const values = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(values) ? values.map(value => String(value)) : []);
    } catch (e) {
      return new Set();
    }
  }

  private static saveSimpleViewFullIdentifiers() {
    try {
      localStorage.setItem(CharacterGroupComponent.SIMPLE_VIEW_FULL_STORAGE_KEY, JSON.stringify(Array.from(CharacterGroupComponent.simpleViewFullIdentifiers)));
    } catch (e) {
      Logger.warn('simple view full identifiers save failed', e);
    }
  }

  private deleteGameObject(gameObject: GameObject) {
    gameObject.destroy();
    this.changeDetector.markForCheck();
  }

  onMove() {
    SoundEffect.play(PresetSound.piecePick);
  }

  onMoved() {
    SoundEffect.play(PresetSound.piecePut);
  }

  /**
   * ダブルクリックで部位管理パネルを開く。
   * CardStack の showStackList と同じパターン(PanelService.open でフローティングパネル生成)。
   * コマ本体のサイズは変えないので位置バグが起きない。
   */
  onDoubleClick() {
    if (!this.characterGroup) return;
    let coordinate = this.pointerDeviceService.pointers[0];
    let option: PanelOption = { left: coordinate.x - 250, top: coordinate.y - 200, width: 500, height: 500 };
    let component = this.panelService.open<CharacterGroupPartsPanelComponent>(CharacterGroupPartsPanelComponent, option);
    component.characterGroup = this.characterGroup;
  }

  // ===== ホバー部位フローティングパネル =====

  /**
   * グループコマにマウスホバー → 部位一覧パネルを表示。
   * パネル上にマウスを乗せている間は消えない(遅延付きで消える)。
   */
  onGroupMouseEnter(event?: MouseEvent) {
    if (!this.characterGroup || this.characterGroup.parts.length === 0) return;
    if (this.hoverHideTimer) { clearTimeout(this.hoverHideTimer); this.hoverHideTimer = null; }
    const x = event && event.clientX !== undefined ? event.clientX : 0;
    const y = event && event.clientY !== undefined ? event.clientY : 0;
    this.showHoverPanel(x, y);
    this.isHoverPanelVisible = true;
    this.changeDetector.markForCheck();
  }

  onGroupMouseLeave() {
    this.hoverHideTimer = setTimeout(() => {
      this.isHoverPanelVisible = false;
      this.hideHoverPanel();
      this.changeDetector.markForCheck();
    }, CharacterGroupComponent.HOVER_DELAY_MS);
  }

  onPanelMouseEnter() {
    if (this.hoverHideTimer) { clearTimeout(this.hoverHideTimer); this.hoverHideTimer = null; }
  }

  onPanelMouseLeave() {
    this.hoverHideTimer = setTimeout(() => {
      this.isHoverPanelVisible = false;
      this.hideHoverPanel();
      this.changeDetector.markForCheck();
    }, CharacterGroupComponent.HOVER_DELAY_MS);
  }

  /**
   * 部位をクリック → ターゲット切り替え。
   */
  togglePartTarget(part: GameCharacter, event: Event) {
    event.stopPropagation();
    event.preventDefault();
    part.targeted = !part.targeted;
    EventSystem.trigger('CHK_TARGET_CHANGE', { identifier: part.identifier, className: part.aliasName });
    // グループ自身のtargetedも連動（全部位ターゲット状態に合わせる）
    this.syncGroupTargeted();
    this.changeDetector.markForCheck();
  }

  /**
   * 全部位がターゲットされたらグループもtargeted、全解除ならグループも解除。
   */
  private syncGroupTargeted() {
    if (!this.characterGroup) return;
    const parts = this.characterGroup.parts;
    if (parts.length === 0) return;
    const allTargeted = parts.every(p => p.targeted);
    this.characterGroup.targeted = allTargeted;
    EventSystem.trigger('CHK_TARGET_CHANGE', { identifier: this.characterGroup.identifier, className: this.characterGroup.aliasName });
  }

  /**
   * ホバーパネル内の部位の右クリックメニュー。
   */
  onPartContextMenuHover(event: Event, part: GameCharacter) {
    event.stopPropagation();
    event.preventDefault();
    if (!part) return;
    const position = this.pointerDeviceService.pointers[0];
    const actions: ContextMenuAction[] = [
      { name: '詳細を表示', action: () => this.showDetail(part) },
      { name: 'チャットパレットを表示', action: () => this.showChatPalette(part) },
      { name: 'リモコンを表示', action: () => this.showRemoteController(part) },
      { name: 'VNステージに送る', action: () => EventSystem.trigger('VN_STAGE_SELECT_CHARACTER', { characterId: part.identifier }) },
      ContextMenuSeparator,
      { name: 'グループから外す', action: () => { this.characterGroup.removePart(part); SoundEffect.play(PresetSound.cardPut); } },
    ];
    this.contextMenuService.open(position, actions, part.name);
  }

  /**
   * 部位のHP/リソースを取得（表示用）。
   */
  getPartResource(part: GameCharacter): string {
    if (!part || !part.rootDataElement) return '';
    const hpEls = part.rootDataElement.getElementsByName('HP');
    const hpEl = hpEls.length > 0 ? hpEls[0] : null;
    if (!hpEl) return '';
    const value = hpEl.value != null ? String(hpEl.value) : '';
    const maxEls = part.rootDataElement.getElementsByName('最大HP');
    const maxEl = maxEls.length > 0 ? maxEls[0] : null;
    const max = maxEl?.value != null ? String(maxEl.value) : '';
    if (max) return `${value}/${max}`;
    return value;
  }

  /**
   * 部位の主要リソース（HP以外も含めて最初の数値要素を拾う）。
   */
  getPartResourceList(part: GameCharacter): { name: string; value: string }[] {
    if (!part || !part.rootDataElement) return [];
    const result: { name: string; value: string }[] = [];
    // 共通データ要素から数値っぽいものを最大3つ拾う
    for (const child of part.rootDataElement.children) {
      if (child instanceof DataElement && child.name) {
        const v = child.value != null ? String(child.value) : '';
        if (v && /^[-\d]+$/.test(v.trim())) {
          result.push({ name: child.name, value: v });
          if (result.length >= 3) break;
        }
      }
    }
    return result;
  }

  trackByIdentifier(index: number, part: GameCharacter): string {
    return part ? part.identifier : index.toString();
  }

  // ===== Body直下ホバーパネル（transformの影響を受けない） =====

  private showHoverPanel(mouseX: number, mouseY: number) {
    if (!this.characterGroup) return;

    if (!this.hoverPanelEl) {
      this.hoverPanelEl = document.createElement('div');
      this.hoverPanelEl.className = 'cg-hover-portal';
      this.hoverPanelEl.addEventListener('mouseenter', () => {
        if (this.hoverHideTimer) { clearTimeout(this.hoverHideTimer); this.hoverHideTimer = null; }
      });
      this.hoverPanelEl.addEventListener('mouseleave', () => {
        this.hoverHideTimer = setTimeout(() => {
          this.isHoverPanelVisible = false;
          this.hideHoverPanel();
          this.changeDetector.markForCheck();
        }, CharacterGroupComponent.HOVER_DELAY_MS);
      });
      document.body.appendChild(this.hoverPanelEl);
    }

    this.renderHoverPanelContent();
    this.positionHoverPanel(mouseX, mouseY);
  }

  private positionHoverPanel(mouseX: number, mouseY: number) {
    if (!this.hoverPanelEl) return;
    const panelWidth = 240;
    const panelMaxHeight = 340;
    let left = mouseX + 20;
    let top = mouseY - 10;
    if (left + panelWidth > window.innerWidth - 8) {
      left = mouseX - panelWidth - 8;
    }
    if (top + panelMaxHeight > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - panelMaxHeight - 8);
    }
    if (left < 8) {
      left = Math.min(mouseX + 20, window.innerWidth - panelWidth - 8);
    }
    this.hoverPanelEl.style.left = left + 'px';
    this.hoverPanelEl.style.top = top + 'px';
  }

  private renderHoverPanelContent() {
    if (!this.hoverPanelEl || !this.characterGroup) return;
    const parts = this.characterGroup.parts;
    const group = this.characterGroup;

    let html = '<div class="cg-hover-header">';
    html += `<span class="cg-hover-title">${this.escapeHtml(group.name)}の部位</span>`;
    html += `<span class="cg-hover-count">${parts.length}体</span>`;
    html += '</div>';
    html += '<div class="cg-hover-list">';

    for (const part of parts) {
      const targeted = part.targeted ? ' is-targeted' : '';
      const img = part.imageFile && part.imageFile.url ? part.imageFile.url : '';
      const resources = this.getPartResourceList(part);

      html += `<div class="cg-hover-item${targeted}" data-part-id="${part.identifier}">`;
      html += '<div class="cg-hover-icon-wrap">';
      if (img) {
        html += `<img src="${this.escapeAttr(img)}" class="cg-hover-icon" />`;
      } else {
        html += '<div class="cg-hover-placeholder">​</div>';
      }
      if (part.targeted) html += '<div class="cg-hover-target">🎯</div>';
      html += '</div>';
      html += '<div class="cg-hover-info">';
      html += `<div class="cg-hover-name">${this.escapeHtml(part.name)}</div>`;
      if (resources.length > 0) {
        html += '<div class="cg-hover-resources">';
        for (const r of resources) {
          html += `<span class="cg-hover-resource"><span class="r-name">${this.escapeHtml(r.name)}</span>: <span class="r-val">${this.escapeHtml(r.value)}</span></span>`;
        }
        html += '</div>';
      }
      html += '</div></div>';
    }
    html += '</div>';

    this.hoverPanelEl.innerHTML = html;

    // イベントリスナーを各部位に登録
    const items = this.hoverPanelEl.querySelectorAll('.cg-hover-item');
    items.forEach((item) => {
      const partId = item.getAttribute('data-part-id');
      if (!partId) return;
      const part = ObjectStore.instance.get<GameCharacter>(partId);
      if (!part) return;

      item.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        part.targeted = !part.targeted;
        part.update();
        EventSystem.trigger('CHK_TARGET_CHANGE', { identifier: part.identifier, className: part.aliasName });
        this.syncGroupTargeted();
        this.renderHoverPanelContent();
      });

      item.addEventListener('contextmenu', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.onPartContextMenuHover(e as any, part);
      });
    });
  }

  private hideHoverPanel() {
    if (this.hoverPanelEl) {
      this.hoverPanelEl.remove();
      this.hoverPanelEl = null;
    }
  }

  private escapeHtml(s: string): string {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  private escapeAttr(s: string): string {
    return s.replace(/"/g, '&quot;');
  }

  checkKey(event) {
    //イベント処理
    let key_event = event || window.event;
    let key_shift = (key_event.shiftKey);
    let key_ctrl = (key_event.ctrlKey);
    let key_alt = (key_event.altKey);
    let key_meta = (key_event.metaKey);
    //キーに対応した処理
    
    if (key_shift) Logger.debug("shiftキー");
    if (key_ctrl) Logger.debug("ctrlキー");
    if (key_alt) {
      Logger.debug("altキー");
      // グループの Alt+クリック: 中の全部位を個別にターゲットした状態にトグル。
      // グループ自身の targeted も連動(ターゲット表示のため)。
      const group = this.characterGroup;
      const newTargeted = !this.areAllPartsTargeted();
      for (const part of group.parts) {
        part.targeted = newTargeted;
        EventSystem.trigger('CHK_TARGET_CHANGE', { identifier: part.identifier, className: part.aliasName });
      }
      group.targeted = newTargeted;
      EventSystem.trigger('CHK_TARGET_CHANGE', { identifier: group.identifier, className: group.aliasName });
    }
    if (key_meta) Logger.debug("metaキー");

    if (key_shift && key_alt) {
      Logger.debug("shift+ALTキー");
      let objects = ObjectStore.instance.getObjects(GameCharacter);
      for (let object of objects) {
        object.targeted = false;
        EventSystem.trigger('CHK_TARGET_CHANGE', { identifier: object.identifier, className: object.aliasName });
      }
      // グループと部位もクリア
      for (const grp of ObjectStore.instance.getObjects<GameCharacterGroup>(GameCharacterGroup)) {
        grp.targeted = false;
        for (const part of grp.parts) part.targeted = false;
      }
    }

    //出力
  }

  /**
   * 全部位がターゲット済みか(部位が無ければグループ自身の targeted で判定)。
   */
  private areAllPartsTargeted(): boolean {
    const parts = this.characterGroup.parts;
    if (parts.length === 0) return this.characterGroup.targeted;
    return parts.every(p => p.targeted);
  }

  private adjustMinBounds(value: number, min: number = 0): number {
    return value < min ? min : value;
  }

  private showDetail(gameObject: GameCharacter) {
    let coordinate = this.pointerDeviceService.pointers[0];
    let title = 'キャラクターシート';
    if (gameObject.name.length) title += ' - ' + gameObject.name;
    let option: PanelOption = { title: title, left: coordinate.x - 400, top: coordinate.y - 300, width: 800, height: 600 };
    let component = this.panelService.open<GameCharacterSheetComponent>(GameCharacterSheetComponent, option);
    component.tabletopObject = gameObject;
  }

  private showChatPalette(gameObject: GameCharacter) {
    let coordinate = this.pointerDeviceService.pointers[0];
    let option: PanelOption = { left: coordinate.x - 250, top: coordinate.y - 175, width: 615, height: 350 };
    let component = this.panelService.open<ChatPaletteComponent>(ChatPaletteComponent, option);
    component.character = gameObject;
  }

  private showRemoteController(gameObject: GameCharacter) {
    let coordinate = this.pointerDeviceService.pointers[0];
    let option: PanelOption = { left: coordinate.x - 250, top: coordinate.y - 175, width: 700, height: 600 };
    let component = this.panelService.open<RemoteControllerComponent>(RemoteControllerComponent, option);
    component.character = gameObject;
  }

  private showBuffEdit(gameObject: GameCharacter) {
    let coordinate = this.pointerDeviceService.pointers[0];
    let option: PanelOption = { left: coordinate.x, top: coordinate.y, width: 420, height: 300 };
    option.title = gameObject.name + 'のバフ編集';
    let component = this.panelService.open<GameCharacterBuffViewComponent>(GameCharacterBuffViewComponent, option);
    component.character = gameObject;
  }

  private foldingBuffFlag(flag: boolean){
    Logger.debug('private foldingBuffFlag');
    this.foldingBuff = flag;
  }

  get isAdvancedMode(): boolean {
    return this.tabletopService.currentTable?.roomMode === 'advanced';
  }

  get autoBuffs(): AutoBuffEntry[] {
    return this.isAdvancedMode && this.characterGroup ? this.characterGroup.getAutoBuffs() : [];
  }

  get hasAutoBuffs(): boolean {
    return 0 < this.autoBuffs.length;
  }

  get hasBuffTags(): boolean {
    return this.buffNum > 0 || this.hasAutoBuffs;
  }

  get buffNum(): number{
    let textBuffNum = 0;
    if (this.characterGroup.buffDataElement && this.characterGroup.buffDataElement.children.length > 0){
      textBuffNum = this.characterGroup.buffDataElement.children[0].children.length;
    }
    return textBuffNum + this.autoBuffs.length;
  }

  autoBuffLabel(buff: AutoBuffEntry): string {
    const op = this.autoBuffOperationLabel(buff.operation);
    let value = '';
    if (buff.operation === 'add' || buff.operation === 'append') value = `${buff.value >= 0 ? '+' : ''}${buff.value}`;
    else if (buff.operation === 'replace') value = `=${buff.value}`;
    else if (buff.operation === 'create') value = `${buff.newElementType === '' ? '通常' : 'リソース'}=${buff.value}`;
    else if (buff.operation === 'palette') return '';
    else value = `記録`;
    return `${buff.name} ${buff.targetStat}/${op}${value}/${buff.rounds}R`;
  }

  get hasAutoBuffPalette(): boolean {
    return this.autoBuffs.some(b => b.paletteCommand);
  }

  rollAutoBuffPalette(buff: AutoBuffEntry, event: Event) {
    if (event) { event.preventDefault(); event.stopPropagation(); }
    if (!this.characterGroup || !buff.paletteCommand) return;
    const character = this.characterGroup;
    const palette = character.chatPalette;
    const charDice = palette ? palette.dicebot : '';
    const gameType = (charDice && charDice !== 'DiceBot') ? charDice : Config.instance.defaultDiceBot;
    const sendFrom = character.identifier;
    const tachieNum = character.selectedTachieNum || 0;
    const messageColor = character.chatColorCode && character.chatColorCode.length ? character.chatColorCode[0] : '#000000';

    let evaluated = buff.paletteCommand;
    if (palette) {
      evaluated = palette.evaluate(buff.paletteCommand, character.rootDataElement, character, true);
    }
    const chatTab = ChatTabList.instance.children[0] as any;
    if (!chatTab) return;

    DiceBot.loadGameSystemAsync(gameType).then(gameSystem => {
      this.chatMessageService.sendMessage(chatTab, evaluated, gameSystem, sendFrom, '', tachieNum, messageColor);
    });
  }

  autoBuffOperationLabel(op: AutoBuffOperation): string {
    switch (op) {
      case 'add': return '加算';
      case 'append': return '最大値追加';
      case 'current': return '現状記録';
      case 'replace': return '置換';
      case 'create': return '新規要素';
      case 'palette': return 'チャパレ';
    }
  }
}
