import { AfterViewInit, Component, ElementRef, NgZone, OnDestroy, ViewChild, ViewContainerRef } from '@angular/core';
import { NgSelectConfig } from '@ng-select/ng-select';
import * as lzbase62 from 'lzbase62';
import { Logger } from './class/core/system/util/logger';

import { ChatTabList } from '@udonarium/chat-tab-list';
import { Config } from '@udonarium/config';

import { AudioPlayer } from '@udonarium/core/file-storage/audio-player';
import { AudioSharingSystem } from '@udonarium/core/file-storage/audio-sharing-system';
import { AudioStorage } from '@udonarium/core/file-storage/audio-storage';
import { FileArchiver } from '@udonarium/core/file-storage/file-archiver';
import { ImageFile } from '@udonarium/core/file-storage/image-file';
import { ImageSharingSystem } from '@udonarium/core/file-storage/image-sharing-system';
import { ImageStorage } from '@udonarium/core/file-storage/image-storage';
import { ServerMediaStorage } from '@udonarium/core/file-storage/server-media-storage';
import { ObjectFactory } from '@udonarium/core/synchronize-object/object-factory';
import { InitialRoomSync } from '@udonarium/core/synchronize-object/initial-room-sync';
import { ObjectSerializer } from '@udonarium/core/synchronize-object/object-serializer';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { ObjectSynchronizer } from '@udonarium/core/synchronize-object/object-synchronizer';
import { EventSystem, Network } from '@udonarium/core/system';
import { CryptoUtil } from '@udonarium/core/system/util/crypto-util';
import { PeerContext } from '@udonarium/core/system/network/peer-context';
import { DataSummarySetting } from '@udonarium/data-summary-setting';
import { DiceBot } from '@udonarium/dice-bot';
import { GameCharacter } from '@udonarium/game-character';
import { GameTable } from '@udonarium/game-table';
import { Jukebox } from '@udonarium/Jukebox';
import { AudioLibraryService } from 'service/audio-library.service';
import { PeerCursor } from '@udonarium/peer-cursor';
import { PresetSound, SoundEffect } from '@udonarium/sound-effect';
import { AutoSoundService } from 'service/auto-sound.service';
import { ReloadCheck } from '@udonarium/reload-check';
import { TableSelecter } from '@udonarium/table-selecter';
import { TextNote } from '@udonarium/text-note';
import { MarkDown } from '@udonarium/mark-down';

import { CutIn } from '@udonarium/cut-in';
import { CutInLauncher } from '@udonarium/cut-in-launcher';
import { Vote, VoteContext } from '@udonarium/vote';
import { Alarm, AlarmContext } from '@udonarium/alarm';

import { ChatWindowComponent } from 'component/chat-window/chat-window.component';
import { ContextMenuComponent } from 'component/context-menu/context-menu.component';
import { FileStorageComponent } from 'component/file-storage/file-storage.component';
import { GameCharacterGeneratorComponent } from 'component/game-character-generator/game-character-generator.component';
import { GameCharacterSheetComponent } from 'component/game-character-sheet/game-character-sheet.component';
import { GameObjectInventoryComponent } from 'component/game-object-inventory/game-object-inventory.component';
import { GameTableSettingComponent } from 'component/game-table-setting/game-table-setting.component';
import { JukeboxComponent } from 'component/jukebox/jukebox.component';
import { DataImportMenuComponent } from 'component/data-import-menu/data-import-menu.component';
import { OptionsPanelComponent } from 'component/options-panel/options-panel.component';
import { InitiativePanelComponent } from 'component/initiative-panel/initiative-panel.component';
import { LightingPanelComponent } from 'component/lighting-panel/lighting-panel.component';
import { ModalComponent } from 'component/modal/modal.component';
import { PeerMenuComponent } from 'component/peer-menu/peer-menu.component';
import { TextViewComponent } from 'component/text-view/text-view.component';
import { UIPanelComponent } from 'component/ui-panel/ui-panel.component';
import { AppConfig, AppConfigService } from 'service/app-config.service';
import { ChatMessageService } from 'service/chat-message.service';
import { ContextMenuService } from 'service/context-menu.service';
import { ModalService } from 'service/modal.service';
import { PanelOption, PanelService } from 'service/panel.service';
import { PointerDeviceService } from 'service/pointer-device.service';
import { SaveDataService } from 'service/save-data.service';
import { GmModeService } from 'service/gm-mode.service';

import { CutInWindowComponent } from 'component/cut-in-window/cut-in-window.component';
import { DiceTableSettingComponent } from 'component/dice-table-setting/dice-table-setting.component';
import { VoteWindowComponent } from 'component/vote-window/vote-window.component';
import { AlarmWindowComponent } from 'component/alarm-window/alarm-window.component';
import { ChatMessageFixComponent } from 'component/chat-message-fix/chat-message-fix.component';

interface BundleLoadingState {
  operationId: string;
  source: 'room' | 'media';
  phase: string;
  done: number;
  total: number;
}

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent implements AfterViewInit, OnDestroy {

  @ViewChild('modalLayer', { read: ViewContainerRef, static: true }) modalLayerViewContainerRef!: ViewContainerRef;

  get reloadCheck(): ReloadCheck { return ObjectStore.instance.get<ReloadCheck>('ReloadCheck'); }
  networkService = Network;

  private immediateUpdateTimer: NodeJS.Timer = null;
  private lazyUpdateTimer: NodeJS.Timer = null;
  private developerPollTimer: NodeJS.Timer = null;
  private developerHeartbeatTimer: NodeJS.Timer = null;
  private developerAnnouncementSeq = 0;
  private developerSessionId = this.loadDeveloperSessionId();
  private developerJoinEntry: any = null;
  private developerJoinAnnounced = false;
  private openPanelCount = 0;
  isSaveing = false;
  progresPercent = 0;
  isMacroHotbarVisible = this.loadMacroHotbarVisible();
  isVnStageVisible = this.loadVnStageVisible();
  vnStageReady = true;
  private vnStageReadyTimer: any = null;
  isAdvancedRoom = false;
  developerAnnouncementText = '';
  developerAnnouncementLevel = 'warning';

  // 初期ルーム同期・メディア一括ダウンロードの共通表示
  isBundleLoading = false;
  bundleTotal = 0;
  bundleDone = 0;
  bundleLoadingText = '部屋データを準備しています';
  bundleLoadingDetail = '同期処理を開始しています。';
  bundleLoadingProgressText = 'しばらくお待ちください';
  bundleProgressPercent: number | null = null;
  bundleProgressAriaValue: number | null = null;
  private initialRoomLoadingState: BundleLoadingState | null = null;
  private mediaBundleLoadingStates: Map<string, BundleLoadingState> = new Map();
  private mediaBundleOperationSequence = 0;
  private previousBundleFocusedElement: HTMLElement | null = null;
  private bundleModalBackground: Array<{ element: HTMLElement, inert: boolean, ariaHidden: string | null }> = [];

  get isGmMode(): boolean { return this.gmModeService.isGm; }

  toggleMacroHotbarVisible() {
    this.isMacroHotbarVisible = !this.isMacroHotbarVisible;
    try {
      localStorage.setItem('udonarium.macroHotbar.visible.v1', this.isMacroHotbarVisible ? '1' : '0');
    } catch (e) {
      Logger.warn('macro hotbar visibility localStorage save failed', e);
    }
    EventSystem.trigger('MACRO_HOTBAR_VISIBILITY_CHANGED', { visible: this.isMacroHotbarVisible });
  }

  private loadMacroHotbarVisible(): boolean {
    try {
      const raw = localStorage.getItem('udonarium.macroHotbar.visible.v1');
      return raw == null ? true : raw === '1';
    } catch (e) {
      return true;
    }
  }

  toggleVnStageVisible() {
    this.isVnStageVisible = !this.isVnStageVisible;
    try {
      localStorage.setItem('udonarium.vnStage.visible.v1', this.isVnStageVisible ? '1' : '0');
    } catch (e) {
      Logger.warn('VN stage visibility localStorage save failed', e);
    }
  }

  private loadVnStageVisible(): boolean {
    try {
      const raw = localStorage.getItem('udonarium.vnStage.visible.v1');
      return raw == null ? false : raw === '1';
    } catch (e) {
      return false;
    }
  }

  toggleGmMode() {
    const isGm = this.gmModeService.toggle();
    if (PeerCursor.myCursor) {
      PeerCursor.myCursor.isGmMode = isGm;
    }

    const gmName = PeerCursor.myCursor && PeerCursor.myCursor.name ? PeerCursor.myCursor.name : Network.peerContext.userId;
    const text = isGm ? `${gmName} がGMを宣言しました。` : `${gmName} がPLに戻りました。`;
    const chatTabList = ObjectStore.instance.get<ChatTabList>('ChatTabList');
    const sysTab = chatTabList ? chatTabList.systemMessageTab : null;
    this.chatMessageService.sendSystemMessage(sysTab, text, '#006633');
  }
  dispcounter = 10 ; // 表示更新用ダミーカットインを閉じるときに無理やり更新させている。


  constructor(
    private modalService: ModalService,
    private panelService: PanelService,
    private pointerDeviceService: PointerDeviceService,
    private chatMessageService: ChatMessageService,
    private appConfigService: AppConfigService,
    private saveDataService: SaveDataService,
    public gmModeService: GmModeService,
    private ngSelectConfig: NgSelectConfig,
    private ngZone: NgZone,
    private audioLibraryService: AudioLibraryService,
    private hostElement: ElementRef<HTMLElement>
  ) {

    // AudioLibraryServiceをJukeboxに注入
    Jukebox.setAudioLibraryService(this.audioLibraryService);
    (window as any).__audioLibraryService = this.audioLibraryService;
    // 初回フェッチ
    this.audioLibraryService.fetchTracks();

    this.ngZone.runOutsideAngular(() => {
      EventSystem;
      Network;
      FileArchiver.instance.initialize();
      ImageSharingSystem.instance.initialize();
      ImageStorage.instance;
      AudioSharingSystem.instance.initialize();
      AudioStorage.instance;
      ObjectFactory.instance;
      ObjectSerializer.instance;
      ObjectStore.instance;
      ObjectSynchronizer.instance.initialize();
      InitialRoomSync.instance.initialize();
    });
    this.appConfigService.initialize();
    this.pointerDeviceService.initialize();
    this.ngSelectConfig.appendTo = 'body';

    TableSelecter.instance.initialize();
    ChatTabList.instance.initialize();

    Config.instance.initialize();

    DataSummarySetting.instance.initialize();

    let diceBot: DiceBot = new DiceBot('DiceBot');
    diceBot.initialize();
    DiceBot.getHelpMessage('').then(() => this.lazyNgZoneUpdate(true));

    let jukebox: Jukebox = new Jukebox('Jukebox');
    jukebox.initialize();

    let markdown: MarkDown = new MarkDown('markdwon');
    markdown.initialize();

    let cutInLauncher = new CutInLauncher('CutInLauncher');
    cutInLauncher.initialize();

    let vote = new Vote('Vote');
    vote.initialize();

    let alarm = new Alarm('Alarm');
    alarm.initialize();

    let reloadCheck = new ReloadCheck('ReloadCheck');
    reloadCheck.initialize();

    let soundEffect: SoundEffect = new SoundEffect('SoundEffect');
    soundEffect.initialize();
    AutoSoundService.init();

    ChatTabList.instance.addChatTab('メインタブ', 'MainTab');
    ChatTabList.instance.addChatTab('サブタブ', 'SubTab');

    let fileContext = ImageFile.createEmpty('none_icon').toContext();
    fileContext.url = './assets/images/ic_account_circle_black_24dp_2x.png';
    let noneIconImage = ImageStorage.instance.add(fileContext);

    AudioPlayer.resumeAudioContext();
    PresetSound.dicePick = AudioStorage.instance.add('./assets/sounds/soundeffect-lab/shoulder-touch1.mp3').identifier;
    PresetSound.dicePut = AudioStorage.instance.add('./assets/sounds/soundeffect-lab/book-stack1.mp3').identifier;
    PresetSound.diceRoll1 = AudioStorage.instance.add('./assets/sounds/on-jin/spo_ge_saikoro_teburu01.mp3').identifier;
    PresetSound.diceRoll2 = AudioStorage.instance.add('./assets/sounds/on-jin/spo_ge_saikoro_teburu02.mp3').identifier;
    PresetSound.cardDraw = AudioStorage.instance.add('./assets/sounds/soundeffect-lab/card-turn-over1.mp3').identifier;
    PresetSound.cardPick = AudioStorage.instance.add('./assets/sounds/soundeffect-lab/shoulder-touch1.mp3').identifier;
    PresetSound.cardPut = AudioStorage.instance.add('./assets/sounds/soundeffect-lab/book-stack1.mp3').identifier;
    PresetSound.cardShuffle = AudioStorage.instance.add('./assets/sounds/soundeffect-lab/card-open1.mp3').identifier;
    PresetSound.piecePick = AudioStorage.instance.add('./assets/sounds/soundeffect-lab/shoulder-touch1.mp3').identifier;
    PresetSound.piecePut = AudioStorage.instance.add('./assets/sounds/soundeffect-lab/book-stack1.mp3').identifier;
    PresetSound.blockPick = AudioStorage.instance.add('./assets/sounds/tm2/tm2_pon002.wav').identifier;
    PresetSound.blockPut = AudioStorage.instance.add('./assets/sounds/tm2/tm2_pon002.wav').identifier;
    PresetSound.lock = AudioStorage.instance.add('./assets/sounds/tm2/tm2_switch001.wav').identifier;
    PresetSound.unlock = AudioStorage.instance.add('./assets/sounds/tm2/tm2_switch001.wav').identifier;
    PresetSound.sweep = AudioStorage.instance.add('./assets/sounds/tm2/tm2_swing003.wav').identifier;
    PresetSound.alarm = AudioStorage.instance.add('./assets/sounds/alarm/alarm.mp3').identifier;

    AudioStorage.instance.get(PresetSound.dicePick).isHidden = true;
    AudioStorage.instance.get(PresetSound.dicePut).isHidden = true;
    AudioStorage.instance.get(PresetSound.diceRoll1).isHidden = true;
    AudioStorage.instance.get(PresetSound.diceRoll2).isHidden = true;
    AudioStorage.instance.get(PresetSound.cardDraw).isHidden = true;
    AudioStorage.instance.get(PresetSound.cardPick).isHidden = true;
    AudioStorage.instance.get(PresetSound.cardPut).isHidden = true;
    AudioStorage.instance.get(PresetSound.cardShuffle).isHidden = true;
    AudioStorage.instance.get(PresetSound.piecePick).isHidden = true;
    AudioStorage.instance.get(PresetSound.piecePut).isHidden = true;
    AudioStorage.instance.get(PresetSound.blockPick).isHidden = true;
    AudioStorage.instance.get(PresetSound.blockPut).isHidden = true;
    AudioStorage.instance.get(PresetSound.lock).isHidden = true;
    AudioStorage.instance.get(PresetSound.unlock).isHidden = true;
    AudioStorage.instance.get(PresetSound.sweep).isHidden = true;
    AudioStorage.instance.get(PresetSound.alarm).isHidden = true;

    PeerCursor.createMyCursor();
    PeerCursor.myCursor.name = 'プレイヤー';
    PeerCursor.myCursor.imageIdentifier = noneIconImage.identifier;
    PeerCursor.myCursor.isGmMode = this.gmModeService.isGm;

    EventSystem.register(this)
      .on('ALARM_TIMEUP_ORIGIN', event => {
        this.alarmTimeUpOrigin( event.data.text );
      })
      .on('ALARM_POP', event => {
        this.alarmPop( event.data.title , event.data.time );
      })
      .on('START_VOTE', event => {
        this.startVote();
      })
      .on('FINISH_VOTE', event => {
        this.finishVote( event.data.text );
      })
      .on('START_CUT_IN', event => {
        this.startCutIn( event.data.cutIn );
      })
      .on('STOP_CUT_IN', event => {
        if ( ! event.data.cutIn ) return;
        Logger.debug('カットインイベント_ストップ'  + event.data.cutIn.name );

      })
      .on('DEVELOPER_ANNOUNCEMENT', event => {
        this.ngZone.run(() => {
          const data = event.data || {};
          this.handleDeveloperControlMessage(data);
        });
      })
      .on('INITIAL_ROOM_MEDIA_CATALOG', 1000, event => {
        if (!event.isSendFromSelf) return;
        const data = event.data as any;
        if (!data || data.handled) return;
        // The low-priority legacy listeners inspect this flag synchronously.
        // Claim the catalog before starting the asynchronous HTTP ZIP request.
        data.handled = true;
        this.loadInitialRoomMediaBundle(data);
      })
      .on('INITIAL_ROOM_SYNC_PROGRESS', event => {
        if (!event.isSendFromSelf) return;
        this.ngZone.run(() => this.updateInitialRoomLoadingState(event.data));
      })
      .on('MEDIA_BUNDLE_PROGRESS', event => {
        if (!event.isSendFromSelf) return;
        this.ngZone.run(() => {
          const data = event.data || {};
          const operationId = typeof data.operationId === 'string' && data.operationId.length <= 128
            ? data.operationId
            : 'legacy-media-bundle';
          if (data.status === 'downloading' || data.status === 'extracting') {
            const next: BundleLoadingState = {
              operationId,
              source: 'media',
              phase: data.status,
              total: this.toProgressNumber(data.total),
              done: this.toProgressNumber(data.done)
            };
            const previous = this.mediaBundleLoadingStates.get(operationId);
            if (!this.shouldUpdateMediaProgress(previous, next)) return;
            // Reinsert so the operation with the newest visible progress wins.
            this.mediaBundleLoadingStates.delete(operationId);
            this.mediaBundleLoadingStates.set(operationId, next);
          } else {
            this.mediaBundleLoadingStates.delete(operationId);
          }
          this.refreshBundleLoadingOverlay();
        });
      })
      .on('UPDATE_GAME_OBJECT', event => { this.syncAdvancedRoomUiClass(); this.lazyNgZoneUpdate(event.isSendFromSelf); })
      .on('DELETE_GAME_OBJECT', event => { this.syncAdvancedRoomUiClass(); this.lazyNgZoneUpdate(event.isSendFromSelf); })
      .on('SELECT_GAME_TABLE', event => { this.syncAdvancedRoomUiClass(); this.closePanelsIfNotAdvanced(); })
      .on('SYNCHRONIZE_AUDIO_LIST', event => { if (event.isSendFromSelf) this.lazyNgZoneUpdate(false); })
      .on('VN_STAGE_VISIBILITY_CHANGED', event => {
        this.ngZone.run(() => { this.isVnStageVisible = !!event.data?.visible; });
      })
      .on('ADD_SAMPLE_CHARACTERS', event => {
        this.ngZone.run(() => {
          this.addDefaultMakutsuMakoPiece();
          this.addDefaultMomokaPiece();
          this.adjustDefaultVnPiecePositions();
        });
      })
      .on('OPTIONS_PANEL_CLOSED', event => {
        this.optionsPanelOpen = false;
      })
      .on('LIGHTING_PANEL_CLOSED', event => {
        this.lightingPanelOpen = false;
      })
      .on('CLOSE_INITIATIVE_PANEL', event => {
        this.initiativePanelOpen = false;
      })
      .on('INITIATIVE_PANEL_CLOSED', event => {
        this.initiativePanelOpen = false;
      })
      .on('OPTIONS_PANEL_RESIZE', event => {
        // PanelService doesn't support runtime resize easily,
        // so close and reopen with adjusted size
        if (this.optionsPanelOpen) {
          EventSystem.trigger('CLOSE_OPTIONS_PANEL', {});
          this.optionsPanelOpen = false;
          setTimeout(() => {
            this.optionsPanelOpen = true;
            const compact = !!event.data?.compact;
            const option: PanelOption = compact
              ? { width: 340, height: 90, left: 120, title: 'オプション' }
              : { width: 400, height: 520, left: 120, title: 'オプション' };
            option.top = (this.openPanelCount % 10 + 1) * 20;
            option.left = 100 + (this.openPanelCount % 20 + 1) * 5;
            this.openPanelCount++;
            this.panelService.open(OptionsPanelComponent, option);
          }, 50);
        }
      })
      .on('SYNCHRONIZE_FILE_LIST', event => { if (event.isSendFromSelf) this.lazyNgZoneUpdate(false); })
      .on<AppConfig>('LOAD_CONFIG', event => {
        Logger.debug('LOAD_CONFIG !!!');
        Network.configure(event.data);
        Network.setApiKey(event.data.webrtc.key);
        Network.setSignalingUrl(event.data.webrtc.signalingUrl || '');
        Network.setIceServers(event.data.webrtc.config ? event.data.webrtc.config.iceServers || [] : []);
        this.openNetworkFromDeveloperJoinIfNeeded().then(opened => {
          if (!opened) Network.open();
        });
      })
      .on<File>('FILE_LOADED', event => {
        this.lazyNgZoneUpdate(false);
      })
      .on('OPEN_NETWORK', event => {
        Logger.debug('OPEN_NETWORK', event.data.peerId);
        // Force VN stage off during sync to prevent freeze
        this.vnStageReady = false;
        if (this.vnStageReadyTimer) clearTimeout(this.vnStageReadyTimer);
        this.vnStageReadyTimer = setTimeout(() => {
          this.ngZone.run(() => { this.vnStageReady = true; });
        }, 1500);
        PeerCursor.myCursor.peerId = Network.peerContext.peerId;
        PeerCursor.myCursor.userId = Network.peerContext.userId;
        this.announceDeveloperJoinIfNeeded();
        // 初期オブジェクトの自動配置は廃止（ヘルプ→サンプルキャラから手動配置）
      })
      .on('NETWORK_ERROR', event => {
        Logger.debug('NETWORK_ERROR', event.data.peerId);
        let errorType: string = event.data.errorType;
        let errorMessage: string = event.data.errorMessage;

        this.ngZone.run(async () => {
          //SKyWayエラーハンドリング
          let quietErrorTypes = ['peer-unavailable'];
          let reconnectErrorTypes = ['disconnected', 'socket-error', 'unavailable-id', 'authentication', 'server-error'];

          if (quietErrorTypes.includes(errorType)) return;
          await this.modalService.open(TextViewComponent, { title: 'ネットワークエラー', text: errorMessage });

          if (!reconnectErrorTypes.includes(errorType)) return;
          await this.modalService.open(TextViewComponent, { title: 'ネットワークエラー', text: 'このウィンドウを閉じると再接続を試みます。' });
          Network.open();
        });
      })
      .on('SERVER_MEDIA_MISSING', event => {
        // システムメッセージを抑制（ログのみ）
        const kind = event.data && event.data.kind === 'image' ? '画像' : '音声';
        const identifier = event.data && event.data.identifier ? String(event.data.identifier).slice(0, 12) : '';
        Logger.debug(`[SERVER_MEDIA_MISSING] ${kind}データが見つかりません${identifier ? ` (${identifier}...)` : ''}`);
      })
      .on('CONNECT_PEER', event => {
        if (event.isSendFromSelf) this.chatMessageService.calibrateTimeOffset();
        this.lazyNgZoneUpdate(event.isSendFromSelf);
      })
      .on('DISCONNECT_PEER', event => {
        this.lazyNgZoneUpdate(event.isSendFromSelf);
      });
  }

  private updateInitialRoomLoadingState(data: any) {
    const phase = typeof data?.phase === 'string' ? data.phase : '';
    const syncId = typeof data?.syncId === 'string' && data.syncId.length <= 128 ? data.syncId : '';
    if (phase === 'idle') {
      this.initialRoomLoadingState = null;
    } else if (phase === 'complete' || phase === 'failed' || phase === 'fallback') {
      if (!this.initialRoomLoadingState || !syncId || this.initialRoomLoadingState.operationId === syncId) {
        this.initialRoomLoadingState = null;
      }
    } else if (phase === 'preparing' || phase === 'downloading' || phase === 'extracting' || phase === 'applying') {
      this.initialRoomLoadingState = {
        operationId: syncId || 'initial-room-sync',
        source: 'room',
        phase,
        total: this.toProgressNumber(data.total),
        done: this.toProgressNumber(data.done)
      };
    } else {
      return;
    }
    this.refreshBundleLoadingOverlay();
  }

  private refreshBundleLoadingOverlay() {
    // Media starts immediately after the room objects are applied. Keeping the
    // states separate prevents the room-complete event from hiding media work.
    const mediaStates = Array.from(this.mediaBundleLoadingStates.values());
    const state = mediaStates[mediaStates.length - 1] || this.initialRoomLoadingState;
    const wasLoading = this.isBundleLoading;
    this.isBundleLoading = state != null;
    if (wasLoading !== this.isBundleLoading) this.setBundleModalActive(this.isBundleLoading);
    if (!state) {
      this.bundleTotal = 0;
      this.bundleDone = 0;
      this.bundleProgressPercent = null;
      this.bundleProgressAriaValue = null;
      return;
    }

    this.bundleTotal = state.total;
    this.bundleDone = 0 < state.total ? Math.min(state.done, state.total) : state.done;
    this.bundleProgressPercent = 0 < state.total
      ? Math.max(0, Math.min(100, this.bundleDone / state.total * 100))
      : null;
    this.bundleProgressAriaValue = this.bundleProgressPercent == null
      ? null
      : Math.floor(this.bundleProgressPercent);

    if (state.source === 'media') {
      if (state.phase === 'extracting') {
        this.bundleLoadingText = '画像・音声を展開中';
        this.bundleLoadingDetail = '受信したメディアZIPを順番に展開しています。';
      } else {
        this.bundleLoadingText = '画像・音声をダウンロード中';
        this.bundleLoadingDetail = '部屋で使用するメディアをまとめて取得しています。';
      }
    } else if (state.phase === 'preparing') {
      this.bundleLoadingText = '部屋データを準備中';
      this.bundleLoadingDetail = '同期元の端末でZIPファイルを作成しています。';
    } else if (state.phase === 'downloading') {
      this.bundleLoadingText = '部屋データをダウンロード中';
      this.bundleLoadingDetail = '同期用ZIPファイルを受信しています。';
    } else if (state.phase === 'extracting') {
      this.bundleLoadingText = '部屋データを展開中';
      this.bundleLoadingDetail = '受信したZIPファイルを確認して展開しています。';
    } else {
      this.bundleLoadingText = '部屋データを反映中';
      this.bundleLoadingDetail = 'キャラクターやチャットなどを部屋に反映しています。';
    }

    if (this.bundleProgressPercent == null) {
      this.bundleLoadingProgressText = state.phase === 'preparing'
        ? 'ZIPファイルを準備しています'
        : state.phase === 'extracting'
          ? 'ZIPファイルを確認しています'
          : '処理を開始しています';
    } else if (state.source === 'media' || state.phase === 'applying') {
      this.bundleLoadingProgressText = `${this.bundleDone.toLocaleString()} / ${this.bundleTotal.toLocaleString()} 件`;
    } else {
      this.bundleLoadingProgressText = `${Math.floor(this.bundleProgressPercent)}%`;
    }
  }

  private toProgressNumber(value: any): number {
    return Number.isSafeInteger(value) && 0 <= value ? value : 0;
  }

  private shouldUpdateMediaProgress(previous: BundleLoadingState | undefined, next: BundleLoadingState): boolean {
    if (!previous || previous.phase !== next.phase || previous.total !== next.total) return true;
    if (0 < next.total && next.total <= next.done) return true;
    if (next.total < 1) return false;
    const previousPercent = Math.floor(Math.min(previous.done, previous.total) / previous.total * 100);
    const nextPercent = Math.floor(Math.min(next.done, next.total) / next.total * 100);
    return previousPercent !== nextPercent;
  }

  private setBundleModalActive(active: boolean) {
    const host = this.hostElement.nativeElement;
    if (active) {
      const focused = document.activeElement;
      this.previousBundleFocusedElement = focused instanceof HTMLElement && focused !== document.body ? focused : null;
    }

    setTimeout(() => {
      if (active) {
        this.restoreBundleModalBackground();
        this.bundleModalBackground = Array.from(host.children)
          .filter(element => !element.classList.contains('bundle-loading-overlay'))
          .map(element => ({
            element: element as HTMLElement,
            inert: element.hasAttribute('inert'),
            ariaHidden: element.getAttribute('aria-hidden')
          }));
        for (const item of this.bundleModalBackground) {
          item.element.setAttribute('inert', '');
          item.element.setAttribute('aria-hidden', 'true');
        }
        const card = host.querySelector('.bundle-loading-card') as HTMLElement;
        if (card) card.focus({ preventScroll: true });
      } else {
        this.restoreBundleModalBackground();
        const previous = this.previousBundleFocusedElement;
        this.previousBundleFocusedElement = null;
        if (previous && previous.isConnected) previous.focus({ preventScroll: true });
      }
    }, 0);
  }

  private restoreBundleModalBackground() {
    for (const item of this.bundleModalBackground) {
      if (item.inert) item.element.setAttribute('inert', '');
      else item.element.removeAttribute('inert');
      if (item.ariaHidden == null) item.element.removeAttribute('aria-hidden');
      else item.element.setAttribute('aria-hidden', item.ariaHidden);
    }
    this.bundleModalBackground = [];
  }

  private async loadInitialRoomMediaBundle(data: any): Promise<void> {
    const images = Array.isArray(data.images)
      ? data.images.map(item => item && item.identifier).filter(identifier => typeof identifier === 'string')
      : [];
    const audios = Array.isArray(data.audios)
      ? data.audios.map(item => item && item.identifier).filter(identifier => typeof identifier === 'string')
      : [];
    const fallback = typeof data.fallback === 'function' ? data.fallback : () => { };
    const operationId = `initial-room-media-${Date.now().toString(36)}-${++this.mediaBundleOperationSequence}`;

    EventSystem.trigger('MEDIA_BUNDLE_PROGRESS', {
      operationId,
      status: 'downloading',
      total: images.length + audios.length,
      done: 0,
    });
    try {
      const result = await ServerMediaStorage.fetchBundle(images, audios, progress => {
        EventSystem.trigger('MEDIA_BUNDLE_PROGRESS', {
          operationId,
          status: 'extracting',
          total: progress.total,
          done: progress.done,
        });
      });
      if (result.missing.length || result.failed.length) {
        Logger.warn(`[media-bundle] loaded=${result.loaded} missing=${result.missing.length} failed=${result.failed.length}`);
      }
    } catch (error) {
      // Old servers and interrupted ZIP transfers immediately return to the
      // existing individual HTTP/P2P path instead of blocking room entry.
      Logger.warn('[media-bundle] bulk download failed; using legacy fallback', error);
    } finally {
      fallback();
      EventSystem.trigger('MEDIA_BUNDLE_PROGRESS', { operationId, status: 'done', total: 0, done: 0 });
    }
  }

  ngAfterViewInit() {
    PanelService.defaultParentViewContainerRef = ModalService.defaultParentViewContainerRef = ContextMenuService.defaultParentViewContainerRef = this.modalLayerViewContainerRef;
    this.syncAdvancedRoomUiClass();
    setTimeout(() => {
      this.panelService.open(PeerMenuComponent, { width: 500, height: 450, left: 100 });
      this.panelService.open(ChatWindowComponent, { width: 700, height: 400, left: 100, top: 450 });
      this.showRightsNoticeOnStartup();
    }, 0);
    this.startDeveloperClientBridge();
    this.installMakoDebugDump();
  }

  private showRightsNoticeOnStartup() {
    const text = [
      '法令または公序良俗に違反する行為を禁止しています。',
      '詳しくは利用規約をご一読ください。',
      'https://udonarium-lycoris.ddns.net/docs/terms.html',
      '',
      'ご了承いただけたらOKを押してください。'
    ].join('\n');
    this.modalService.open(TextViewComponent, { title: '利用規約について', text });
  }

  private installMakoDebugDump() {
    (window as any).__makoUdonDebug = () => {
      const safePeer = (peer: any) => peer ? {
        peerId: peer.peerId,
        userId: peer.userId,
        roomId: peer.roomId,
        roomName: peer.roomName,
        digestPassword: peer.digestPassword,
        roomChannelName: peer.roomChannelName,
        isDeveloperJoin: peer.isDeveloperJoin,
        isOpen: peer.isOpen,
        isRoom: peer.isRoom,
        hasPassword: peer.hasPassword,
      } : null;
      const instance: any = (Network as any).instance;
      const connection: any = instance?.connection;
      const skyWay: any = connection?.skyWay;
      const room: any = skyWay?.room;
      const streams = connection?.streams ? Array.from(connection.streams as any).map((stream: any) => ({
        peer: safePeer(stream.peer),
        isPublication: stream.isPublication,
        open: stream.open,
        state: stream.state,
        isCanceled: stream.isCanceled,
        isRejected: stream.isRejected,
        isOpend: stream.isOpend,
        sortKey: stream.sortKey,
        subscriptionId: stream.subscription?.id,
        publicationId: stream.subscription?.publication?.id,
        dataChannelState: stream.dataChannel?.readyState,
      })) : [];
      return {
        href: location.href,
        userAgent: navigator.userAgent,
        at: new Date().toISOString(),
        developerJoinEntry: this.developerJoinEntry,
        network: {
          peerId: Network.peerId,
          peerIds: Network.peerIds,
          peerContext: safePeer(Network.peerContext),
          peerContexts: Network.peerContexts.map(peer => safePeer(peer)),
        },
        connection: {
          className: connection?.constructor?.name,
          listAllPeersCache: connection?.listAllPeersCache,
          trustedPeerIds: connection?.trustedPeerIds ? Array.from(connection.trustedPeerIds) : [],
          maybeUnavailablePeerIds: connection?.maybeUnavailablePeerIds ? Array.from(connection.maybeUnavailablePeerIds) : [],
          relayingPeerIds: connection?.relayingPeerIds ? Array.from(connection.relayingPeerIds.entries()) : [],
          streams,
        },
        skyWay: {
          isOpen: skyWay?.isOpen,
          peer: safePeer(skyWay?.peer),
          roomName: room?.name,
          roomId: room?.id,
          members: room?.members?.map((member: any) => ({
            id: member.id,
            name: member.name,
            state: member.state,
            publications: member.publications?.map((publication: any) => ({ id: publication.id, contentType: publication.contentType, metadata: publication.metadata })) || [],
            subscriptions: member.subscriptions?.map((subscription: any) => ({
              id: subscription.id,
              publicationId: subscription.publication?.id,
              publisherName: subscription.publication?.publisher?.name,
              contentType: subscription.publication?.contentType,
              metadata: subscription.publication?.metadata,
            })) || [],
          })) || [],
          localPublication: skyWay?.publication ? {
            id: skyWay.publication.id,
            contentType: skyWay.publication.contentType,
            metadata: skyWay.publication.metadata,
            publisherName: skyWay.publication.publisher?.name,
          } : null,
        },
      };
    };
  }

  ngOnDestroy() {
    InitialRoomSync.instance.destroy();
    EventSystem.unregister(this);
    this.restoreBundleModalBackground();
    document.body.classList.remove('udonarium-advanced-room');
    if (this.developerPollTimer != null) clearInterval(this.developerPollTimer);
    if (this.developerHeartbeatTimer != null) clearInterval(this.developerHeartbeatTimer);
  }

  private loadDeveloperSessionId(): string {
    try {
      let id = sessionStorage.getItem('udonarium.devClientSessionId');
      if (!id) {
        id = 'dev-client-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        sessionStorage.setItem('udonarium.devClientSessionId', id);
      }
      return id;
    } catch (e) {
      return 'dev-client-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
  }

  private startDeveloperClientBridge() {
    this.pollDeveloperAnnouncements();
    this.sendDeveloperHeartbeat();
    this.developerPollTimer = setInterval(() => this.pollDeveloperAnnouncements(), 3000);
    this.developerHeartbeatTimer = setInterval(() => this.sendDeveloperHeartbeat(), 10000);
  }

  private async pollDeveloperAnnouncements() {
    try {
      const response = await fetch(`/api/dev/announcements?since=${this.developerAnnouncementSeq}`, { cache: 'no-cache' });
      if (!response.ok) return;
      const data = await response.json();
      if (typeof data.seq === 'number') this.developerAnnouncementSeq = Math.max(this.developerAnnouncementSeq, data.seq);
      const announcements = Array.isArray(data.announcements) ? data.announcements : [];
      if (announcements.length < 1) return;
      for (const announcement of announcements) this.handleDeveloperControlMessage(announcement);
    } catch (e) {
      // 開発者機能なので、失敗しても通常プレイは止めない
    }
  }

  private handleDeveloperControlMessage(message: any) {
    this.ngZone.run(() => {
      if (message.clear || message.type === 'developer-announcement-clear') {
        this.developerAnnouncementText = '';
        this.developerAnnouncementLevel = 'warning';
        return;
      }
      if (message.type === 'developer-room-deleted') {
        if (message.roomKey === this.getDeveloperRoomKey()) {
          this.developerAnnouncementText = message.text || 'この部屋は開発者により削除されました。';
          this.developerAnnouncementLevel = 'danger';
          const chatTabList = ObjectStore.instance.get<ChatTabList>('ChatTabList');
          const sysTab = chatTabList ? chatTabList.systemMessageTab : null;
          this.chatMessageService.sendSystemMessage(sysTab, this.developerAnnouncementText, '#b71c1c');
          Network.open();
        }
        return;
      }
      this.developerAnnouncementText = message.startsAt ? `${message.startsAt} ${message.text}` : message.text;
      this.developerAnnouncementLevel = message.level || 'warning';
    });
  }

  private getDeveloperRoomKey(): string {
    const peerContext = Network.peerContext;
    return peerContext && peerContext.roomId ? `room:${peerContext.roomId}:${lzbase62.compress(peerContext.roomName || '')}:${peerContext.digestPassword || ''}` : 'lobby';
  }

  private async sendDeveloperHeartbeat() {
    try {
      const peerContext = Network.peerContext;
      await fetch('/api/dev/client-heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: this.developerSessionId,
          peerId: peerContext ? peerContext.peerId : '',
          roomId: peerContext ? peerContext.roomId : '',
          roomName: peerContext ? peerContext.roomName : '',
          digestPassword: peerContext ? peerContext.digestPassword : '',
          roomChannelName: peerContext && peerContext.isRoom ? (peerContext.roomChannelName || CryptoUtil.sha256Base64Url(peerContext.roomId + peerContext.roomName + peerContext.password)) : '',
        })
      });
    } catch (e) {
      // 開発者機能なので、失敗しても通常プレイは止めない
    }
  }

  private async openNetworkFromDeveloperJoinIfNeeded(): Promise<boolean> {
    try {
      const url = new URL(location.href);
      const token = url.searchParams.get('devJoin');
      if (!token) return false;
      url.searchParams.delete('devJoin');
      history.replaceState(null, document.title, url.pathname + url.search + url.hash);

      const response = await fetch(`/api/dev/join-room/${encodeURIComponent(token)}`, { cache: 'no-cache' });
      if (!response.ok) return false;
      const data = await response.json();
      if (!data || !data.ok || !data.entry) return false;
      const entry = data.entry;
      this.developerJoinEntry = entry;
      const userId = entry.developerName || '開発者';
      const password = PeerContext.createDeveloperJoinPassword(entry.digestPassword, entry.roomChannelName);
      const joinPeerIds = Array.isArray(entry.peerIds) ? entry.peerIds.map(peerId => String(peerId || '')).filter(peerId => peerId.length > 0) : [];
      EventSystem.register(entry)
        .on('OPEN_NETWORK', event => {
          EventSystem.unregister(entry);
          ObjectStore.instance.clearDeleteHistory();
          setTimeout(() => {
            for (const peerId of joinPeerIds) {
              if (peerId !== Network.peerId) Network.connect(peerId);
            }
          }, 500);
        });
      Network.open(userId, entry.roomId, entry.roomName, password);
      return true;
    } catch (e) {
      Logger.warn('developer join failed', e);
      return false;
    }
  }

  private announceDeveloperJoinIfNeeded() {
    if (!this.developerJoinEntry || this.developerJoinAnnounced) return;
    this.developerJoinAnnounced = true;
    setTimeout(() => {
      const chatTabList = ObjectStore.instance.get<ChatTabList>('ChatTabList');
      const sysTab = chatTabList ? chatTabList.systemMessageTab : null;
      this.chatMessageService.sendSystemMessage(sysTab, '開発者が入室しました。', '#b71c1c');
    }, 1200);
  }

  alarmTimeUpOrigin(text: string){
    let alarm = ObjectStore.instance.get<Alarm>('Alarm');
    this.chatMessageService.sendSystemMessageLastSendCharactor(text);
  }

  alarmTimeUpTarget(text: string){
    let alarm = ObjectStore.instance.get<Alarm>('Alarm');
    this.chatMessageService.sendSystemMessageLastSendCharactor(text);
  }

  startVote(){
    Logger.debug( '点呼/投票イベント_スタート' );
    let vote = ObjectStore.instance.get<Vote>('Vote');
    if (!vote.chkToMe() )return;

    let option: PanelOption = { left: 0, top: 0, width: 450, height: 400 };
    option.title = '点呼/投票';

    let margin_w = (window.innerWidth - option.width) / 2;
    let margin_h = (window.innerHeight - option.height) / 2 ;
    if ( margin_w < 0 )margin_w = 0 ;
    if ( margin_h < 0 )margin_h = 0 ;
    option.left = margin_w ;
    option.top = margin_h;
    let component = this.panelService.open(VoteWindowComponent, option);
  }

  finishVote(text: string){
    Logger.debug( '投票集計完了' );
    this.chatMessageService.sendSystemMessageLastSendCharactor(text);
  }

  alarmPop(title: string, time: string){
    Logger.debug( 'ポップアップ_スタート' + title );
    let winH = 100;
    let winW = 200;
    let option: PanelOption = { width: winW, height: winH, left: 300 , top: 100};
    option.title = 'アラーム ' + title;

    Logger.debug( 'POP画面領域 w:' + window.innerWidth + ' h:' + window.innerHeight );
    Logger.debug( 'POPサイズ w:' + winW + ' h:' + winH );

    let margin_w = window.innerWidth - winW ;
    let margin_h = window.innerHeight - winH - 25 ;

    if ( margin_w < 0 )margin_w = 0 ;
    if ( margin_h < 0 )margin_h = 0 ;

    let margin_x = margin_w * 0.5;
    let margin_y = margin_h * 0.5;

    option.width = winW ;
    option.height = winH + 25 ;
    option.left = margin_x ;
    option.top = margin_y;

    let component = this.panelService.open(AlarmWindowComponent, option);
    component.title = title;
    component.time = time;

  }

  startCutIn( cutIn: CutIn ){
    if ( ! cutIn ) return;
    Logger.debug( 'カットインイベント_スタート' + cutIn.name );
    let option: PanelOption = { width: 200, height: 100, left: 300 , top: 100};
    option.title = 'カットイン : ' + cutIn.name ;

    Logger.debug( '画面領域 w:' + window.innerWidth + ' h:' + window.innerHeight );

    let cutin_w = cutIn.width;
    let cutin_h = cutIn.height;

    Logger.debug( '画像サイズ w:' + cutin_w + ' h:' + cutin_h );

    let margin_w = window.innerWidth - cutin_w ;
    let margin_h = window.innerHeight - cutin_h - 25 ;

    if ( margin_w < 0 )margin_w = 0 ;
    if ( margin_h < 0 )margin_h = 0 ;

    let margin_x = margin_w * cutIn.x_pos / 100;
    let margin_y = margin_h * cutIn.y_pos / 100;

    option.width = cutin_w ;
    option.height = cutin_h + 25 ;
    option.left = margin_x ;
    option.top = margin_y;
    option.isCutIn = true;
    option.cutInIdentifier = cutIn.identifier;


    let component = this.panelService.open(CutInWindowComponent, option);
    component.cutIn = cutIn;
    component.startCutIn();

  }

  open(componentName: string) {
    if (componentName === 'OptionsPanelComponent') {
      this.toggleOptionsPanel();
      return;
    }
    if (componentName === 'LightingPanelComponent') {
      this.toggleLightingPanel();
      return;
    }
    let component: { new(...args: any[]): any } = null;
    let option: PanelOption = { width: 450, height: 600, left: 100 }
    switch (componentName) {
      case 'PeerMenuComponent':
        component = PeerMenuComponent;
        break;
      case 'ChatWindowComponent':
        component = ChatWindowComponent;
        option.width = 700;
        break;
      case 'GameTableSettingComponent':
        component = GameTableSettingComponent;
        option = { width: 1200, height: 550, left: 10, top: 20 };
        break;
      case 'FileStorageComponent':
        component = FileStorageComponent;
        break;
      case 'GameCharacterSheetComponent':
        component = GameCharacterSheetComponent;
        break;
      case 'JukeboxComponent':
        component = JukeboxComponent;
        break;
      case 'GameCharacterGeneratorComponent':
        component = GameCharacterGeneratorComponent;
        option = { width: 500, height: 300, left: 100 };
        break;
      case 'GameObjectInventoryComponent':
        component = GameObjectInventoryComponent;
        break;
      case 'DataImportMenuComponent':
        component = DataImportMenuComponent;
        option = { width: 260, height: 160, left: 120 };
        break;
      case 'LightingPanelComponent':
        component = LightingPanelComponent;
        option = { width: 400, height: 500, left: 120, title: '照明視覚' };
        break;
      case 'InitiativePanelComponent':
        this.toggleInitiativePanel();
        return;
      case 'OptionsPanelComponent':
        component = OptionsPanelComponent;
        option = { width: 400, height: 520, left: 120, title: 'オプション' };
        break;
    }
    if (component) {
      option.top = (this.openPanelCount % 10 + 1) * 20;
      option.left = 100 + (this.openPanelCount % 20 + 1) * 5;
      if (componentName === 'GameTableSettingComponent') {
        option.width = Math.max(320, Math.min(1200, window.innerWidth - 20));
        option.height = Math.max(320, Math.min(550, window.innerHeight - 40));
        option.left = 10;
        option.top = 20;
      }
      this.openPanelCount = this.openPanelCount + 1;
      this.panelService.open(component, option);
    }
  }

  private optionsPanelOpen = false;

  private toggleOptionsPanel() {
    if (this.optionsPanelOpen) {
      EventSystem.trigger('CLOSE_OPTIONS_PANEL', {});
      this.optionsPanelOpen = false;
      return;
    }
    this.optionsPanelOpen = true;
    const compact = localStorage.getItem('udonarium.options.compact.v3') === '1';
    const option: PanelOption = compact
      ? { width: 340, height: 90, left: 120, title: 'オプション' }
      : { width: 400, height: 520, left: 120, title: 'オプション' };
    option.top = (this.openPanelCount % 10 + 1) * 20;
    option.left = 100 + (this.openPanelCount % 20 + 1) * 5;
    this.openPanelCount++;
    this.panelService.open(OptionsPanelComponent, option);
  }

  private lightingPanelOpen: boolean = false;

  private toggleLightingPanel() {
    if (this.lightingPanelOpen) {
      EventSystem.trigger('LIGHTING_PANEL_CLOSED', {});
      return;
    }
    this.lightingPanelOpen = true;
    const option: PanelOption = { width: 400, height: 400, left: 120, title: '照明視覚' };
    option.top = (this.openPanelCount % 10 + 1) * 20;
    option.left = 100 + (this.openPanelCount % 20 + 1) * 5;
    this.openPanelCount++;
    this.panelService.open(LightingPanelComponent, option);
  }

  get isLightingPanelOpen(): boolean { return this.lightingPanelOpen; }
  get isOptionsPanelOpen(): boolean { return this.optionsPanelOpen; }
  get isInitiativePanelOpen(): boolean { return this.initiativePanelOpen; }

  private initiativePanelOpen: boolean = false;

  private toggleInitiativePanel() {
    if (this.initiativePanelOpen) {
      EventSystem.trigger('CLOSE_INITIATIVE_PANEL', {});
      return;
    }
    this.initiativePanelOpen = true;
    const option: PanelOption = { width: 380, height: 500, left: 120, title: '戦闘管理' };
    option.top = (this.openPanelCount % 10 + 1) * 20;
    option.left = 100 + (this.openPanelCount % 20 + 1) * 5;
    this.openPanelCount++;
    this.panelService.open(InitiativePanelComponent, option);
  }

  async save() {
    if (this.isSaveing) return;
    this.isSaveing = true;
    this.progresPercent = 0;

    let roomName = Network.peerContext && 0 < Network.peerContext.roomName.length
      ? Network.peerContext.roomName
      : 'ルームデータ';
    await this.saveDataService.saveRoomAsync(roomName, percent => {
      this.progresPercent = percent;
    });

    setTimeout(() => {
      this.isSaveing = false;
      this.progresPercent = 0;
    }, 500);
  }

  handleFileSelect(event: Event) {
    let input = <HTMLInputElement>event.target;
    let files = input.files;

    this.reloadCheck.reloadCheckStart(this.networkService.peerContext.roomName != '');

    if (files.length) FileArchiver.instance.load(files);
    input.value = '';
  }

  private escapeXmlText(text: string): string {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /** assets画像をfetchしてImageFile（SHA256ハッシュID）に変換し、サーバーにアップロード */
  private async ensureAssetImagesSynced(paths: string[]): Promise<string[]> {
    const identifiers: string[] = [];
    for (const path of paths) {
      try {
        const response = await fetch(path);
        const blob = await response.blob();
        const imageFile = await ImageFile.createAsync(blob);
        if (imageFile && imageFile.identifier) {
          ImageStorage.instance.add(imageFile.toContext());
          await ServerMediaStorage.uploadImage(imageFile);
          identifiers.push(imageFile.identifier);
        } else {
          identifiers.push(path);
        }
      } catch (e) {
        Logger.warn('asset image fetch failed:', path, e);
        identifiers.push(path);
      }
    }
    return identifiers;
  }

  private addDefaultMakutsuMakoPiece() {
    const existing = ObjectStore.instance.getObjects(GameCharacter)
      .some(character => character.name === '魔窟マコ');
    if (existing) return;

    const assetPaths = [
      './assets/images/mako-vn/mako_0_normal.png',
      './assets/images/mako-vn/mako_1_musuttu.png',
      './assets/images/mako-vn/mako_2_bikkuri.png',
      './assets/images/mako-vn/mako_3_nakisou.png',
      './assets/images/mako-vn/mako_4_egao.png',
    ];
    const labels = ['通常', 'むすっ', 'びっくり', '泣きそう', '笑顔'];

    this.ensureAssetImagesSynced(assetPaths).then(identifiers => {
      const imageXml = identifiers
        .map((id, i) => `<data type="image" currentValue="${labels[i]}" name="imageIdentifier">${id}</data>`)
        .join('');
    const palette = `◆VNの使い方
// VNステージをONにする：右上/設定の「VN」を押す
// 盤面コマ名の横の「VN」ボタン、またはVNパネルのキャラ選択から「魔窟マコ」を選ぶ
// 立ち絵スロットで表情を選ぶ →「入場」でVNステージに表示
// VN入力欄で発言すると、ステージ上の立ち絵に吹き出し＋タイプライター表示
// 「立ち絵送信」をONにすると、チャットログにも選択中の立ち絵が付く
// 「コマにも反映」をONにすると、VNで選んだ表情が盤面コマ画像にも反映
// パレットを開くと、このチャパレの台詞をそのままVN発言として送れる
◆サンプル台詞
えへへ、マコをVNステージに出してくれるの？
ちゃんと表示できてるね。いい感じだよ
立ち絵を切り替える時は、VNパネルの表情スロットを押してね
コマにも反映をONにすると、盤面のアイコンも同じ表情になるよ
はじめてでも分かりやすい、VNステージのサンプルコマだよ
◆チェック用
2d6 表示テスト
1d100 動作確認`;
    const xml = `<character location.name="table" location.x="700" location.y="600" posZ="0" isDropShadow="true" overViewWidth="270" overViewMaxHeight="250" specifyKomaImageFlag="true" komaImageHeignt="100" chatColorCode.0="#B84CFF" chatColorCode.1="#FF5FB7" chatColorCode.2="#55AAFF"><data name="character"><data name="image">${imageXml}</data><data name="common"><data name="name">魔窟マコ</data><data name="size">1</data><data name="altitude">0</data></data><data name="detail"><data name="リソース"><data type="numberResource" currentValue="0" name="ICON">4</data><data type="numberResource" currentValue="10" name="HP">10</data></data><data name="立ち絵位置"><data type="numberResource" currentValue="0" name="POS">11</data></data><data name="コマ画像"><data type="numberResource" currentValue="0" name="ICON">4</data></data><data name="情報"><data type="note" name="用途">VN標準サンプルコマ</data><data type="note" name="説明">VNステージの立ち絵選択・入場・発言・コマ反映を試すためのサンプルです。</data></data></data><data name="buff"><data name="バフ/デバフ"></data></data></data><chat-palette dicebot="DiceBot">${this.escapeXmlText(palette)}</chat-palette></character>`;
    const object = ObjectSerializer.instance.parseXml(xml);
    if (object instanceof GameCharacter) {
      object.addExtendData();
      object.update();
    }
    });
  }

  private addDefaultMomokaPiece() {
    const existing = ObjectStore.instance.getObjects(GameCharacter)
      .some(character => character.name === '桃鬼華');
    if (existing) return;

    const assetPaths = [
      './assets/images/momoka-vn/momoka_0_normal.png',
      './assets/images/momoka-vn/momoka_1_joy.png',
      './assets/images/momoka-vn/momoka_2_angry.png',
      './assets/images/momoka-vn/momoka_3_surprised.png',
      './assets/images/momoka-vn/momoka_4_sad.png',
    ];
    const labels = ['通常', '喜び', '怒り', '驚き', '悲しみ'];

    this.ensureAssetImagesSynced(assetPaths).then(identifiers => {
      const imageXml = identifiers
        .map((id, i) => `<data type="image" currentValue="${labels[i]}" name="imageIdentifier">${id}</data>`)
        .join('');
    const palette = `◆VNの使い方
// VNステージで「桃鬼華」を選び、表情スロットから 通常/喜び/怒り/驚き/悲しみ を切り替え
// チャパレから台詞を送ると、VNステージ上に吹き出し表示
// 「コマにも反映」をONにすると、盤面アイコンも同じ表情に変わります
◆D&D 5e 判定
1d20+3 イニシアチブ
1d20+2 筋力判定
1d20+3 敏捷力判定
1d20+2 耐久力判定
1d20+0 知力判定
1d20+1 判断力判定
1d20+3 魅力判定
1d20+5 近接攻撃：鬼爪
1d6+3 斬撃ダメージ
1d20+5 遠隔攻撃：霊炎
1d8+3 火/霊的ダメージ
◆サンプル台詞
……桃鬼華。準備はできているわ
うまくいったみたい。少し嬉しい
それ以上は、許さない
えっ、今のは何？
少しだけ、胸が痛むの`;
    const xml = `<character location.name="table" location.x="800" location.y="600" posZ="0" isDropShadow="true" overViewWidth="270" overViewMaxHeight="250" specifyKomaImageFlag="true" komaImageHeignt="100" chatColorCode.0="#E86BA8" chatColorCode.1="#FF8FA3" chatColorCode.2="#7A4CFF"><data name="character"><data name="image">${imageXml}</data><data name="common"><data name="name">桃鬼華</data><data name="size">1</data><data name="altitude">0</data></data><data name="detail"><data name="リソース"><data type="numberResource" currentValue="24" name="HP">24</data><data type="numberResource" currentValue="15" name="AC">15</data><data type="numberResource" currentValue="3" name="INIT">3</data><data type="numberResource" currentValue="2" name="PB">2</data></data><data name="能力値"><data type="note" name="STR">14（+2）</data><data type="note" name="DEX">16（+3）</data><data type="note" name="CON">14（+2）</data><data type="note" name="INT">10（+0）</data><data type="note" name="WIS">12（+1）</data><data type="note" name="CHA">16（+3）</data></data><data name="D&amp;D 5e"><data type="note" name="種別">中型・人型（鬼の血を引く者）</data><data type="note" name="想定CR/レベル">サンプル用：低〜中レベル帯</data><data type="note" name="移動速度">30ft</data><data type="note" name="攻撃">鬼爪：+5、1d6+3斬撃 / 霊炎：+5、1d8+3火または霊的ダメージ</data><data type="note" name="特徴">暗視60ft、威圧に習熟、感情に応じてVN立ち絵を切替</data></data><data name="立ち絵位置"><data type="numberResource" currentValue="1" name="POS">11</data></data><data name="コマ画像"><data type="numberResource" currentValue="0" name="ICON">4</data></data><data name="情報"><data type="note" name="用途">D&amp;D 5eベースのVNサンプルコマ</data><data type="note" name="説明">桃鬼華。通常/喜び/怒り/驚き/悲しみの5表情を持つ初期配置キャラクターです。</data></data></data><data name="buff"><data name="バフ/デバフ"></data></data></data><chat-palette dicebot="DungeonsAndDragons5">${this.escapeXmlText(palette)}</chat-palette></character>`;
    const object = ObjectSerializer.instance.parseXml(xml);
    if (object instanceof GameCharacter) {
      object.addExtendData();
      object.update();
    }
    });
  }

  private addDefaultUpdateNoticeNote() {
    const existing = ObjectStore.instance.getObjects(TextNote)
      .some(note => note.title === 'アップデート内容');
    if (existing) return;

    const text = `ユドナリウムリコリス v1.22.0 更新メモ

◆コマ正面マーク
・コマの向き（光源方向 rotate + 90）を外側の矢印で表示
・平面モードでは正面マークをドラッグしてコマを回転可能

◆照明レーザー
・照射形状に「レーザー」を追加
・指定色の細い直線光を rotate + 90 方向へ照射
・レーザーは壁で遮断され、懐中電灯と同様に近距離の足元照明を補助

◆光源タイプ整理
・光源タイプを「松明」「魔法の光」「懐中電灯」の3種類に整理
・魔法の光にソナー風の脈動リング演出を追加
・コーン/レーザー/懐中電灯の近距離照明を調整


このメモはセッション開始時の案内スペースです。必要に応じて内容を書き換えて使ってください。`;

    const note = TextNote.create('アップデート内容', text, 14, 5, 4);
    note.location.x = 750;
    note.location.y = 500;
    note.posZ = 0;
    note.isLock = false;
    note.zindex = 1;
    note.overViewWidth = 620;
    note.overViewMaxHeight = 180;
    note.limitHeight = true;
    note.update();
  }

  private adjustDefaultVnPiecePositions() {
    const mako = ObjectStore.instance.getObjects(GameCharacter).find(character => character.name === '魔窟マコ');
    if (mako && mako.location.x === 80 && mako.location.y === 80) {
      mako.location.x = 700;
      mako.location.y = 600;
      mako.update();
    }

    const momoka = ObjectStore.instance.getObjects(GameCharacter).find(character => character.name === '桃鬼華');
    if (momoka && momoka.location.x === 240 && momoka.location.y === 80) {
      momoka.location.x = 800;
      momoka.location.y = 600;
      momoka.update();
    }
  }

  private lazyNgZoneUpdate(isImmediate: boolean) {
    this.syncAdvancedRoomUiClass();
    if (isImmediate) {
      if (this.immediateUpdateTimer !== null) return;
      this.immediateUpdateTimer = setTimeout(() => {
        this.immediateUpdateTimer = null;
        if (this.lazyUpdateTimer != null) {
          clearTimeout(this.lazyUpdateTimer);
          this.lazyUpdateTimer = null;
        }
        this.ngZone.run(() => { });
      }, 0);
    } else {
      if (this.lazyUpdateTimer !== null) return;
      this.lazyUpdateTimer = setTimeout(() => {
        this.lazyUpdateTimer = null;
        if (this.immediateUpdateTimer != null) {
          clearTimeout(this.immediateUpdateTimer);
          this.immediateUpdateTimer = null;
        }
        this.ngZone.run(() => { });
      }, 100);
    }
  }

  private syncAdvancedRoomUiClass() {
    const ts = TableSelecter.instance;
    const inRoom = ts != null && ts.viewTableIdentifier.length > 0;
    const viewTable = inRoom ? ts.viewTable : null;
    const enabled = !!viewTable && viewTable.roomMode === 'advanced';
    this.isAdvancedRoom = enabled;
    document.body.classList.toggle('udonarium-advanced-room', enabled);
  }

  private closePanelsIfNotAdvanced() {
    if (!this.isAdvancedRoom) {
      if (this.lightingPanelOpen) {
        EventSystem.trigger('LIGHTING_PANEL_CLOSED', {});
      }
      if (this.initiativePanelOpen) {
        EventSystem.trigger('CLOSE_INITIATIVE_PANEL', {});
      }
    }
  }
}

PanelService.UIPanelComponentClass = UIPanelComponent;
ContextMenuService.ContextMenuComponentClass = ContextMenuComponent;
ModalService.ModalComponentClass = ModalComponent;
