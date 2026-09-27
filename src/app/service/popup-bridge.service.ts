import { Injectable, NgZone, OnDestroy } from '@angular/core';

export type PopupPaneKind = 'palette' | 'chat' | 'vnchat';

export interface PopupBridgeCharacter {
  identifier: string;
  name: string;
}

export interface PopupOpenOptions {
  theme?: 'normal' | 'vn';
  width?: number;
  height?: number;
}

/**
 * オーナー（メイン画面側の応答コンポーネント）1つに紐づく BroadcastChannel ラッパー。
 * 同じ origin 内だけで動き、通信・同期系には一切触らない。
 */
export class PopupChannel {
  private channel: BroadcastChannel = null;
  private listeners = new Set<(message: any) => void>();

  constructor(readonly owner: string, private zone: NgZone) {
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(`lycoris-popup-v2:${owner}`);
      this.channel.onmessage = (event: MessageEvent) => {
        const message = event.data;
        if (!message || typeof message.type !== 'string') return;
        this.zone.run(() => this.listeners.forEach(listener => listener(message)));
      };
    }
  }

  get supported(): boolean { return this.channel !== null; }

  onMessage(listener: (message: any) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  post(message: any): void {
    if (this.channel) this.channel.postMessage(message);
  }

  destroy(): void {
    if (this.channel) this.channel.close();
    this.channel = null;
    this.listeners.clear();
  }
}

/**
 * ポップアウト（別ウィンドウ）共通ブリッジ。
 *
 * - メイン側: openPopup() でサブウィンドウを開き、claimServe() でオーナー権を取得して応答する
 * - サブ側: ?popup=1&kind=...&owner=... で起動し、windowChannel() で自分のオーナーとだけ繋ぐ
 *
 * オーナーIDごとに独立チャンネルを持つため、複数チャパレ・VN/通常の同時ポップアウトが競合しない。
 */
@Injectable({ providedIn: 'root' })
export class PopupBridgeService implements OnDestroy {
  /** サブウィンドウとして起動したか（?popup=1） */
  readonly isWindow: boolean;
  /** サブウィンドウ専用: 自分のオーナーID */
  readonly windowOwner: string;
  /** サブウィンドウ専用: ペイン種別 */
  readonly windowKind: PopupPaneKind;
  readonly theme: 'normal' | 'vn';

  private channels = new Map<string, PopupChannel>();
  /** ownerId -> serve 権トークン。後から claim したインスタンスが権利を奪う。 */
  private serveTokens = new Map<string, object>();

  constructor(private zone: NgZone) {
    const params = new URLSearchParams(window.location.search);
    this.isWindow = params.get('popup') === '1';
    this.windowOwner = this.isWindow ? (params.get('owner') || '') : '';
    const kind = params.get('kind');
    this.windowKind = kind === 'chat' || kind === 'vnchat' ? kind : 'palette';
    this.theme = params.get('theme') === 'vn' ? 'vn' : 'normal';
  }

  ngOnDestroy() {
    this.channels.forEach(channel => channel.destroy());
    this.channels.clear();
    this.serveTokens.clear();
  }

  /** オーナーIDに紐づくチャンネルを取得（なければ作成）。メイン・サブどちらからでも使える。 */
  channel(owner: string): PopupChannel {
    if (!owner) return null;
    let channel = this.channels.get(owner);
    if (!channel) {
      channel = new PopupChannel(owner, this.zone);
      this.channels.set(owner, channel);
    }
    return channel;
  }

  /** サブウィンドウのチャンネル（自分のオーナー宛）。メイン画面では null。 */
  windowChannel(): PopupChannel {
    return this.isWindow ? this.channel(this.windowOwner) : null;
  }

  /**
   * オーナー権を要求する。同じオーナーIDを後から claim したコンポーネントが優先され、
   * 先のコンポーネントは自動的に応答権を失う（二重送信・二重 state を防ぐ）。
   */
  claimServe(owner: string): object {
    const token = {};
    this.serveTokens.set(owner, token);
    return token;
  }

  /** claim した権利を手放す（パネル破棄時など）。 */
  releaseServe(owner: string, token: object): void {
    if (this.serveTokens.get(owner) === token) this.serveTokens.delete(owner);
  }

  /** このトークンが今もオーナー権を持っているか。 */
  isServing(owner: string, token: object): boolean {
    return token != null && this.serveTokens.get(owner) === token;
  }

  /** サブウィンドウを開く。オーナーIDごとに別ウィンドウになる。 */
  openPopup(kind: PopupPaneKind, owner: string, options: PopupOpenOptions = {}): void {
    if (!owner) return;
    const params = new URLSearchParams({ popup: '1', kind, owner });
    if (options.theme === 'vn') params.set('theme', 'vn');
    const url = window.location.origin + window.location.pathname + '?' + params.toString();
    const width = options.width || 560;
    const height = options.height || 800;
    const windowName = 'lycoris-pop-' + owner.replace(/[^a-zA-Z0-9_-]/g, '_');
    window.open(url, windowName, `width=${width},height=${height}`);
  }
}
