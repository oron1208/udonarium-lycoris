import { Injectable } from '@angular/core';
import { EventSystem } from '@udonarium/core/system';
import { StickyNote } from '@udonarium/sticky-note';

/**
 * 付箋のローカル管理サービス。
 * 付箋は個人メモのためネットワーク同期せず、localStorageに永続化する。
 */
@Injectable({ providedIn: 'root' })
export class StickyNoteService {
  static readonly STORE_KEY = 'lycoris.sticky-notes.v1';

  private _notes: StickyNote[] = [];
  get stickyNotes(): StickyNote[] { return this._notes; }

  private saveTimer: any = null;

  constructor() {
    this.load();
    // ドラッグ終了などのタイミングで保存（デバウンス）
    document.addEventListener('mouseup', () => this.requestSave());
    document.addEventListener('touchend', () => this.requestSave());
  }

  add(position: { x: number, y: number, z?: number }): StickyNote {
    const note = StickyNote.create();
    note.location = { name: 'table', x: position.x, y: position.y };
    note.posZ = position.z || 0;
    this._notes = [...this._notes, note];
    this.changed();
    return note;
  }

  remove(note: StickyNote) {
    this._notes = this._notes.filter(n => n !== note);
    this.changed();
  }

  bringToFront(note: StickyNote) {
    this._notes = [...this._notes.filter(n => n !== note), note];
    this.changed();
  }

  /** 卓へ再描画通知＋保存 */
  changed() {
    EventSystem.trigger('UPDATE_STICKY_NOTES', {});
    this.requestSave();
  }

  requestSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 250);
  }

  private save() {
    try {
      const data = this._notes.map(n => ({
        identifier: n.identifier,
        location: { name: 'table', x: n.location.x, y: n.location.y },
        posZ: n.posZ,
        text: n.text,
        color: n.color,
        isLock: n.isLock,
        rotate: n.rotate,
        title: n.title,
        collapsed: n.collapsed
      }));
      localStorage.setItem(StickyNoteService.STORE_KEY, JSON.stringify(data));
    } catch (_) { }
  }

  private load() {
    try {
      const raw = localStorage.getItem(StickyNoteService.STORE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as any[];
      if (!Array.isArray(data)) return;
      this._notes = data.map(d => {
        const note = new StickyNote(d.identifier);
        note.location = d.location || { name: 'table', x: 0, y: 0 };
        note.posZ = d.posZ || 0;
        note.text = d.text || '';
        note.color = d.color || '#ffe973';
        note.isLock = !!d.isLock;
        note.rotate = d.rotate || 0;
        note.title = d.title || '';
        note.collapsed = !!d.collapsed;
        return note;
      });
    } catch (_) {
      this._notes = [];
    }
  }
}
