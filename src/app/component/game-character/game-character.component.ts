import { animate, keyframes, style, transition, trigger } from '@angular/animations';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  Input,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild
} from '@angular/core';
import { GameObject } from '@udonarium/core/synchronize-object/game-object';
import { ImageFile } from '@udonarium/core/file-storage/image-file';
import { ObjectNode } from '@udonarium/core/synchronize-object/object-node';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { EventSystem, Network } from '@udonarium/core/system';
import { GameCharacter } from '@udonarium/game-character';
import { PresetSound, SoundEffect } from '@udonarium/sound-effect';
import { ChatPaletteComponent } from 'component/chat-palette/chat-palette.component';
import { GameCharacterSheetComponent } from 'component/game-character-sheet/game-character-sheet.component';
import { InputHandler } from 'directive/input-handler';
import { MovableOption } from 'directive/movable.directive';
import { RotableOption } from 'directive/rotable.directive';
import { ContextMenuAction, ContextMenuSeparator, ContextMenuService } from 'service/context-menu.service';
import { PanelOption, PanelService } from 'service/panel.service';
import { PointerDeviceService } from 'service/pointer-device.service';
import { GmModeService } from 'service/gm-mode.service';
import { RemoteControllerComponent } from 'component/remote-controller/remote-controller.component';
import { GameCharacterBuffViewComponent } from 'component/game-character-buff-view/game-character-buff-view.component';
import { findStatusMarkerDefinition, parseStatusMarkerIds, StatusMarkerDefinition } from '@udonarium/status-marker-dictionary';
import { TabletopService } from 'service/tabletop.service';
import { TabletopUndoService } from 'service/tabletop-undo.service';
import { TabletopSelectionService } from 'service/tabletop-selection.service';

@Component({
  selector: 'game-character',
  templateUrl: './game-character.component.html',
  styleUrls: ['./game-character.component.css'],
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
export class GameCharacterComponent implements OnInit, OnDestroy, AfterViewInit {
  private static readonly SIMPLE_VIEW_FULL_STORAGE_KEY = 'udonarium.character.simpleView.full.v1';
  private static simpleViewFullIdentifiers: Set<string> = GameCharacterComponent.loadSimpleViewFullIdentifiers();

  @Input() gameCharacter: GameCharacter = null;
  @Input() is3D: boolean = false;
  @Input() isSimpleView: boolean = false;
  @Input() isFlatMode: boolean = false;
  @Input() isRangeSelected: boolean = false;
  @ViewChild('root') rootElementRef: ElementRef<HTMLElement>;

  get isLock(): boolean { return this.gameCharacter.isLock; }
  set isLock(isLock: boolean) { this.gameCharacter.isLock = isLock; }

  get name(): string { return this.gameCharacter.name; }
  get size(): number { return this.adjustMinBounds(this.gameCharacter.size); }
  get altitude(): number { return this.gameCharacter.altitude; }
  set altitude(altitude: number) { this.gameCharacter.altitude = altitude; }
  get imageFile(): ImageFile { return this.gameCharacter.imageFile; }
  get rotate(): number { return this.gameCharacter.rotate; }
  set rotate(rotate: number) { this.gameCharacter.rotate = rotate; }
  get roll(): number { return this.gameCharacter.roll; }
  set roll(roll: number) { this.gameCharacter.roll = roll; }
  get isDropShadow(): boolean { return this.gameCharacter.isDropShadow; }
  _showSideNameLabel: boolean = true;
  get showSideNameLabel(): boolean { return this._showSideNameLabel; }
  set isDropShadow(isDropShadow: boolean) { this.gameCharacter.isDropShadow = isDropShadow; }
  get isAltitudeIndicate(): boolean { return this.gameCharacter.isAltitudeIndicate; }
  set isAltitudeIndicate(isAltitudeIndicate: boolean) { this.gameCharacter.isAltitudeIndicate = isAltitudeIndicate; }
  get visibility(): string { return this.gameCharacter.visibility || 'public'; }
  set visibility(visibility: string) { this.gameCharacter.visibility = visibility; }
  get isGmOnly(): boolean { return this.visibility === 'gmOnly'; }
  get isSecretDetails(): boolean { return !!this.gameCharacter.secretDetails; }
  set isSecretDetails(secret: boolean) { this.gameCharacter.secretDetails = secret; }
  get isSecretDetailsHidden(): boolean { return this.isSecretDetails && !this.gmModeService.isGm; }
  get canDisplayByRole(): boolean { return !this.isGmOnly || this.gmModeService.isGm; }
  get canUseVnStageButton(): boolean {
    if (!this.isVnBoardButtonVisible) return false;
    if (!this.gameCharacter || this.gameCharacter.nonTalkFlag) return false;
    if (this.isGmOnly && !this.gmModeService.isGm) return false;
    if (this.isSecretDetailsHidden) return false;
    return true;
  }
  get isSimpleViewForcedFull(): boolean { return GameCharacterComponent.simpleViewFullIdentifiers.has(this.gameCharacter.identifier); }
  get shouldUseFlatIcon(): boolean { return this.isFlatMode; }
  get shouldUseSimpleView(): boolean { return !this.shouldUseFlatIcon && this.isSimpleView && !this.gameCharacter.targeted && !this.isSimpleViewForcedFull; }
  get isTopDownView(): boolean { return !this.isFlatMode && !this.shouldUseSimpleView && !this.shouldUseFlatIcon && this.viewRotateX <= 16; }
  _showTopDownNameLabel: boolean = true;
  get shouldShowTopDownNameTag(): boolean { return this.isTopDownView && 0 < this.name.length && this._showTopDownNameLabel; }
  get shouldShowTopDownIcon(): boolean { return this.isTopDownView; }
  get perspectiveAssistTransform(): string {
    return 'translateZ(2.05px)';
  }
  get perspectiveAssistNameTransform(): string {
    return 'translateX(-50%) translateZ(2.2px)';
  }
  get simpleInitial(): string { return (this.name || '?').trim().charAt(0) || '?'; }
  get statusMarkers(): StatusMarkerDefinition[] { return parseStatusMarkerIds(this.gameCharacter.statusMarkerIds).map(id => findStatusMarkerDefinition(id, this.tabletopService.currentTable.statusMarkerDictionary)).filter(marker => !!marker); }

  private foldingBuff: boolean = false;
  private foldingBuffAutoCollapse: boolean = true;
  isVnBoardButtonVisible: boolean = false;
  gridSize: number = 50;
  math = Math;

  viewRotateX = 50;
  viewRotateY = 0;
  viewRotateZ = 10;

  movableOption: MovableOption = {};
  private input: InputHandler = null;

  rotableOption: RotableOption = {};

  private highlightTimer: NodeJS.Timer;
  private unhighlightTimer: NodeJS.Timer;

  get elevation(): number {
    return +((this.gameCharacter.posZ + (this.altitude * this.gridSize)) / this.gridSize).toFixed(1);
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
    this.gameCharacter.chatBubbleAltitude = ret;
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
  ) { }

  selectForVnStage(event: Event) {
    event.preventDefault();
    event.stopPropagation();
    if (!this.canUseVnStageButton) return;
    EventSystem.trigger('VN_STAGE_SELECT_CHARACTER', { characterId: this.gameCharacter.identifier });
  }

  ngOnInit() {
    try { this.foldingBuffAutoCollapse = localStorage.getItem('udonarium.buffTower.collapsed.v1') !== 'false'; } catch (_) { }
    try { this.isVnBoardButtonVisible = localStorage.getItem('udonarium.vnStage.boardButton.visible.v1') === '1'; } catch (_) { }
    try { this._showSideNameLabel = localStorage.getItem('udonarium.nameLabel.side.v1') !== '0'; } catch (_) { }
    try { this._showTopDownNameLabel = localStorage.getItem('udonarium.nameLabel.topdown.v1') !== '0'; } catch (_) { }
    if (this.foldingBuffAutoCollapse) this.foldingBuff = true;

    EventSystem.register(this)
      .on('UPDATE_GAME_OBJECT', event => {
        let object = ObjectStore.instance.get(event.data.identifier);
        if (!this.gameCharacter || !object) return;
        if (this.gameCharacter === object || (object instanceof ObjectNode && this.gameCharacter.contains(object))) {
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
      .on('CHK_TARGET_CHANGE', -1000, event => {
        let objct = ObjectStore.instance.get(event.data.identifier);
        if (objct == this.gameCharacter) {
          this.changeDetector.detectChanges();
        }
      })

      .on('HIGHTLIGHT_TABLETOP_OBJECT', event => {
        if (this.gameCharacter.identifier !== event.data.identifier) { return; }
        if (this.gameCharacter.location.name != "table") { return; }

        console.log(`recv focus event to ${this.gameCharacter.name}`);
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
      tabletopObject: this.gameCharacter,
      transformCssOffset: 'translateZ(1.0px)',
      colideLayers: ['terrain']
    };
    this.rotableOption = {
      tabletopObject: this.gameCharacter
    };
  }

  ngAfterViewInit() {
    this.ngZone.runOutsideAngular(() => {
      this.input = new InputHandler(this.elementRef.nativeElement);
    });
    this.input.onStart = this.onInputStart.bind(this);
  }

  ngOnDestroy() {
    this.input.destroy();
    EventSystem.unregister(this);
  }

  @HostListener('dragstart', ['$event'])
  onDragstart(e: any) {
    console.log('Dragstart Cancel !!!!');
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
        name: '高度設定', action: null, subActions: [
          {
            name: '高度を0にする', action: () => {
              if (this.altitude != 0) {
                this.altitude = 0;
                SoundEffect.play(PresetSound.sweep);
              }
            },
            altitudeHande: this.gameCharacter
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
      { name: this.isSecretDetailsHidden ? '詳細は秘匿中' : '詳細を表示', action: () => { if (!this.isSecretDetailsHidden) this.showDetail(this.gameCharacter); } },
      { name: this.isSecretDetailsHidden ? 'チャットパレットは秘匿中' : 'チャットパレットを表示', action: () => { if (!this.isSecretDetailsHidden) this.showChatPalette(this.gameCharacter) } },
      { name: this.isSecretDetailsHidden ? 'リモコンは秘匿中' : 'リモコンを表示', action: () => { if (!this.isSecretDetailsHidden) this.showRemoteController(this.gameCharacter) } },
      { name: this.isSecretDetailsHidden ? 'バフ編集は秘匿中' : 'バフ編集', action: () => { if (!this.isSecretDetailsHidden) this.showBuffEdit(this.gameCharacter) } },
      ContextMenuSeparator,
      {
        name: '共有イベントリに移動', action: () => {
          this.tabletopUndoService.moveToLocation(this.gameCharacter, 'common');
          SoundEffect.play(PresetSound.piecePut);
        }
      },
      {
        name: '個人イベントリに移動', action: () => {
          this.tabletopUndoService.moveToLocation(this.gameCharacter, Network.peerId);
          SoundEffect.play(PresetSound.piecePut);
        }
      },
      {
        name: '墓場に移動', action: () => {
          this.tabletopUndoService.moveToLocation(this.gameCharacter, 'graveyard');
          SoundEffect.play(PresetSound.sweep);
        }
      },
/*
      {
        name: '削除', action: () => {
          console.log("円柱_削除実行_キャラコマ");
          this.gameCharacter.setLocation('graveyard');
          this.deleteGameObject(this.gameCharacter);
          ObjectStore.instance.clearDeleteHistory();
        }
      },
*/
      ContextMenuSeparator,
      (this.isGmOnly
        ? {
          name: '☑ GMだけに見せる', action: () => {
            this.visibility = 'public';
            this.gameCharacter.update();
            SoundEffect.play(PresetSound.sweep);
          }
        } : {
          name: '☐ GMだけに見せる', action: () => {
            this.visibility = 'gmOnly';
            this.gameCharacter.update();
            SoundEffect.play(PresetSound.sweep);
          }
        }),
      (this.isSecretDetails
        ? {
          name: '☑ PLに詳細を隠す', action: () => {
            this.isSecretDetails = false;
            this.gameCharacter.update();
            SoundEffect.play(PresetSound.sweep);
          }
        } : {
          name: '☐ PLに詳細を隠す', action: () => {
            this.isSecretDetails = true;
            this.gameCharacter.update();
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
    ], this.name);
  }

  private cloneCharacters(count: number) {
    const columns = Math.ceil(Math.sqrt(count));
    const cloneObjects: GameCharacter[] = [];
    for (let i = 0; i < count; i++) {
      const cloneObject = this.gameCharacter.clone();
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

  private getSelectedCharactersForBatch(): GameCharacter[] {
    if (!this.gameCharacter || !this.tabletopSelectionService.isSelected(this.gameCharacter.identifier)) return [];
    if (this.tabletopSelectionService.selectedCharacterIds.size < 2) return [];

    const locationName = this.gameCharacter.location?.name;
    const characters: GameCharacter[] = [];
    for (const identifier of this.tabletopSelectionService.selectedCharacterIds) {
      const object = ObjectStore.instance.get<GameCharacter>(identifier);
      if (!(object instanceof GameCharacter)) continue;
      if (object.location?.name !== locationName) continue;
      characters.push(object);
    }
    characters.sort((a, b) => a.identifier === this.gameCharacter.identifier ? -1 : b.identifier === this.gameCharacter.identifier ? 1 : 0);
    return characters;
  }

  private openBatchContextMenu(position: any, characters: GameCharacter[]) {
    const allGmOnly = characters.every(character => (character.visibility || 'public') === 'gmOnly');
    const allSecretDetails = characters.every(character => !!character.secretDetails);
    const allLocked = characters.every(character => !!character.isLock);
    const allAltitudeIndicate = characters.every(character => !!character.isAltitudeIndicate);
    const allDropShadow = characters.every(character => !!character.isDropShadow);
    const altitudeHandle = this.createBatchAltitudeHandle(characters);

    const actions: ContextMenuAction[] = [
      {
        name: '高度設定', action: null, subActions: [
          {
            name: '高度を0にする', action: () => {
              for (const character of characters) character.altitude = 0;
              this.updateBatchCharacters(characters, PresetSound.sweep);
            },
            altitudeHande: altitudeHandle as any
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

  private setSimpleViewForcedFull(forceFull: boolean) {
    if (forceFull) {
      GameCharacterComponent.simpleViewFullIdentifiers.add(this.gameCharacter.identifier);
    } else {
      GameCharacterComponent.simpleViewFullIdentifiers.delete(this.gameCharacter.identifier);
    }
    GameCharacterComponent.saveSimpleViewFullIdentifiers();
    this.changeDetector.markForCheck();
  }

  private static loadSimpleViewFullIdentifiers(): Set<string> {
    try {
      const raw = localStorage.getItem(GameCharacterComponent.SIMPLE_VIEW_FULL_STORAGE_KEY);
      const values = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(values) ? values.map(value => String(value)) : []);
    } catch (e) {
      return new Set();
    }
  }

  private static saveSimpleViewFullIdentifiers() {
    try {
      localStorage.setItem(GameCharacterComponent.SIMPLE_VIEW_FULL_STORAGE_KEY, JSON.stringify(Array.from(GameCharacterComponent.simpleViewFullIdentifiers)));
    } catch (e) {
      console.warn('simple view full identifiers save failed', e);
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

  checkKey(event) {
    //イベント処理
    let key_event = event || window.event;
    let key_shift = (key_event.shiftKey);
    let key_ctrl = (key_event.ctrlKey);
    let key_alt = (key_event.altKey);
    let key_meta = (key_event.metaKey);
    //キーに対応した処理
    
    if (key_shift) console.log("shiftキー");
    if (key_ctrl) console.log("ctrlキー");
    if (key_alt) {
      console.log("altキー");
      this.gameCharacter.targeted = this.gameCharacter.targeted ? false : true;
    }
    if (key_meta) console.log("metaキー");

    if (key_shift && key_alt) {
      console.log("shift+ALTキー");
      let objects = ObjectStore.instance.getObjects(GameCharacter);
      for (let object of objects) {
        object.targeted = false;
        EventSystem.trigger('CHK_TARGET_CHANGE', { identifier: object.identifier, className: object.aliasName });
      }
    }

    //出力
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
    console.log('private foldingBuffFlag');
    this.foldingBuff = flag;
  }

  get buffNum(): number{
    if ( this.gameCharacter.buffDataElement.children.length == 0){
      return 0;
    }
    return this.gameCharacter.buffDataElement.children[0].children.length;
  }
}
