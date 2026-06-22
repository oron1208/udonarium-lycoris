import { Component, NgZone, OnDestroy, OnInit } from '@angular/core';

import { AudioFile } from '@udonarium/core/file-storage/audio-file';
import { AudioPlayer, HttpAudioPlayer, VolumeType } from '@udonarium/core/file-storage/audio-player';
import { AudioStorage } from '@udonarium/core/file-storage/audio-storage';
import { FileArchiver } from '@udonarium/core/file-storage/file-archiver';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { EventSystem } from '@udonarium/core/system';
import { Jukebox, TableAudioLayerSetting } from '@udonarium/Jukebox';
import { Config } from '@udonarium/config';
import { ModalService } from 'service/modal.service';

import { CutInListComponent } from 'component/cut-in-list/cut-in-list.component';
import { PointerDeviceService } from 'service/pointer-device.service';
import { PanelOption, PanelService } from 'service/panel.service';

import { CutInLauncher } from '@udonarium/cut-in-launcher';
import { AudioLibraryService, ServerAudioTrack } from 'service/audio-library.service';

@Component({
  selector: 'app-jukebox',
  templateUrl: './jukebox.component.html',
  styleUrls: ['./jukebox.component.css']
})
export class JukeboxComponent implements OnInit, OnDestroy {

  roomVolumeChange = false;

  selectedFolder: string = '';
  editingFolderName: string = '';

  // ===== Library Tab =====
  activeTab: 'upload' | 'library' = 'upload';
  libraryPassword: string = '';
  libraryAuthed: boolean = false;
  libraryPasswordError: boolean = false;
  librarySearchQuery: string = '';
  libraryCategoryFilter: string = 'すべて';
  libraryTracks: ServerAudioTrack[] = [];
  libraryPreviewPlayer: HttpAudioPlayer | null = null;
  libraryPreviewId: string | null = null;

  private static readonly LIBRARY_PASSWORD = 'yaminoma';
  private static readonly SESSION_KEY = 'audio_library_authed';

  get roomVolume(): number { 
    let conf = ObjectStore.instance.get<Config>('Config');
    return conf? conf.roomVolume : 1 ;
  }

  set roomVolume(volume: number){
    let conf = ObjectStore.instance.get<Config>('Config');
    if(conf) conf.roomVolume = volume;
    this.jukebox.setNewVolume();
  }

  get volume(): number { return this.jukebox.volume; }
  set volume(volume: number) { 
    this.jukebox.volume = volume;
    AudioPlayer.volume = volume * this.roomVolume;
    EventSystem.trigger('CHANGE_JUKEBOX_VOLUME', null);
  }

  get auditionVolume(): number { return this.jukebox.auditionVolume; }
  set auditionVolume(auditionVolume: number) { 
    this.jukebox.auditionVolume = auditionVolume;
    AudioPlayer.auditionVolume = auditionVolume * this.roomVolume;
    EventSystem.trigger('CHANGE_JUKEBOX_VOLUME', null); 
  }

  get audios(): AudioFile[] { return AudioStorage.instance.audios.filter(audio => !audio.isHidden); }
  get jukebox(): Jukebox { return ObjectStore.instance.get<Jukebox>('Jukebox'); }

  get cutInLauncher(): CutInLauncher { return ObjectStore.instance.get<CutInLauncher>('CutInLauncher'); }

  get jukeboxLayers(): TableAudioLayerSetting[] { return this.jukebox.getJukeboxLayers(); }
  set jukeboxLayers(layers: TableAudioLayerSetting[]) { this.jukebox.setJukeboxLayers(layers); }

  get isLayerPlaying(): boolean { return this.jukeboxLayerPlayers.length > 0; }
  get jukeboxLayerPlayers(): AudioPlayer[] { return this.jukebox['jukeboxLayerPlayers'] || []; }

  readonly auditionPlayer: AudioPlayer = new AudioPlayer();
  readonly sePlayer: AudioPlayer = new AudioPlayer();
  readonly ambientPlayer: AudioPlayer = new AudioPlayer();
  private lazyUpdateTimer: NodeJS.Timer = null;

  constructor(
    private modalService: ModalService,
    private panelService: PanelService,
    private pointerDeviceService: PointerDeviceService,
    private ngZone: NgZone,
    private audioLibraryService: AudioLibraryService
  ) { }

  ngOnInit() {
    Promise.resolve().then(() => this.modalService.title = this.panelService.title = 'ジュークボックス');
    this.auditionPlayer.volumeType = VolumeType.AUDITION;
    // セッションストレージから認証状態を復元
    this.libraryAuthed = sessionStorage.getItem(JukeboxComponent.SESSION_KEY) === '1';
    EventSystem.register(this)
      .on('*', event => {
        if (event.eventName.startsWith('FILE_')) this.lazyNgZoneUpdate();
      });
  }

  ngOnDestroy() {
    EventSystem.unregister(this);
    this.stop();
    this.stopLibraryPreview();
  }

  play(audio: AudioFile) {
    this.auditionPlayer.play(audio);
  }

  stop() {
    this.auditionPlayer.stop();
  }

  playBGM(audio: AudioFile) {
    this.cutInLauncher.stopBlankTagCutIn();
    this.jukebox.play(audio.identifier, true);
  }

  playOnce(audio: AudioFile) {
    this.sePlayer.play(audio);
    this.sePlayer.volume = this.volume * this.roomVolume;
  }

  stopSE() {
    this.sePlayer.stop();
  }

  playAmbient(audio: AudioFile) {
    this.ambientPlayer.loop = true;
    this.ambientPlayer.play(audio);
    this.ambientPlayer.volume = this.volume * this.roomVolume;
  }

  stopAmbient() {
    this.ambientPlayer.stop();
  }

  stopBGM(audio: AudioFile) {
    if (this.jukebox.audio === audio) this.jukebox.stop();
  }

  // ===== Folder System =====

  getFolders(): string[] {
    const custom = this.jukebox.getCustomFolderNames();
    return ['すべて', ...custom];
  }

  getFilteredAudios(): AudioFile[] {
    const all = this.audios;
    if (!this.selectedFolder || this.selectedFolder === 'すべて') return all;
    const folderMap = this.jukebox.getAudioFolderMap();
    return all.filter(a => folderMap[a.identifier] === this.selectedFolder);
  }

  getAudioFolder(audioIdentifier: string): string {
    return this.jukebox.getAudioFolderMap()[audioIdentifier] || '';
  }

  setAudioFolder(audioIdentifier: string, folder: string) {
    const map = this.jukebox.getAudioFolderMap();
    if (folder) {
      map[audioIdentifier] = folder;
    } else {
      delete map[audioIdentifier];
    }
    this.jukebox.setAudioFolderMap(map);
  }

  addFolder() {
    const name = this.editingFolderName.trim();
    if (!name) return;
    const names = this.jukebox.getCustomFolderNames();
    if (names.includes(name)) return;
    names.push(name);
    this.jukebox.setCustomFolderNames(names);
    this.editingFolderName = '';
  }

  removeFolder(name: string) {
    const names = this.jukebox.getCustomFolderNames().filter(n => n !== name);
    this.jukebox.setCustomFolderNames(names);
    const map = this.jukebox.getAudioFolderMap();
    for (const key of Object.keys(map)) {
      if (map[key] === name) delete map[key];
    }
    this.jukebox.setAudioFolderMap(map);
    if (this.selectedFolder === name) this.selectedFolder = 'すべて';
  }

  // ===== Jukebox Layer System =====

  addJukeboxLayer(mode: 'loop' | 'once') {
    const layers = [...this.jukebox.getJukeboxLayers()];
    layers.push({
      name: mode === 'loop' ? 'BGM' : 'SE',
      audioIdentifier: '',
      mode,
      volume: 0.5,
      enabled: true
    });
    this.jukebox.setJukeboxLayers(layers);
  }

  removeJukeboxLayer(index: number) {
    const layers = [...this.jukebox.getJukeboxLayers()];
    layers.splice(index, 1);
    this.jukebox.setJukeboxLayers(layers);
  }

  moveJukeboxLayer(index: number, delta: number) {
    const layers = [...this.jukebox.getJukeboxLayers()];
    const target = index + delta;
    if (target < 0 || layers.length <= target) return;
    [layers[index], layers[target]] = [layers[target], layers[index]];
    this.jukebox.setJukeboxLayers(layers);
  }

  updateJukeboxLayer(index: number, patch: Partial<TableAudioLayerSetting>) {
    const layers = [...this.jukebox.getJukeboxLayers()];
    Object.assign(layers[index], patch);
    this.jukebox.setJukeboxLayers(layers);
  }

  playJukeboxLayers() {
    this.jukebox.playJukeboxLayers();
  }

  stopJukeboxLayers() {
    this.jukebox.stopJukeboxLayers();
  }

  handleFileSelect(event: Event) {
    let input = <HTMLInputElement>event.target;
    let files = input.files;
    if (files.length) FileArchiver.instance.load(files);
    input.value = '';
  }

  private lazyNgZoneUpdate() {
    if (this.lazyUpdateTimer !== null) return;
    this.lazyUpdateTimer = setTimeout(() => {
      this.lazyUpdateTimer = null;
      this.ngZone.run(() => { });
    }, 100);
  }

  openCutInList() {
    let coordinate = this.pointerDeviceService.pointers[0];
    let option: PanelOption = { left: coordinate.x+25, top: coordinate.y+25, width: 650, height: 740 };
    this.panelService.open<CutInListComponent>(CutInListComponent, option);
  }

  // ===== Library Tab Methods =====

  switchTab(tab: 'upload' | 'library') {
    if (this.activeTab === tab) return;
    this.activeTab = tab;
    if (tab === 'library' && this.libraryAuthed && this.libraryTracks.length === 0) {
      this.loadLibraryTracks();
    }
  }

  checkLibraryPassword() {
    if (this.libraryPassword === JukeboxComponent.LIBRARY_PASSWORD) {
      this.libraryAuthed = true;
      this.libraryPasswordError = false;
      this.libraryPassword = '';
      sessionStorage.setItem(JukeboxComponent.SESSION_KEY, '1');
      this.loadLibraryTracks();
    } else {
      this.libraryPasswordError = true;
    }
  }

  async loadLibraryTracks() {
    this.libraryTracks = await this.audioLibraryService.fetchTracks();
  }

  get libraryCategories(): string[] {
    return ['すべて', ...this.audioLibraryService.categories];
  }

  getFilteredLibraryTracks(): ServerAudioTrack[] {
    let tracks = this.libraryTracks;
    if (this.libraryCategoryFilter && this.libraryCategoryFilter !== 'すべて') {
      tracks = tracks.filter(t => t.category === this.libraryCategoryFilter);
    }
    if (this.librarySearchQuery.trim()) {
      const q = this.librarySearchQuery.toLowerCase();
      tracks = tracks.filter(t =>
        t.name.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q)
      );
    }
    return tracks;
  }

  formatDuration(seconds: number): string {
    if (!seconds || seconds <= 0) return '--:--';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  previewTrack(track: ServerAudioTrack) {
    if (this.libraryPreviewId === track.id) {
      this.stopLibraryPreview();
      return;
    }
    this.stopLibraryPreview();
    const url = this.audioLibraryService.getTrackUrl(track.id);
    if (!url) return;
    this.libraryPreviewPlayer = new HttpAudioPlayer();
    this.libraryPreviewPlayer.loop = false;
    this.libraryPreviewPlayer.volume = this.auditionVolume * this.roomVolume;
    this.libraryPreviewPlayer.play(url);
    this.libraryPreviewId = track.id;
    // 再生終了時にステートをリセット
    const audioElm = (this.libraryPreviewPlayer as any).audioElm as HTMLAudioElement;
    if (audioElm) {
      audioElm.onended = () => {
        this.libraryPreviewId = null;
        this.libraryPreviewPlayer = null;
        this.ngZone.run(() => {});
      };
    }
  }

  stopLibraryPreview() {
    if (this.libraryPreviewPlayer) {
      this.libraryPreviewPlayer.stop();
      this.libraryPreviewPlayer = null;
    }
    this.libraryPreviewId = null;
  }

  useLibraryTrack(track: ServerAudioTrack) {
    this.stopLibraryPreview();
    const sourceId = 'server:' + track.id;
    this.cutInLauncher.stopBlankTagCutIn();
    this.jukebox.play(sourceId, true);
  }

  isTrackPinned(trackId: string): boolean {
    return this.jukebox.isPinnedLibraryTrack(trackId);
  }

  togglePin(track: ServerAudioTrack) {
    // 再生中の曲を選択解除したら停止する
    const sourceId = 'server:' + track.id;
    if (this.jukebox.audioIdentifier === sourceId) {
      this.jukebox.stop();
    }
    this.stopLibraryPreview();
    this.jukebox.togglePinnedLibraryTrack(track.id);
  }

  get pinnedLibraryTracks(): ServerAudioTrack[] {
    const pinnedIds = this.jukebox.getPinnedLibraryTrackIds();
    return pinnedIds
      .map(id => this.audioLibraryService.getTrack(id))
      .filter(t => t !== null) as ServerAudioTrack[];
  }

}
