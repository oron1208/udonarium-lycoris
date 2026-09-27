import { Component, OnDestroy, OnInit } from '@angular/core';
import { PopupBridgeService, PopupBridgeCharacter } from 'service/popup-bridge.service';

/** palette-browser が必要な最小限の面だけを持つ、サブウィンドウ側のパレット。 */
export class PopupPalette {
  value = '';
  identifier = '';
  dicebot = 'DiceBot';
  constructor(private notify: (value: string) => void) {}
  setPalette(source: string) {
    this.value = source;
    this.notify(source);
  }
}

/**
 * ポップアウト専用サブウィンドウ（?popup=1&kind=...&owner=...）。
 * ペイン種別に応じて チャパレ / チャット / VNチャット を表示する。
 * 接続・応答の窓口はこのシェルが1つだけ持ち、各ペインはデータとイベントの入出力だけを行う。
 */
@Component({
  selector: 'popup-window',
  templateUrl: './popup-window.component.html',
  styleUrls: ['./popup-window.component.css']
})
export class PopupWindowComponent implements OnInit, OnDestroy {
  readonly kind: string;
  connected = false;
  ownerGone = false;

  // ── チャパレペイン ──
  characters: PopupBridgeCharacter[] = [];
  selected = '';
  title = '';
  palette: any = new PopupPalette(() => {});

  // ── チャットペイン ──
  chat: any = null;

  private pingTimer: any = null;
  private offMessage: () => void = null;
  private readonly sendBye = () => this.channel.post({ type: 'bye' });

  constructor(public bridge: PopupBridgeService) {
    this.kind = bridge.windowKind;
  }

  private get channel() { return this.bridge.windowChannel(); }

  ngOnInit() {
    document.title = this.kind === 'chat' ? 'チャット - ユドナリウムリコリス'
      : this.kind === 'vnchat' ? 'VNチャット - ユドナリウムリコリス'
      : 'チャパレ - ユドナリウムリコリス';
    this.offMessage = this.bridge.windowChannel().onMessage(message => this.handle(message));
    this.channel.post({ type: 'ready' });
    // 接続が切れたら再送できるよう、常時 ping を送り続ける（ごく軽い）。
    this.pingTimer = setInterval(() => this.channel.post({ type: 'ready' }), 2000);
    window.addEventListener('pagehide', this.sendBye);
  }

  ngOnDestroy() {
    window.removeEventListener('pagehide', this.sendBye);
    this.sendBye();
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.offMessage) this.offMessage();
  }

  private handle(message: any) {
    if (message.type === 'owner-bye') {
      this.connected = false;
      this.ownerGone = true;
      return;
    }
    if (message.type === 'state') {
      this.connected = true;
      this.ownerGone = false;
      const state = message.state || {};
      if (this.kind === 'palette') this.applyPaletteState(state);
      else this.chat = state;
      return;
    }
    if (message.type === 'chat-append' && this.chat) {
      if (message.tab !== this.chat.currentTab) return;
      const entries = Array.isArray(message.entries) ? message.entries : [];
      const merged = (this.chat.messages || []).concat(entries);
      this.chat = Object.assign({}, this.chat, { messages: merged.slice(-400) });
      return;
    }
    if (this.kind !== 'palette') return;
    // チャパレの state 更新は state で来るため、以降は palette ペイン専用の追加処理はない
  }

  private applyPaletteState(state: any) {
    this.characters = state.characters || [];
    this.title = state.title || '';
    this.selected = state.selected || '';
    const identifier = state.paletteIdentifier || '';
    const value = state.value || '';
    if (this.palette.identifier !== identifier) {
      // コマを切り替えたら入力参照も替えて、表示状態（タブ・開閉）を識別子ごとに読み込ませる。
      this.palette = new PopupPalette(v => this.channel.post({ type: 'edit-palette', value: v }));
      this.palette.identifier = identifier;
    }
    if (this.palette.value !== value) this.palette.value = value;
  }

  /* ── チャパレペインの操作 → メインへ中継 ── */
  selectCharacter(identifier: string) {
    this.selected = identifier;
    this.channel.post({ type: 'select-character', identifier });
  }
  choose(line: string) { this.channel.post({ type: 'choose-line', line }); }
  send(line: string) { this.channel.post({ type: 'send-line', line }); }

  /* ── チャットペインの操作 → メインへ中継 ── */
  selectTab(identifier: string) { this.channel.post({ type: 'select-tab', identifier }); }
  selectSendFrom(identifier: string) { this.channel.post({ type: 'select-sendfrom', identifier }); }
  selectChatCharacter(identifier: string) { this.channel.post({ type: 'select-character', identifier }); }
  sendChat(text: string) {
    if (this.kind === 'vnchat') this.channel.post({ type: 'send-vn-chat', text });
    else this.channel.post({ type: 'send-chat', text, sendFrom: this.chat ? this.chat.sendFrom : '' });
  }

  close() {
    this.sendBye();
    window.close();
  }
}
