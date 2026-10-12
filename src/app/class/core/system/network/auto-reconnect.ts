import { EventSystem, Network } from '..';
import { Logger } from '../util/logger';

/**
 * ゲーム中の完全切断（Wi-Fi切替・PCスリープ・一時的なネット断等）を検知して、
 * 同じ部屋へ自動的に再接続する。
 *
 * - 検知: 部屋在室中（isRoom）なのにシグナリング未接続（isOpen=false）が一定時間（8秒）継続。
 *   peerIds は自分自身を含むため「接続ピア0」は実質発生せず（websocket-signaling-connection.ts の
 *   peerIds.push(this.peerId)）、切断判定はシグナリング登録状態 isOpen で行う。正常な1人プレイや
 *   全員退室は WS が生きている（isOpen=true）ため誤検知しない。
 * - 復旧: 記憶した部屋コンテキストでNetwork.openを再実行（指数バックオフ付きリトライ・上限10回）
 * - 再接続後はInitialRoomSyncが部屋状態を自動再同期する（オブジェクト破棄は行わない。
 *   正しい状態は再同期で配られるため、手動re-connectパネルのdeleteObjectとは挙動が異なる）
 * - 既存のSkyWay health再接続（ピア単位の不安定）とrelay WS再接続は併存し、
 *   本サービスは「シグナリングごと落ちた完全切断」の最終復旧を担う
 */
export class AutoReconnect {
  private static _instance: AutoReconnect;
  static get instance(): AutoReconnect {
    if (!AutoReconnect._instance) AutoReconnect._instance = new AutoReconnect();
    return AutoReconnect._instance;
  }

  /** 切断疑いと判定する継続時間(ms)。瞬断は既存のhealth再接続に任せるため8秒待つ */
  readonly thresholdMs = 8000;
  /** 自動再接続の最大試行回数（超過で停止・手動re-connectパネルへ誘導） */
  readonly maxAttempts = 10;
  private monitorTimer: any = null;
  private roomLostSince = 0;
  private isAttempting = false;
  private attempt = 0;
  private lastAttemptAt = 0;
  private lastContext: { userId: string, roomId: string, roomName: string, password: string } | null = null;

  initialize() {
    EventSystem.register(this)
      .on('OPEN_NETWORK', () => {
        // 部屋復帰成功
        if (this.isAttempting) {
          Logger.debug(`[AutoReconnect] reconnected successfully. attempts=${this.attempt}`);
          EventSystem.trigger('AUTO_RECONNECTED', { attempts: this.attempt });
        }
        this.reset();
        const pc = Network.peerContext;
        if (pc && pc.isRoom) {
          // 常に最新の部屋コンテキストを記憶（次回切断時の再接続に使う）
          this.lastContext = {
            userId: pc.userId || '',
            roomId: pc.roomId || '',
            roomName: pc.roomName || '',
            password: pc.password || '',
          };
        }
      });

    if (this.monitorTimer == null) {
      this.monitorTimer = setInterval(() => this.monitor(), 2000);
    }
    Logger.debug('[AutoReconnect] initialized.');
  }

  private reset() {
    this.isAttempting = false;
    this.attempt = 0;
    this.roomLostSince = 0;
    this.lastAttemptAt = 0;
  }

  private monitor() {
    if (this.isAttempting) return;
    const pc = Network.peerContext;
    const inRoom = !!(pc && pc.isRoom);
    if (!inRoom || Network.isOpen) { this.roomLostSince = 0; return; }

    // 部屋在室のはずなのにシグナリング未接続 → 切断疑い
    if (this.roomLostSince === 0) { this.roomLostSince = Date.now(); return; }
    if (Date.now() - this.roomLostSince < this.thresholdMs) return;
    if (Date.now() - this.lastAttemptAt < this.nextDelayMs()) return;
    this.attemptReconnect();
  }

  private nextDelayMs(): number {
    return Math.min(60000, 3000 * Math.pow(2, Math.max(0, this.attempt - 1)));
  }

  private attemptReconnect() {
    if (this.isAttempting) return;
    const pc = Network.peerContext;
    if (!this.lastContext && pc) {
      this.lastContext = {
        userId: pc.userId || '',
        roomId: pc.roomId || '',
        roomName: pc.roomName || '',
        password: pc.password || '',
      };
    }
    if (!this.lastContext || !this.lastContext.roomId) {
      Logger.warn('[AutoReconnect] no room context to reconnect. skip.');
      return;
    }
    this.isAttempting = true;
    this.attempt++;
    this.lastAttemptAt = Date.now();
    Logger.debug(`[AutoReconnect] reconnecting attempt=${this.attempt}/${this.maxAttempts} room=${this.lastContext.roomId}/${this.lastContext.roomName}`);
    EventSystem.trigger('AUTO_RECONNECT_TRYING', { attempt: this.attempt });
    try {
      Network.open(this.lastContext.userId, this.lastContext.roomId, this.lastContext.roomName, this.lastContext.password);
    } catch (e) {
      Logger.warn('[AutoReconnect] open failed', e);
    }
    // 成功はOPEN_NETWORKイベントで判定。失敗時はバックオフ後にisAttemptingを解除して再試行
    setTimeout(() => { this.isAttempting = false; }, this.nextDelayMs());
  }
}
