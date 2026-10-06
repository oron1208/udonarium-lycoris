import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, Input, NgZone, OnDestroy, OnInit } from '@angular/core';
import { EventSystem } from '@udonarium/core/system';
import { StickyNote } from '@udonarium/sticky-note';
import { ContextMenuSeparator, ContextMenuService } from 'service/context-menu.service';
import { PointerDeviceService } from 'service/pointer-device.service';
import { StickyNoteService } from 'service/sticky-note.service';

/** 付箋らしい色5色＋半透明（glass）。右クリックで順に切り替わる */
const NOTE_COLORS = ['#ffe973', '#a8e6a1', '#a1d6e6', '#f4b8d8', '#f4c8a8', 'glass'];

@Component({
  selector: 'sticky-note',
  templateUrl: './sticky-note.component.html',
  styleUrls: ['./sticky-note.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class StickyNoteComponent implements OnInit, OnDestroy {
  @Input() stickyNote: StickyNote = null;

  get text(): string { return this.stickyNote.text; }
  set text(text: string) { this.stickyNote.text = text; }
  get color(): string { return this.stickyNote.color; }
  get isLock(): boolean { return this.stickyNote.isLock; }
  get title(): string { return this.stickyNote.title; }
  set title(title: string) { this.stickyNote.title = title; }
  get collapsed(): boolean { return this.stickyNote.collapsed; }

  /** 画面座標（卓の回転・ズームの影響を受けない） */
  get posX(): number { return this.stickyNote.location.x; }
  get posY(): number { return this.stickyNote.location.y; }

  get isGlass(): boolean { return this.stickyNote.color === 'glass'; }
  get bodyColor(): string { return this.isGlass ? 'rgba(255, 255, 255, 0.55)' : this.stickyNote.color; }
  /** 次の色のプレビュー（色ボタンのチップ） */
  get nextColor(): string {
    const idx = NOTE_COLORS.indexOf(this.stickyNote.color);
    const next = NOTE_COLORS[(idx + 1 + NOTE_COLORS.length) % NOTE_COLORS.length];
    return next === 'glass' ? 'rgba(255, 255, 255, 0.7)' : next;
  }
  /** 付箋同士の前後（サービス配列の順序） */
  get zIndex(): number { return 100 + this.stickyNoteService.stickyNotes.indexOf(this.stickyNote); }

  constructor(
    private ngZone: NgZone,
    private contextMenuService: ContextMenuService,
    private elementRef: ElementRef<HTMLElement>,
    private changeDetector: ChangeDetectorRef,
    private pointerDeviceService: PointerDeviceService,
    private stickyNoteService: StickyNoteService
  ) { }

  ngOnInit() {
    EventSystem.register(this)
      .on('UPDATE_STICKY_NOTES', -1000, event => {
        this.changeDetector.markForCheck();
      });
  }

  ngOnDestroy() {
    EventSystem.unregister(this);
  }

  /** ハンドルでドラッグ（画面座標。卓のtransformと無関係） */
  onGrabPointerDown(e: PointerEvent) {
    if (this.isLock) return;
    e.stopPropagation();
    e.preventDefault();
    this.stickyNoteService.bringToFront(this.stickyNote);
    const offX = e.clientX - this.stickyNote.location.x;
    const offY = e.clientY - this.stickyNote.location.y;
    const onMove = (ev: PointerEvent) => {
      this.stickyNote.location = { name: 'table', x: Math.max(0, ev.clientX - offX), y: Math.max(0, ev.clientY - offY) };
      this.changeDetector.markForCheck();
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      this.stickyNoteService.changed();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  /** ハンドル上のボタンがドラッグを発火させないようにする */
  onBtnPointerDown(e: Event) {
    e.stopPropagation();
  }

  /** 色ボタン：次の色へ循環 */
  cycleColor(e: Event) {
    e.stopPropagation();
    const idx = NOTE_COLORS.indexOf(this.stickyNote.color);
    this.stickyNote.color = NOTE_COLORS[(idx + 1 + NOTE_COLORS.length) % NOTE_COLORS.length];
    this.stickyNoteService.changed();
    this.changeDetector.markForCheck();
  }

  /** 折りたたみボタン：本文の表示を切り替える */
  toggleCollapse(e: Event) {
    e.stopPropagation();
    this.stickyNote.collapsed = !this.stickyNote.collapsed;
    this.stickyNoteService.changed();
    this.changeDetector.markForCheck();
  }

  onTextChanged() {
    this.stickyNoteService.requestSave();
  }

  onContextMenu(e: Event) {
    e.stopPropagation();
    e.preventDefault();
    // 卓メニューと同じく常に開く（isAllowedフラグのチェックはしない）
    let position = this.pointerDeviceService.pointers[0];
    this.contextMenuService.open(position, [
      (this.isLock
        ? { name: '☑ 固定', action: () => { this.stickyNote.isLock = false; this.stickyNoteService.changed(); this.changeDetector.markForCheck(); } }
        : { name: '☐ 固定', action: () => { this.stickyNote.isLock = true; this.stickyNoteService.changed(); this.changeDetector.markForCheck(); } }),
      { name: this.collapsed ? '展開する' : '折りたたむ', action: () => { this.stickyNote.collapsed = !this.stickyNote.collapsed; this.stickyNoteService.changed(); this.changeDetector.markForCheck(); } },
      {
        name: '色を変える', action: () => {
          const idx = NOTE_COLORS.indexOf(this.stickyNote.color);
          this.stickyNote.color = NOTE_COLORS[(idx + 1 + NOTE_COLORS.length) % NOTE_COLORS.length];
          this.stickyNoteService.changed();
          this.changeDetector.markForCheck();
        }
      },
      ContextMenuSeparator,
      { name: '付箋を削除', action: () => { this.stickyNoteService.remove(this.stickyNote); } }
    ]);
  }
}
