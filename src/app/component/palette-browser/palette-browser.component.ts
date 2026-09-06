import { Component, DoCheck, ElementRef, EventEmitter, Input, OnChanges, OnDestroy, Output } from '@angular/core';
import { ChatPalette } from '@udonarium/chat-palette';
import { flattenPalette, isPaletteCommand, isPaletteDragItem, movePaletteItem, PaletteNode, PaletteSection, parsePaletteDocument } from '@udonarium/palette-document';

@Component({
  selector: 'palette-browser',
  templateUrl: './palette-browser.component.html',
  styleUrls: ['./palette-browser.component.css']
})
export class PaletteBrowserComponent implements OnChanges, DoCheck, OnDestroy {
  @Input() palette: ChatPalette;
  @Output() chooseLine = new EventEmitter<string>();
  @Output() sendLine = new EventEmitter<string>();
  private static readonly dragMime = 'application/x-lycoris-palette-item';
  private static drag: { id: string; owner: PaletteBrowserComponent; palette: ChatPalette; source: string; start: number; end: number; text: string } = null;
  dropHint: { key: string; position: number; source: string; placement: string; label: string } = null;
  insertInside = false;
  private suppressClickUntil = 0;
  query = '';
  active = -2; // all; -1 is the implicit common section
  selected = -1;
  collapsed = new Set<number>();
  managing = false;
  form = '';
  name = '';
  body = '';
  error = '';
  notice = '';
  private base = '';
  private target: PaletteNode | PaletteSection = null;
  private cachedSource: string = null;
  private cachedDocument = parsePaletteDocument('');
  private stateKey = '';

  constructor(private host: ElementRef<HTMLElement>) {}
  ngOnDestroy() { if (PaletteBrowserComponent.drag?.owner === this) PaletteBrowserComponent.drag = null; }
  ngDoCheck() {
    if (this.cachedSource !== null && this.cachedSource !== this.source) {
      // Line numbers are not stable after someone else edits the shared text.
      this.selected = -1;
      this.active = -2;
      this.collapsed.clear();
    }
  }
  ngOnChanges() {
    const key = 'lycoris-palette-view:' + (this.palette?.identifier || '');
    if (key === this.stateKey) return;
    this.stateKey = key;
    this.active = -2;
    this.selected = -1;
    this.collapsed.clear();
    this.cancel();
    try {
      const state = JSON.parse(localStorage.getItem(key) || 'null');
      if (state && state.source === this.source) {
        this.active = state.active;
        this.collapsed = new Set(state.collapsed);
      }
    } catch (_) { /* Storage unavailable: in-memory view still works. */ }
  }
  get source(): string { return String(this.palette?.value ?? ''); }
  get document() {
    if (this.cachedSource !== this.source) {
      this.cachedSource = this.source;
      this.cachedDocument = parsePaletteDocument(this.source);
    }
    return this.cachedDocument;
  }
  get tabs(): PaletteSection[] { return this.document.tabs.filter(t => t.start >= 0 || t.children.some(n => n.text.trim())); }
  get activeTab(): PaletteSection { return this.document.tabs.find(t => t.start === this.active); }
  get visibleTabs(): PaletteSection[] {
    return this.query.trim() || this.active === -2 || !this.activeTab ? this.tabs : [this.activeTab];
  }
  get selectedNode(): PaletteNode {
    const find = (nodes: PaletteNode[]): PaletteNode => {
      for (const node of nodes) {
        if (node.start === this.selected) return node;
        const child = find(node.children);
        if (child) return child;
      }
      return null;
    };
    for (const tab of this.document.tabs) { const node = find(tab.children); if (node) return node; }
    return null;
  }
  matches(node: PaletteNode): boolean {
    const q = this.query.trim().toLocaleLowerCase();
    return !q || node.text.toLocaleLowerCase().includes(q) || node.children.some(n => this.matches(n));
  }
  command(line: string): boolean { return isPaletteCommand(line); }
  selectTab(start: number) { this.active = start; this.selected = -1; this.saveView(); }
  toggle(node: PaletteNode) {
    if (Date.now() < this.suppressClickUntil) return;
    this.selected = node.start;
    if (this.collapsed.has(node.start)) this.collapsed.delete(node.start); else this.collapsed.add(node.start);
    this.saveView();
  }
  choose(node: PaletteNode) { if (Date.now() < this.suppressClickUntil) return; this.selected = node.start; if (this.command(node.text)) this.chooseLine.emit(node.text); }
  send(node: PaletteNode) { if (Date.now() < this.suppressClickUntil) return; if (this.command(node.text)) this.sendLine.emit(node.text); }
  expandAll(collapse: boolean) {
    this.collapsed.clear();
    const visit = (nodes: PaletteNode[]) => nodes.forEach(n => { if (collapse && n.kind === 'fold') this.collapsed.add(n.start); visit(n.children); });
    this.document.tabs.forEach(t => visit(t.children));
    this.saveView();
  }
  private saveView() {
    try { localStorage.setItem(this.stateKey, JSON.stringify({ source: this.source, active: this.active, collapsed: Array.from(this.collapsed) })); } catch (_) {}
  }
  jumpToLine(line: number) {
    this.query = '';
    this.active = -2;
    this.collapsed.clear();
    this.selected = line;
    setTimeout(() => this.host.nativeElement.querySelector('[data-palette-line="' + line + '"]')?.scrollIntoView({ block: 'center' }));
  }
  begin(action: string) {
    this.base = this.source;
    this.insertInside = false;
    this.form = action;
    this.error = '';
    this.notice = '';
    this.name = '';
    this.body = '';
    this.target = action.includes('tab') && action !== 'add-tab' ? this.activeTab : this.selectedNode;
    if (action === 'rename-tab') this.name = (this.target as PaletteSection)?.name || '';
    if (action === 'edit-node' && this.target) {
      const node = this.target as PaletteNode;
      if (node.kind === 'fold') {
        this.name = node.text;
        this.body = this.document.lines.slice(node.start + 1, node.closed ? node.end - 1 : node.end).join('\n');
      } else this.body = node.text;
    }
    if (action === 'source') this.body = this.base;
  }
  cancel() { this.form = ''; this.error = ''; }
  get needsName(): boolean { return ['add-tab', 'rename-tab', 'add-fold'].includes(this.form) || (this.form === 'edit-node' && (this.target as PaletteNode)?.kind === 'fold'); }
  get needsBody(): boolean { return ['add-fold', 'add-lines', 'edit-node', 'source'].includes(this.form); }
  get formTitle(): string {
    return ({ 'add-tab': 'タブを追加', 'rename-tab': 'タブ名を変更', 'add-fold': '折りたたみを追加', 'add-lines': '行・説明文を追加', 'edit-node': '選択項目を編集', source: '全文テキストを編集', 'delete-tab': 'タブと中身を削除', 'delete-node': '選択項目と中身を削除' })[this.form] || '';
  }
  get canInsertInside(): boolean { return (this.form ? this.target as PaletteNode : this.selectedNode)?.kind === 'fold'; }
  get insertionLabel(): string {
    const node = this.form ? this.target as PaletteNode : this.selectedNode;
    if (node) return this.insertInside && node.kind === 'fold' ? '「' + node.text + '」の中' : '選択項目「' + (node.text || '空行') + '」の直下（折りたたみは中身の後）';
    return this.activeTab ? '「' + this.activeTab.name + '」の末尾' : '共通欄の末尾（タブを選ぶとそのタブに追加）';
  }
  private commit(lines: string[]): boolean {
    if (this.source !== this.base) { this.error = '編集中に本文が更新されました。入力内容を控えてから、キャンセルして開き直してください。'; return false; }
    this.palette.setPalette(lines.join('\n'));
    this.cachedSource = this.source;
    this.cachedDocument = parsePaletteDocument(this.source);
    this.collapsed.clear();
    this.selected = -1;
    this.saveView();
    this.cancel();
    return true;
  }
  save() {
    if (this.needsName && (!this.name.trim() || /[\r\n]/.test(this.name))) { this.error = '名前を1行で入力してください。'; return; }
    const lines = this.base.split(/\r?\n/);
    const title = this.name.trim();
    let nextActive = this.active;
    if (this.form === 'source') { nextActive = -2; lines.splice(0, lines.length, ...this.body.split(/\r?\n/)); }
    else if (this.form === 'add-tab') { nextActive = lines.length; lines.push('// @tab ' + title); }
    else if (this.form === 'rename-tab' && this.target) lines[this.target.start] = '// @tab ' + title;
    else if (this.form === 'delete-tab' && this.target) { lines.splice(this.target.start, this.target.end - this.target.start); nextActive = -2; }
    else if (this.form === 'delete-node' && this.target) lines.splice(this.target.start, this.target.end - this.target.start);
    else if (this.form === 'edit-node' && this.target) {
      const node = this.target as PaletteNode;
      const replacement = this.body.split(/\r?\n/);
      if (node.kind === 'fold') replacement.splice(0, 0, '// @fold ' + title);
      if (node.kind === 'fold') replacement.push('// @end');
      lines.splice(node.start, node.end - node.start, ...replacement);
    } else if (this.form === 'add-fold' || this.form === 'add-lines') {
      const node = this.target as PaletteNode;
      const pos = node ? (node.kind === 'fold' && this.insertInside ? node.start + 1 : node.end) : (this.activeTab || this.document.tabs[0]).end;
      const addition = this.body ? this.body.split(/\r?\n/) : [];
      if (this.form === 'add-fold') { addition.unshift('// @fold ' + title); addition.push('// @end'); }
      if (!addition.length) { this.error = '本文を入力してください。'; return; }
      lines.splice(pos, 0, ...addition);
    }
    if (this.commit(lines)) { this.active = nextActive; this.saveView(); }
  }
  unwrap() {
    this.base = this.source;
    const lines = this.document.lines.slice();
    const node = this.selectedNode;
    if (node?.kind === 'fold') {
      if (node.closed) lines.splice(node.end - 1, 1);
      lines.splice(node.start, 1);
    } else if (this.activeTab?.start >= 0) lines.splice(this.activeTab.start, 1);
    else return;
    if (this.commit(lines)) { this.active = -2; this.saveView(); }
  }
  moveTab(direction: number) {
    const tabs = this.document.tabs.filter(t => t.start >= 0);
    const i = tabs.findIndex(t => t.start === this.active);
    if (i < 0 || !tabs[i + direction]) return;
    this.base = this.source;
    const a = tabs[Math.min(i, i + direction)], b = tabs[Math.max(i, i + direction)];
    const lines = this.document.lines.slice();
    const first = lines.slice(a.start, a.end), second = lines.slice(b.start, b.end);
    lines.splice(a.start, b.end - a.start, ...second, ...first);
    if (this.commit(lines)) { this.active = direction < 0 ? a.start : a.start + second.length; this.saveView(); }
  }
  startDrag(event: DragEvent, node: PaletteNode) {
    event.stopPropagation();
    if (this.form || !event.dataTransfer) { event.preventDefault(); return; }
    const text = this.document.lines.slice(node.start, node.end).join('\n');
    if (!isPaletteDragItem(text)) {
      event.preventDefault();
      this.notice = '折りたたみの区切りが閉じていないため移動できません。先に全文編集で区切りを確認してください。';
      return;
    }
    const id = Date.now() + ':' + Math.random();
    PaletteBrowserComponent.drag = { id, owner: this, palette: this.palette, source: this.source, start: node.start, end: node.end, text };
    event.dataTransfer.setData(PaletteBrowserComponent.dragMime, JSON.stringify({ version: 1, id, text }));
    event.dataTransfer.effectAllowed = 'copyMove';
    this.selected = node.start;
    this.notice = '';
    this.suppressClickUntil = Date.now() + 60000;
  }
  endDrag(event?: DragEvent) {
    event?.stopPropagation();
    const owner = PaletteBrowserComponent.drag?.owner;
    if (owner) owner.suppressClickUntil = Date.now() + 300;
    PaletteBrowserComponent.drag = null;
    this.suppressClickUntil = Date.now() + 300;
    this.dropHint = null;
  }
  private isPaletteDrag(event: DragEvent): boolean {
    return !this.form && !!event.dataTransfer && Array.from(event.dataTransfer.types).includes(PaletteBrowserComponent.dragMime);
  }
  private sameDragPalette(): boolean {
    const drag = PaletteBrowserComponent.drag;
    return !!drag && drag.palette.identifier === this.palette.identifier;
  }
  private offerDrop(event: DragEvent, key: string, position: number, placement: string) {
    if (!this.isPaletteDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const copy = !this.sameDragPalette() || event.ctrlKey || event.altKey;
    event.dataTransfer.dropEffect = copy ? 'copy' : 'move';
    this.dropHint = { key, position, placement, source: this.source, label: (copy ? 'コピー' : '移動') + '：' + ({ before: 'この上', after: 'この下', inside: 'この折りたたみの中', end: 'このタブの末尾' })[placement] };
    // Native autoscroll varies with nested panels; help the palette's scroll box.
    const rows = this.host.nativeElement.querySelector('.rows');
    if (rows) {
      const box = rows.getBoundingClientRect();
      if (event.clientY < box.top + 28) rows.scrollTop -= 12;
      else if (event.clientY > box.bottom - 28) rows.scrollTop += 12;
    }
  }
  dragOverNode(event: DragEvent, node: PaletteNode) {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const ratio = box.height ? (event.clientY - box.top) / box.height : .5;
    const placement = node.kind === 'fold' ? (ratio < .25 ? 'before' : ratio > .75 ? 'after' : 'inside') : ratio < .5 ? 'before' : 'after';
    this.offerDrop(event, 'node:' + node.start, placement === 'before' ? node.start : placement === 'inside' ? node.start + 1 : node.end, placement);
  }
  dragOverTab(event: DragEvent, tab: PaletteSection) {
    this.offerDrop(event, 'tab:' + tab.start, tab.end, 'end');
  }
  leaveDrop(event: DragEvent) {
    if ((event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) return;
    this.dropHint = null;
  }
  receiveDrop(event: DragEvent, key: string) {
    if (!this.isPaletteDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const hint = this.dropHint;
    const drag = PaletteBrowserComponent.drag;
    try {
      if (!hint || hint.key !== key || hint.source !== this.source) {
        this.notice = 'ドロップ先が更新されました。内容を確認してもう一度ドラッグしてください。'; return;
      }
      const payload = JSON.parse(event.dataTransfer.getData(PaletteBrowserComponent.dragMime));
      if (payload?.version !== 1 || typeof payload.text !== 'string' || !isPaletteDragItem(payload.text)) {
        this.notice = 'この項目は取り込めません。'; return;
      }
      // Only a verified in-page source is ever removed. Other windows copy only.
      const local = drag && drag.id === payload.id && drag.text === payload.text;
      if (local && drag.palette.value !== drag.source) {
        this.notice = 'ドラッグ元が更新されました。もう一度ドラッグしてください。'; return;
      }
      const same = local && this.sameDragPalette();
      const copy = !same || event.ctrlKey || event.altKey;
      if (same && hint.position > drag.start && hint.position < drag.end) {
        this.notice = '折りたたみを自分自身の中には入れられません。'; return;
      }
      let lines: string[], insertedAt = hint.position;
      if (!copy) {
        const result = movePaletteItem(this.source, drag.start, drag.end, hint.position);
        if (!result) { this.notice = '並び順は変わりません。'; return; }
        lines = result.lines; insertedAt = result.insertedAt;
      } else {
        lines = this.document.lines.slice();
        lines.splice(insertedAt, 0, ...payload.text.split(/\r?\n/));
      }
      this.base = hint.source;
      if (this.commit(lines)) {
        this.selected = insertedAt;
        this.query = '';
        this.active = this.document.tabs.find(t => t.start < insertedAt && insertedAt < t.end)?.start ?? -2;
        this.notice = copy ? 'コピーしました。コピー元は変更していません。' : '並び順を変更しました。';
        this.saveView();
        setTimeout(() => this.host.nativeElement.querySelector('[data-palette-line="' + insertedAt + '"]')?.scrollIntoView({ block: 'nearest' }));
      }
    } catch (_) { this.notice = 'ドラッグした項目を読み取れませんでした。内容は変更していません。'; }
    finally { this.endDrag(); }
  }
  exportPlain() {
    const blob = new Blob([flattenPalette(this.source)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'chat-palette.txt'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.notice = '区切りを除いた本文を出力しました。';
  }
}
