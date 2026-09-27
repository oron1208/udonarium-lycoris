import { AfterViewChecked, Component, ElementRef, Input, OnChanges, Output, EventEmitter, ViewChild } from '@angular/core';

/**
 * ポップアウトウィンドウ内のチャットペイン（メインチャット / VNチャット共用）。
 * ログ表示・タブ切替・送信だけを行い、実際の送信はメイン画面のオーナーが行う。
 */
@Component({
  selector: 'popup-chat',
  templateUrl: './popup-chat.component.html',
  styleUrls: ['./popup-chat.component.css']
})
export class PopupChatComponent implements OnChanges, AfterViewChecked {
  @Input() state: any = null;
  @Input() connected = false;
  @Input() vn = false;
  @Output() selectTab = new EventEmitter<string>();
  @Output() selectSendFrom = new EventEmitter<string>();
  @Output() selectCharacter = new EventEmitter<string>();
  @Output() sendText = new EventEmitter<string>();

  @ViewChild('logContainer', { static: false }) logContainer: ElementRef;

  draft = '';
  private scrollPending = false;

  ngOnChanges() { this.scrollPending = true; }
  ngAfterViewChecked() {
    if (!this.scrollPending) return;
    this.scrollPending = false;
    const element = this.logContainer ? this.logContainer.nativeElement as HTMLElement : null;
    if (element) element.scrollTop = element.scrollHeight;
  }

  get tabs(): any[] { return this.state ? (this.state.tabs || []) : []; }
  get messages(): any[] { return this.state ? (this.state.messages || []) : []; }
  get characters(): any[] { return this.state ? (this.state.characters || []) : []; }
  get currentTab(): string { return this.state ? (this.state.currentTab || '') : ''; }
  get sendFrom(): string { return this.state ? (this.state.sendFrom || '') : ''; }
  get sendFromName(): string { return this.state ? (this.state.sendFromName || '自分') : '自分'; }
  get selectedCharacter(): string { return this.state ? (this.state.selectedCharacter || '') : ''; }
  get gameType(): string { return this.state ? (this.state.gameType || 'DiceBot') : 'DiceBot'; }

  onKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.submit();
    }
  }

  submit() {
    const text = (this.draft || '').trim();
    if (!text || !this.connected) return;
    this.sendText.emit(text);
    this.draft = '';
  }

  characterName(identifier: string): string {
    const character = this.characters.find(c => c.identifier === identifier);
    return character ? character.name : '';
  }

  secretLabel(entry: any): string { return '🔒 シークレット（内容は本人のみ表示）'; }

  trackByTab(index: number, tab: any) { return tab.id; }
  trackByMessage(index: number, entry: any) { return (entry.timestamp || 0) + '.' + index; }
}
