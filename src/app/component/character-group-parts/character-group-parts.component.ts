import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, Input, OnDestroy, OnInit, ViewChild } from '@angular/core';

import { GameCharacter } from '@udonarium/game-character';
import { GameCharacterGroup } from '@udonarium/game-character-group';
import { ImageFile } from '@udonarium/core/file-storage/image-file';
import { ImageStorage } from '@udonarium/core/file-storage/image-storage';
import { DataElement } from '@udonarium/data-element';
import { ObjectNode } from '@udonarium/core/synchronize-object/object-node';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { EventSystem } from '@udonarium/core/system';
import { PresetSound, SoundEffect } from '@udonarium/sound-effect';

import { ChatPaletteComponent } from 'component/chat-palette/chat-palette.component';
import { FileSelecterComponent } from 'component/file-selecter/file-selecter.component';
import { GameCharacterSheetComponent } from 'component/game-character-sheet/game-character-sheet.component';
import { RemoteControllerComponent } from 'component/remote-controller/remote-controller.component';
import { TooltipDirective } from 'directive/tooltip.directive';
import { ContextMenuAction, ContextMenuService } from 'service/context-menu.service';
import { ModalService } from 'service/modal.service';
import { PanelOption, PanelService } from 'service/panel.service';
import { PointerDeviceService } from 'service/pointer-device.service';
import { TabletopService } from 'service/tabletop.service';

/**
 * キャラクターグループ(部位管理)の展開パネル。
 * CharacterGroupComponent からダブルクリックで開かれる(UIPanelComponent がラップ)。
 * 背景画像付きエリアに部位(parts)を相対座標で配置表示する。
 * CardStackListComponent と同じパターン(PanelService.open で生成、@Input を後設定)。
 */
@Component({
  selector: 'character-group-parts',
  templateUrl: './character-group-parts.component.html',
  styleUrls: ['./character-group-parts.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CharacterGroupPartsPanelComponent implements OnInit, OnDestroy {
  @Input() characterGroup: GameCharacterGroup = null;

  get gridSize(): number { return 50; }

  get parts(): GameCharacter[] { return this.characterGroup?.parts ?? []; }

  get backgroundImage(): ImageFile {
    const id = this.characterGroup?.backgroundImageIdentifier;
    if (!id) return ImageFile.Empty;
    return ImageStorage.instance.get(id) ?? ImageFile.Empty;
  }

  get areaWidthPx(): number { return (this.characterGroup?.areaWidth ?? 6) * this.gridSize; }
  get areaHeightPx(): number { return (this.characterGroup?.areaHeight ?? 6) * this.gridSize; }

  constructor(
    private panelService: PanelService,
    private modalService: ModalService,
    private contextMenuService: ContextMenuService,
    private pointerDeviceService: PointerDeviceService,
    private changeDetector: ChangeDetectorRef,
    private tabletopService: TabletopService,
  ) { }

  /** 追加対象として選択中のキャラ識別子(プルダウン用) */
  selectedCharacterId: string = '';

  /**
   * 追加候補: 卓上のキャラクターのうち、まだこのグループに入っていないもの。
   */
  get availableCharacters(): GameCharacter[] {
    if (!this.characterGroup) return [];
    const partIds = new Set(this.parts.map(p => p.identifier));
    return this.tabletopService.characters.filter(c => !partIds.has(c.identifier));
  }

  /**
   * 選択中のキャラをこのグループの部位として追加。
   */
  addSelectedCharacter() {
    if (!this.characterGroup || !this.selectedCharacterId) return;
    const target = ObjectStore.instance.get<GameCharacter>(this.selectedCharacterId);
    if (target) {
      this.characterGroup.addPart(target);
    }
    this.selectedCharacterId = '';
  }

  /**
   * 指定部位をグループから外す(卓面に戻す)。
   */
  removePart(part: GameCharacter) {
    if (!this.characterGroup) return;
    this.characterGroup.removePart(part);
  }

  /**
   * 部位の Alt+クリックで個別にターゲットをトグル。
   * 普通のコマと同じ挙動(targeted フラグ + CHK_TARGET_CHANGE イベント)。
   */
  onPartMouseDown(event: MouseEvent, part: GameCharacter) {
    if (!part) return;
    if (event.altKey) {
      event.stopPropagation();
      event.preventDefault();
      part.targeted = !part.targeted;
      EventSystem.trigger('CHK_TARGET_CHANGE', { identifier: part.identifier, className: part.aliasName });
    }
  }

  // ===== 部位のドラッグ移動(パネル専用・appMovable 不使用) =====
  @ViewChild('partsArea') partsAreaRef: ElementRef<HTMLElement>;
  private draggingPart: GameCharacter = null;
  private dragOffsetX = 0;
  private dragOffsetY = 0;
  private dragMoveHandler: (e: MouseEvent) => void = null;
  private dragEndHandler: (e: MouseEvent) => void = null;
  private dragTouchMoveHandler: (e: TouchEvent) => void = null;
  private dragTouchEndHandler: (e: TouchEvent) => void = null;

  /**
   * 部位のドラッグ開始。マウス/タッチ座標からエリア内ローカル座標を計算して location を更新する。
   */
  onPartDragStart(event: MouseEvent | TouchEvent, part: GameCharacter) {
    if (!this.characterGroup || !part || !this.partsAreaRef) return;
    event.preventDefault();
    event.stopPropagation();
    this.draggingPart = part;

    const areaRect = this.partsAreaRef.nativeElement.getBoundingClientRect();
    const point = this.getPoint(event);
    // 部位の左上ではなく中心を掴んだ感じにするため、現在位置との差をオフセットに持つ
    this.dragOffsetX = point.x - areaRect.left - part.location.x;
    this.dragOffsetY = point.y - areaRect.top - part.location.y;

    this.dragMoveHandler = (e) => this.onPartDragMove(e);
    this.dragEndHandler = () => this.onPartDragEnd();
    this.dragTouchMoveHandler = (e) => this.onPartDragMove(e);
    this.dragTouchEndHandler = () => this.onPartDragEnd();

    document.addEventListener('mousemove', this.dragMoveHandler);
    document.addEventListener('mouseup', this.dragEndHandler);
    document.addEventListener('touchmove', this.dragTouchMoveHandler, { passive: false });
    document.addEventListener('touchend', this.dragTouchEndHandler);
  }

  private onPartDragMove(event: MouseEvent | TouchEvent) {
    if (!this.draggingPart || !this.partsAreaRef) return;
    event.preventDefault();
    const areaRect = this.partsAreaRef.nativeElement.getBoundingClientRect();
    const point = this.getPoint(event);
    let x = point.x - areaRect.left - this.dragOffsetX;
    let y = point.y - areaRect.top - this.dragOffsetY;
    // エリア内にクリップ
    x = Math.max(0, Math.min(x, areaRect.width));
    y = Math.max(0, Math.min(y, areaRect.height));
    // location は新しいオブジェクトでセットしないと同期されない(@SyncVar)
    this.draggingPart.location = { name: this.draggingPart.location.name, x, y };
  }

  private onPartDragEnd() {
    // 同期を確定
    if (this.draggingPart) {
      const loc = this.draggingPart.location;
      this.draggingPart.location = { name: loc.name, x: loc.x, y: loc.y };
    }
    this.draggingPart = null;
    document.removeEventListener('mousemove', this.dragMoveHandler);
    document.removeEventListener('mouseup', this.dragEndHandler);
    document.removeEventListener('touchmove', this.dragTouchMoveHandler);
    document.removeEventListener('touchend', this.dragTouchEndHandler);
    this.dragMoveHandler = null;
    this.dragEndHandler = null;
    this.dragTouchMoveHandler = null;
    this.dragTouchEndHandler = null;
  }

  private getPoint(event: MouseEvent | TouchEvent): { x: number; y: number } {
    if ('touches' in event && event.touches.length > 0) {
      return { x: event.touches[0].clientX, y: event.touches[0].clientY };
    }
    if ('clientX' in event) {
      return { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY };
    }
    return { x: 0, y: 0 };
  }

  /**
   * 背景画像を選択(ゲームテーブル設定と同じ FileSelecter モーダルパターン)。
   */
  openBackgroundImageModal() {
    if (!this.characterGroup) return;
    this.modalService.open<string>(FileSelecterComponent, { isAllowedEmpty: true }).then(value => {
      if (!this.characterGroup) return;
      // isAllowedEmpty で空選択(クリア)も許可。value が空文字なら背景なし。
      this.characterGroup.backgroundImageIdentifier = value || '';
      this.characterGroup.update();
    });
  }

  // ===== 部位の個別操作(普通のコマと同等) =====

  /**
   * 指定部位のバフ一覧(テキストバフ + 自動バフ)。
   * game-character.component の buffNum/hasBuffTags 相当。
   */
  getPartBuffs(part: GameCharacter): string[] {
    const buffs: string[] = [];
    const buffEl = part.buffDataElement;
    if (buffEl && buffEl.children.length > 0) {
      for (const cat of buffEl.children) {
        if (cat instanceof DataElement) {
          for (const b of cat.children) {
            if (b instanceof DataElement && b.name) buffs.push(b.name);
          }
        }
      }
    }
    // 自動バフ(アドバンスモード)
    if (this.isAdvancedMode && part.getAutoBuffs) {
      for (const ab of part.getAutoBuffs()) {
        if (ab.name) buffs.push(ab.name);
      }
    }
    return buffs;
  }

  get isAdvancedMode(): boolean {
    return this.tabletopService.currentTable?.roomMode === 'advanced';
  }

  /**
   * 部位の右クリックメニュー(詳細/チャパレ/VN/所有権切り離し)。
   * game-character.component の onContextMenu を簡略化して踏襲。
   */
  onPartContextMenu(event: Event, part: GameCharacter) {
    event.stopPropagation();
    event.preventDefault();
    if (!part) return;

    const position = this.pointerDeviceService.pointers[0];
    const actions: ContextMenuAction[] = [
      { name: '詳細を表示', action: () => this.showDetail(part) },
      { name: 'チャットパレットを表示', action: () => this.showChatPalette(part) },
      { name: 'リモコンを表示', action: () => this.showRemoteController(part) },
      { name: 'VNステージに送る', action: () => this.sendToVnStage(part) },
      { name: 'グループから外す', action: () => { this.characterGroup.removePart(part); SoundEffect.play(PresetSound.cardPut); } },
    ];
    this.contextMenuService.open(position, actions, part.name);
  }

  private showDetail(gameObject: GameCharacter) {
    let coordinate = this.pointerDeviceService.pointers[0];
    let option: PanelOption = { left: coordinate.x - 200, top: coordinate.y - 300, width: 400, height: 600 };
    let component = this.panelService.open<GameCharacterSheetComponent>(GameCharacterSheetComponent, option);
    component.tabletopObject = gameObject;
  }

  private showChatPalette(gameObject: GameCharacter) {
    let coordinate = this.pointerDeviceService.pointers[0];
    let option: PanelOption = { left: coordinate.x - 200, top: coordinate.y - 300, width: 400, height: 600 };
    let component = this.panelService.open<ChatPaletteComponent>(ChatPaletteComponent, option);
    component.character = gameObject;
  }

  private showRemoteController(gameObject: GameCharacter) {
    let coordinate = this.pointerDeviceService.pointers[0];
    let option: PanelOption = { left: coordinate.x - 200, top: coordinate.y - 300, width: 400, height: 600 };
    let component = this.panelService.open<RemoteControllerComponent>(RemoteControllerComponent, option);
    component.character = gameObject;
  }

  private sendToVnStage(part: GameCharacter) {
    EventSystem.trigger('VN_STAGE_SELECT_CHARACTER', { characterId: part.identifier });
  }

  ngOnInit() {
    Promise.resolve().then(() => {
      if (this.characterGroup) this.panelService.title = this.characterGroup.name + ' の部位';
    });
    EventSystem.register(this)
      .on('UPDATE_GAME_OBJECT', event => {
        let object = ObjectStore.instance.get(event.data.identifier);
        if (!this.characterGroup || !object) return;
        // グループ自身か部位(子孫)の変更で再描画
        if ((this.characterGroup === object)
          || (object instanceof ObjectNode && this.characterGroup.contains(object))) {
          this.changeDetector.markForCheck();
        }
      })
      .on('DELETE_GAME_OBJECT', event => {
        if (this.characterGroup && this.characterGroup.identifier === event.data.identifier) {
          this.panelService.close();
        }
      });
  }

  ngOnDestroy() {
    EventSystem.unregister(this);
  }

  close() {
    this.panelService.close();
  }

  trackByIdentifier(index: number, part: GameCharacter): string {
    return part ? part.identifier : index.toString();
  }
}
