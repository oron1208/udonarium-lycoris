import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, EventEmitter, HostListener, Input, NgZone, OnChanges, OnDestroy, OnInit, Output, SimpleChanges } from '@angular/core';
import { GameTable } from '@udonarium/game-table';
import { EventSystem, Network } from '@udonarium/core/system';
import { PeerCursor } from '@udonarium/peer-cursor';
import { CoordinateService } from 'service/coordinate.service';

interface RulerPoint { x: number; y: number; }
interface RulerUpdate { tableId: string; points: RulerPoint[]; }
interface RemoteRuler {
  peerId: string; points: RulerPoint[]; projected: RulerPoint[]; polyline: string; color: string; updated: number;
}

/** Measurement paths use transient room events, not persistent saved objects. */
@Component({
  selector: 'table-ruler',
  templateUrl: './table-ruler.component.html',
  styleUrls: ['./table-ruler.component.css'],
  changeDetection: ChangeDetectionStrategy.Eager,
  standalone: false
})
export class TableRulerComponent implements OnChanges, OnInit, OnDestroy {
  @Input() table: GameTable;
  @Input() board: HTMLElement;
  @Input() active = false;
  @Output() activeChange = new EventEmitter<boolean>();

  points: RulerPoint[] = [];
  endpoint: RulerPoint | null = null;
  projected: RulerPoint[] = [];
  measuring = false;
  remoteRulers: RemoteRuler[] = [];
  private pointerStart: RulerPoint | null = null;
  private pointerId: number | null = null;
  private frame = 0;
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastSent = 0;
  private initialized = false;

  constructor(private coordinates: CoordinateService, private host: ElementRef<HTMLElement>,
    private zone: NgZone, private changeDetector: ChangeDetectorRef) { }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['table']) {
      const previous = changes['table'].previousValue as GameTable;
      if (previous && this.points.length) this.sendClear(previous.identifier);
      this.clear(false);
      this.remoteRulers = [];
      if (this.initialized) this.requestState();
    } else if (changes['active']) this.clear();
  }

  ngOnInit() {
    this.initialized = true;
    EventSystem.register(this)
      .on<RulerUpdate>('TABLE_RULER_UPDATE', event => {
        if (event.isSendFromSelf || event.data?.tableId !== this.table?.identifier) return;
        const points = event.data.points;
        if (!Array.isArray(points) || points.length > 512 || points.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return;
        this.remoteRulers = this.remoteRulers.filter(r => r.peerId !== event.sendFrom);
        if (points.length) this.remoteRulers.push({ peerId: event.sendFrom, points: points.map(p => ({ x: p.x, y: p.y })),
          projected: [], polyline: '', color: this.peerColor(event.sendFrom), updated: Date.now() });
        this.refreshProjection();
        this.changeDetector.markForCheck();
      })
      .on<{ tableId: string }>('TABLE_RULER_REQUEST', event => {
        if (!event.isSendFromSelf && event.data?.tableId === this.table?.identifier && this.points.length) this.publish(true, event.sendFrom);
      })
      .on('CONNECT_PEER', event => {
        if (this.points.length) this.publish(true, event.data.peerId);
        this.requestState(event.data.peerId);
      })
      .on('DISCONNECT_PEER', event => {
        this.remoteRulers = this.remoteRulers.filter(r => r.peerId !== event.data.peerId);
        this.changeDetector.markForCheck();
      })
      .on('CLOSE_NETWORK', () => {
        this.clear(false); this.remoteRulers = []; this.changeDetector.markForCheck();
      });
    this.requestState();
    this.heartbeat = setInterval(() => {
      if (this.points.length) this.publish(true);
      const now = Date.now();
      this.remoteRulers = this.remoteRulers.filter(r => now - r.updated < 30000);
      this.changeDetector.markForCheck();
    }, 5000);
  }

  ngOnDestroy() {
    if (this.points.length) this.sendClear(this.table?.identifier);
    EventSystem.unregister(this);
    if (this.sendTimer) clearTimeout(this.sendTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.frame) cancelAnimationFrame(this.frame);
  }

  private requestState(sendTo?: string) {
    if (Network.isOpen && this.table) EventSystem.call('TABLE_RULER_REQUEST', { tableId: this.table.identifier }, sendTo);
  }
  private sendClear(tableId: string) {
    if (Network.isOpen && tableId) EventSystem.call('TABLE_RULER_UPDATE', { tableId, points: [] });
  }
  private publish(immediate = false, sendTo?: string) {
    if (!Network.isOpen || !this.table) return;
    if (sendTo) {
      // A late joiner's snapshot must not cancel a pending update to everyone else.
      EventSystem.call('TABLE_RULER_UPDATE', { tableId: this.table.identifier, points: this.path.map(p => ({ ...p })) }, sendTo);
      return;
    }
    if (immediate || Date.now() - this.lastSent >= 80) {
      if (this.sendTimer) clearTimeout(this.sendTimer);
      this.sendTimer = null;
      this.lastSent = Date.now();
      EventSystem.call('TABLE_RULER_UPDATE', { tableId: this.table.identifier, points: this.path.map(p => ({ ...p })) });
    } else if (!this.sendTimer) {
      this.sendTimer = setTimeout(() => { this.sendTimer = null; this.publish(true); }, 80);
    }
  }
  private peerColor(peerId: string): string {
    let hash = 0;
    for (const c of peerId) hash = (hash * 31 + c.charCodeAt(0)) | 0;
    return `hsl(${Math.abs(hash) % 360}, 85%, 65%)`;
  }
  remoteName(peerId: string): string { return PeerCursor.findByPeerId(peerId)?.name || '参加者'; }

  get distancePerCell(): number {
    const value = Number(this.table?.rulerDistancePerCell);
    return Number.isFinite(value) && value > 0 ? value : 5;
  }
  get unit(): string { return this.table?.rulerUnit?.trim() || 'm'; }
  get path(): RulerPoint[] { return this.endpoint ? [...this.points, this.endpoint] : this.points; }
  get distance(): number {
    return this.distanceFor(this.path);
  }
  private distanceFor(path: RulerPoint[]): number {
    let pixels = 0;
    for (let i = 1; i < path.length; i++) pixels += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    return pixels / Math.max(1, Number(this.table?.gridSize) || 50) * this.distancePerCell;
  }
  get distanceLabel(): string { return `${Number(this.distance.toFixed(1))} ${this.unit}`; }
  remoteDistance(ruler: RemoteRuler): string { return `${Number(this.distanceFor(ruler.points).toFixed(1))} ${this.unit}`; }
  get polyline(): string { return this.projected.map(p => `${p.x},${p.y}`).join(' '); }
  get labelPoint(): RulerPoint { return this.projected[this.projected.length - 1] || { x: 0, y: 0 }; }
  get labelStyle(): { [key: string]: string } {
    return this.pointLabelStyle(this.labelPoint);
  }
  remoteLabelStyle(ruler: RemoteRuler): { [key: string]: string } {
    return this.pointLabelStyle(ruler.projected[ruler.projected.length - 1] || { x: 0, y: 0 }, 240);
  }
  private pointLabelStyle(point: RulerPoint, width = 140): { [key: string]: string } {
    const bounds = this.host.nativeElement.getBoundingClientRect();
    return { left: `${Math.max(8, Math.min(bounds.width - width, point.x + 12))}px`,
      top: `${Math.max(8, Math.min(bounds.height - 40, point.y - 36))}px` };
  }

  updateScale(value: number, input: HTMLInputElement) {
    const distance = Number(value);
    if (Number.isFinite(distance) && distance > 0) {
      this.table.rulerDistancePerCell = distance;
      this.table.update();
    }
    input.value = String(this.distancePerCell);
  }
  updateUnit(value: string, input: HTMLInputElement) {
    const unit = value.trim().slice(0, 12);
    if (unit) { this.table.rulerUnit = unit; this.table.update(); }
    input.value = this.unit;
  }

  clear(notify = true) {
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.sendTimer = null;
    if (notify && this.points.length) this.sendClear(this.table?.identifier);
    this.points = []; this.endpoint = null; this.projected = [];
    this.measuring = false; this.pointerStart = null; this.pointerId = null;
  }
  close() { this.clear(); this.activeChange.emit(false); }

  private localPoint(event: PointerEvent): RulerPoint | null {
    if (!this.board || !this.table) return null;
    // Always intersect the board plane, not the clicked token or a screen overlay.
    const p = this.coordinates.convertToLocal({ x: event.clientX, y: event.clientY, z: 0 }, this.board);
    const width = this.table.width * this.table.gridSize, height = this.table.height * this.table.gridSize;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    return { x: Math.max(0, Math.min(width, p.x)), y: Math.max(0, Math.min(height, p.y)) };
  }

  onPointerDown(event: PointerEvent) {
    event.stopPropagation();
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    // Clicking the map leaves scale editing, so Escape can cancel the measurement.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && this.host.nativeElement.contains(focused)) focused.blur();
    const point = this.localPoint(event);
    if (!point) return;
    this.pointerId = event.pointerId;
    this.pointerStart = { x: event.clientX, y: event.clientY };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    if (!this.measuring) {
      this.points = [point]; this.endpoint = point; this.measuring = true;
    } else if (event.ctrlKey || event.metaKey) {
      this.addWaypoint(point);
    } else {
      this.endpoint = point; this.measuring = false;
    }
    this.refreshProjection();
    this.publish(true);
  }

  onPointerMove(event: PointerEvent) {
    event.stopPropagation();
    if (!this.measuring || !event.isPrimary || (this.pointerId !== null && this.pointerId !== event.pointerId)) return;
    const point = this.localPoint(event);
    if (point) { this.endpoint = point; this.refreshProjection(); this.publish(); }
  }

  onPointerUp(event: PointerEvent) {
    event.stopPropagation();
    if (event.pointerId !== this.pointerId || event.button !== 0) return;
    const moved = this.pointerStart && Math.hypot(event.clientX - this.pointerStart.x, event.clientY - this.pointerStart.y) > 4;
    if (this.measuring && moved) {
      const point = this.localPoint(event);
      if (point) {
        this.endpoint = point;
        if (event.ctrlKey || event.metaKey) this.addWaypoint(point);
        else this.measuring = false;
      }
    }
    this.pointerId = null; this.pointerStart = null;
    this.refreshProjection();
    this.publish(true);
  }

  onPointerCancel(event: PointerEvent) {
    if (event.pointerId === this.pointerId) this.clear();
  }
  private addWaypoint(point: RulerPoint) {
    const last = this.points[this.points.length - 1];
    if (!last || Math.hypot(point.x - last.x, point.y - last.y) > 0.01) this.points = [...this.points, point];
    this.endpoint = point;
  }
  onContextMenu(event: MouseEvent) {
    event.preventDefault(); event.stopPropagation();
    if (this.points.length > 1) {
      this.points = this.points.slice(0, -1); this.measuring = true;
      this.refreshProjection();
      this.publish(true);
    } else this.clear();
  }

  @HostListener('document:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent) {
    if (!this.active || event.key !== 'Escape') return;
    if ((event.target as HTMLElement)?.closest('input,textarea,select,[contenteditable="true"]')) return;
    event.preventDefault();
    if (this.points.length) this.clear(); else this.close();
    this.changeDetector.markForCheck();
  }

  @HostListener('window:resize')
  refreshProjection() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (!this.board) return;
      const rect = this.host.nativeElement.getBoundingClientRect();
      const project = (point: RulerPoint) => {
        const p = this.coordinates.convertToGlobal({ ...point, z: 0 }, this.board);
        return { x: p.x - rect.left, y: p.y - rect.top };
      };
      this.projected = this.active ? this.path.map(project) : [];
      for (const ruler of this.remoteRulers) {
        ruler.projected = ruler.points.map(project);
        ruler.polyline = ruler.projected.map(p => `${p.x},${p.y}`).join(' ');
      }
      this.zone.run(() => this.changeDetector.markForCheck());
    });
  }
}
