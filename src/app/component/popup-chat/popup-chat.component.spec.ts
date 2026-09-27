import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { PopupChatComponent } from './popup-chat.component';

describe('PopupChatComponent（ポップアウト・チャットペイン）', () => {
  let fixture: ComponentFixture<PopupChatComponent>;
  let component: PopupChatComponent;

  const baseState = {
    mode: 'chat',
    title: 'メイン',
    tabs: [{ id: 'tab-1', name: 'メイン' }, { id: 'tab-2', name: 'ネタバレ' }],
    currentTab: 'tab-1',
    characters: [{ identifier: 'char-a', name: '魔窟マコ' }, { identifier: 'char-b', name: '桃鬼華' }],
    sendFrom: 'me-1',
    sendFromName: 'おれおん',
    selectedCharacter: 'char-a',
    gameType: 'SwordWorld2.5',
    messages: [
      { name: '魔窟マコ', text: 'こんにちは', timestamp: 1, messColor: '', isSystem: false, isDicebot: false, isSecret: false, secretVisible: true, isMine: false },
      { name: '', text: '2d6 → 7', timestamp: 2, messColor: '', isSystem: true, isDicebot: true, isSecret: false, secretVisible: true, isMine: false },
      { name: 'GM', text: '内緒の話', timestamp: 3, messColor: '', isSystem: false, isDicebot: false, isSecret: true, secretVisible: false, isMine: false }
    ]
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [PopupChatComponent],
      imports: [FormsModule]
    }).compileComponents();
    fixture = TestBed.createComponent(PopupChatComponent);
    component = fixture.componentInstance;
    component.state = baseState;
    component.connected = true;
    fixture.detectChanges();
  });

  it('タブ・メッセージ・発言者を表示する', () => {
    const root = fixture.nativeElement as HTMLElement;
    const tabs = Array.from(root.querySelectorAll('.tab')).map(t => t.textContent.trim());
    expect(tabs).toContain('メイン');
    expect(tabs).toContain('ネタバレ');
    expect(root.querySelectorAll('.entry').length).toBe(3);
    expect(root.querySelector('.entry.dicebot .text').textContent).toContain('2d6');
    expect(root.querySelector('select.send-from option:checked').textContent).toContain('おれおん');
  });

  it('他人のシークレットは内容を伏せる', () => {
    const root = fixture.nativeElement as HTMLElement;
    const secret = root.querySelectorAll('.entry')[2];
    expect(secret.querySelector('.secret-hidden')).toBeTruthy();
    expect(secret.textContent).toContain('シークレット');
    expect(secret.textContent).not.toContain('内緒の話');
  });

  it('タブ切替と発言者変更をemitする', () => {
    const tabs: string[] = [];
    const senders: string[] = [];
    component.selectTab.subscribe(id => tabs.push(id));
    component.selectSendFrom.subscribe(id => senders.push(id));
    const root = fixture.nativeElement as HTMLElement;
    (root.querySelectorAll('.tab')[1] as HTMLElement).click();
    expect(tabs).toEqual(['tab-2']);
    const select = root.querySelector('.composer-row select') as HTMLSelectElement;
    select.value = 'char-a';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(senders).toContain('char-a');
  });

  it('Enterで送信して入力を空にする・Shift+Enterは改行扱い', () => {
    const sent: string[] = [];
    component.sendText.subscribe(text => sent.push(text));
    component.draft = '攻撃する';
    component.onKeydown(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(sent).toEqual(['攻撃する']);
    expect(component.draft).toBe('');
    component.draft = '途中';
    component.onKeydown(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }));
    expect(sent.length).toBe(1);
    expect(component.draft).toBe('途中');
  });

  it('未接続・空入力では送信しない', () => {
    const sent: string[] = [];
    component.sendText.subscribe(text => sent.push(text));
    component.draft = '  ';
    component.submit();
    expect(sent.length).toBe(0);
    component.connected = false;
    component.draft = '本文';
    component.submit();
    expect(sent.length).toBe(0);
  });

  it('VNモードではキャラ選択に切り替わる', () => {
    component.vn = true;
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const select = root.querySelector('.composer-row select') as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(Array.from(select.options).some(o => o.textContent.includes('魔窟マコ'))).toBeTrue();
    const picked: string[] = [];
    component.selectCharacter.subscribe(id => picked.push(id));
    select.value = 'char-b';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(picked).toContain('char-b');
  });
});
