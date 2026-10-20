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
  constructor(
    private tabletopService: TabletopService,
    private ngZone: NgZone,
    private changeDetector: ChangeDetectorRef
  ) { }

  ngOnInit() {
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
}
