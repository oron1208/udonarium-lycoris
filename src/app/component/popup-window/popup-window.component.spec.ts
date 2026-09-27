import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { PopupWindowComponent } from './popup-window.component';
import { PopupChatComponent } from '../popup-chat/popup-chat.component';
import { PaletteBrowserComponent } from '../palette-browser/palette-browser.component';
import { PopupBridgeService } from 'service/popup-bridge.service';

class ChannelStub {
  posts: any[] = [];
  private listeners = new Set<(message: any) => void>();
  supported = true;
  post(message: any) { this.posts.push(message); }
  onMessage(listener: (message: any) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(message: any) { this.listeners.forEach(listener => listener(message)); }
}

class BridgeStub {
  isWindow = true;
  windowOwner = 'palette:panel:palette-1';
  windowKind: any = 'palette';
  theme: 'normal' | 'vn' = 'normal';
  private channels = new Map<string, ChannelStub>();
  channel(owner: string): ChannelStub {
    let channel = this.channels.get(owner);
    if (!channel) { channel = new ChannelStub(); this.channels.set(owner, channel); }
    return channel;
  }
  windowChannel(): ChannelStub { return this.channel(this.windowOwner); }
}

describe('PopupWindowComponent（ポップアウト・チャパレペイン）', () => {
  let fixture: ComponentFixture<PopupWindowComponent>;
  let component: PopupWindowComponent;
  let bridge: BridgeStub;

  const state = (over: Partial<any> = {}) => ({
    type: 'state',
    state: Object.assign({
      role: 'panel',
      title: '魔窟マコ',
      characters: [
        { identifier: 'char-a', name: '魔窟マコ' },
        { identifier: 'char-b', name: '桃鬼華' }
      ],
      selected: 'char-a',
      paletteIdentifier: 'palette-1',
      value: '// @tab 戦闘\n2d6+5 命中判定'
    }, over)
  });

  beforeEach(async () => {
    bridge = new BridgeStub();
    await TestBed.configureTestingModule({
      declarations: [PopupWindowComponent, PopupChatComponent, PaletteBrowserComponent],
      imports: [FormsModule],
      providers: [{ provide: PopupBridgeService, useValue: bridge }]
    }).compileComponents();
    fixture = TestBed.createComponent(PopupWindowComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    try { localStorage.clear(); } catch (_) {}
  });

  it('起動時にメインへ準備完了を送り、定期的にpingし続ける', async () => {
    expect(bridge.windowChannel().posts.some(m => m.type === 'ready')).toBeTrue();
    await new Promise(r => setTimeout(r, 2100));
    expect(bridge.windowChannel().posts.filter(m => m.type === 'ready').length).toBeGreaterThan(1);
  });

  it('状態が来るまで待機案内を表示する', () => {
    expect(component.connected).toBeFalse();
    expect((fixture.nativeElement as HTMLElement).querySelector('.status')).toBeTruthy();
  });

  it('メインの状態でコマ一覧・タイトル・本文を表示する', () => {
    bridge.windowChannel().emit(state());
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const options = Array.from(root.querySelectorAll('option')).map(o => o.textContent.trim());
    expect(options).toContain('魔窟マコ');
    expect(options).toContain('桃鬼華');
    expect(root.querySelector('.title').textContent).toContain('魔窟マコ');
    expect(root.querySelector('.line').textContent).toContain('2d6+5');
    expect(root.querySelector('.status')).toBeNull();
  });

  it('コマを切り替えるときはメインに指示を投げ、表示はメインの状態で更新する', () => {
    bridge.windowChannel().emit(state());
    fixture.detectChanges();
    component.selectCharacter('char-b');
    expect(bridge.windowChannel().posts).toContain({ type: 'select-character', identifier: 'char-b' });
    bridge.windowChannel().emit(state({ selected: 'char-b', paletteIdentifier: 'palette-2', value: 'こんにちは' }));
    fixture.detectChanges();
    expect(component.palette.identifier).toBe('palette-2');
    expect(component.palette.value).toBe('こんにちは');
  });

  it('クリックで入力・ダブルクリックで送信をメインへ投げる', () => {
    bridge.windowChannel().emit(state());
    fixture.detectChanges();
    const line = (fixture.nativeElement as HTMLElement).querySelector('.line') as HTMLElement;
    line.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(bridge.windowChannel().posts.some(m => m.type === 'choose-line' && /2d6\+5/.test(m.line))).toBeTrue();
    line.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(bridge.windowChannel().posts.some(m => m.type === 'send-line' && /2d6\+5/.test(m.line))).toBeTrue();
  });

  it('サブウィンドウ内の編集をメインへ送る', () => {
    bridge.windowChannel().emit(state());
    fixture.detectChanges();
    component.palette.setPalette('// @tab 戦闘\n2d6+6 上昇後');
    expect(component.palette.value).toContain('2d6+6');
    expect(bridge.windowChannel().posts.some(m => m.type === 'edit-palette' && /2d6\+6/.test(m.value))).toBeTrue();
    const before = bridge.windowChannel().posts.filter(m => m.type === 'edit-palette').length;
    bridge.windowChannel().emit(state({ value: '// @tab 戦闘\n2d6+6 上昇後' }));
    expect(bridge.windowChannel().posts.filter(m => m.type === 'edit-palette').length).toBe(before);
  });

  it('閉じるときに別れの挨拶を送る', () => {
    spyOn(window, 'close');
    component.close();
    expect(bridge.windowChannel().posts.some(m => m.type === 'bye')).toBeTrue();
  });

  it('オーナーがいなくなったら切断案内を出し、再接続で戻る', () => {
    bridge.windowChannel().emit(state());
    fixture.detectChanges();
    bridge.windowChannel().emit({ type: 'owner-bye' });
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(component.ownerGone).toBeTrue();
    expect(root.querySelector('.status').textContent).toContain('切断');
    bridge.windowChannel().emit(state());
    fixture.detectChanges();
    expect(component.ownerGone).toBeFalse();
    expect(component.connected).toBeTrue();
  });

  it('VNで開いたときは黒テーマの装飾を付ける', () => {
    bridge.theme = 'vn';
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.vn-palette-theme')).toBeTruthy();
    expect((fixture.nativeElement as HTMLElement).querySelector('.window.vn')).toBeTruthy();
  });

  it('kind=chatのときはチャットペインを表示し、送信をメインへ中継する', () => {
    bridge.windowKind = 'chat';
    const chatFixture = TestBed.createComponent(PopupWindowComponent);
    chatFixture.detectChanges();
    bridge.windowChannel().emit({
      type: 'state',
      state: {
        mode: 'chat', title: 'メイン',
        tabs: [{ id: 'tab-1', name: 'メイン' }],
        currentTab: 'tab-1',
        characters: [{ identifier: 'char-a', name: '魔窟マコ' }],
        sendFrom: 'me', sendFromName: 'おれおん',
        gameType: 'DiceBot',
        messages: [{ name: '魔窟マコ', text: 'こんにちは', timestamp: 1, isMine: false }]
      }
    });
    chatFixture.detectChanges();
    const root = chatFixture.nativeElement as HTMLElement;
    expect(root.querySelector('popup-chat')).toBeTruthy();
    expect((root.querySelector('.tab.active') as HTMLElement).textContent).toContain('メイン');
    expect((root.querySelector('.entry .text') as HTMLElement).textContent).toContain('こんにちは');
    chatFixture.componentInstance.sendChat('こんばんは');
    expect(bridge.windowChannel().posts).toContain({ type: 'send-chat', text: 'こんばんは', sendFrom: 'me' });
    chatFixture.destroy();
  });

  it('kind=vnchatのときは送信をVNチャット用メッセージで中継する', () => {
    bridge.windowKind = 'vnchat';
    const vnFixture = TestBed.createComponent(PopupWindowComponent);
    vnFixture.detectChanges();
    bridge.windowChannel().emit({
      type: 'state',
      state: { mode: 'vnchat', title: 'VNチャット', tabs: [], currentTab: '', characters: [], messages: [] }
    });
    vnFixture.componentInstance.sendChat('台詞');
    expect(bridge.windowChannel().posts).toContain({ type: 'send-vn-chat', text: '台詞' });
    vnFixture.destroy();
  });

  it('chat-appendは現在タブの分だけ末尾に追記する', () => {
    bridge.windowKind = 'chat';
    const chatFixture = TestBed.createComponent(PopupWindowComponent);
    chatFixture.detectChanges();
    const base = {
      mode: 'chat', title: 'メイン', tabs: [{ id: 'tab-1', name: 'メイン' }], currentTab: 'tab-1',
      characters: [], sendFrom: 'me', sendFromName: '自分', gameType: 'DiceBot', messages: []
    };
    bridge.windowChannel().emit({ type: 'state', state: base });
    chatFixture.detectChanges();
    bridge.windowChannel().emit({ type: 'chat-append', tab: 'tab-1', entries: [{ name: 'A', text: '1', timestamp: 2 }] });
    bridge.windowChannel().emit({ type: 'chat-append', tab: 'tab-2', entries: [{ name: 'B', text: '他タブ', timestamp: 3 }] });
    chatFixture.detectChanges();
    const chat = chatFixture.componentInstance.chat;
    expect(chat.messages.length).toBe(1);
    expect(chat.messages[0].text).toBe('1');
    chatFixture.destroy();
  });
});
