import { Component, OnDestroy, OnInit } from '@angular/core';

interface ServerStatus {
  ok: boolean;
  peers: number;
  rooms: { [key: string]: number };
  roomDetails: any[];
  media: { saved: number; referenced: number };
  startedAt: string;
  connectionsTotal: number;
  relayedDataMessages: number;
  replayedDataMessages: number;
  savedRooms: number;
  savedMedia: number;
  system?: {
    memory: {
      total: number;
      free: number;
      used: number;
      usedRatio: number;
      rss: number;
      heapUsed: number;
      heapTotal: number;
      heapLimit: number;
      heapUsedRatio: number;
      external: number;
      arrayBuffers: number;
    };
    cpu: {
      loadavg: number[];
      cores: number;
      loadRatio1m: number;
    };
    uptimeSec: number;
  };
}

@Component({
  selector: 'server-status',
  templateUrl: './server-status.component.html',
  styleUrls: ['./server-status.component.css']
})
export class ServerStatusComponent implements OnInit, OnDestroy {
  status: ServerStatus | null = null;
  expanded = false;
  loading = false;
  error: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private static readonly POLL_MS = 30000;

  ngOnInit() {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), ServerStatusComponent.POLL_MS);
  }

  ngOnDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  toggle() { this.expanded = !this.expanded; }

  get activeRooms(): number {
    if (!this.status?.rooms) return 0;
    return Object.entries(this.status.rooms).filter(([k, v]) => k !== 'lobby' && k !== 'unregistered' && v > 0).length;
  }

  get uptimeText(): string {
    const sec = this.status?.system?.uptimeSec;
    if (sec == null) return '?';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return h > 0 ? `${h}h${m}m` : `${m}m`;
  }

  get memoryPercent(): number { return Math.round((this.status?.system?.memory.usedRatio ?? 0) * 100); }
  get heapPercent(): number { return Math.round((this.status?.system?.memory.heapUsedRatio ?? 0) * 100); }
  get loadPercent(): number { return Math.round((this.status?.system?.cpu.loadRatio1m ?? 0) * 100); }

  get congestionLevel(): 'low' | 'medium' | 'high' {
    const mem = this.status?.system?.memory.usedRatio ?? 0;
    const heap = this.status?.system?.memory.heapUsedRatio ?? 0;
    const load = this.status?.system?.cpu.loadRatio1m ?? 0;
    // リソースベース判定。人数では判定しない。
    if (mem >= 0.85 || heap >= 0.75 || load >= 1.0) return 'high';
    if (mem >= 0.70 || heap >= 0.55 || load >= 0.70) return 'medium';
    return 'low';
  }

  get congestionText(): string {
    switch (this.congestionLevel) {
      case 'low': return '快適';
      case 'medium': return 'やや混雑';
      case 'high': return '混雑';
    }
  }

  formatBytes(bytes?: number): string {
    if (bytes == null || !Number.isFinite(bytes)) return '?';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i++;
    }
    return `${value.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
  }

  private async refresh() {
    if (this.loading) return;
    this.loading = true;
    try {
      const res = await fetch('/api/status', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.status = await res.json();
      this.error = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
    }
  }
}
