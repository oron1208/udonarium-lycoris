import { ResettableTimeout } from '../../util/resettable-timeout';
import { Logger } from '../../util/logger';

export interface WebRTCConnection {
  open: boolean;
  updateStatsAsync(): Promise<void>;
  sendPing?(): void;
}

export class WebRTCStatsMonitor {
  private static updateWebRTCStatsTimer: ResettableTimeout = null;
  private static monitoringConnections: Set<WebRTCConnection> = new Set();
  private static inFlight: WeakSet<WebRTCConnection> = new WeakSet();

  private constructor() { }

  static add(connection: WebRTCConnection) {
    if (this.monitoringConnections.has(connection)) return;
    this.monitoringConnections.add(connection);
    this.update(connection);
    this.restart();
  }

  static remove(connection: WebRTCConnection) {
    this.monitoringConnections.delete(connection);
    if (!this.monitoringConnections.size) {
      this.updateWebRTCStatsTimer?.clear();
      this.updateWebRTCStatsTimer = null;
    }
  }

  private static update(connection: WebRTCConnection) {
    if (!connection.open) { this.remove(connection); return; }
    // Heartbeats must continue even if getStats for this peer never settles.
    try { connection.sendPing?.(); } catch (error) { Logger.warn('WebRTC ping failed', error); }
    if (this.inFlight.has(connection)) return;
    this.inFlight.add(connection);
    Promise.resolve().then(() => connection.updateStatsAsync())
      .catch(error => Logger.warn('WebRTC stats failed', error))
      .finally(() => this.inFlight.delete(connection));
  }

  private static restart() {
    if (!this.monitoringConnections.size) return;
    if (this.updateWebRTCStatsTimer == null) {
      this.updateWebRTCStatsTimer = new ResettableTimeout(() => this.doMonitoringAsync(), this.calcIntervalTime());
    } else if (!this.updateWebRTCStatsTimer.isActive) {
      this.updateWebRTCStatsTimer.reset(this.calcIntervalTime());
    }
  }

  private static calcIntervalTime(): number {
    return Math.min(2000 + 1000 * this.monitoringConnections.size, 8000);
  }

  private static doMonitoringAsync() {
    // Start each peer independently; a rejection or stalled peer cannot block
    // the other peers or prevent scheduling the next monitoring interval.
    for (const connection of this.monitoringConnections) this.update(connection);
    this.restart();
  }
}
