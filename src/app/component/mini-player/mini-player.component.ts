import { Component, DoCheck, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';

import { AudioPlayer } from '@udonarium/core/file-storage/audio-player';
import { AudioStorage } from '@udonarium/core/file-storage/audio-storage';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { EventSystem } from '@udonarium/core/system';
import { Jukebox } from '@udonarium/Jukebox';
import { Config } from '@udonarium/config';
import { GameTable } from '@udonarium/game-table';
import { AudioLibraryService } from 'service/audio-library.service';

interface TrackSelection {
  identifiers: string[];
  source: string;
  tableId?: string;
}

@Component({
  selector: 'app-mini-player',
  templateUrl: './mini-player.component.html',
  styleUrls: ['./mini-player.component.css']
})
export class MiniPlayerComponent implements OnInit, OnDestroy, DoCheck {
  visible = false;
  private lastSelection: TrackSelection = null;
  private libraryNames: { [id: string]: string } = {};
  private timer: any = null;

  // ===== ドラッグ移動 =====
  pos: { x: number, y: number } | null = null;
  private dragging = false;
  private dragMoved = false;
  private dragStart: { x: number, y: number, px: number, py: number } = null;

  // ===== 曲リスト =====
  trackListOpen = false;
  listAbove = false;
  @ViewChild('player') player: ElementRef<HTMLElement>;

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

  ngDoCheck() {
    // 再生元が他のパネルや同期で変わった場合も、停止前の選択を保持する。
    const selection = this.activeSelection;
    if (selection) this.lastSelection = selection;
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
    if (e.button !== 0 || target.closest('button, input, .mp-track-list')) return;
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    this.dragging = true;
    this.dragMoved = false;
    this.dragStart = { x: e.clientX, y: e.clientY, px: rect.left, py: rect.top };
    // 操作ボタンはキャプチャせず、背景・アイコンだけをドラッグハンドルにする。
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  onPointerMove(e: PointerEvent) {
    if (!this.dragging || !this.dragStart) return;
    const dx = e.clientX - this.dragStart.x;
    const dy = e.clientY - this.dragStart.y;
    if (Math.abs(dx) + Math.abs(dy) <= 4) return; // クリック相当の微動は無視
    this.dragMoved = true;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const nx = Math.max(0, Math.min(window.innerWidth - rect.width, this.dragStart.px + dx));
    const ny = Math.max(0, Math.min(window.innerHeight - rect.height, this.dragStart.py + dy));
    this.pos = { x: nx, y: ny };
    this.listAbove = ny + rect.height + 260 > window.innerHeight && ny > 260;
  }

  onPointerUp() {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.dragMoved) {
      try { localStorage.setItem('lycoris.mini-player-pos.v1', JSON.stringify(this.pos)); } catch { }
    }
  }

  onDoubleClick(e: MouseEvent) {
    // pointer capture中のダブルクリックはアイコンでなく親に届く。
    if ((e.target as HTMLElement).closest('button, input, .mp-track-list')) return;
    this.resetPosition();
  }

  resetPosition() {
    this.pos = null;
    this.listAbove = false;
    try { localStorage.removeItem('lycoris.mini-player-pos.v1'); } catch { }
  }

  // ===== 曲リスト =====
  toggleTrackList() {
    this.trackListOpen = !this.trackListOpen;
    if (this.trackListOpen) {
      const rect = this.player?.nativeElement.getBoundingClientRect();
      this.listAbove = !!rect && rect.bottom + 260 > window.innerHeight && rect.top > 260;
      this.audioLibraryService.fetchTracks().then(tracks => {
        for (const track of tracks) this.libraryNames[track.id] = track.name;
      }).catch(() => { });
    }
  }

  trackByIdentifier(_index: number, track: { identifier: string }): string { return track.identifier; }

  get trackList(): { identifier: string, name: string, playing: boolean, selected: boolean, ready: boolean }[] {
    const j = this.jukebox;
    const active = this.activeSelection?.identifiers || [];
    const selected = (this.activeSelection || this.lastSelection)?.identifiers || [];
    const items: { identifier: string, name: string, playing: boolean, selected: boolean, ready: boolean }[] = [];
    for (const audio of AudioStorage.instance.audios.filter(a => !a.isHidden)) {
      items.push({ identifier: audio.identifier, name: audio.name, playing: active.includes(audio.identifier), selected: selected.includes(audio.identifier), ready: audio.isReady });
    }
    if (j) {
      for (const id of j.getPinnedLibraryTrackIds()) {
        const identifier = 'server:' + id;
        items.push({ identifier, name: this.resolveName(identifier), playing: active.includes(identifier), selected: selected.includes(identifier), ready: !!this.audioLibraryService.getTrack(id) });
      }
    }
    return items;
  }

  listNote: string = '';
  private listNoteTimer: any = null;

  private notifyList(note: string) {
    if (!this.trackListOpen) this.toggleTrackList();
    this.listNote = note;
    if (this.listNoteTimer) clearTimeout(this.listNoteTimer);
    this.listNoteTimer = setTimeout(() => { this.listNote = ''; }, 2600);
  }

  selectTrack(identifier: string) {
    const j = this.jukebox;
    if (!j) { this.notifyList('ジュークボックスを初期化できません'); return; }
    if (!identifier.startsWith('server:')) {
      identifier = this.normalizeIdentifier(identifier);
      const audio = AudioStorage.instance.get(identifier);
      if (!audio || !audio.isReady) {
        // Jukebox.playは未同期曲を黙って無視するため、ここで理由を出す（リストは開いたまま）
        this.notifyList('この曲はデータ未同期で再生できません');
        return;
      }
    } else if (!this.audioLibraryService.getTrack(identifier.slice(7))) {
      this.notifyList('ライブラリ曲を読み込めません。音楽パネルで確認してください');
      return;
    }
    this.lastSelection = { identifiers: [identifier], source: 'jukebox' };
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
    return !!this.activeSelection;
  }

  private normalizeIdentifier(id: string): string { return id.startsWith('upload:') ? id.slice(7) : id; }

  private get activeSelection(): TrackSelection | null {
    const j = this.jukebox;
    if (!j) return null;
    if (j.activeBgmSource === 'combat' && j.combatBgmIdentifierSync && !j.combatBgmManualOverride) {
      return { identifiers: [this.normalizeIdentifier(j.combatBgmIdentifierSync)], source: 'combat' };
    }
    if (j.activeBgmSource === 'table') {
      const table = ObjectStore.instance.get<GameTable>(j.activeTableIdentifier);
      const identifiers = Jukebox.getTableAudioLayers(table).filter(l => l.enabled && l.audioIdentifier).map(l => this.normalizeIdentifier(l.audioIdentifier));
      return identifiers.length ? { identifiers, source: 'table', tableId: j.activeTableIdentifier } : null;
    }
    if (j.activeBgmSource === 'jukebox') {
      const identifiers = j.isPlaying && j.audioIdentifier ? [this.normalizeIdentifier(j.audioIdentifier)]
        : j.getJukeboxLayers().filter(l => l.enabled && l.audioIdentifier).map(l => this.normalizeIdentifier(l.audioIdentifier));
      return identifiers.length ? { identifiers, source: j.isPlaying && j.audioIdentifier ? 'jukebox' : 'layers' } : null;
    }
    return null;
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
    const selection = this.activeSelection || this.lastSelection;
    return selection ? selection.identifiers.map(id => this.resolveName(id)).join(' ＋ ') : '曲を選択';
  }

  private resolveName(identifier: string): string {
    if (!identifier) return '—';
    if (identifier.startsWith('server:')) {
      const id = identifier.slice(7);
      return this.audioLibraryService.getTrack(id)?.name || this.libraryNames[id] || 'ライブラリ曲';
    }
    const audio = AudioStorage.instance.get(identifier);
    return audio ? audio.name : '不明な曲';
  }

  playSelected() {
    const j = this.jukebox;
    if (!j) return;
    if (this.isPlaying) return;
    const selection = this.lastSelection;
    if (!selection) { if (!this.trackListOpen) this.toggleTrackList(); return; }
    if (selection.source === 'table') {
      const table = ObjectStore.instance.get<GameTable>(selection.tableId);
      if (table && Jukebox.getTableAudioLayers(table).some(l => l.enabled && l.audioIdentifier)) { j.playTableAudio(table); return; }
    }
    if (selection.source === 'layers' && j.getJukeboxLayers().some(l => l.enabled && l.audioIdentifier)) { j.playJukeboxLayers(); return; }
    this.selectTrack(selection.identifiers[0]);
  }

  masterStop() {
    const j = this.jukebox;
    if (!j) return;
    const selection = this.activeSelection;
    if (selection) this.lastSelection = selection;
    j.stop();
    j.stopTableAudio();
  }
}
