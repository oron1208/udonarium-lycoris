import { Logger } from '../util/logger';

/** The relay server of this origin, unless the configuration names one. */
export function defaultSignalingUrl(): string {
  let protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return protocol + '//' + location.host + '/signaling';
}

/**
 * A room that chose P2P is carried by SkyWay from member to member, but it still has to be found in the
 * lobby, which is the server's. This socket only announces the member there. No room data passes through it.
 */
export class RoomBeacon {
  private socket: WebSocket = null;
  private reconnectTimer: any = null;
  private attempts = 0;
  private closed = false;

  constructor(
    private url: string,
    private peerId: string,
    private onRefused: (message: any) => void = () => { },
  ) { }

  open() {
    this.closed = false;
    this.openSocket();
  }

  close() {
    this.closed = true;
    this.clearReconnectTimer();
    if (this.socket) this.socket.close();
    this.socket = null;
  }

  private openSocket() {
    if (this.closed) return;
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      socket.send(JSON.stringify({ type: 'register', id: this.peerId, mode: 'p2p' }));
    });
    socket.addEventListener('message', event => {
      if (this.socket !== socket) return;
      let message: any;
      try {
        message = JSON.parse(event.data);
      } catch (_) { return; }
      if (message.type === 'registered') {
        this.attempts = 0;
        return;
      }
      if (message.type === 'error') {
        // The room is carried the other way: there is nothing to announce here.
        Logger.warn('[RoomBeacon] ' + (message.errorType || 'error') + ': ' + (message.message || ''));
        this.close();
        this.onRefused(message);
      }
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.closed || this.reconnectTimer != null) return;
      const delay = Math.min(30000, 1000 * Math.pow(1.6, this.attempts++));
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.openSocket(); }, delay);
    });
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer == null) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}
