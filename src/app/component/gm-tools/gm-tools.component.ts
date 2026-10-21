import { Component, ChangeDetectionStrategy, ChangeDetectorRef, NgZone, OnDestroy, OnInit } from '@angular/core';
import { EventSystem } from '@udonarium/core/system';
import { TabletopService } from 'service/tabletop.service';

/** GM限定ツールパネル。GMだけが使える機能をここに集約する（強制平面など）。 */
@Component({
    selector: 'gm-tools',
    templateUrl: './gm-tools.component.html',
    styleUrls: ['./gm-tools.component.css'],
    changeDetection: ChangeDetectionStrategy.Eager,
    standalone: false
})
export class GmToolsComponent implements OnInit, OnDestroy {
  private static readonly COUNTERS_KEY = 'udonarium.gmCounters.v1';
  counters: { value: number }[] = [];

  constructor(
    private tabletopService: TabletopService,
    private ngZone: NgZone,
    private changeDetector: ChangeDetectorRef
  ) { }

  ngOnInit() {
    this.loadCounters();
    EventSystem.register(this)
      .on('UPDATE_GAME_OBJECT', event => {
        if (event.data?.aliasName !== 'game-table') return;
        this.ngZone.run(() => this.changeDetector.markForCheck());
      });
  }

  ngOnDestroy() {
    EventSystem.unregister(this);
  }

  get forceFlatView(): boolean {
    return !!this.tabletopService.currentTable?.forceFlatView;
  }

  toggleForceFlatView() {
    const table = this.tabletopService.currentTable;
    if (!table || table.identifier.length < 1) return;
    table.forceFlatView = !table.forceFlatView;
    table.update();
    this.changeDetector.markForCheck();
  }

  /** カウンター（GM個人メモ。localStorage保存・同期なし） */
  loadCounters() {
    try {
      const parsed = JSON.parse(localStorage.getItem(GmToolsComponent.COUNTERS_KEY) || '[]');
      this.counters = Array.isArray(parsed) ? parsed.map((entry: any) => ({ value: Number(entry?.value) || 0 })) : [];
    } catch (_) { this.counters = []; }
  }

  saveCounters() {
    try { localStorage.setItem(GmToolsComponent.COUNTERS_KEY, JSON.stringify(this.counters)); } catch (_) { }
  }

  addCounter() {
    this.counters.push({ value: 0 });
    this.saveCounters();
  }

  removeCounter(index: number) {
    this.counters.splice(index, 1);
    this.saveCounters();
  }

  stepCounter(index: number, delta: number) {
    const counter = this.counters[index];
    if (!counter) return;
    counter.value = (Number(counter.value) || 0) + delta;
    this.saveCounters();
  }

  onCounterInput(index: number, input: HTMLInputElement) {
    const counter = this.counters[index];
    if (!counter) return;
    counter.value = Number(input.value) || 0;
    this.saveCounters();
  }

  /** クイックダメージ/回復の対象リソース名（卓共有SyncVar） */
  get quickDamageResource(): string {
    return this.tabletopService.currentTable?.quickDamageResource || 'HP';
  }

  commitQuickDamageResource(name: string) {
    const table = this.tabletopService.currentTable;
    if (!table || table.identifier.length < 1) return;
    table.quickDamageResource = name.trim() || 'HP';
    table.update();
    this.changeDetector.markForCheck();
  }
}
