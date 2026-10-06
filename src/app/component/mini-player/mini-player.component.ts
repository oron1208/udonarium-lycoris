import { Component, OnDestroy, OnInit } from '@angular/core';

import { AudioPlayer } from '@udonarium/core/file-storage/audio-player';
import { AudioStorage } from '@udonarium/core/file-storage/audio-storage';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { EventSystem } from '@udonarium/core/system';
import { Jukebox } from '@udonarium/Jukebox';
import { Config } from '@udonarium/config';
import { AudioLibraryService } from 'service/audio-library.service';

@Component({
  selector: 'app-mini-player',
  templateUrl: './mini-player.component.html',
  styleUrls: ['./mini-player.component.css']
})
export class MiniPlayerComponent implements OnInit, OnDestroy {
  visible = false;
  private lastTrackId = '';
  private libraryNames: { [id: string]: string } = {};
  private timer: any = null;

  // ===== ドラッグ移動 =====
  pos: { x: number, y: number } | null = null;
  private dragging = false;
  private dragMoved = false;
  private pressedOnInfo = false;
  private dragStart: { x: number, y: number, px: number, py: number } = null;

  // ===== 曲リスト =====
  trackListOpen = false;

  constructor(private audioLibraryService: AudioLibraryService) { }

  ngOnInit() {
    try {
      this.visible = localStorage.getItem('lycoris.mini-player.v1') === '1';
      const raw = localStorage.getItem('lycoris.mini-player-pos.v1');
      if (raw) this.pos = JSON.parse(raw);
    } catch { }
    EventSystem.register(this).on('MINI_PLAYER_OPEN', () => this.open());
    this.audioLibraryService.fetchTracks().then(tracks => {
      for (const track of tracks) this.libraryNames[track.id] = track.name;
    }).catch(() => { });
    // 再生状態は同期更新で変わるため、定期的に変更検知を回して表示を更新する
    this.timer = setInterval(() => { }, 1500);
  }

  ngOnDestroy() {
    EventSystem.unregister(this);
    if (this.timer) clearInterval(this.timer);
    if (this.listNoteTimer) clearTimeout(this.listNoteTimer);
  }

  open() { this.visible = true; this.save(); }
  close() { this.visible = false; this.trackListOpen = false; this.save(); }
  private save() {
    try { localStorage.setItem('lycoris.mini-player.v1', this.visible ? '1' : '0'); } catch { }
  }

  // ===== ドラッグ移動 =====
  get playerStyle(): { [k: string]: string } {
    if (!this.pos) return null;
    return { 'left': this.pos.x + 'px', 'top': this.pos.y + 'px', 'right': 'auto' };
  }

  onPointerDown(e: PointerEvent) {
    const target = e.target as HTMLElement;
    if (target.closest('button, input, .mp-track-list')) return;
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    this.dragging = true;
    this.dragMoved = false;
    this.pressedOnInfo = !!target.closest('.mp-info');
    this.dragStart = { x: e.clientX, y: e.clientY, px: rect.left, py: rect.top };
    // ドラッグ中の追跡を確実にするため即キャプチャ。
    // クリックの宛先が奪われるので曲名クリックはpointerupで自前処理する
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  onPointerMove(e: PointerEvent) {
    if (!this.dragging || !this.dragStart) return;
    const dx = e.clientX - this.dragStart.x;
    const dy = e.clientY - this.dragStart.y;
    if (Math.abs(dx) + Math.abs(dy) <= 4) return; // クリック相当の微動は無視
    this.dragMoved = true;
    const nx = Math.max(0, Math.min(window.innerWidth - 80, this.dragStart.px + dx));
    const ny = Math.max(0, Math.min(window.innerHeight - 40, this.dragStart.py + dy));
    this.pos = { x: nx, y: ny };
  }

  onPointerUp() {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.dragMoved) {
      try { localStorage.setItem('lycoris.mini-player-pos.v1', JSON.stringify(this.pos)); } catch { }
    } else if (this.pressedOnInfo) {
      // ドラッグせず離した＝曲名クリック → 曲リストを開閉
      this.toggleTrackList();
    }
  }

  resetPosition() {
    this.pos = null;
    try { localStorage.removeItem('lycoris.mini-player-pos.v1'); } catch { }
  }

  // ===== 曲リスト =====
  toggleTrackList() {
    this.trackListOpen = !this.trackListOpen;
  }

  get trackList(): { identifier: string, name: string, playing: boolean, ready: boolean }[] {
    const j = this.jukebox;
    const items: { identifier: string, name: string, playing: boolean, ready: boolean }[] = [];
    for (const audio of AudioStorage.instance.audios.filter(a => !a.isHidden)) {
      items.push({ identifier: audio.identifier, name: audio.name, playing: !!j && j.audioIdentifier === audio.identifier, ready: audio.isReady });
    }
    if (j) {
      for (const id of j.getPinnedLibraryTrackIds()) {
        items.push({ identifier: 'server:' + id, name: this.libraryNames[id] || 'ライブラリ曲', playing: j.audioIdentifier === 'server:' + id, ready: true });
      }
    }
    return items;
  }

  listNote: string = '';
  private listNoteTimer: any = null;

  private notifyList(note: string) {
    this.listNote = note;
    if (this.listNoteTimer) clearTimeout(this.listNoteTimer);
    this.listNoteTimer = setTimeout(() => { this.listNote = ''; }, 2600);
  }

  selectTrack(identifier: string) {
    const j = this.jukebox;
    if (!j) { this.notifyList('ジュークボックスを初期化できません'); return; }
    if (!identifier.startsWith('server:')) {
      const audio = AudioStorage.instance.get(identifier);
      if (!audio || !audio.isReady) {
        // Jukebox.playは未同期曲を黙って無視するため、ここで理由を出す（リストは開いたまま）
        this.notifyList('この曲はデータ未同期で再生できません');
        return;
      }
    }
    j.play(identifier, true);
    this.trackListOpen = false;
  }

  get jukebox(): Jukebox { return ObjectStore.instance.get<Jukebox>('Jukebox'); }

  get roomVolume(): number {
    const conf = ObjectStore.instance.get<Config>('Config');
    return conf ? conf.roomVolume : 1;
  }

  get volume(): number { const j = this.jukebox; return j ? j.volume : 0.5; }
  set volume(volume: number) {
    const j = this.jukebox;
    if (!j) return;
    j.volume = volume;
    AudioPlayer.volume = volume * this.roomVolume;
    EventSystem.trigger('CHANGE_JUKEBOX_VOLUME', null);
  }

  get isPlaying(): boolean {
    const j = this.jukebox;
    if (!j) return false;
    if (j.activeBgmSource === 'combat') return !!j.combatBgmIdentifierSync && !j.combatBgmManualOverride;
    if (j.isPlaying && j.audioIdentifier) return true;
    return j.activeBgmSource === 'table' || j.activeBgmSource === 'jukebox';
  }

  get sourceLabel(): string {
    const j = this.jukebox;
    if (!j) return '';
    switch (j.activeBgmSource) {
      case 'combat': return '戦闘BGM';
      case 'table': return 'テーブルBGM';
      case 'jukebox': return 'ジュークボックス';
      default: return '停止中';
    }
  }

  get nowPlayingName(): string {
    const j = this.jukebox;
    if (!j) return '—';
    if (j.activeBgmSource === 'combat' && j.combatBgmIdentifierSync) return this.resolveName(j.combatBgmIdentifierSync);
    if (j.isPlaying && j.audioIdentifier) return this.resolveName(j.audioIdentifier);
    return '—';
  }

  private resolveName(identifier: string): string {
    if (!identifier) return '—';
    if (identifier.startsWith('server:')) {
      return this.libraryNames[identifier.slice('server:'.length)] || 'ライブラリ曲';
    }
    const audio = AudioStorage.instance.get(identifier);
    return audio ? audio.name : '不明な曲';
  }

  togglePlayPause() {
    const j = this.jukebox;
    if (!j) return;
    if (j.isPlaying && j.audioIdentifier) {
      this.lastTrackId = j.audioIdentifier;
      j.stop(); // 戦闘BGM再生中なら手動制御オーバーライドが効いて止まる
      return;
    }
    if (j.activeBgmSource === 'combat') {
      j.stopCombatBgm();
      return;
    }
    if (this.lastTrackId) j.play(this.lastTrackId, true);
  }

  masterStop() {
    const j = this.jukebox;
    if (!j) return;
    j.stopTableAudio();
    j.stop();
  }
}
