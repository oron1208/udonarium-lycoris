import { AudioFile } from './core/file-storage/audio-file';
import { AudioPlayer } from './core/file-storage/audio-player';
import { AudioStorage } from './core/file-storage/audio-storage';
import { SyncObject, SyncVar } from './core/synchronize-object/decorator';
import { GameObject, ObjectContext } from './core/synchronize-object/game-object';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { EventSystem } from './core/system';
import { Config } from '@udonarium/config';
import { GameTable } from './game-table';

export type TableAudioMode = 'loop' | 'once';

export interface TableAudioLayerSetting {
  name: string;
  audioIdentifier: string;
  mode: TableAudioMode;
  volume: number;
  enabled: boolean;
}

@SyncObject('jukebox')
export class Jukebox extends GameObject {
  @SyncVar() audioIdentifier: string = '';
  @SyncVar() startTime: number = 0;
  @SyncVar() isLoop: boolean = false;
  @SyncVar() isPlaying: boolean = false;
  @SyncVar() jukeboxLayersJson: string = '[]';
  @SyncVar() audioFolderMapJson: string = '{}';
  @SyncVar() customFolderNamesJson: string = '[]';

  // ===== BGM同期用SyncVar =====
  // 新規ログインユーザーが「今どのBGMが再生中か」を知るため
  @SyncVar() activeBgmSource: string = ''; // 'combat' | 'table' | 'jukebox' | ''
  @SyncVar() combatBgmIdentifierSync: string = '';
  @SyncVar() activeTableIdentifier: string = ''; // 再生中のテーブルID

  get audio(): AudioFile { return AudioStorage.instance.get(this.audioIdentifier); }

  // ===== Audio Players (actual playback) =====
  private audioPlayer: AudioPlayer = new AudioPlayer();
  private tableAudioPlayers: AudioPlayer[] = [];
  private jukeboxLayerPlayers: AudioPlayer[] = [];
  private combatAudioPlayer: AudioPlayer = null;

  // ===== BGM Priority System =====
  private _combatBgmIdentifier: string = '';
  private _tableWantsPlay: boolean = false;
  private _jukeboxLayerOverrideActive: boolean = false;

  // Currently active BGM source
  private _currentBgmSource: 'combat' | 'table' | 'jukebox' | null = null;
  // Which table's audio is currently loaded
  private _tableAudioLoadedFor: string = '';
  // Which jukebox audio is currently playing (to detect song switches)
  private _jukeboxAudioLoadedFor: string = '';
  private _jukeboxLayerLoadedFor: string = '';

  get config(): Config { return ObjectStore.instance.get<Config>('Config'); }

  private _volume = 0.5;
  get volume(): number { return this._volume; }
  set volume(volume: number) { this._volume = volume; }

  private _auditionVolume = 0.5;
  get auditionVolume(){ return this._auditionVolume;}
  set auditionVolume(_auditionVolume: number){ this._auditionVolume = _auditionVolume; }

  // ===== Lifecycle =====

  onStoreAdded() {
    super.onStoreAdded();
    this.unlockAfterUserInteraction();
    EventSystem.register(this)
      .on('SELECT_GAME_TABLE', event => {
        const table = ObjectStore.instance.get<GameTable>(event.data.identifier);
        this.playTableAudio(table);
      })
      .on('TABLE_AUDIO_PLAY', event => {
        const table = ObjectStore.instance.get<GameTable>(event.data.identifier);
        if (table) {
          this.replayTableAudio(table);
        }
      })
      .on('TABLE_AUDIO_STOP', event => {
        this.stopTableAudio();
      })
      .on('COMBAT_BGM_PLAY', event => {
        this.playCombatBgm(event.data.identifier);
      })
      .on('COMBAT_BGM_STOP', event => {
        this.stopCombatBgm();
      })
      // テーブルオブジェクトの更新を監視（属性が後から同期された場合の再評価）
      .on('UPDATE_GAME_OBJECT', event => {
        if (event.data.identifier === this.activeTableIdentifier && event.data.aliasName === 'game-table') {
          this._recheckTableAudio();
        }
      });
  }

  onStoreRemoved() {
    super.onStoreRemoved();
    this._stopAllBgmAudio();
    this.unregisterEvent();
  }

  setNewVolume(){
    AudioPlayer.volume = this.volume * this.config.roomVolume;
    AudioPlayer.auditionVolume = this.auditionVolume * this.config.roomVolume;
  }

  // ===== Jukebox BGM (lowest priority) =====

  play(identifier: string, isLoop: boolean = false) {
    let audio = AudioStorage.instance.get(identifier);
    if (!audio || !audio.isReady) return;
    this._jukeboxLayerOverrideActive = false;
    for (const p of this.jukeboxLayerPlayers) p.stop();
    this.jukeboxLayerPlayers = [];

    this.audioIdentifier = identifier;
    this.isPlaying = true;
    this.isLoop = isLoop;
    this._updateBgmPlayback();
  }

  stop() {
    this.audioIdentifier = '';
    this.isPlaying = false;
    this._updateBgmPlayback();
  }

  // ===== Table Setting BGM (medium priority) =====

  playTableAudio(table: GameTable) {
    if (!table) return;
    const layers = Jukebox.getTableAudioLayers(table).filter(layer => layer.enabled && layer.audioIdentifier);
    this._tableWantsPlay = layers.length > 0;
    this.activeTableIdentifier = table.identifier;

    this._updateBgmPlayback();
  }

  stopTableAudio() {
    this._tableWantsPlay = false;
    this.activeTableIdentifier = '';
    this._updateBgmPlayback();
  }

  replayTableAudio(table: GameTable) {
    this._tableAudioLoadedFor = ''; // force reload
    this.playTableAudio(table);
  }

  // テーブルオブジェクト更新時の再評価（属性が後から同期されたケース）
  private _recheckTableAudio() {
    if (this._currentBgmSource === 'combat') return; // 戦闘中は無視
    const table = ObjectStore.instance.get<GameTable>(this.activeTableIdentifier);
    if (!table) return;
    const layers = Jukebox.getTableAudioLayers(table).filter(layer => layer.enabled && layer.audioIdentifier);
    const shouldPlay = layers.length > 0;

    if (shouldPlay !== this._tableWantsPlay) {
      console.log('Table audio config updated, re-evaluating BGM');
      this._tableWantsPlay = shouldPlay;
      this._updateBgmPlayback();
    }
  }

  // ===== Jukebox Layer System =====

  getJukeboxLayers(): TableAudioLayerSetting[] {
    try {
      const layers = JSON.parse(this.jukeboxLayersJson || '[]');
      return Array.isArray(layers) ? layers : [];
    } catch { return []; }
  }

  setJukeboxLayers(layers: TableAudioLayerSetting[]) {
    this.jukeboxLayersJson = JSON.stringify((layers || []).map(l => Jukebox.normalizeTableAudioLayer(l)));
  }

  playJukeboxLayers() {
    this.audioIdentifier = '';
    this.isPlaying = false;
    this._jukeboxLayerOverrideActive = true;
    this._updateBgmPlayback();
  }

  stopJukeboxLayers() {
    this._jukeboxLayerOverrideActive = false;
    this._updateBgmPlayback();
  }

  // ===== Combat BGM (highest priority) =====

  playCombatBgm(identifier: string) {
    this._combatBgmIdentifier = identifier || '';
    this.combatBgmIdentifierSync = identifier || '';
    this._updateBgmPlayback();
  }

  stopCombatBgm() {
    this._combatBgmIdentifier = '';
    this.combatBgmIdentifierSync = '';
    this._updateBgmPlayback();
  }

  // ===== BGM Priority Engine =====
  // 優先度: 戦闘BGM ＞ テーブル設定BGM ＞ ジュークボックスBGM

  private _updateBgmPlayback() {
    const combatReady = !!this._combatBgmIdentifier;
    const tableReady = this._tableWantsPlay && !!this.activeTableIdentifier;
    const jukeboxReady = this._jukeboxLayerOverrideActive || (this.isPlaying && !!this.audioIdentifier);

    let desired: 'combat' | 'table' | 'jukebox' | null = null;
    if (combatReady) desired = 'combat';
    else if (tableReady) desired = 'table';
    else if (jukeboxReady) desired = 'jukebox';

    // 同一ソースかつ再スタート不要なら何もしない
    if (desired === this._currentBgmSource) {
      if (desired === 'table' && this._tableAudioLoadedFor !== this.activeTableIdentifier) {
        // テーブルIDが変わったら再スタート
      } else if (desired === 'jukebox') {
        // ジュークボックス内で曲が変わったら再スタート
        const currentJukeboxId = this._jukeboxLayerOverrideActive
          ? '__layers__'
          : this.audioIdentifier;
        if (currentJukeboxId !== this._jukeboxAudioLoadedFor) {
          // fall through to restart
        } else {
          return;
        }
      } else {
        return;
      }
    }

    // activeBgmSource SyncVarを更新（他ピアに現在の再生状態を伝える）
    const newActiveSource = desired || '';
    if (this.activeBgmSource !== newActiveSource) {
      this.activeBgmSource = newActiveSource;
    }

    console.log(`BGM priority: ${this._currentBgmSource} → ${desired}`);

    this._stopAllBgmAudio();

    let actuallyStarted = false;
    if (desired === 'combat') {
      actuallyStarted = this._startCombatPlayback();
    } else if (desired === 'table') {
      actuallyStarted = this._startTablePlayback();
      if (actuallyStarted) this._tableAudioLoadedFor = this.activeTableIdentifier;
    } else if (desired === 'jukebox') {
      actuallyStarted = this._startJukeboxPlayback();
      if (actuallyStarted) this._jukeboxAudioLoadedFor = this._jukeboxLayerOverrideActive
        ? '__layers__'
        : this.audioIdentifier;
    }

    this._currentBgmSource = actuallyStarted ? desired : null;
  }

  private _stopAllBgmAudio() {
    this.unregisterEvent();
    this.audioPlayer.stop();
    for (const p of this.tableAudioPlayers) p.stop();
    this.tableAudioPlayers = [];
    for (const p of this.jukeboxLayerPlayers) p.stop();
    this.jukeboxLayerPlayers = [];
    if (this.combatAudioPlayer) { this.combatAudioPlayer.stop(); this.combatAudioPlayer = null; }
  }

  private _startCombatPlayback(): boolean {
    if (!this._combatBgmIdentifier) return false;
    const audio = AudioStorage.instance.get(this._combatBgmIdentifier);
    if (!audio || !audio.isReady) {
      this.playAfterFileUpdate();
      return false;
    }
    this.combatAudioPlayer = new AudioPlayer(audio);
    this.combatAudioPlayer.loop = true;
    this.combatAudioPlayer.volume = 0.6;
    this.combatAudioPlayer.play(audio);
    return true;
  }

  private _startTablePlayback(): boolean {
    const table = ObjectStore.instance.get<GameTable>(this.activeTableIdentifier);
    if (!table) {
      this.playAfterFileUpdate();
      return false;
    }
    const layers = Jukebox.getTableAudioLayers(table).filter(layer => layer.enabled && layer.audioIdentifier);
    if (layers.length === 0) {
      // テーブル属性がまだ同期されていない可能性 → ファイル更新イベントで再評価
      console.log('Table audio layers not yet available, waiting for sync...');
      this.playAfterFileUpdate();
      return false;
    }
    let started = false;
    for (const layer of layers) {
      const audio = AudioStorage.instance.get(layer.audioIdentifier);
      if (!audio || !audio.isReady) continue;
      const player = new AudioPlayer(audio);
      player.loop = layer.mode === 'loop';
      player.volume = Number.isFinite(layer.volume) ? Math.max(0, Math.min(1, layer.volume)) : 0.5;
      player.play(audio);
      this.tableAudioPlayers.push(player);
      started = true;
    }
    if (!started) this.playAfterFileUpdate();
    return started;
  }

  private _startJukeboxPlayback(): boolean {
    if (this._jukeboxLayerOverrideActive) {
      const layers = this.getJukeboxLayers().filter(l => l.enabled && l.audioIdentifier);
      let started = false;
      for (const layer of layers) {
        const audio = AudioStorage.instance.get(layer.audioIdentifier);
        if (!audio || !audio.isReady) continue;
        const player = new AudioPlayer(audio);
        player.loop = layer.mode === 'loop';
        player.volume = Number.isFinite(layer.volume) ? Math.max(0, Math.min(1, layer.volume)) : 0.5;
        player.play(audio);
        this.jukeboxLayerPlayers.push(player);
        started = true;
      }
      if (!started) this.playAfterFileUpdate();
      return started;
    } else if (this.isPlaying && this.audioIdentifier) {
      if (!this.audio || !this.audio.isReady) {
        this.playAfterFileUpdate();
        return false;
      }
      this.audioPlayer.loop = true;
      this.audioPlayer.play(this.audio);
      return true;
    }
    return false;
  }

  // ===== Audio Folder System =====

  getAudioFolderMap(): { [identifier: string]: string } {
    try {
      return JSON.parse(this.audioFolderMapJson || '{}');
    } catch { return {}; }
  }

  setAudioFolderMap(map: { [identifier: string]: string }) {
    this.audioFolderMapJson = JSON.stringify(map || {});
  }

  getCustomFolderNames(): string[] {
    try {
      const names = JSON.parse(this.customFolderNamesJson || '[]');
      return Array.isArray(names) ? names : [];
    } catch { return []; }
  }

  setCustomFolderNames(names: string[]) {
    this.customFolderNamesJson = JSON.stringify(names || []);
  }

  // ===== Table Audio Layer Helpers =====

  static getTableAudioLayers(table: GameTable): TableAudioLayerSetting[] {
    if (!table) return [];
    const raw = table.getAttribute('lycorisTableAudioLayers');
    if (!raw) return [];
    try {
      const layers = JSON.parse(raw);
      return Array.isArray(layers) ? layers.map(layer => Jukebox.normalizeTableAudioLayer(layer)) : [];
    } catch (error) {
      console.warn('テーブルBGM設定の読み込みに失敗しました', error);
      return [];
    }
  }

  static setTableAudioLayers(table: GameTable, layers: TableAudioLayerSetting[]) {
    if (!table) return;
    table.setAttribute('lycorisTableAudioLayers', JSON.stringify((layers || []).map(layer => Jukebox.normalizeTableAudioLayer(layer))));
  }

  private static normalizeTableAudioLayer(layer: Partial<TableAudioLayerSetting>): TableAudioLayerSetting {
    return {
      name: layer && layer.name ? layer.name : 'レイヤー',
      audioIdentifier: layer && layer.audioIdentifier ? layer.audioIdentifier : '',
      mode: layer && layer.mode === 'once' ? 'once' : 'loop',
      volume: layer && Number.isFinite(layer.volume) ? Math.max(0, Math.min(1, Number(layer.volume))) : 0.5,
      enabled: layer && layer.enabled === false ? false : true
    };
  }

  // ===== Internal Helpers =====

  private playAfterFileUpdate() {
    EventSystem.register(this)
      .on('UPDATE_AUDIO_RESOURE', event => {
        this._updateBgmPlayback();
      });
  }

  private unlockAfterUserInteraction() {
    let callback = () => {
      document.body.removeEventListener('touchstart', callback, true);
      document.body.removeEventListener('mousedown', callback, true);
      this._updateBgmPlayback();
    }
    document.body.addEventListener('touchstart', callback, true);
    document.body.addEventListener('mousedown', callback, true);
  }

  private unregisterEvent() {
    EventSystem.unregister(this, 'UPDATE_AUDIO_RESOURE');
  }

  // ===== Sync Handler =====

  // override
  apply(context: ObjectContext) {
    let prevActiveBgm = this.activeBgmSource;
    let prevCombatId = this.combatBgmIdentifierSync;
    let prevActiveTable = this.activeTableIdentifier;
    let prevIsPlaying = this.isPlaying;
    let prevAudioId = this.audioIdentifier;

    super.apply(context);

    // activeBgmSourceの変化を検知（新規ログイン・他ピアの操作）
    if (prevActiveBgm !== this.activeBgmSource) {
      console.log(`Sync: activeBgmSource changed ${prevActiveBgm} → ${this.activeBgmSource}`);
      // 同期された状態から内部フラグを復元
      this._combatBgmIdentifier = this.combatBgmIdentifierSync;
      if (this.activeBgmSource === 'table' && this.activeTableIdentifier) {
        this._tableWantsPlay = true;
      }
      this._updateBgmPlayback();
      return;
    }

    // 戦闘BGM識別子の変化
    if (prevCombatId !== this.combatBgmIdentifierSync) {
      this._combatBgmIdentifier = this.combatBgmIdentifierSync;
      this._updateBgmPlayback();
      return;
    }

    // テーブル識別子の変化
    if (prevActiveTable !== this.activeTableIdentifier) {
      if (this.activeTableIdentifier) {
        this._tableWantsPlay = true;
      } else {
        this._tableWantsPlay = false;
      }
      this._tableAudioLoadedFor = '';
      this._updateBgmPlayback();
      return;
    }

    // ジュークボックス状態の変化
    if (prevIsPlaying !== this.isPlaying || (this.isPlaying && prevAudioId !== this.audioIdentifier)) {
      this._updateBgmPlayback();
    }
  }
}
