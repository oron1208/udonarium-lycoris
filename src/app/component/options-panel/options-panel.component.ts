import { Component, NgZone, OnDestroy, OnInit } from '@angular/core';
import { EventSystem } from '@udonarium/core/system';
import { Network } from '@udonarium/core/system';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { GameTable } from '@udonarium/game-table';
import { ChatTabList } from '@udonarium/chat-tab-list';
import { PeerCursor } from '@udonarium/peer-cursor';
import { ImageStorage } from '@udonarium/core/file-storage/image-storage';
import { AudioStorage } from '@udonarium/core/file-storage/audio-storage';
import { ServerMediaStorage } from '@udonarium/core/file-storage/server-media-storage';
import { ImageFile } from '@udonarium/core/file-storage/image-file';
import { AudioFile } from '@udonarium/core/file-storage/audio-file';
import { ChatMessageService } from 'service/chat-message.service';
import { GmModeService } from 'service/gm-mode.service';
import { PanelService } from 'service/panel.service';
import { PointerDeviceService } from 'service/pointer-device.service';
import { Logger } from '@udonarium/core/system/util/logger';

@Component({
  selector: 'options-panel',
  templateUrl: './options-panel.component.html',
  styleUrls: ['./options-panel.component.css']
})
export class OptionsPanelComponent implements OnInit, OnDestroy {
  isMacroHotbarVisible = true;
  isVnStageVisible = false;
  isGmMode = false;

  get isAdvancedRoom(): boolean {
    const table = ObjectStore.instance.getObjects<GameTable>(GameTable).find(t => t.selected) ||
      ObjectStore.instance.getObjects<GameTable>(GameTable)[0];
    return table?.roomMode === 'advanced';
  }
  get isDiceCutinEnabled(): boolean {
    const table = ObjectStore.instance.getObjects<GameTable>(GameTable).find(t => t.selected) ||
      ObjectStore.instance.getObjects<GameTable>(GameTable)[0];
    return table?.diceCutinEnabled ?? true;
  }
  get isExtendedDiceBotEnabled(): boolean {
    const table = ObjectStore.instance.getObjects<GameTable>(GameTable).find(t => t.selected) ||
      ObjectStore.instance.getObjects<GameTable>(GameTable)[0];
    return table?.extendedDiceBotEnabled ?? false;
  }
  isOperationHelpOpen = false;
  isUpdateNotesOpen = false;
  isBuffTowerCollapsed = true;
  isCompactMode = false;
  isCursorShareDisabled = false;
  isVnAutoFit = true;
  isVnHeightEditorOpen = false;
  vnStageHeightPercent = 58;
  isVnBoardButtonVisible = false;
  isActivePanelForeground = true;
  isTooltipForeground = false;
  isAutoSoundEnabled = true;
  hotbarScale = 100;
  isShowSideNameLabel = true;
  isShowTopDownNameLabel = true;
  isShowCharacterDirectionMarker = false;
  isBundleLoading = false;
  bundleProgressText = '';

  private static readonly CURSOR_SHARE_DISABLED_KEY = 'udonarium.gm.cursorShareDisabled';
  private static readonly VN_STAGE_HEIGHT_KEY = 'udonarium.vnStage.heightPercent.v1';
  private static readonly VN_BOARD_BUTTON_VISIBLE_KEY = 'udonarium.vnStage.boardButton.visible.v1';
  private static readonly ACTIVE_PANEL_FOREGROUND_KEY = 'udonarium.panel.activeForeground.v1';
  private static readonly TOOLTIP_FOREGROUND_KEY = 'udonarium.tooltip.foreground.v1';
  private static readonly SHOW_SIDE_NAME_LABEL_KEY = 'udonarium.nameLabel.side.v1';
  private static readonly SHOW_TOPDOWN_NAME_LABEL_KEY = 'udonarium.nameLabel.topdown.v1';
  private static readonly SHOW_CHARACTER_DIRECTION_MARKER_KEY = 'udonarium.character.directionMarker.visible.v1';

  constructor(
    private panelService: PanelService,
    private chatMessageService: ChatMessageService,
    private gmModeService: GmModeService,
    private pointerDeviceService: PointerDeviceService,
    private ngZone: NgZone
  ) { }

  ngOnInit() {
    try { this.isMacroHotbarVisible = localStorage.getItem('udonarium.macroHotbar.visible.v1') !== '0'; } catch (_) { }
    try { this.isVnStageVisible = localStorage.getItem('udonarium.vnStage.visible.v1') === '1'; } catch (_) { }
    this.isGmMode = this.gmModeService.isGm;
    try { this.isVnAutoFit = localStorage.getItem('udonarium.vnStage.autoFit.v1') === '1'; } catch (_) { }
    this.vnStageHeightPercent = this.clampVnStageHeight(this.loadNumber(OptionsPanelComponent.VN_STAGE_HEIGHT_KEY, 58));
    try { this.isVnBoardButtonVisible = localStorage.getItem(OptionsPanelComponent.VN_BOARD_BUTTON_VISIBLE_KEY) === '1'; } catch (_) { }
    try { this.isActivePanelForeground = localStorage.getItem(OptionsPanelComponent.ACTIVE_PANEL_FOREGROUND_KEY) !== '0'; } catch (_) { }
    try { this.isTooltipForeground = localStorage.getItem(OptionsPanelComponent.TOOLTIP_FOREGROUND_KEY) !== '0'; } catch (_) { }
    try { this.isAutoSoundEnabled = localStorage.getItem('udonarium.autoSound.enabled') !== '0'; } catch (_) { }
    try { this.hotbarScale = Number(localStorage.getItem('udonarium.hotbar.scale') || '100'); } catch (_) { }
    try { this.isBuffTowerCollapsed = localStorage.getItem('udonarium.buffTower.collapsed.v1') !== 'false'; } catch (_) { }
    try { this.isCompactMode = localStorage.getItem('udonarium.options.compact.v3') === '1'; } catch (_) { }
    try { this.isCursorShareDisabled = localStorage.getItem(OptionsPanelComponent.CURSOR_SHARE_DISABLED_KEY) === '1'; } catch (_) { }
    try { this.isShowSideNameLabel = localStorage.getItem(OptionsPanelComponent.SHOW_SIDE_NAME_LABEL_KEY) !== '0'; } catch (_) { }
    try { this.isShowTopDownNameLabel = localStorage.getItem(OptionsPanelComponent.SHOW_TOPDOWN_NAME_LABEL_KEY) !== '0'; } catch (_) { }
    try { this.isShowCharacterDirectionMarker = localStorage.getItem(OptionsPanelComponent.SHOW_CHARACTER_DIRECTION_MARKER_KEY) === '1'; } catch (_) { }

    EventSystem.register(this)
      .on('MACRO_HOTBAR_VISIBILITY_CHANGED', event => {
        this.ngZone.run(() => { this.isMacroHotbarVisible = !!event.data?.visible; });
      })
      .on('VN_STAGE_VISIBILITY_CHANGED', event => {
        this.ngZone.run(() => { this.isVnStageVisible = !!event.data?.visible; });
      })
      .on('CLOSE_OPTIONS_PANEL', event => {
        this.ngZone.run(() => { this.panelService.close(); });
      })
      .on('GM_CURSOR_SHARE_DISABLED_CHANGED', event => {
        this.ngZone.run(() => { this.isCursorShareDisabled = !!event.data?.disabled; });
      })
      .on('VN_STAGE_BOARD_BUTTON_VISIBILITY_CHANGED', event => {
        this.ngZone.run(() => { this.isVnBoardButtonVisible = !!event.data?.visible; });
      })
      .on('NAME_LABEL_VISIBILITY_CHANGED', event => {
        this.ngZone.run(() => {
          if (event.data?.side !== undefined) this.isShowSideNameLabel = !!event.data.side;
          if (event.data?.topdown !== undefined) this.isShowTopDownNameLabel = !!event.data.topdown;
        });
      })
      .on('CHARACTER_DIRECTION_MARKER_VISIBILITY_CHANGED', event => {
        this.ngZone.run(() => { this.isShowCharacterDirectionMarker = !!event.data?.visible; });
      });
  }

  ngOnDestroy() {
    EventSystem.unregister(this);
    EventSystem.trigger('OPTIONS_PANEL_CLOSED', {});
  }

  toggleCompactMode() {
    this.isCompactMode = !this.isCompactMode;
    try { localStorage.setItem('udonarium.options.compact.v3', this.isCompactMode ? '1' : '0'); } catch (_) { }
    EventSystem.trigger('OPTIONS_PANEL_RESIZE', { compact: this.isCompactMode });
  }

  toggleMacroHotbar() {
    this.isMacroHotbarVisible = !this.isMacroHotbarVisible;
    try { localStorage.setItem('udonarium.macroHotbar.visible.v1', this.isMacroHotbarVisible ? '1' : '0'); } catch (_) { }
    EventSystem.trigger('MACRO_HOTBAR_VISIBILITY_CHANGED', { visible: this.isMacroHotbarVisible });
  }

  toggleVnStage() {
    this.isVnStageVisible = !this.isVnStageVisible;
    try { localStorage.setItem('udonarium.vnStage.visible.v1', this.isVnStageVisible ? '1' : '0'); } catch (_) { }
    EventSystem.trigger('VN_STAGE_VISIBILITY_CHANGED', { visible: this.isVnStageVisible });
  }

  toggleGmMode() {
    const isGm = this.gmModeService.toggle();
    this.isGmMode = isGm;
    if (PeerCursor.myCursor) {
      PeerCursor.myCursor.isGmMode = isGm;
    }
    const gmName = PeerCursor.myCursor?.name || Network.peerContext.userId;
    const text = isGm ? `${gmName} がGMを宣言しました。` : `${gmName} がPLに戻りました。`;
    const chatTabList = ObjectStore.instance.get<ChatTabList>('ChatTabList');
    const sysTab = chatTabList ? chatTabList.systemMessageTab : null;
    this.chatMessageService.sendSystemMessage(sysTab, text, '#006633');
  }

  toggleDiceCutin() {
    const table = ObjectStore.instance.getObjects<GameTable>(GameTable).find(t => t.selected) ||
      ObjectStore.instance.getObjects<GameTable>(GameTable)[0];
    if (table) {
      table.diceCutinEnabled = !table.diceCutinEnabled;
      table.update();
    }
  }

  toggleExtendedDiceBot() {
    const table = ObjectStore.instance.getObjects<GameTable>(GameTable).find(t => t.selected) ||
      ObjectStore.instance.getObjects<GameTable>(GameTable)[0];
    if (table) {
      table.extendedDiceBotEnabled = !table.extendedDiceBotEnabled;
      table.update();
    }
  }

  toggleVnAutoFit() {
    this.isVnAutoFit = !this.isVnAutoFit;
    try { localStorage.setItem('udonarium.vnStage.autoFit.v1', this.isVnAutoFit ? '1' : '0'); } catch (_) { }
    EventSystem.trigger('VN_STAGE_AUTOFIT_CHANGED', { autoFit: this.isVnAutoFit });
  }

  toggleVnHeightEditor() {
    this.isVnHeightEditorOpen = !this.isVnHeightEditorOpen;
  }

  setVnStageHeight(value: number) {
    this.vnStageHeightPercent = this.clampVnStageHeight(value);
    try { localStorage.setItem(OptionsPanelComponent.VN_STAGE_HEIGHT_KEY, String(this.vnStageHeightPercent)); } catch (_) { }
    EventSystem.trigger('VN_STAGE_HEIGHT_CHANGED', { heightPercent: this.vnStageHeightPercent });
  }

  toggleVnBoardButton() {
    this.isVnBoardButtonVisible = !this.isVnBoardButtonVisible;
    try { localStorage.setItem(OptionsPanelComponent.VN_BOARD_BUTTON_VISIBLE_KEY, this.isVnBoardButtonVisible ? '1' : '0'); } catch (_) { }
    EventSystem.trigger('VN_STAGE_BOARD_BUTTON_VISIBILITY_CHANGED', { visible: this.isVnBoardButtonVisible });
  }

  toggleActivePanelForeground() {
    this.isActivePanelForeground = !this.isActivePanelForeground;
    try { localStorage.setItem(OptionsPanelComponent.ACTIVE_PANEL_FOREGROUND_KEY, this.isActivePanelForeground ? '1' : '0'); } catch (_) { }
  }

  toggleTooltipForeground() {
    this.isTooltipForeground = !this.isTooltipForeground;
    try { localStorage.setItem(OptionsPanelComponent.TOOLTIP_FOREGROUND_KEY, this.isTooltipForeground ? '1' : '0'); } catch (_) { }
  }

  toggleAutoSound() {
    this.isAutoSoundEnabled = !this.isAutoSoundEnabled;
    try { localStorage.setItem('udonarium.autoSound.enabled', this.isAutoSoundEnabled ? '1' : '0'); } catch (_) { }
  }

  setHotbarScale(event: any) {
    const val = Number(event.target?.value || event);
    this.hotbarScale = val;
    try { localStorage.setItem('udonarium.hotbar.scale', String(val)); } catch (_) { }
    EventSystem.trigger('MACRO_HOTBAR_SCALE_CHANGED', { scale: val });
  }

  resetCamera() {
    EventSystem.trigger('RESET_CAMERA', {});
  }

  resetHotbarPosition() {
    try {
      localStorage.removeItem('udonarium.macroHotbar.pos.v1');
      localStorage.removeItem('udonarium.macroHotbar.visible.v1');
      localStorage.setItem('udonarium.macroHotbar.visible.v1', '1');
    } catch (_) { }
    EventSystem.trigger('MACRO_HOTBAR_RESET', {});
    EventSystem.call('MACRO_HOTBAR_VISIBILITY_CHANGED', { visible: true });
  }

  clearHotbarSlots() {
    if (!confirm('ホットバーの全スロットをクリアしますか？')) return;
    try {
      localStorage.setItem('udonarium.macroHotbar.v1', JSON.stringify({ version: 2, pageCount: 5, slotCount: 12, slots: Array.from({ length: 60 }, () => ({ label: '', text: '', iconIdentifier: '' })) }));
    } catch (_) { }
    EventSystem.trigger('MACRO_HOTBAR_CLEAR_ALL', {});
  }

  resetVnUi() {
    try {
      localStorage.removeItem('udonarium.vnPanel.pos.v1');
      localStorage.removeItem('udonarium.vnSubPanels.v1');
      localStorage.removeItem('udonarium.vnStage.heightPercent.v1');
      localStorage.setItem('udonarium.vnStage.heightPercent.v1', '58');
    } catch (_) { }
    EventSystem.trigger('VN_RESET_UI', {});
  }

  toggleBuffTowerCollapse() {
    this.isBuffTowerCollapsed = !this.isBuffTowerCollapsed;
    try { localStorage.setItem('udonarium.buffTower.collapsed.v1', this.isBuffTowerCollapsed ? '1' : 'false'); } catch (_) { }
    EventSystem.trigger('BUFF_TOWER_COLLAPSE_CHANGED', { collapsed: this.isBuffTowerCollapsed });
  }

  toggleCursorShare() {
    this.isCursorShareDisabled = !this.isCursorShareDisabled;
    try { localStorage.setItem(OptionsPanelComponent.CURSOR_SHARE_DISABLED_KEY, this.isCursorShareDisabled ? '1' : '0'); } catch (_) { }
    if (PeerCursor.myCursor) {
      PeerCursor.myCursor.isCursorShareDisabled = this.isCursorShareDisabled;
      PeerCursor.myCursor.update();
    }
    EventSystem.trigger('GM_CURSOR_SHARE_DISABLED_CHANGED', { disabled: this.isCursorShareDisabled });
  }

  toggleOperationHelp() {
    this.isOperationHelpOpen = !this.isOperationHelpOpen;
  }

  openGuideSite() {
    window.open('https://udonarium-lycoris.ddns.net/docs/guide/index.html', '_blank');
  }

  openUpdateNotesSite() {
    window.open('https://udonarium-lycoris.ddns.net/docs/#updates', '_blank');
  }

  toggleUpdateNotes() {
    this.isUpdateNotesOpen = !this.isUpdateNotesOpen;
  }

  addSampleCharacters() {
    EventSystem.trigger('ADD_SAMPLE_CHARACTERS', {});
  }

  toggleShowSideNameLabel() {
    this.isShowSideNameLabel = !this.isShowSideNameLabel;
    try { localStorage.setItem(OptionsPanelComponent.SHOW_SIDE_NAME_LABEL_KEY, this.isShowSideNameLabel ? '1' : '0'); } catch (_) { }
    EventSystem.trigger('NAME_LABEL_VISIBILITY_CHANGED', { side: this.isShowSideNameLabel });
  }

  toggleShowTopDownNameLabel() {
    this.isShowTopDownNameLabel = !this.isShowTopDownNameLabel;
    try { localStorage.setItem(OptionsPanelComponent.SHOW_TOPDOWN_NAME_LABEL_KEY, this.isShowTopDownNameLabel ? '1' : '0'); } catch (_) { }
    EventSystem.trigger('NAME_LABEL_VISIBILITY_CHANGED', { topdown: this.isShowTopDownNameLabel });
  }

  toggleShowCharacterDirectionMarker() {
    this.isShowCharacterDirectionMarker = !this.isShowCharacterDirectionMarker;
    try { localStorage.setItem(OptionsPanelComponent.SHOW_CHARACTER_DIRECTION_MARKER_KEY, this.isShowCharacterDirectionMarker ? '1' : '0'); } catch (_) { }
    EventSystem.trigger('CHARACTER_DIRECTION_MARKER_VISIBILITY_CHANGED', { visible: this.isShowCharacterDirectionMarker });
  }

  async downloadAllMedia() {
    if (this.isBundleLoading) return;
    // P2Pで取得済みでない画像・音声をサーバーから一括取得
    const images = ImageStorage.instance.images
      .filter(img => img && img.state < 2 && /^[a-f0-9]{64}$/i.test(img.identifier))
      .map(img => img.identifier);
    const audios = AudioStorage.instance.audios
      .filter(aud => aud && !aud.blob && /^[a-f0-9]{64}$/i.test(aud.identifier))
      .map(aud => aud.identifier);
    if (images.length === 0 && audios.length === 0) {
      EventSystem.trigger('CREATE_MESSAGE', { text: '一括ダウンロード対象のメディアがありません。', style: 'notice' });
      return;
    }
    this.isBundleLoading = true;
    this.bundleProgressText = `準備中... (${images.length + audios.length}件)`;
    try {
      const result = await ServerMediaStorage.fetchBundle(images, audios, progress => {
        this.ngZone.run(() => {
          this.bundleProgressText = `${progress.done}/${progress.total}件展開中`;
        });
      });
      // missing/failed の placeholder を削除
      for (const entry of result.missing) {
        if (entry.kind === 'image') ImageStorage.instance.delete(entry.hash);
        else AudioStorage.instance.delete(entry.hash);
      }
      for (const entry of result.failed) {
        if (entry.kind === 'image') ImageStorage.instance.delete(entry.hash);
        else AudioStorage.instance.delete(entry.hash);
      }
      const msg = `一括ダウンロード完了: 成功${result.loaded}件 / 欠落${result.missing.length + result.failed.length}件`;
      EventSystem.trigger('CREATE_MESSAGE', { text: msg, style: 'notice' });
      Logger.info(`[options-panel] ${msg}`);
    } catch (e) {
      Logger.warn('[options-panel] manual bundle download failed', e);
      EventSystem.trigger('CREATE_MESSAGE', { text: '一括ダウンロードに失敗しました。', style: 'notice' });
    } finally {
      this.isBundleLoading = false;
      this.bundleProgressText = '';
    }
  }

  private loadNumber(key: string, fb: number): number {
    try { const v = Number(localStorage.getItem(key)); return Number.isFinite(v) ? v : fb; } catch (_) { return fb; }
  }

  private clampVnStageHeight(value: any): number {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(25, Math.min(100, Math.round(n))) : 58;
  }
}
