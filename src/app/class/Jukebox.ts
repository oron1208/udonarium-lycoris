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

  get audio(): AudioFile { return AudioStorage.instance.get(this.audioIdentifier); }

  private audioPlayer: AudioPlayer = new AudioPlayer();
  private tableAudioPlayers: AudioPlayer[] = [];
  private jukeboxLayerPlayers: AudioPlayer[] = [];
  private combatAudioPlayer: AudioPlayer = null;
  private currentTableAudioIdentifier: string = '';
  private _jukeboxLayerOverrideActive = false;
  private _combatBgmActive = false;

  get config(): Config { return ObjectStore.instance.get<Config>('Config'); }

  private _volume = 0.5;
  get volume(): number { return this._volume; }
  set volume(volume: number) { this._volume = volume; }

  private _auditionVolume = 0.5;
  get auditionVolume(){ return this._auditionVolume;}
  set auditionVolume(_auditionVolume: number){ this._auditionVolume = _auditionVolume; }

  // GameObject Lifecycle
  onStoreAdded() {
    super.onStoreAdded();
    this.unlockAfterUserInteraction();
    EventSystem.register(this)
      .on('SELECT_GAME_TABLE', event => {
        const table = ObjectStore.instance.get<GameTable>(event.data.identifier);
        this.playTableAudio(table);
      })
      .on('COMBAT_BGM_PLAY', event => {
        this.playCombatBgm(event.data.identifier);
      })
      .on('COMBAT_BGM_STOP', event => {
        this.stopCombatBgm();
      });
  }

  // GameObject Lifecycle
  onStoreRemoved() {
    super.onStoreRemoved();
    this._stop();
  }

  setNewVolume(){
    AudioPlayer.volume = this.volume * this.config.roomVolume;
    AudioPlayer.auditionVolume = this.auditionVolume * this.config.roomVolume;
  }

  play(identifier: string, isLoop: boolean = false) {
    let audio = AudioStorage.instance.get(identifier);
    if (!audio || !audio.isReady) return;
    // ジュークボックス優先: テーブルBGMを止める
    this.stopTableAudio();
    this.stopJukeboxLayers();
    this.audioIdentifier = identifier;
    this.isPlaying = true;
    this.isLoop = isLoop;
    this._play();
  }

  private _play() {
    this._stop();
    if (!this.audio || !this.audio.isReady) {
      this.playAfterFileUpdate();
      return;
    }
    this.audioPlayer.loop = true;
    this.audioPlayer.play(this.audio);
  }

  stop() {
    this.audioIdentifier = '';
    this.isPlaying = false;
    this._stop();
  }

  playTableAudio(table: GameTable) {
    if (!table) return;
    if (this.currentTableAudioIdentifier === table.identifier) return;
    this.currentTableAudioIdentifier = table.identifier;

    // 戦闘BGM中はテーブルBGMを上書きしない
    if (this._combatBgmActive) return;

    const layers = Jukebox.getTableAudioLayers(table).filter(layer => layer.enabled && layer.audioIdentifier);
    this.stopTableAudio();
    if (layers.length < 1) return;

    // ジュークボックスレイヤーがアクティブならテーブルBGMはスキップ（ジュークボックス優先）
    if (this._jukeboxLayerOverrideActive || this.isPlaying) return;

    this.stop();

    for (const layer of layers) {
      const audio = AudioStorage.instance.get(layer.audioIdentifier);
      if (!audio || !audio.isReady) continue;
      const player = new AudioPlayer(audio);
      player.loop = layer.mode === 'loop';
      player.volume = Number.isFinite(layer.volume) ? Math.max(0, Math.min(1, layer.volume)) : 0.5;
      player.play(audio);
      this.tableAudioPlayers.push(player);
    }
  }

  stopTableAudio() {
    for (const player of this.tableAudioPlayers) player.stop();
    this.tableAudioPlayers = [];
  }

  replayTableAudio(table: GameTable) {
    this.currentTableAudioIdentifier = '';
    this.playTableAudio(table);
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
    this.stopJukeboxLayers();
    this.stopTableAudio();
    this.stop();
    this._jukeboxLayerOverrideActive = true;

    const layers = this.getJukeboxLayers().filter(l => l.enabled && l.audioIdentifier);
    for (const layer of layers) {
      const audio = AudioStorage.instance.get(layer.audioIdentifier);
      if (!audio || !audio.isReady) continue;
      const player = new AudioPlayer(audio);
      player.loop = layer.mode === 'loop';
      player.volume = Number.isFinite(layer.volume) ? Math.max(0, Math.min(1, layer.volume)) : 0.5;
      player.play(audio);
      this.jukeboxLayerPlayers.push(player);
    }
  }

  stopJukeboxLayers() {
    for (const player of this.jukeboxLayerPlayers) player.stop();
    this.jukeboxLayerPlayers = [];
    this._jukeboxLayerOverrideActive = false;
  }

  // ===== Combat BGM =====

  playCombatBgm(identifier: string) {
    // 現在の音を全部止める（テーブルBGM含む）
    this.stopTableAudio();
    this.stopJukeboxLayers();
    this.stop();
    // 戦闘BGMが既にあれば個別に停止のみ（再開処理なし）
    if (this.combatAudioPlayer) {
      this.combatAudioPlayer.stop();
      this.combatAudioPlayer = null;
    }

    if (!identifier) return;
    const audio = AudioStorage.instance.get(identifier);
    if (!audio || !audio.isReady) return;

    this._combatBgmActive = true;
    this.combatAudioPlayer = new AudioPlayer(audio);
    this.combatAudioPlayer.loop = true;
    this.combatAudioPlayer.volume = 0.6;
    this.combatAudioPlayer.play(audio);
  }

  stopCombatBgm() {
    if (this.combatAudioPlayer) {
      this.combatAudioPlayer.stop();
      this.combatAudioPlayer = null;
    }
    this._combatBgmActive = false;

    // 元のテーブルBGMを再開
    if (this.currentTableAudioIdentifier) {
      const table = ObjectStore.instance.get<GameTable>(this.currentTableAudioIdentifier);
      if (table) {
        const prev = this.currentTableAudioIdentifier;
        this.currentTableAudioIdentifier = '';
        this.playTableAudio(table);
      }
    }
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

  private _stop() {
    this.unregisterEvent();
    this.audioPlayer.stop();
  }

  private playAfterFileUpdate() {
    EventSystem.register(this)
      .on('UPDATE_AUDIO_RESOURE', event => {
        this._play();
      });
  }

  private unlockAfterUserInteraction() {
    let callback = () => {
      document.body.removeEventListener('touchstart', callback, true);
      document.body.removeEventListener('mousedown', callback, true);
      this.audioPlayer.stop();
      if (this.isPlaying) this._play();
      const table = ObjectStore.instance.get<GameTable>(this.currentTableAudioIdentifier);
      if (table) {
        this.currentTableAudioIdentifier = '';
        this.playTableAudio(table);
      }
    }
    document.body.addEventListener('touchstart', callback, true);
    document.body.addEventListener('mousedown', callback, true);
  }

  private unregisterEvent() {
    EventSystem.unregister(this, 'UPDATE_AUDIO_RESOURE');
  }

  // override
  apply(context: ObjectContext) {
    let audioIdentifier = this.audioIdentifier;
    let isPlaying = this.isPlaying;
    super.apply(context);
    if ((audioIdentifier !== this.audioIdentifier || !isPlaying) && this.isPlaying) {
      this._play();
    } else if (isPlaying !== this.isPlaying && !this.isPlaying) {
      this._stop();
    }
  }
}
