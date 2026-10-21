import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, EventEmitter, HostListener, Input, NgZone, OnChanges, OnDestroy, Output, SimpleChanges } from '@angular/core';
import { GameTable } from '@udonarium/game-table';
import { CoordinateService } from 'service/coordinate.service';

interface RulerPoint { x: number; y: number; }

/** Measurements are personal/transient; only the table scale is synchronized. */
@Component({
  selector: 'table-ruler',
  templateUrl: './table-ruler.component.html',
  styleUrls: ['./table-ruler.component.css'],
  changeDetection: ChangeDetectionStrategy.Eager,
  standalone: false
})
export class TableRulerComponent implements OnChanges, OnDestroy {
  @Input() table: GameTable;
  @Input() board: HTMLElement;
  @Input() active = false;
  @Output() activeChange = new EventEmitter<boolean>();

  points: RulerPoint[] = [];
  endpoint: RulerPoint | null = null;
  projected: RulerPoint[] = [];
  measuring = false;
  private pointerStart: RulerPoint | null = null;
  private pointerId: number | null = null;
  private frame = 0;

  constructor(private coordinates: CoordinateService, private host: ElementRef<HTMLElement>,
    private zone: NgZone, private changeDetector: ChangeDetectorRef) { }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['table'] || changes['active']) this.clear();
  }

  ngOnDestroy() { if (this.frame) cancelAnimationFrame(this.frame); }

  get distancePerCell(): number {
    const value = Number(this.table?.rulerDistancePerCell);
    return Number.isFinite(value) && value > 0 ? value : 5;
  }
  get unit(): string { return this.table?.rulerUnit?.trim() || 'm'; }
  get path(): RulerPoint[] { return this.endpoint ? [...this.points, this.endpoint] : this.points; }
  get distance(): number {
    const path = this.path;
    let pixels = 0;
    for (let i = 1; i < path.length; i++) pixels += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    return pixels / Math.max(1, Number(this.table?.gridSize) || 50) * this.distancePerCell;
  }
  get distanceLabel(): string { return `${Number(this.distance.toFixed(1))} ${this.unit}`; }
  get polyline(): string { return this.projected.map(p => `${p.x},${p.y}`).join(' '); }
  get labelPoint(): RulerPoint { return this.projected[this.projected.length - 1] || { x: 0, y: 0 }; }
  get labelStyle(): { [key: string]: string } {
    const bounds = this.host.nativeElement.getBoundingClientRect();
    return { left: `${Math.max(8, Math.min(bounds.width - 140, this.labelPoint.x + 12))}px`,
      top: `${Math.max(8, Math.min(bounds.height - 40, this.labelPoint.y - 36))}px` };
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

  clear() {
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
  }

  onPointerMove(event: PointerEvent) {
    event.stopPropagation();
    if (!this.measuring || !event.isPrimary || (this.pointerId !== null && this.pointerId !== event.pointerId)) return;
    const point = this.localPoint(event);
    if (point) { this.endpoint = point; this.refreshProjection(); }
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
      if (!this.active || !this.board) return;
      const rect = this.host.nativeElement.getBoundingClientRect();
      this.projected = this.path.map(point => {
        const p = this.coordinates.convertToGlobal({ ...point, z: 0 }, this.board);
        return { x: p.x - rect.left, y: p.y - rect.top };
      });
      this.zone.run(() => this.changeDetector.markForCheck());
    });
  }
}
