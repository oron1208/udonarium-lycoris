import { ChangeDetectorRef, Component, NgZone, OnDestroy, OnInit } from '@angular/core';
import { EventSystem } from '@udonarium/core/system';
import { MediaIntegrity, MediaIntegritySummary } from '@udonarium/core/file-storage/media-integrity';

@Component({
    selector: 'media-integrity-badge',
    templateUrl: './media-integrity-badge.component.html',
    styleUrls: ['./media-integrity-badge.component.css'],
    standalone: false
})
export class MediaIntegrityBadgeComponent implements OnInit, OnDestroy {
  summary: MediaIntegritySummary = { total: 0, ok: 0, localOnly: 0, missing: 0, items: [] };
  expanded = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private zone: NgZone,
    private cd: ChangeDetectorRef,
  ) { }

  ngOnInit() {
    MediaIntegrity.instance.initialize();
    this.refresh();
    EventSystem.register(this)
      .on('MEDIA_INTEGRITY_CHANGED', () => {
        this.zone.run(() => this.refresh());
      });
    // イベント取りこぼし（画像apply完了等）のフォールバック
    this.timer = setInterval(() => this.zone.run(() => this.refresh()), 5000);
  }

  ngOnDestroy() {
    EventSystem.unregister(this);
    if (this.timer) clearInterval(this.timer);
  }

  get hasIssues(): boolean {
    return this.summary.localOnly > 0 || this.summary.missing > 0;
  }

  toggle() {
    this.expanded = !this.expanded;
  }

  private refresh() {
    this.summary = MediaIntegrity.instance.refresh();
    this.cd.markForCheck();
  }
}
