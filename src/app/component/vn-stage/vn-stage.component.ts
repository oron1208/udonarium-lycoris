import { Component, ElementRef, HostBinding, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';

import { ChatMessage, ChatMessageTargetContext } from '@udonarium/chat-message';
import { ChatTab } from '@udonarium/chat-tab';
import { ImageFile } from '@udonarium/core/file-storage/image-file';
import { ImageStorage } from '@udonarium/core/file-storage/image-storage';
import { ServerMediaStorage } from '@udonarium/core/file-storage/server-media-storage';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { EventSystem, Network } from '@udonarium/core/system';
import { GameCharacter } from '@udonarium/game-character';
import { DiceBot } from '@udonarium/dice-bot';
import { ChatMessageService } from 'service/chat-message.service';
import { GmModeService } from 'service/gm-mode.service';
import { PointerDeviceService } from 'service/pointer-device.service';
import { TabletopService } from 'service/tabletop.service';

const BUBBLE_MS = 8000;
const SPEAKING_MS = 2500;
const MAX_ACTORS = 6;
const PORTRAIT_FADE_MS = 160;
const PORTRAIT_SCALE_MIN = 0.5;
const PORTRAIT_SCALE_MAX = 2.0;
const PORTRAIT_SCALE_STEP = 0.1;

interface VnActor {
  characterId: string;
  name: string;
  tachieIndex: number;
  imageIdentifier: string;
  portraitScale: number;
  previousImageIdentifier: string;
  isPortraitFading: boolean;
  portraitFadeTimer: any;
  text: string;
  enterKey: number;
  speakingUntil: number;
  bubbleUntil: number;
  lastSpokeAt: number;
  isEntering: boolean;
  // per-actor typewriter state
  displayedText: string;
  typewriterIndex: number;
  typewriterTimer: any;
  lastBubbleUntil: number;
  bubbleKey: number;
  // Per-actor custom layout
  customOffsetX: number;
  customOffsetY: number;
  portraitWidth: number;
  portraitHeight: number;
  customZ: number;
  aspectLocked: boolean;
}

@Component({
  selector: 'vn-stage',
  templateUrl: './vn-stage.component.html',
  styleUrls: ['./vn-stage.component.css']
})
export class VnStageComponent implements OnInit, OnDestroy {
  @HostBinding('class.vn-has-front-pinned') get hasFrontPinnedSubPanel(): boolean { return this.paletteFrontPinned || this.logFrontPinned; }
  @ViewChild('logScroll', { static: false }) logScrollEl: ElementRef;
  @ViewChild('paletteScroll', { static: false }) paletteScrollEl: ElementRef;

  actors: VnActor[] = [];
  selectedCharacterId: string = '';
  selectedTachieIndex: number = 0;
  inputText: string = '';
  secretMode: boolean = false;
  verticalOffset: number = this.loadNumber('udonarium.vnStage.verticalOffset.v1', 0);
  stageHeightPercent: number = this.loadNumber('udonarium.vnStage.heightPercent.v1', 58);
  now: number = Date.now();
  isHotbarVisible: boolean = false;
  isAutoFit: boolean = true;
  affectPiece: boolean = false;
  sendPortrait: boolean = true;

  // ── Stage portrait free-layout ──
  stageSelectedId: string = '';
  moveMode: boolean = false;
  private portraitDragMode: 'move' | 'resize' | null = null;
  private portraitDragEdge: string = '';
  private portraitDragStartX = 0;
  private portraitDragStartY = 0;
  private portraitDragStartOffX = 0;
  private portraitDragStartOffY = 0;
  private portraitDragStartW = 0;
  private portraitDragStartH = 0;
  private portraitDragAspect = 1;
  private draggingActor: VnActor | null = null;

  // Chat log panel
  chatLogExpanded: boolean = false;

  // ── Detached panel state ──
  paletteDetached: boolean = false;
  logDetached: boolean = false;
  paletteFloatX: number = -1;
  paletteFloatY: number = -1;
  paletteFloatW: number = 360;
  paletteFloatH: number = 400;
  logFloatX: number = -1;
  logFloatY: number = -1;
  logFloatW: number = 360;
  logFloatH: number = 300;
  paletteZIndex: number = 3000;
  logZIndex: number = 3001;
  paletteFrontPinned: boolean = false;
  logFrontPinned: boolean = false;
  private subPanelZCounter: number = 3001;
  private panelDragTarget: 'palette' | 'log' | null = null;
  private subDragOffsetX = 0;
  private subDragOffsetY = 0;
  private subDragPanelW = 0;
  private subDragPanelH = 0;
  private subResizeStartW = 0;
  private subResizeStartH = 0;
  private subResizeStartMX = 0;
  private subResizeStartMY = 0;
  private panelResizeTarget: 'palette' | 'log' | null = null;
  chatLogPinned: boolean = false;
  selectedTabIdentifier: string = '';
  selectedDiceBot: string = 'DiceBot';
  private chatLogFadeTimer: any = null;
  chatLogVisible: boolean = true;

  // Typewriter effect — per actor (stored in VnActor)

  readonly diceTypes = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100'];
  diceRowCollapsed: boolean = false;

  // ── Floating panel state ──
  panelX: number = -1; // -1 = use default (right-aligned)
  panelY: number = -1;
  panelW: number = 450;
  panelH: number = -1; // -1 = auto
  panelLocked: boolean = false;
  isPanelDragging: boolean = false;
  isPanelResizing: boolean = false;
  private dragOffsetX = 0;
  private dragOffsetY = 0;
  private dragPanelW = 0;
  private dragPanelH = 0;
  private resizeStartW = 0;
  private resizeStartH = 0;
  private resizeStartMouseX = 0;
  private resizeStartMouseY = 0;

  private loadingImages: Set<string> = new Set();
  private clockTimer: NodeJS.Timer = null;
  private enterCounter = 0;
  private diceBuffer: string = '';
  private diceCounters: Map<string, number> = new Map();

  // Cache for characters getter to avoid repeated ObjectStore scans during sync
  private _charactersCache: GameCharacter[] | null = null;
  private _charactersCacheTimer: any = null;
  private syncGraceTimer: any = null;

  get isPointerDragging(): boolean { return this.pointerDeviceService.isDragging; }

  constructor(
    public chatMessageService: ChatMessageService,
    private ngZone: NgZone,
    private gmModeService: GmModeService,
    private pointerDeviceService: PointerDeviceService,
    private tabletopService: TabletopService
  ) { }

  ngOnInit() {
    this.selectedCharacterId = this.loadSelectedCharacterId();
    this.ensureSelectedCharacter();
    // initialize imageId for selected character
    const initChar = ObjectStore.instance.get<GameCharacter>(this.selectedCharacterId);
    if (initChar instanceof GameCharacter && initChar.imageDataElement) {
      const children = initChar.imageDataElement.children || [];
      if (children.length > 0) this.selectedImageId = String((children[0] as any)?.value ?? '');
    }

    try { this.isHotbarVisible = localStorage.getItem('udonarium.macroHotbar.visible.v1') !== '0'; } catch (_) { this.isHotbarVisible = true; }
    try { this.isAutoFit = localStorage.getItem('udonarium.vnStage.autoFit.v1') === '1'; } catch (_) { }
    try { this.affectPiece = localStorage.getItem('udonarium.vnStage.affectPiece.v1') === '1'; } catch (_) { }
    try { this.secretMode = localStorage.getItem('udonarium.vnStage.secretMode.v1') === '1'; } catch (_) { }
    try {
      const saved = localStorage.getItem('udonarium.vnPanel.pos.v1');
      if (saved) { const p = JSON.parse(saved); this.panelX = p.x ?? -1; this.panelY = p.y ?? -1; this.panelW = Math.max(p.w ?? 450, 450); this.panelH = p.h ?? -1; this.panelLocked = !!p.locked; this.clampMainPanelToViewport(); }
    } catch (_) { }
    this.loadSubPanelState();
    try { this.sendPortrait = localStorage.getItem('udonarium.vnStage.sendPortrait.v1') !== 'false'; } catch (_) { }

    // Defer event registration and timer to avoid interfering with initial sync
    // During SYNCHRONIZE_GAME_OBJECT, vn-stage must be completely inert
    // One-time cleanup of bad layout values from drag bug
    try {
      const keys = Object.keys(localStorage).filter(k => k.startsWith('udonarium.vnStage.actorLayout.'));
      for (const k of keys) {
        const d = JSON.parse(localStorage.getItem(k) || '{}');
        if (Math.abs(d.customOffsetX || 0) > 50 || Math.abs(d.customOffsetY || 0) > 50) {
          localStorage.removeItem(k);
        }
      }
    } catch (_) { }

    this.syncGraceTimer = setTimeout(() => {
      this.registerEventHandlers();
      this.clockTimer = setInterval(() => {
        this.ngZone.run(() => { this.now = Date.now(); });
      }, 100);
    }, 1000);
  }

  private registerEventHandlers() {
    EventSystem.register(this)
      .on('VN_STAGE_ADD', event => {
        if (event.isSendFromSelf) return;
        const d = event.data;
        if (!d || !d.characterId) return;
        this.ngZone.run(() => this.upsertActor(d.characterId, d.name, d.tachieIndex ?? 0, d.imageIdentifier || '', '', false, false, d.portraitScale));
      })
      .on('VN_STAGE_REMOVE', event => {
        if (event.isSendFromSelf) return;
        this.ngZone.run(() => this.removeActorInternal(event.data?.characterId));
      })
      .on('VN_STAGE_CLEAR', event => {
        if (event.isSendFromSelf) return;
        this.ngZone.run(() => { this.actors = []; });
      })
      .on('VN_STAGE_FULL', event => {
        if (event.isSendFromSelf) return;
        const list: any[] = event.data?.actors;
        if (!Array.isArray(list)) return;
        this.ngZone.run(() => {
          for (const a of list) {
            if (a?.characterId) this.upsertActor(a.characterId, a.name, a.tachieIndex ?? 0, a.imageIdentifier, '', false, false, a.portraitScale);
            if (a?.characterId) {
              const actor = this.findActor(a.characterId);
              if (actor) {
                actor.customOffsetX = Math.max(-50, Math.min(50, a.customOffsetX || 0));
                actor.customOffsetY = Math.max(-50, Math.min(50, a.customOffsetY || 0));
                actor.portraitWidth = Math.max(0, Math.min(1200, a.portraitWidth || 0));
                actor.portraitHeight = Math.max(0, Math.min(1200, a.portraitHeight || 0));
                actor.customZ = a.customZ || 0;
                actor.aspectLocked = a.aspectLocked !== false;
              }
            }
          }
        });
      })
      .on('MESSAGE_ADDED', event => {
        const message = ObjectStore.instance.get<ChatMessage>(event.data.messageIdentifier);
        if (!message) return;
        if (event.isSendFromSelf) {
          if (this.chatLogExpanded) {
            this.scrollLogToBottom();
            this.refreshChatLogFade();
          }
          return;
        }
        if (this.isDisplayableMessage(message)) {
          this.ngZone.run(() => this.applyChatMessage(message));
        }
        if (this.chatLogExpanded) {
          this.scrollLogToBottom();
          this.refreshChatLogFade();
        }
      })
      .on('CONNECT_PEER', event => {
        if (!event.isSendFromSelf) return;
        const peerId: string = event.data?.peerId;
        if (!peerId) return;
        const payload = this.actors.map(a => ({
          characterId: a.characterId, name: a.name, tachieIndex: a.tachieIndex, imageIdentifier: a.imageIdentifier, portraitScale: a.portraitScale,
          customOffsetX: a.customOffsetX || 0, customOffsetY: a.customOffsetY || 0, portraitWidth: a.portraitWidth || 0, portraitHeight: a.portraitHeight || 0, customZ: a.customZ || 0, aspectLocked: a.aspectLocked !== false
        }));
        EventSystem.call('VN_STAGE_FULL', { actors: payload }, peerId);
      })
      .on('MACRO_HOTBAR_VISIBILITY_CHANGED', event => {
        this.ngZone.run(() => { this.isHotbarVisible = !!event.data?.visible; });
      })
      .on('VN_STAGE_VISIBILITY_CHANGED', event => {
        if (event.data?.visible) {
          this.restoreActorsFromTable();
        }
      })
      .on('VN_RESET_UI', event => {
        this.ngZone.run(() => {
          this.panelX = -1;
          this.panelY = -1;
          this.panelW = 450;
          this.panelH = -1;
          this.panelLocked = false;
          this.stageHeightPercent = 58;
          this.paletteDetached = false;
          this.logDetached = false;
          this.resetSubPanelPositions();
          this.savePanelState();
        });
      })
      .on('VN_STAGE_PIECE_SCALE_CHANGED', event => { })
      .on('VN_STAGE_AUTOFIT_CHANGED', event => {
        this.ngZone.run(() => { this.isAutoFit = event.data?.autoFit ?? true; });
      })
      .on('VN_STAGE_HEIGHT_CHANGED', event => {
        this.ngZone.run(() => { this.stageHeightPercent = this.clampStageHeight(event.data?.heightPercent); });
      })
      .on('VN_STAGE_SELECT_CHARACTER', event => {
        const characterId = event.data?.characterId;
        if (!characterId) return;
        this.ngZone.run(() => this.selectCharacterFromBoard(characterId));
      })
      .on('VN_STAGE_REQUEST', event => {
        // Another peer is asking for our VN actors — send them VN_STAGE_FULL
        const requesterPeerId = event.data?.requesterPeerId;
        if (!requesterPeerId) return;
        const payload = this.actors.map(a => ({
          characterId: a.characterId, name: a.name, tachieIndex: a.tachieIndex, imageIdentifier: a.imageIdentifier, portraitScale: a.portraitScale,
          customOffsetX: a.customOffsetX || 0, customOffsetY: a.customOffsetY || 0, portraitWidth: a.portraitWidth || 0, portraitHeight: a.portraitHeight || 0, customZ: a.customZ || 0, aspectLocked: a.aspectLocked !== false
        }));
        EventSystem.call('VN_STAGE_FULL', { actors: payload }, requesterPeerId);
      })
      .on('VN_STAGE_LAYOUT', event => {
        if (event.isSendFromSelf) return;
        const d = event.data;
        if (!d?.characterId) return;
        this.ngZone.run(() => {
          const actor = this.findActor(d.characterId);
          if (!actor) return;
          actor.customOffsetX = Math.max(-50, Math.min(50, d.customOffsetX || 0));
          actor.customOffsetY = Math.max(-50, Math.min(50, d.customOffsetY || 0));
          actor.portraitWidth = Math.max(0, Math.min(1200, d.portraitWidth || 0));
          actor.portraitHeight = Math.max(0, Math.min(1200, d.portraitHeight || 0));
          actor.customZ = d.customZ || 0;
          actor.aspectLocked = d.aspectLocked !== false;
        });
      })
      // Fallback: detect ChatMessage syncs from other peers (MESSAGE_ADDED only fires locally)
      .on('UPDATE_GAME_OBJECT', 1, event => {
        if (event.isSendFromSelf) return;
        const obj = ObjectStore.instance.get<ChatMessage>(event.data?.identifier);
        if (!(obj instanceof ChatMessage)) return;
        if (!obj.text || obj.isSystem || obj.isSecret || obj.isDicebot) return;
        const charId = obj.sendFrom || obj.from;
        if (!charId) return;
        const actor = this.findActor(charId);
        if (!actor) return;
        if (actor.text === obj.text && Date.now() - actor.lastSpokeAt < 3000) return;
        this.ngZone.run(() => this.applyChatMessage(obj));
      });
    console.log('[VN] Event handlers registered after sync grace period');

    // Request VN_STAGE_FULL from all existing peers (handles late VN activation)
    const peers = Network.peerContexts.filter(p => p.peerId !== Network.peerContext?.peerId);
    for (const peer of peers) {
      EventSystem.call('VN_STAGE_REQUEST', { requesterPeerId: Network.peerContext?.peerId }, peer.peerId);
    }
  }

  /** Scan table characters and restore actors for those with tachie images set */
  private restoreActorsFromTable() {
    const chars = ObjectStore.instance.getObjects<GameCharacter>(GameCharacter);
    for (const c of chars) {
      if (!c || c.nonTalkFlag) continue;
      if (!c.imageDataElement) continue;
      const children = c.imageDataElement.children || [];
      if (children.length === 0) continue;
      const imageIdentifier = String(children[c.selectedTachieNum]?.value || '');
      if (!imageIdentifier) continue;
      // Only add if not already an actor
      if (this.findActor(c.identifier)) continue;
      this.upsertActor(c.identifier, c.name, c.selectedTachieNum, imageIdentifier, '', false, false);
    }
  }

  ngOnDestroy() {
    EventSystem.unregister(this);
    if (this.syncGraceTimer) clearTimeout(this.syncGraceTimer);
    if (this.clockTimer) clearInterval(this.clockTimer);
    if (this.chatLogFadeTimer) clearTimeout(this.chatLogFadeTimer);
    if (this.paletteFadeTimer) clearTimeout(this.paletteFadeTimer);
    if (this.indexFadeTimer) clearTimeout(this.indexFadeTimer);
    if (this._charactersCacheTimer) clearTimeout(this._charactersCacheTimer);
    for (const a of this.actors) {
      if (a.typewriterTimer) { clearTimeout(a.typewriterTimer); clearInterval(a.typewriterTimer); }
    }
  }

  /* ═══════════ floating panel drag / resize ═══════════ */

  get panelStyle(): { [key: string]: string } {
    this.clampMainPanelToViewport();
    const s: { [key: string]: string } = {};
    if (this.panelX >= 0) { s['left'] = this.panelX + 'px'; s['right'] = 'auto'; s['bottom'] = 'auto'; }
    if (this.panelY >= 0) s['top'] = this.panelY + 'px';
    if (this.panelW > 0) s['width'] = this.panelW + 'px';
    if (this.panelH > 0) { s['max-height'] = 'none'; s['height'] = this.panelH + 'px'; }
    return s;
  }

  onPanelDragStart(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (this.panelLocked) return;
    this.isPanelDragging = true;
    const rect = (e.currentTarget as HTMLElement).closest('.vn-control').getBoundingClientRect();
    this.dragOffsetX = e.clientX - rect.left;
    this.dragOffsetY = e.clientY - rect.top;
    this.dragPanelW = rect.width;
    this.dragPanelH = rect.height;
    // fix to absolute position on first drag
    this.panelX = rect.left;
    this.panelY = rect.top;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  onPanelDragMove(e: PointerEvent) {
    if (!this.isPanelDragging) return;
    e.preventDefault();
    const nx = Math.max(0, Math.min(window.innerWidth - this.dragPanelW, e.clientX - this.dragOffsetX));
    const ny = Math.max(0, Math.min(window.innerHeight - this.dragPanelH, e.clientY - this.dragOffsetY));
    this.panelX = nx;
    this.panelY = ny;
  }

  onPanelDragEnd(e: PointerEvent) {
    if (!this.isPanelDragging) return;
    this.isPanelDragging = false;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch (_) { }
    this.savePanelState();
  }

  onPanelResizeStart(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (this.panelLocked) return;
    this.isPanelResizing = true;
    const rect = (e.currentTarget as HTMLElement).closest('.vn-control').getBoundingClientRect();
    this.resizeStartW = rect.width;
    this.resizeStartH = rect.height;
    this.resizeStartMouseX = e.clientX;
    this.resizeStartMouseY = e.clientY;
    // fix position
    this.panelX = rect.left;
    this.panelY = rect.top;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  onPanelResizeMove(e: PointerEvent) {
    if (!this.isPanelResizing) return;
    e.preventDefault();
    const dx = e.clientX - this.resizeStartMouseX;
    const dy = e.clientY - this.resizeStartMouseY;
    this.panelW = Math.max(280, Math.min(window.innerWidth - this.panelX - 10, this.resizeStartW + dx));
    this.panelH = Math.max(200, Math.min(window.innerHeight - this.panelY - 10, this.resizeStartH + dy));
  }

  onPanelResizeEnd(e: PointerEvent) {
    if (!this.isPanelResizing) return;
    this.isPanelResizing = false;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch (_) { }
    this.savePanelState();
  }

  resetPanelPosition() {
    this.panelX = -1;
    this.panelY = -1;
    this.panelW = 450;
    this.panelH = -1;
    this.panelLocked = false;
    this.savePanelState();
    setTimeout(() => this.resetSubPanelPositions(), 0);
  }

  togglePanelLock(event?: Event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    this.panelLocked = !this.panelLocked;
    this.clampMainPanelToViewport();
    this.savePanelState();
  }

  private savePanelState() {
    try {
      localStorage.setItem('udonarium.vnPanel.pos.v1', JSON.stringify({ x: this.panelX, y: this.panelY, w: this.panelW, h: this.panelH, locked: this.panelLocked }));
    } catch (_) { }
  }

  private clampMainPanelToViewport() {
    const viewportW = Math.max(1, window.innerWidth || 1);
    const viewportH = Math.max(1, window.innerHeight || 1);
    this.panelW = Math.max(280, Math.min(this.panelW || 450, Math.max(280, viewportW - 10)));
    if (this.panelH > 0) this.panelH = Math.max(200, Math.min(this.panelH, Math.max(200, viewportH - 10)));
    if (this.panelX >= 0) this.panelX = this.clampNumber(this.panelX, 0, Math.max(0, viewportW - this.panelW));
    if (this.panelY >= 0) this.panelY = this.clampNumber(this.panelY, 0, Math.max(0, viewportH - (this.panelH > 0 ? this.panelH : 220)));
  }

  /* ═══════════ sub-panel (palette / chatlog) floating ═══════════ */

  togglePaletteDetached() {
    this.paletteDetached = !this.paletteDetached;
    if (this.paletteDetached && this.paletteFloatX < 0) {
      const rect = (document.querySelector('.vn-palette-wrap') as HTMLElement)?.getBoundingClientRect();
      if (rect) { this.paletteFloatX = rect.left; this.paletteFloatY = rect.top; }
      else { this.paletteFloatX = 20; this.paletteFloatY = 80; }
    }
    this.saveSubPanelState();
  }

  toggleLogDetached() {
    this.logDetached = !this.logDetached;
    if (this.logDetached && this.logFloatX < 0) {
      const rect = (document.querySelector('.vn-chat-log') as HTMLElement)?.getBoundingClientRect();
      if (rect) { this.logFloatX = rect.left; this.logFloatY = rect.top; }
      else { this.logFloatX = 20; this.logFloatY = 300; }
    }
    this.saveSubPanelState();
  }

  get paletteFloatStyle(): { [k: string]: string } {
    this.clampSubPanelToViewport('palette');
    const x = this.paletteFloatX >= 0 ? this.paletteFloatX : 20;
    const y = this.paletteFloatY >= 0 ? this.paletteFloatY : 80;
    return {
      'left': x + 'px', 'top': y + 'px',
      'width': this.paletteFloatW + 'px', 'height': this.paletteFloatH + 'px',
      'z-index': String(this.paletteFrontPinned ? 9000 : this.paletteZIndex)
    };
  }

  get logFloatStyle(): { [k: string]: string } {
    this.clampSubPanelToViewport('log');
    const x = this.logFloatX >= 0 ? this.logFloatX : 20;
    const y = this.logFloatY >= 0 ? this.logFloatY : 80;
    return {
      'left': x + 'px', 'top': y + 'px',
      'width': this.logFloatW + 'px', 'height': this.logFloatH + 'px',
      'z-index': String(this.logFrontPinned ? 8999 : this.logZIndex)
    };
  }

  bringSubPanelToFront(target: 'palette' | 'log') {
    if (target === 'palette') {
      if (!this.paletteFrontPinned) this.paletteZIndex = ++this.subPanelZCounter;
    } else {
      if (!this.logFrontPinned) this.logZIndex = ++this.subPanelZCounter;
    }
    this.saveSubPanelState();
  }

  toggleSubPanelFrontPin(target: 'palette' | 'log') {
    if (target === 'palette') {
      this.ensureSubPanelPosition('palette');
      this.paletteFrontPinned = !this.paletteFrontPinned;
      this.clampSubPanelToViewport('palette');
      if (!this.paletteFrontPinned) this.paletteZIndex = ++this.subPanelZCounter;
    } else {
      this.ensureSubPanelPosition('log');
      this.logFrontPinned = !this.logFrontPinned;
      this.clampSubPanelToViewport('log');
      if (!this.logFrontPinned) this.logZIndex = ++this.subPanelZCounter;
    }
    this.saveSubPanelState();
  }

  private isSubPanelPositionPinned(target: 'palette' | 'log'): boolean {
    return target === 'palette' ? this.paletteFrontPinned : this.logFrontPinned;
  }

  private ensureSubPanelPosition(target: 'palette' | 'log') {
    if (target === 'palette' && (this.paletteFloatX < 0 || this.paletteFloatY < 0)) {
      const rect = (document.querySelector('.vn-palette-wrap') as HTMLElement)?.getBoundingClientRect();
      this.paletteFloatX = rect ? rect.left : 20;
      this.paletteFloatY = rect ? rect.top : 80;
    }
    if (target === 'log' && (this.logFloatX < 0 || this.logFloatY < 0)) {
      const rect = (document.querySelector('.vn-chat-log') as HTMLElement)?.getBoundingClientRect();
      this.logFloatX = rect ? rect.left : Math.min(400, Math.max(20, window.innerWidth - this.logFloatW - 20));
      this.logFloatY = rect ? rect.top : 80;
    }
  }

  resetSubPanelPositions() {
    this.paletteFloatW = 360;
    this.paletteFloatH = 400;
    this.logFloatW = 360;
    this.logFloatH = 300;
    const rect = (document.querySelector('.vn-control') as HTMLElement)?.getBoundingClientRect();
    const baseRight = rect ? rect.right : window.innerWidth - 18;
    const baseTop = rect ? rect.top : window.innerHeight - (this.isHotbarVisible ? 92 : 18) - 320;
    this.paletteFloatX = Math.max(0, Math.min(window.innerWidth - this.paletteFloatW, baseRight - this.paletteFloatW));
    this.paletteFloatY = Math.max(0, Math.min(window.innerHeight - this.paletteFloatH, baseTop - this.paletteFloatH - 8));
    this.logFloatX = Math.max(0, Math.min(window.innerWidth - this.logFloatW, baseRight - this.logFloatW));
    this.logFloatY = Math.max(0, Math.min(window.innerHeight - this.logFloatH, baseTop - this.logFloatH - 8));
    this.paletteZIndex = 3000;
    this.logZIndex = 3001;
    this.subPanelZCounter = 3001;
    this.saveSubPanelState();
  }

  closeSubPanel(target: 'palette' | 'log', event?: Event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (target === 'palette') {
      this.paletteExpanded = false;
    } else {
      this.chatLogExpanded = false;
    }
    if (this.panelDragTarget === target) this.panelDragTarget = null;
    if (this.panelResizeTarget === target) this.panelResizeTarget = null;
    this.saveSubPanelState();
  }

  onSubDragStart(target: 'palette' | 'log', e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    if (this.isSubPanelPositionPinned(target)) return;
    this.bringSubPanelToFront(target);
    this.panelDragTarget = target;
    const sel = target === 'palette' ? '.vn-palette-wrap' : '.vn-chat-log';
    const rect = (e.currentTarget as HTMLElement).closest(sel)?.getBoundingClientRect();
    if (!rect) return;
    this.subDragOffsetX = e.clientX - rect.left;
    this.subDragOffsetY = e.clientY - rect.top;
    this.subDragPanelW = rect.width;
    this.subDragPanelH = rect.height;
    if (target === 'palette') { this.paletteFloatX = rect.left; this.paletteFloatY = rect.top; }
    else { this.logFloatX = rect.left; this.logFloatY = rect.top; }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  onSubDragMove(target: 'palette' | 'log', e: PointerEvent) {
    if (this.panelDragTarget !== target) return;
    e.preventDefault();
    const nx = Math.max(0, Math.min(window.innerWidth - this.subDragPanelW, e.clientX - this.subDragOffsetX));
    const ny = Math.max(0, Math.min(window.innerHeight - this.subDragPanelH, e.clientY - this.subDragOffsetY));
    if (target === 'palette') { this.paletteFloatX = nx; this.paletteFloatY = ny; }
    else { this.logFloatX = nx; this.logFloatY = ny; }
  }

  onSubDragEnd(target: 'palette' | 'log', e: PointerEvent) {
    if (this.panelDragTarget !== target) return;
    this.panelDragTarget = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch (_) { }
    this.saveSubPanelState();
  }

  onSubResizeStart(target: 'palette' | 'log', e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    if (this.isSubPanelPositionPinned(target)) return;
    this.panelResizeTarget = target;
    const sel = target === 'palette' ? '.vn-palette-wrap' : '.vn-chat-log';
    const rect = (e.currentTarget as HTMLElement).closest(sel)?.getBoundingClientRect();
    if (!rect) return;
    this.subResizeStartW = rect.width;
    this.subResizeStartH = rect.height;
    this.subResizeStartMX = e.clientX;
    this.subResizeStartMY = e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  onSubResizeMove(target: 'palette' | 'log', e: PointerEvent) {
    if (this.panelResizeTarget !== target) return;
    e.preventDefault();
    const dx = e.clientX - this.subResizeStartMX;
    const dy = e.clientY - this.subResizeStartMY;
    const currentX = target === 'palette' ? this.paletteFloatX : this.logFloatX;
    const currentY = target === 'palette' ? this.paletteFloatY : this.logFloatY;
    const w = Math.max(220, Math.min(window.innerWidth - Math.max(0, currentX) - 10, this.subResizeStartW + dx));
    const h = Math.max(150, Math.min(window.innerHeight - Math.max(0, currentY) - 10, this.subResizeStartH + dy));
    if (target === 'palette') { this.paletteFloatW = w; this.paletteFloatH = h; }
    else { this.logFloatW = w; this.logFloatH = h; }
  }

  onSubResizeEnd(target: 'palette' | 'log', e: PointerEvent) {
    if (this.panelResizeTarget !== target) return;
    this.panelResizeTarget = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch (_) { }
    this.saveSubPanelState();
  }

  private saveSubPanelState() {
    try {
      localStorage.setItem('udonarium.vnSubPanels.v1', JSON.stringify({
        paletteDetached: this.paletteDetached, paletteFloatX: this.paletteFloatX, paletteFloatY: this.paletteFloatY,
        paletteFloatW: this.paletteFloatW, paletteFloatH: this.paletteFloatH,
        logDetached: this.logDetached, logFloatX: this.logFloatX, logFloatY: this.logFloatY,
        logFloatW: this.logFloatW, logFloatH: this.logFloatH,
        paletteZIndex: this.paletteZIndex, logZIndex: this.logZIndex,
        paletteFrontPinned: this.paletteFrontPinned, logFrontPinned: this.logFrontPinned,
        subPanelZCounter: this.subPanelZCounter
      }));
    } catch (_) { }
  }

  private loadSubPanelState() {
    try {
      const s = JSON.parse(localStorage.getItem('udonarium.vnSubPanels.v1') || '{}');
      if (s.paletteDetached != null) {
        this.paletteDetached = s.paletteDetached; this.paletteFloatX = s.paletteFloatX ?? -1; this.paletteFloatY = s.paletteFloatY ?? -1;
        this.paletteFloatW = s.paletteFloatW ?? 360; this.paletteFloatH = s.paletteFloatH ?? 400;
      }
      if (s.logDetached != null) {
        this.logDetached = s.logDetached; this.logFloatX = s.logFloatX ?? -1; this.logFloatY = s.logFloatY ?? -1;
        this.logFloatW = s.logFloatW ?? 360; this.logFloatH = s.logFloatH ?? 300;
      }
      this.paletteZIndex = s.paletteZIndex ?? this.paletteZIndex;
      this.logZIndex = s.logZIndex ?? this.logZIndex;
      this.paletteFrontPinned = s.paletteFrontPinned ?? false;
      this.logFrontPinned = s.logFrontPinned ?? false;
      this.subPanelZCounter = Math.max(s.subPanelZCounter ?? this.subPanelZCounter, this.paletteZIndex, this.logZIndex);
      this.clampSubPanelToViewport('palette');
      this.clampSubPanelToViewport('log');
    } catch (_) { }
  }

  private clampSubPanelToViewport(target: 'palette' | 'log') {
    const viewportW = Math.max(1, window.innerWidth || 1);
    const viewportH = Math.max(1, window.innerHeight || 1);
    const minW = 220;
    const minH = 150;
    if (target === 'palette') {
      this.paletteFloatW = Math.max(minW, Math.min(this.paletteFloatW || 360, Math.max(minW, viewportW - 10)));
      this.paletteFloatH = Math.max(minH, Math.min(this.paletteFloatH || 400, Math.max(minH, viewportH - 10)));
      if (this.paletteFloatX >= 0) this.paletteFloatX = this.clampNumber(this.paletteFloatX, 0, Math.max(0, viewportW - this.paletteFloatW));
      if (this.paletteFloatY >= 0) this.paletteFloatY = this.clampNumber(this.paletteFloatY, 0, Math.max(0, viewportH - this.paletteFloatH));
    } else {
      this.logFloatW = Math.max(minW, Math.min(this.logFloatW || 360, Math.max(minW, viewportW - 10)));
      this.logFloatH = Math.max(minH, Math.min(this.logFloatH || 300, Math.max(minH, viewportH - 10)));
      if (this.logFloatX >= 0) this.logFloatX = this.clampNumber(this.logFloatX, 0, Math.max(0, viewportW - this.logFloatW));
      if (this.logFloatY >= 0) this.logFloatY = this.clampNumber(this.logFloatY, 0, Math.max(0, viewportH - this.logFloatH));
    }
  }

  private clampNumber(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
  }

  /* ═══════════ template helpers ═══════════ */

  get characters(): GameCharacter[] {
    if (this._charactersCache) return this._charactersCache;
    this._charactersCache = ObjectStore.instance.getObjects<GameCharacter>(GameCharacter)
      .filter(c => this.canUseCharacter(c))
      .sort((a, b) => a.name.localeCompare(b.name));
    // Invalidate cache after 2 seconds
    if (this._charactersCacheTimer) clearTimeout(this._charactersCacheTimer);
    this._charactersCacheTimer = setTimeout(() => { this._charactersCache = null; }, 2000);
    return this._charactersCache;
  }

  get isAdvancedRoom(): boolean { return this.tabletopService.currentTable?.roomMode === 'advanced'; }
  get isExtendedDiceBotEnabled(): boolean { return this.tabletopService.currentTable?.extendedDiceBotEnabled ?? false; }

  get selectedCharacter(): GameCharacter {
    const character = ObjectStore.instance.get<GameCharacter>(this.selectedCharacterId);
    return character instanceof GameCharacter ? character : null;
  }

  get isSelectedMyPiece(): boolean {
    const character = this.selectedCharacter;
    return !!character && (this.includesJsonId(character.ownerPeerIds, Network.peerId) || this.includesJsonId(character.ownerUserIds, Network.peerContext?.userId));
  }

  toggleSelectedMyPiece() {
    const character = this.selectedCharacter;
    if (!character) return;
    const owned = !this.isSelectedMyPiece;
    character.ownerPeerIds = this.setJsonId(character.ownerPeerIds, Network.peerId, owned);
    character.ownerUserIds = this.setJsonId(character.ownerUserIds, Network.peerContext?.userId, owned);
    if (owned && !character.sightEnabled) character.sightEnabled = true;
    character.update();
  }

  private canUseCharacter(c: GameCharacter): boolean {
    if (!c || c.nonTalkFlag) return false;
    const isGm = this.gmModeService.isGm;
    if (!isGm && c.visibility === 'gmOnly') return false;
    if (!isGm && !!c.secretDetails) return false;
    return true;
  }

  get chatTabs(): ChatTab[] { return this.chatMessageService.chatTabs; }

  get selectedTab(): ChatTab {
    if (!this.selectedTabIdentifier && this.chatTabs.length > 0) return this.chatTabs[0];
    return this.chatTabs.find(t => t.identifier === this.selectedTabIdentifier) || this.chatTabs[0];
  }

  get chatLogMessages(): ChatMessage[] {
    const tab = this.selectedTab;
    if (!tab) return [];
    return (tab.chatMessages || []).filter(m => this.canShowChatLogMessage(m)).slice(-80);
  }

  get diceBotInfos() { return DiceBot.diceBotInfos || []; }

  isSectionHeader(line: string): boolean {
    return !!(line && (line.match(/^\/\/---/) || line.match(/^◆/)));
  }

  sectionTitle(line: string): string {
    return line.replace(/^\/\/---+/, '').replace(/-+$/, '').replace(/^◆/, '');
  }

  get selectedPaletteLines(): string[] {
    const character = ObjectStore.instance.get<GameCharacter>(this.selectedCharacterId);
    if (!(character instanceof GameCharacter)) return [];
    const palette = character.chatPalette;
    if (!palette) return [];
    const lines = palette.getPalette();
    return lines.filter(l => l && !l.match(/^\/\/---/) && !l.match(/^◆/));
  }

  get selectedPaletteIndex(): { name: string; line: number }[] {
    const character = ObjectStore.instance.get<GameCharacter>(this.selectedCharacterId);
    if (!(character instanceof GameCharacter)) return [];
    const palette = character.chatPalette;
    if (!palette) return [];
    return palette.paletteIndex || [];
  }

  get selectedAllPaletteLines(): string[] {
    const character = ObjectStore.instance.get<GameCharacter>(this.selectedCharacterId);
    if (!(character instanceof GameCharacter)) return [];
    const palette = character.chatPalette;
    if (!palette) return [];
    return palette.getPalette();
  }

  get visiblePaletteLines(): string[] {
    const lines = this.selectedAllPaletteLines;
    const q = this.paletteSearchText.trim().toLowerCase();
    if (!q) return lines;
    return lines.filter(line => line && line.toLowerCase().includes(q));
  }

  paletteExpanded: boolean = false;
  indexExpanded: boolean = false;
  paletteVisible: boolean = true;
  indexVisible: boolean = true;
  paletteSearchText: string = '';
  selectedPaletteLine: string = null;
  private revealedSecrets: Set<string> = new Set();
  private paletteFadeTimer: any = null;
  private indexFadeTimer: any = null;
  scrollToIndex: number = -1;
  tachieCompactOverride: boolean = false;
  tachieExpandedOverride: boolean = false;
  tachieHoverPanelOpen: boolean = false;

  get hasInputText(): boolean { return this.inputText.trim().length > 0; }

  get debugInfo(): string {
    const actor = this.findActor(this.selectedCharacterId);
    return `actors=${this.actors.length} char=${this.selectedCharacterId || '-'} tachie=${this.selectedTachieIndex} img=${actor?.imageIdentifier || '-'} url=${actor && this.getImage(actor.imageIdentifier).url ? 'yes' : 'no'} slots=${this.tachieSlots.length}`;
  }

  /** Dynamic tachie slots for selected character */
  get tachieSlots(): { index: number; label: string; imageId: string }[] {
    const character = ObjectStore.instance.get<GameCharacter>(this.selectedCharacterId);
    if (!(character instanceof GameCharacter) || !character.imageDataElement) return [];
    const children = character.imageDataElement.children || [];
    if (children.length < 1) return [];
    const slots: { index: number; label: string; imageId: string }[] = [];
    for (let i = 0; i < children.length; i++) {
      const child: any = children[i];
      const label = this.tachieLabel(child);
      const id = String(child?.value ?? child?.getAttribute?.('value') ?? '');
      if (id) {
        slots.push({ index: i, label: label ? `${i} ${label}` : `${i}`, imageId: id });
      }
    }
    return slots;
  }

  get shouldCompactTachie(): boolean {
    return this.tachieCompactOverride || this.tachieSlots.length > 12;
  }

  get isTachieExpanded(): boolean {
    return !this.shouldCompactTachie || this.tachieExpandedOverride;
  }

  get tachieHoverPanelStyle(): { [key: string]: string } {
    const panelWidth = Math.max(this.panelW || 450, 280);
    const popupWidth = 260;
    const gap = 8;
    const bottom = this.isHotbarVisible ? 92 : 18;
    if (this.panelX < 0) {
      return { right: `${18 + panelWidth + gap}px`, bottom: `${bottom}px` };
    }

    const rightX = this.panelX + panelWidth + gap;
    const leftX = this.panelX - popupWidth - gap;
    const x = rightX + popupWidth <= window.innerWidth - 8 ? rightX : Math.max(8, leftX);
    const y = this.panelY >= 0 ? Math.max(8, Math.min(this.panelY + 72, window.innerHeight - 368)) : 8;
    return { left: `${x}px`, top: `${y}px` };
  }

  get selectedTachieSlot(): { index: number; label: string; imageId: string } {
    return this.tachieSlots.find(slot => slot.index === this.selectedTachieIndex) || this.tachieSlots[0] || null;
  }

  setTachieExpanded(isExpanded: boolean) {
    this.tachieCompactOverride = !isExpanded;
    this.tachieExpandedOverride = isExpanded;
    if (isExpanded) this.tachieHoverPanelOpen = false;
  }

  openTachieHoverPanel() {
    if (this.shouldCompactTachie) this.tachieHoverPanelOpen = true;
  }

  closeTachieHoverPanel() {
    this.tachieHoverPanelOpen = false;
  }

  toggleTachieHoverPanel() {
    if (!this.shouldCompactTachie) return;
    this.tachieHoverPanelOpen = !this.tachieHoverPanelOpen;
  }

  actorImage(actor: VnActor): ImageFile {
    if (!actor?.imageIdentifier) return ImageFile.Empty;
    return this.imageByIdentifier(actor.imageIdentifier);
  }

  actorPreviousImage(actor: VnActor): ImageFile {
    if (!actor?.previousImageIdentifier) return ImageFile.Empty;
    return this.imageByIdentifier(actor.previousImageIdentifier);
  }

  imageByIdentifier(identifier: string): ImageFile {
    if (!identifier) return ImageFile.Empty;
    const img = this.getImage(identifier);
    if (!img.url) this.ensureImageLoaded(identifier);
    return img;
  }

  actorHasPortrait(actor: VnActor): boolean {
    const img = this.actorImage(actor);
    return img && !img.isEmpty && !!img.url;
  }

  actorLeft(index: number): string {
    const n = Math.max(1, this.actors.length);
    if (n === 1) return '38%';
    const start = n <= 3 ? 24 : 16;
    const end = n <= 3 ? 76 : 84;
    return `${start + ((end - start) * index / (n - 1))}%`;
  }

  actorScale(index: number, actor?: VnActor): number {
    const n = this.actors.length;
    const baseScale = n <= 2 ? 1 : n === 3 ? 0.9 : 0.8;
    return baseScale * this.normalizePortraitScale(actor?.portraitScale, 1);
  }

  actorZIndex(index: number, actor: VnActor): number {
    const base = this.showBubble(actor) || this.isSpeaking(actor) ? 1000 + index : 100 + index;
    return actor.customZ || base;
  }

  get stageSelectedActor(): VnActor {
    return this.findActor(this.stageSelectedId);
  }

  isStageSelected(actor: VnActor): boolean {
    return !!actor && actor.characterId === this.stageSelectedId;
  }

  selectStageActor(actor: VnActor) {
    this.stageSelectedId = (actor && actor.characterId === this.stageSelectedId) ? '' : (actor?.characterId || '');
  }

  toggleMoveMode() {
    this.moveMode = !this.moveMode;
    if (!this.moveMode) {
      this.stageSelectedId = '';
    } else if (this.selectedCharacterId) {
      const actor = this.findActor(this.selectedCharacterId);
      if (actor) this.stageSelectedId = this.selectedCharacterId;
    }
  }

  private broadcastActorLayout(actor: VnActor) {
    if (!actor?.characterId) return;
    EventSystem.call('VN_STAGE_LAYOUT', {
      characterId: actor.characterId,
      customOffsetX: actor.customOffsetX || 0,
      customOffsetY: actor.customOffsetY || 0,
      portraitWidth: actor.portraitWidth || 0,
      portraitHeight: actor.portraitHeight || 0,
      customZ: actor.customZ || 0,
      aspectLocked: actor.aspectLocked !== false
    });
  }

  /* ── portrait free-drag ── */

  onPortraitDragStart(actor: VnActor, e: PointerEvent) {
    if (e.button !== 0) return;
    if (!this.moveMode) return;  // only drag when move mode is active
    e.preventDefault(); e.stopPropagation();
    this.draggingActor = actor;
    this.portraitDragMode = 'move';
    this.portraitDragStartX = e.clientX;
    this.portraitDragStartY = e.clientY;
    this.portraitDragStartOffX = actor.customOffsetX || 0;
    this.portraitDragStartOffY = actor.customOffsetY || 0;
    const moveHandler = (ev: PointerEvent) => {
      this.ngZone.run(() => {
        if (this.portraitDragMode !== 'move' || !this.draggingActor) return;
        const dxVw = (ev.clientX - this.portraitDragStartX) / window.innerWidth * 100;
        const dyVh = (ev.clientY - this.portraitDragStartY) / window.innerHeight * 100;
        this.draggingActor.customOffsetX = this.portraitDragStartOffX + dxVw;
        this.draggingActor.customOffsetY = this.portraitDragStartOffY + dyVh;
      });
    };
    const upHandler = (ev: PointerEvent) => {
      document.removeEventListener('pointermove', moveHandler);
      document.removeEventListener('pointerup', upHandler);
      document.removeEventListener('pointercancel', upHandler);
      this.ngZone.run(() => {
        if (this.draggingActor) {
          this.saveActorLayout(this.draggingActor);
          this.broadcastActorLayout(this.draggingActor);
        }
        this.portraitDragMode = null;
        this.draggingActor = null;
      });
    };
    document.addEventListener('pointermove', moveHandler);
    document.addEventListener('pointerup', upHandler);
    document.addEventListener('pointercancel', upHandler);
  }

  onPortraitDragMove(actor: VnActor, e: PointerEvent) {
    // handled by document-level listener in onPortraitDragStart
  }

  onPortraitDragEnd(actor: VnActor, e: PointerEvent) {
    // handled by document-level listener in onPortraitDragStart
  }

  /* ── portrait resize (8 handles) ── */

  onPortraitResizeStart(actor: VnActor, edge: string, e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    this.portraitDragMode = 'resize';
    this.portraitDragEdge = edge;
    this.portraitDragStartX = e.clientX;
    this.portraitDragStartY = e.clientY;
    const vw = window.innerWidth / 100;
    const vh = window.innerHeight / 100;
    const stackEl = (e.currentTarget as HTMLElement).closest('.vn-portrait-stack') as HTMLElement;
    this.portraitDragStartW = (stackEl?.offsetWidth || 300) / vw;
    this.portraitDragStartH = (stackEl?.offsetHeight || 400) / vh;
    this.portraitDragAspect = this.portraitDragStartW / Math.max(0.01, this.portraitDragStartH);
    if (!actor.portraitWidth) actor.portraitWidth = this.portraitDragStartW;
    if (!actor.portraitHeight) actor.portraitHeight = this.portraitDragStartH;
    const moveHandler = (ev: PointerEvent) => {
      this.ngZone.run(() => {
        if (this.portraitDragMode !== 'resize' || !actor) return;
        const dxVw = (ev.clientX - this.portraitDragStartX) / vw;
        const dyVh = (ev.clientY - this.portraitDragStartY) / vh;
        const edgeName = this.portraitDragEdge;
        const lock = actor.aspectLocked !== false;
        let w = actor.portraitWidth || this.portraitDragStartW;
        let h = actor.portraitHeight || this.portraitDragStartH;
        const minW = 5, minH = 5, maxW = 120, maxH = 120;
        if (edgeName.includes('e')) w = this.portraitDragStartW + dxVw;
        if (edgeName.includes('w')) w = this.portraitDragStartW - dxVw;
        if (edgeName.includes('s')) h = this.portraitDragStartH + dyVh;
        if (edgeName.includes('n')) h = this.portraitDragStartH - dyVh;
        w = Math.max(minW, Math.min(maxW, w));
        h = Math.max(minH, Math.min(maxH, h));
        if (lock) {
          if (edgeName === 'e' || edgeName === 'w') h = w / this.portraitDragAspect;
          else if (edgeName === 'n' || edgeName === 's') w = h * this.portraitDragAspect;
          else { if (Math.abs(dxVw) >= Math.abs(dyVh)) h = w / this.portraitDragAspect; else w = h * this.portraitDragAspect; }
        }
        actor.portraitWidth = w;
        actor.portraitHeight = h;
      });
    };
    const upHandler = (ev: PointerEvent) => {
      document.removeEventListener('pointermove', moveHandler);
      document.removeEventListener('pointerup', upHandler);
      document.removeEventListener('pointercancel', upHandler);
      this.ngZone.run(() => this.onPortraitResizeEnd(actor, ev));
    };
    document.addEventListener('pointermove', moveHandler);
    document.addEventListener('pointerup', upHandler);
    document.addEventListener('pointercancel', upHandler);
  }

  onPortraitResizeMove(actor: VnActor, e: PointerEvent) {
    if (this.portraitDragMode !== 'resize' || !this.isStageSelected(actor)) return;
    e.preventDefault();
    const dx = e.clientX - this.portraitDragStartX;
    const dy = e.clientY - this.portraitDragStartY;
    const edge = this.portraitDragEdge;
    const lock = actor.aspectLocked !== false; // default true
    let w = actor.portraitWidth || this.portraitDragStartW;
    let h = actor.portraitHeight || this.portraitDragStartH;

    const minW = 60, minH = 60, maxW = 1200, maxH = 1200;

    if (edge.includes('e')) w = this.portraitDragStartW + dx;
    if (edge.includes('w')) w = this.portraitDragStartW - dx;
    if (edge.includes('s')) h = this.portraitDragStartH + dy; // bottom edge: drag down = grow
    if (edge.includes('n')) h = this.portraitDragStartH - dy; // top edge: drag up = grow

    w = Math.max(minW, Math.min(maxW, w));
    h = Math.max(minH, Math.min(maxH, h));

    if (lock) {
      // Keep aspect ratio: adjust the non-primary axis
      if (edge === 'e' || edge === 'w') {
        h = w / this.portraitDragAspect;
      } else if (edge === 'n' || edge === 's') {
        w = h * this.portraitDragAspect;
      } else {
        // corner: use the larger delta
        if (Math.abs(dx) >= Math.abs(dy)) h = w / this.portraitDragAspect;
        else w = h * this.portraitDragAspect;
      }
    }

    actor.portraitWidth = w;
    actor.portraitHeight = h;
  }

  onPortraitResizeEnd(actor: VnActor, e: PointerEvent) {
    if (this.portraitDragMode !== 'resize') return;
    this.portraitDragMode = null;
    this.saveActorLayout(actor);
    this.broadcastActorLayout(actor);
  }

  bringActorForward(actor: VnActor) {
    if (!actor) return;
    const maxZ = this.actors.reduce((m, a) => Math.max(m, a.customZ || 0), 0);
    actor.customZ = maxZ + 1;
    this.saveActorLayout(actor);
    this.broadcastActorLayout(actor);
  }

  sendActorBackward(actor: VnActor) {
    if (!actor) return;
    const minZ = this.actors.reduce((m, a) => Math.min(m, a.customZ || 9999), 9999);
    actor.customZ = minZ - 1;
    this.saveActorLayout(actor);
    this.broadcastActorLayout(actor);
  }

  toggleAspectLock(actor: VnActor) {
    if (!actor) return;
    actor.aspectLocked = actor.aspectLocked === false ? true : false;
    this.saveActorLayout(actor);
    this.broadcastActorLayout(actor);
  }

  resetActorLayout(actor: VnActor) {
    if (!actor) return;
    actor.customOffsetX = 0;
    actor.customOffsetY = 0;
    actor.portraitWidth = 0;
    actor.portraitHeight = 0;
    actor.customZ = 0;
    actor.aspectLocked = true;
    this.saveActorLayout(actor);
    this.broadcastActorLayout(actor);
  }

  get portraitResizeEdges(): string[] {
    return ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  }

  portraitHandleCursor(edge: string): string {
    const map: { [k: string]: string } = {
      'nw': 'nwse-resize', 'n': 'ns-resize', 'ne': 'nesw-resize',
      'e': 'ew-resize', 'se': 'nwse-resize', 's': 'ns-resize',
      'sw': 'nesw-resize', 'w': 'ew-resize'
    };
    return map[edge] || 'default';
  }

  private saveActorLayout(actor: VnActor) {
    if (!actor?.characterId) return;
    try {
      localStorage.setItem(`udonarium.vnStage.actorLayout.${actor.characterId}.v1`, JSON.stringify({
        customOffsetX: actor.customOffsetX || 0,
        customOffsetY: actor.customOffsetY || 0,
        portraitWidth: actor.portraitWidth || 0,
        portraitHeight: actor.portraitHeight || 0,
        customZ: actor.customZ || 0,
        aspectLocked: actor.aspectLocked !== false
      }));
    } catch (_) { }
  }

  private loadActorLayout(actor: VnActor) {
    if (!actor?.characterId) return;
    try {
      const raw = localStorage.getItem(`udonarium.vnStage.actorLayout.${actor.characterId}.v1`);
      if (!raw) return;
      const d = JSON.parse(raw);
      actor.customOffsetX = Math.max(-50, Math.min(50, d.customOffsetX || 0));
      actor.customOffsetY = Math.max(-50, Math.min(50, d.customOffsetY || 0));
      actor.portraitWidth = Math.max(0, Math.min(1200, d.portraitWidth || 0));
      actor.portraitHeight = Math.max(0, Math.min(1200, d.portraitHeight || 0));
      actor.customZ = d.customZ || 0;
      actor.aspectLocked = d.aspectLocked !== false;
    } catch (_) { }
  }

  bubbleSide(index: number): string {
    const n = this.actors.length;
    if (n <= 1) return 'right';
    return index <= (n - 1) / 2 ? 'right' : 'left';
  }

  isSpeaking(actor: VnActor): boolean { return actor && this.now < actor.speakingUntil; }
  showBubble(actor: VnActor): boolean { return actor && actor.text && this.now < actor.bubbleUntil; }

  getTypewriterText(characterId: string): string {
    const actor = this.findActor(characterId);
    if (!actor) return '';
    return actor.displayedText || '';
  }

  private startActorTypewriter(actor: VnActor, text: string) {
    if (actor.typewriterTimer) {
      clearTimeout(actor.typewriterTimer);
      clearInterval(actor.typewriterTimer);
    }
    // Show bubble first with empty text, then start typewriter after a short delay
    actor.displayedText = '';
    actor.typewriterIndex = 0;
    actor.typewriterTimer = setTimeout(() => {
      let idx = 0;
      actor.typewriterTimer = setInterval(() => {
        this.ngZone.run(() => {
          idx++;
          actor.typewriterIndex = idx;
          actor.displayedText = text.substring(0, idx);
          if (idx >= text.length) {
            clearInterval(actor.typewriterTimer as any);
            actor.typewriterTimer = null;
          }
        });
      }, 40);
    }, 300) as any;
  }
  trackByCharacterId(index: number, actor: VnActor): string { return actor.characterId; }

  trackByIndexItem(index: number, item: { name: string; line: number }): string { return item.line + ':' + item.name; }

  // Drag & drop reordering
  private dragIndex: number = -1;
  private dropIndex: number = -1;

  onDragStart(index: number, event: DragEvent) {
    this.dragIndex = index;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(index));
  }

  onDragOver(index: number, event: DragEvent) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    this.dropIndex = index;
  }

  onDrop(index: number, event: DragEvent) {
    event.preventDefault();
    if (this.dragIndex < 0 || this.dragIndex === index) { this.dragIndex = -1; this.dropIndex = -1; return; }
    const item = this.actors.splice(this.dragIndex, 1)[0];
    this.actors.splice(index, 0, item);
    this.dragIndex = -1;
    this.dropIndex = -1;
  }

  onDragEnd() {
    this.dragIndex = -1;
    this.dropIndex = -1;
  }

  /* ═══════════ user actions ═══════════ */

  selectTachie(index: number) {
    this.selectedTachieIndex = index;
    const character = ObjectStore.instance.get<GameCharacter>(this.selectedCharacterId);
    if (character instanceof GameCharacter && character.imageDataElement) {
      const children = character.imageDataElement.children || [];
      if (index >= 0 && index < children.length) {
        const child: any = children[index];
        this.selectedImageId = String(child?.value ?? child?.getAttribute?.('value') ?? '');
        if (this.selectedImageId) this.ensureImageLoaded(this.selectedImageId);
      }
    }
    // update stage actor if already on stage
    const actor = this.findActor(this.selectedCharacterId);
    if (actor) {
      actor.tachieIndex = this.selectedTachieIndex;
      if (this.selectedImageId) this.setActorImage(actor, this.selectedImageId);
      if (this.affectPiece) this.applyTachieToPiece(character, this.selectedTachieIndex);
      EventSystem.call('VN_STAGE_ADD', {
        characterId: this.selectedCharacterId, name: actor.name, tachieIndex: this.selectedTachieIndex, imageIdentifier: this.selectedImageId, portraitScale: actor.portraitScale
      });
    }
  }
  private selectedImageId: string = '';

  onCharacterChange() {
    try { localStorage.setItem('udonarium.vnStage.selectedCharacterId.v1', this.selectedCharacterId || ''); } catch (_) { }
    this.selectedTachieIndex = 0;
    this.selectedImageId = '';
    this.tachieCompactOverride = false;
    this.tachieExpandedOverride = false;
    this.tachieHoverPanelOpen = false;
    const slots = this.tachieSlots;
    if (slots.length > 0) this.selectedImageId = slots[0].imageId;

    // Auto-select dicebot from character's palette
    const character = ObjectStore.instance.get<GameCharacter>(this.selectedCharacterId);
    if (character instanceof GameCharacter && character.chatPalette) {
      const db = character.chatPalette.dicebot;
      if (db) {
        this.selectedDiceBot = db;
      }
    }
  }

  selectCharacterFromBoard(characterId: string) {
    const character = ObjectStore.instance.get<GameCharacter>(characterId);
    if (!(character instanceof GameCharacter) || !this.canUseCharacter(character)) return;
    this.selectedCharacterId = characterId;
    this.onCharacterChange();
  }

  toggleAffectPiece() {
    this.affectPiece = !this.affectPiece;
    try { localStorage.setItem('udonarium.vnStage.affectPiece.v1', this.affectPiece ? '1' : '0'); } catch (_) { }
  }

  toggleSendPortrait() {
    this.sendPortrait = !this.sendPortrait;
    try { localStorage.setItem('udonarium.vnStage.sendPortrait.v1', this.sendPortrait ? '1' : 'false'); } catch (_) { }
  }

  private targeted(gameCharacter: GameCharacter): boolean {
    if (gameCharacter.location.name != 'table') return false;
    return gameCharacter.targeted;
  }

  private targetedGameCharacterList(): GameCharacter[] {
    return ObjectStore.instance
      .getObjects<GameCharacter>(GameCharacter)
      .filter(character => this.targeted(character));
  }

  private prepareVnChatText(rawText: string, character: GameCharacter): { text: string, messageTargetContext: ChatMessageTargetContext[] } {
    const palette = character.chatPalette;
    if (!palette) {
      return { text: rawText, messageTargetContext: [{ text: rawText, object: null }] };
    }

    if (palette.checkTargetCharactor(rawText)) {
      const targets = this.targetedGameCharacterList();
      if (targets.length < 1) {
        return { text: '対象が未選択です', messageTargetContext: [] };
      }

      const evaluatedTexts: string[] = [];
      const messageTargetContext: ChatMessageTargetContext[] = [];
      let first = true;
      for (let target of targets) {
        const targetText = first ? rawText : DiceBot.deleteMyselfResourceBuff(rawText);
        const evaluated = palette.evaluate(targetText, character.rootDataElement, target, this.isExtendedDiceBotEnabled);
        evaluatedTexts.push(`${evaluated} [${target.name}]`);
        messageTargetContext.push({ text: evaluated, object: target });
        first = false;
      }
      return { text: evaluatedTexts.join('\n'), messageTargetContext };
    }

    const evaluated = palette.evaluate(rawText, character.rootDataElement, null, this.isExtendedDiceBotEnabled);
    return { text: evaluated, messageTargetContext: [{ text: evaluated, object: null }] };
  }

  sendVnChat() {
    let text = this.inputText.trim();
    if (!text) return;
    const secretText = this.applySecretMode(text);
    const { isSecret, coreText } = this.parseSecretText(secretText);
    if (!coreText) return;
    this.ensureSelectedCharacter();
    const chatTab = this.selectedTab || this.chatTabs[0];
    if (!chatTab || !this.selectedCharacterId) return;

    const character = ObjectStore.instance.get<GameCharacter>(this.selectedCharacterId);
    const onStage = !!this.findActor(this.selectedCharacterId);
    const shouldSendPortrait = this.sendPortrait && onStage;
    const tachieNum = shouldSendPortrait && character instanceof GameCharacter
      ? this.selectedTachieIndex : null;

    let evaluatedText = coreText;
    let messageTargetContext: ChatMessageTargetContext[] = [{ text: coreText, object: null }];
    let gameType = this.selectedDiceBot || 'DiceBot';
    let messageColor: string = null;
    if (character instanceof GameCharacter) {
      const palette = character.chatPalette;
      const prepared = this.prepareVnChatText(coreText, character);
      evaluatedText = prepared.text;
      messageTargetContext = prepared.messageTargetContext;
      // シークレットの場合、messageTargetContext の text に s: を付与して
      // dice-bot.ts の checkResourceEditCommand が認識できるようにする
      if (isSecret) this.applySecretPrefixToContexts(messageTargetContext);
      if (palette) {
        if (!this.selectedDiceBot || this.selectedDiceBot === 'DiceBot') {
          gameType = palette.dicebot || 'DiceBot';
        }
      }
      if (character.chatColorCode && character.chatColorCode.length > 0) {
        messageColor = character.chatColorCode[0];
      }
    }

    // Update actor directly
    const actor = this.findActor(this.selectedCharacterId);
    if (actor) {
      actor.text = evaluatedText;
      actor.speakingUntil = Date.now() + SPEAKING_MS;
      actor.bubbleUntil = Date.now() + BUBBLE_MS;
      actor.bubbleKey++;
      this.now = Date.now();
      this.startActorTypewriter(actor, evaluatedText);
    }

    if (gameType && gameType !== 'DiceBot') {
      DiceBot.loadGameSystemAsync(gameType).then(gs => {
        this.chatMessageService.sendMessage(chatTab, evaluatedText, gs, this.selectedCharacterId, null, tachieNum, messageColor, messageTargetContext, isSecret);
      });
    } else {
      this.chatMessageService.sendMessage(chatTab, evaluatedText, null, this.selectedCharacterId, null, tachieNum, messageColor, messageTargetContext, isSecret);
    }
    this.inputText = '';
    this.diceCounters.clear();
    this.diceBuffer = '';
  }

  toggleSecretMode() {
    this.secretMode = !this.secretMode;
    try { localStorage.setItem('udonarium.vnStage.secretMode.v1', this.secretMode ? '1' : '0'); } catch (_) { }
  }

  private applySecretMode(text: string): string {
    const trimmed = this.normalizeSecretTargetPrefix((text || '').trim());
    if (!trimmed) return '';
    return this.secretMode && !this.hasSecretPrefix(trimmed) && !this.hasSecretResourceEditPrefix(trimmed) ? 's:' + trimmed : trimmed;
  }

  private parseSecretText(text: string): { isSecret: boolean, coreText: string } {
    const trimmed = (text || '').trim();
    if (this.hasSecretResourceEditPrefix(trimmed)) return { isSecret: true, coreText: trimmed };
    if (!this.hasSecretPrefix(trimmed)) return { isSecret: false, coreText: trimmed };
    return {
      isSecret: true,
      coreText: trimmed.replace(/^s[:：]\s*/i, '').trim()
    };
  }

  private hasSecretPrefix(text: string): boolean {
    return /^s[:：]/i.test((text || '').trim());
  }

  private hasSecretResourceEditPrefix(text: string): boolean {
    return /^st[:：]/i.test((text || '').trim());
  }

  private applySecretPrefixToContexts(messageTargetContext: ChatMessageTargetContext[]) {
    for (const ctx of messageTargetContext) {
      ctx.text = this.normalizeSecretTargetPrefix(ctx.text);
      if (!this.hasSecretPrefix(ctx.text)) ctx.text = 's:' + ctx.text;
      ctx.text = this.normalizeSecretTargetPrefix(ctx.text);
    }
  }

  private normalizeSecretTargetPrefix(text: string): string {
    return (text || '').trim().replace(/^s[:：]\s*st[:：]/i, 'st:');
  }

  removeActor(characterId: string) {
    this.removeActorInternal(characterId);
    EventSystem.call('VN_STAGE_REMOVE', { characterId });
  }

  clearStage() {
    this.actors = [];
    EventSystem.call('VN_STAGE_CLEAR', {});
  }

  selectActor(characterId: string) {
    this.selectedCharacterId = characterId;
    try { localStorage.setItem('udonarium.vnStage.selectedCharacterId.v1', characterId); } catch (_) { }
    const actor = this.findActor(characterId);
    if (actor) {
      this.selectedTachieIndex = actor.tachieIndex;
      this.selectedImageId = actor.imageIdentifier;
    }
    // Auto-select dicebot from character's palette
    const character = ObjectStore.instance.get<GameCharacter>(characterId);
    if (character instanceof GameCharacter && character.chatPalette) {
      const db = character.chatPalette.dicebot;
      if (db) {
        this.selectedDiceBot = db;
      }
    }
  }

  nudgeUp() { this.setVerticalOffset(this.verticalOffset - 16); }
  nudgeDown() { this.setVerticalOffset(this.verticalOffset + 16); }
  resetPosition() { this.setVerticalOffset(0); }

  get selectedActor(): VnActor {
    return this.findActor(this.selectedCharacterId);
  }

  get selectedActorScaleLabel(): string {
    return `${Math.round(this.normalizePortraitScale(this.selectedActor?.portraitScale, 1) * 100)}%`;
  }

  scaleSelectedActorDown() {
    const actor = this.selectedActor;
    if (!actor) return;
    this.setActorPortraitScale(actor, actor.portraitScale - PORTRAIT_SCALE_STEP);
  }

  scaleSelectedActorUp() {
    const actor = this.selectedActor;
    if (!actor) return;
    this.setActorPortraitScale(actor, actor.portraitScale + PORTRAIT_SCALE_STEP);
  }

  resetSelectedActorScale() {
    const actor = this.selectedActor;
    if (!actor) return;
    this.setActorPortraitScale(actor, 1);
  }

  enterStage() {
    if (!this.selectedCharacterId) return;
    const character = ObjectStore.instance.get<GameCharacter>(this.selectedCharacterId);
    if (!(character instanceof GameCharacter)) return;
    const name = character.name || '';
    const imageIdentifier = this.selectedImageId || this.findImageIdentifierByIndex(character, this.selectedTachieIndex);

    const portraitScale = this.loadActorPortraitScale(character.identifier);
    this.upsertActor(character.identifier, name, this.selectedTachieIndex, imageIdentifier, '', false, true, portraitScale);

    if (this.affectPiece) this.applyTachieToPiece(character, this.selectedTachieIndex);

    EventSystem.call('VN_STAGE_ADD', {
      characterId: character.identifier, name, tachieIndex: this.selectedTachieIndex, imageIdentifier, portraitScale
    });
  }

  addDice(die: string) {
    const count = (this.diceCounters.get(die) || 0) + 1;
    this.diceCounters.set(die, count);
    this.rebuildDiceBuffer();
  }

  clearDice() {
    this.diceCounters.clear();
    this.diceBuffer = '';
    this.syncInputWithDice();
  }

  toggleChatLog() {
    this.chatLogExpanded = !this.chatLogExpanded;
    if (this.chatLogExpanded) {
      this.refreshChatLogFade();
      this.scrollLogToBottom();
    }
  }

  toggleChatLogPin() {
    this.chatLogPinned = !this.chatLogPinned;
  }

  selectTab(tabId: string) {
    this.selectedTabIdentifier = tabId;
  }

  selectDiceBot(botId: string) {
    this.selectedDiceBot = botId;
  }

  togglePalette() {
    this.paletteExpanded = !this.paletteExpanded;
    if (this.paletteExpanded) {
      this.paletteVisible = true;
      this.refreshPaletteFade();
      // scroll to top on open
      setTimeout(() => {
        try {
          const el = this.paletteScrollEl?.nativeElement;
          if (el) el.scrollTop = 0;
        } catch (_) { }
      }, 50);
    }
  }

  onPaletteScroll(event: Event) {
    const el = event.target as HTMLElement;
    const atTop = el.scrollTop <= 0;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    // If not at top or bottom, user is scrolling — keep visible
    if (!atTop || !atBottom) {
      this.paletteVisible = true;
      this.refreshPaletteFade();
    }
  }

  toggleIndex() {
    this.indexExpanded = !this.indexExpanded;
    if (this.indexExpanded) {
      this.refreshIndexFade();
    }
  }

  jumpToIndex(idx: { name: string; line: number }) {
    this.paletteSearchText = '';
    this.scrollToIndex = idx.line;
    this.refreshPaletteFade();
    this.refreshIndexFade();
    setTimeout(() => {
      try {
        const el = document.querySelector('.vn-palette-scroll');
        if (!el) return;
        // DOM childrenは空行含む全行に対応する要素を持つ
        // paletteIndex.line == visiblePaletteLinesのインデックス == DOM childrenのインデックス
        const children = el.children;
        if (children[idx.line]) {
          (children[idx.line] as HTMLElement).scrollIntoView({ block: 'center' });
        }
      } catch (e) { console.warn('jumpToIndex error', e); }
    }, 200);
  }

  selectPaletteLine(line: string) {
    this.selectedPaletteLine = line;
    this.inputText = line;
    this.refreshPaletteFade();
  }

  isSecretRevealed(msg: any): boolean {
    if (this.gmModeService.isGm || msg.isSendFromSelf) return true;
    return this.revealedSecrets.has(msg.identifier || msg.tag);
  }

  canRevealSecret(msg: any): boolean {
    return this.gmModeService.isGm || msg.isSendFromSelf;
  }

  revealSecret(msg: any) {
    if (!this.canRevealSecret(msg)) return;
    const id = msg.identifier || msg.tag;
    if (id) this.revealedSecrets.add(id);
  }

  sendPaletteLine(line: string) {
    const character = ObjectStore.instance.get<GameCharacter>(this.selectedCharacterId);
    if (!(character instanceof GameCharacter)) return;
    const palette = character.chatPalette;
    if (!palette) return;
    const secretText = this.applySecretMode(line);
    const { isSecret, coreText } = this.parseSecretText(secretText);
    if (!coreText) return;
    const prepared = this.prepareVnChatText(coreText, character);
    const evaluated = prepared.text;
    const messageTargetContext = prepared.messageTargetContext;
    if (isSecret) this.applySecretPrefixToContexts(messageTargetContext);
    if (!evaluated) return;
    const chatTab = this.selectedTab || this.chatTabs[0];
    if (!chatTab) return;

    const actor = this.findActor(this.selectedCharacterId);
    const onStage = !!actor;
    const shouldSendPortrait = this.sendPortrait && onStage;
    const tachieNum = shouldSendPortrait ? this.selectedTachieIndex : null;
    const messageColor = character.chatColorCode?.length ? character.chatColorCode[0] : null;
    const gameType = palette.dicebot || this.selectedDiceBot || 'DiceBot';

    if (actor) {
      actor.text = evaluated;
      actor.lastSpokeAt = Date.now();
      actor.speakingUntil = Date.now() + SPEAKING_MS;
      actor.bubbleUntil = Date.now() + BUBBLE_MS;
      actor.bubbleKey++;
      this.now = Date.now();
      this.startActorTypewriter(actor, evaluated);
    }

    if (gameType && gameType !== 'DiceBot') {
      DiceBot.loadGameSystemAsync(gameType).then(gs => {
        this.chatMessageService.sendMessage(chatTab, evaluated, gs, this.selectedCharacterId, null, tachieNum, messageColor, messageTargetContext, isSecret);
      });
    } else {
      this.chatMessageService.sendMessage(chatTab, evaluated, null, this.selectedCharacterId, null, tachieNum, messageColor, messageTargetContext, isSecret);
    }
    this.refreshChatLogFade();
    this.refreshPaletteFade();
    this.refreshIndexFade();
    this.selectedPaletteLine = null;
    this.inputText = '';
  }

  get chatLogAutoHide(): boolean {
    return !this.chatLogPinned && !this.chatLogVisible;
  }

  onInputChange() {
    const userText = this.inputText.replace(/^\d+d\d+(?:\+\d+d\d+)*\s*/, '');
    if (!this.diceBuffer && !userText) return;
    if (userText !== this.inputText.replace(/^\d+d\d+(?:\+\d+d\d+)*\s*/, '')) {
      this.diceCounters.clear();
      this.diceBuffer = '';
    }
    // removed previewOrBroadcast — don't auto-add to stage
  }

  onInputKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendVnChat();
    }
  }

  /* ═══════════ core logic ═══════════ */

  previewOrBroadcast() {
    const character = ObjectStore.instance.get<GameCharacter>(this.selectedCharacterId);
    if (!(character instanceof GameCharacter)) return;

    // use cached imageId, fallback to lookup
    let imageIdentifier = this.selectedImageId;
    if (!imageIdentifier) {
      imageIdentifier = this.findImageIdentifierByIndex(character, this.selectedTachieIndex);
    }
    const name = character.name || '';

    const portraitScale = this.loadActorPortraitScale(character.identifier);
    this.upsertActor(character.identifier, name, this.selectedTachieIndex, imageIdentifier, '', false, true, portraitScale);

    if (this.affectPiece) {
      this.applyTachieToPiece(character, this.selectedTachieIndex);
    }

    EventSystem.call('VN_STAGE_ADD', {
      characterId: character.identifier, name, tachieIndex: this.selectedTachieIndex, imageIdentifier, portraitScale
    });
  }

  private applyTachieToPiece(character: GameCharacter, tachieIndex: number) {
    character.selectedTachieNum = tachieIndex;
    // also update ICON currentValue so the piece portrait actually changes
    const iconNum = character.detailDataElement?.getFirstElementByName('ICON');
    if (iconNum && iconNum.isNumberResource) {
      iconNum.currentValue = tachieIndex;
    }
  }

  private applyChatMessage(message: ChatMessage) {
    const characterId = message.sendFrom || message.from;
    if (!characterId) return;
    // Only update actors already on stage — don't auto-add
    const actor = this.findActor(characterId);
    if (!actor) return;
    const character = ObjectStore.instance.get<GameCharacter>(characterId);
    const name = message.name || (character instanceof GameCharacter ? character.name : '');
    const imageIdentifier = message.imageIdentifier || '';
    const tachieIndex = imageIdentifier && character instanceof GameCharacter
      ? this.findTachieIndexByIdentifier(character, imageIdentifier) : actor.tachieIndex;
    actor.name = name || actor.name;
    actor.text = message.text || '';
    actor.lastSpokeAt = Date.now();
    actor.speakingUntil = Date.now() + SPEAKING_MS;
    actor.bubbleUntil = Date.now() + BUBBLE_MS;
    actor.bubbleKey++;
    this.now = Date.now(); // immediate update to prevent race
    this.startActorTypewriter(actor, actor.text);
    if (imageIdentifier) this.setActorImage(actor, imageIdentifier);
    actor.tachieIndex = tachieIndex;
    if (actor.imageIdentifier) this.ensureImageLoaded(actor.imageIdentifier);
    // Refresh chat log auto-hide timer
    this.refreshChatLogFade();
    this.scrollLogToBottom();
  }

  private upsertActor(
    characterId: string, name: string, tachieIndex: number, imageIdentifier: string,
    text: string, speaking: boolean, broadcast: boolean, portraitScale?: number
  ) {
    if (!characterId) return;
    const now = Date.now();
    let actor = this.findActor(characterId);
    const isNew = !actor;

    if (!actor) {
      actor = {
        characterId, name, tachieIndex, imageIdentifier, portraitScale: this.normalizePortraitScale(portraitScale, this.loadActorPortraitScale(characterId)), previousImageIdentifier: '', isPortraitFading: false, portraitFadeTimer: null, text: '',
        enterKey: ++this.enterCounter,
        speakingUntil: 0, bubbleUntil: 0, lastSpokeAt: now,
        isEntering: true,
        displayedText: '', typewriterIndex: 0, typewriterTimer: null, lastBubbleUntil: 0, bubbleKey: 0,
        customOffsetX: 0, customOffsetY: 0, portraitWidth: 0, portraitHeight: 0, customZ: 0, aspectLocked: true,
      };
      this.actors.push(actor);
      this.loadActorLayout(actor);
      setTimeout(() => this.ngZone.run(() => { actor.isEntering = false; }), 400);
    }

    actor.name = name || actor.name;
    actor.tachieIndex = tachieIndex;
    if (Number.isFinite(Number(portraitScale))) actor.portraitScale = this.normalizePortraitScale(portraitScale, actor.portraitScale || 1);
    if (imageIdentifier) this.setActorImage(actor, imageIdentifier, isNew);
    if (text) actor.text = text;
    actor.lastSpokeAt = now;

    if (speaking && text) {
      actor.speakingUntil = now + SPEAKING_MS;
      actor.bubbleUntil = now + BUBBLE_MS;
      actor.bubbleKey++;
      this.startActorTypewriter(actor, text);
    }
    if (isNew) actor.enterKey = ++this.enterCounter;

    if (actor.imageIdentifier) this.ensureImageLoaded(actor.imageIdentifier);

    // Don't reorder — keep manual order from drag-and-drop
    if (isNew) {
      this.actors = this.actors.slice(-MAX_ACTORS);
    }
  }

  private removeActorInternal(characterId: string) {
    const actor = this.findActor(characterId);
    if (actor?.portraitFadeTimer) clearTimeout(actor.portraitFadeTimer);
    this.actors = this.actors.filter(a => a.characterId !== characterId);
  }

  private setActorImage(actor: VnActor, imageIdentifier: string, immediate: boolean = false) {
    if (!actor || !imageIdentifier || actor.imageIdentifier === imageIdentifier) return;
    const previous = actor.imageIdentifier;
    if (actor.portraitFadeTimer) {
      clearTimeout(actor.portraitFadeTimer);
      actor.portraitFadeTimer = null;
    }

    if (!immediate && previous) {
      actor.previousImageIdentifier = previous;
      actor.isPortraitFading = true;
    } else {
      actor.previousImageIdentifier = '';
      actor.isPortraitFading = false;
    }

    actor.imageIdentifier = imageIdentifier;
    this.ensureImageLoaded(imageIdentifier);
    if (actor.previousImageIdentifier) this.ensureImageLoaded(actor.previousImageIdentifier);

    if (actor.isPortraitFading) {
      actor.portraitFadeTimer = setTimeout(() => this.ngZone.run(() => {
        actor.previousImageIdentifier = '';
        actor.isPortraitFading = false;
        actor.portraitFadeTimer = null;
      }), PORTRAIT_FADE_MS);
    }
  }

  private findActor(characterId: string): VnActor {
    return this.actors.find(a => a.characterId === characterId);
  }

  private setActorPortraitScale(actor: VnActor, scale: number) {
    if (!actor) return;
    actor.portraitScale = this.normalizePortraitScale(scale, actor.portraitScale || 1);
    this.saveActorPortraitScale(actor.characterId, actor.portraitScale);
    EventSystem.call('VN_STAGE_ADD', {
      characterId: actor.characterId,
      name: actor.name,
      tachieIndex: actor.tachieIndex,
      imageIdentifier: actor.imageIdentifier,
      portraitScale: actor.portraitScale
    });
  }

  private normalizePortraitScale(value: any, fallback: number): number {
    const n = Number(value);
    const safe = Number.isFinite(n) ? n : fallback;
    return Math.max(PORTRAIT_SCALE_MIN, Math.min(PORTRAIT_SCALE_MAX, Math.round(safe * 100) / 100));
  }

  private loadActorPortraitScale(characterId: string): number {
    try {
      const raw = localStorage.getItem('udonarium.vnStage.portraitScales.v1') || '{}';
      const map = JSON.parse(raw);
      return this.normalizePortraitScale(map?.[characterId], 1);
    } catch (_) {
      return 1;
    }
  }

  private saveActorPortraitScale(characterId: string, scale: number) {
    if (!characterId) return;
    try {
      const raw = localStorage.getItem('udonarium.vnStage.portraitScales.v1') || '{}';
      const map = JSON.parse(raw);
      map[characterId] = this.normalizePortraitScale(scale, 1);
      localStorage.setItem('udonarium.vnStage.portraitScales.v1', JSON.stringify(map));
    } catch (_) { }
  }

  /* ═══════════ image helpers ═══════════ */

  private getImage(identifier: string): ImageFile {
    if (!identifier) return ImageFile.Empty;
    return ImageStorage.instance.get(identifier) || ImageFile.Empty;
  }

  private ensureImageLoaded(identifier: string) {
    if (!identifier || this.loadingImages.has(identifier)) return;
    const cached = ImageStorage.instance.get(identifier);
    if (cached && cached.url) return;
    this.loadingImages.add(identifier);
    ServerMediaStorage.fetchImage(identifier)
      .then(image => {
        if (image) {
          ImageStorage.instance.add(image);
          this.ngZone.run(() => { this.now = Date.now(); });
        }
      })
      .catch(err => console.warn('VN image fetch fail', identifier, err))
      .finally(() => this.loadingImages.delete(identifier));
  }

  /* ═══════════ tachie helpers ═══════════ */

  private findImageIdentifierByIndex(character: GameCharacter, index: number): string {
    if (!character?.imageDataElement) return '';
    const children = character.imageDataElement.children || [];
    if (children.length < 1) return '';
    const i = Math.max(0, Math.min(index, children.length - 1));
    const child: any = children[i];
    const id = String(child?.value || '');
    if (id) this.ensureImageLoaded(id);
    return id;
  }

  private findTachieIndexByIdentifier(character: GameCharacter, imageIdentifier: string): number {
    if (!character?.imageDataElement || !imageIdentifier) return 0;
    const children = character.imageDataElement.children || [];
    for (let i = 0; i < children.length; i++) {
      if (String((children[i] as any)?.value || '') === imageIdentifier) return i;
    }
    return 0;
  }

  private tachieLabel(child: any): string {
    if (!child) return '';
    return String(child.currentValue || child.getAttribute?.('currentValue') || '');
  }

  private rebuildDiceBuffer() {
    const parts: string[] = [];
    for (const d of this.diceTypes) {
      const c = this.diceCounters.get(d);
      if (c) parts.push(`${c}${d}`);
    }
    this.diceBuffer = parts.join('+');
    this.syncInputWithDice();
  }

  private syncInputWithDice() {
    const prefix = this.diceBuffer ? this.diceBuffer + ' ' : '';
    const userText = this.inputText.replace(/^\d+d\d+(?:\+\d+d\d+)*\s*/, '');
    this.inputText = prefix + userText;
  }

  /* ═══════════ misc ═══════════ */

  private isDisplayableMessage(m: ChatMessage): boolean {
    return !!(m && this.canShowChatLogMessage(m) && !m.isSystem && !m.isSecret && !m.isDicebot && m.text?.trim());
  }

  private canShowChatLogMessage(m: ChatMessage): boolean {
    if (!m || !m.isDisplayable) return false;
    // シークレットメッセージもログに表示する（内容はHTML側で隠す）
    return true;
  }

  private ensureSelectedCharacter() {
    const chars = this.characters;
    if (this.selectedCharacterId && chars.some(c => c.identifier === this.selectedCharacterId)) return;
    this.selectedCharacterId = chars.length ? chars[0].identifier : '';
  }

  private setVerticalOffset(v: number) {
    this.verticalOffset = Math.max(-220, Math.min(160, v));
    try { localStorage.setItem('udonarium.vnStage.verticalOffset.v1', String(this.verticalOffset)); } catch (_) { }
  }

  private clampStageHeight(v: any): number {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(25, Math.min(100, Math.round(n))) : 58;
  }

  private loadNumber(key: string, fb: number): number {
    try { const v = Number(localStorage.getItem(key)); return Number.isFinite(v) ? v : fb; } catch (_) { return fb; }
  }

  private loadSelectedCharacterId(): string {
    try { return localStorage.getItem('udonarium.vnStage.selectedCharacterId.v1') || ''; } catch (_) { return ''; }
  }

  private includesJsonId(raw: string, id: string): boolean {
    if (!id) return false;
    try {
      const ids = JSON.parse(raw || '[]');
      return Array.isArray(ids) && ids.map(value => String(value)).includes(id);
    } catch (_) {
      return false;
    }
  }

  private setJsonId(raw: string, id: string, enabled: boolean): string {
    let ids: string[] = [];
    try {
      const parsed = JSON.parse(raw || '[]');
      if (Array.isArray(parsed)) ids = parsed.map(value => String(value)).filter(value => 0 < value.length);
    } catch (_) { }
    if (id) {
      const index = ids.indexOf(id);
      if (enabled && index < 0) ids.push(id);
      if (!enabled && 0 <= index) ids.splice(index, 1);
    }
    return JSON.stringify(ids);
  }

  private refreshChatLogFade() {
    this.chatLogVisible = true;
    if (this.chatLogFadeTimer) clearTimeout(this.chatLogFadeTimer);
    if (this.chatLogPinned) return;
    this.chatLogFadeTimer = setTimeout(() => {
      this.ngZone.run(() => { this.chatLogVisible = false; });
    }, 5000);
  }

  private refreshPaletteFade() {
    this.paletteVisible = true;
    // no auto-fade for palette
  }

  private refreshIndexFade() {
    this.indexVisible = true;
    // no auto-fade for index
  }

  private scrollLogToBottom() {
    setTimeout(() => {
      try {
        const el = this.logScrollEl?.nativeElement;
        if (el) el.scrollTop = el.scrollHeight;
      } catch (_) { }
    }, 50);
  }
}
