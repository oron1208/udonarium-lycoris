import { Component, NgZone, OnDestroy, OnInit } from '@angular/core';

import { AudioFile } from '@udonarium/core/file-storage/audio-file';
import { AudioPlayer, VolumeType } from '@udonarium/core/file-storage/audio-player';
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

@Component({
  selector: 'app-jukebox',
  templateUrl: './jukebox.component.html',
  styleUrls: ['./jukebox.component.css']
})
export class JukeboxComponent implements OnInit, OnDestroy {

  roomVolumeChange = false;

  selectedFolder: string = '';
  editingFolderName: string = '';

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
    private ngZone: NgZone
  ) { }

  ngOnInit() {
    Promise.resolve().then(() => this.modalService.title = this.panelService.title = 'ジュークボックス');
    this.auditionPlayer.volumeType = VolumeType.AUDITION;
    EventSystem.register(this)
      .on('*', event => {
        if (event.eventName.startsWith('FILE_')) this.lazyNgZoneUpdate();
      });
  }

  ngOnDestroy() {
    EventSystem.unregister(this);
    this.stop();
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

}
