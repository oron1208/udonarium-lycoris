import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { PaletteBrowserComponent } from './palette-browser.component';
import { flattenPalette, isPaletteCommand, parsePaletteDocument } from '@udonarium/palette-document';

describe('Structured palette compatibility and editor', () => {
  const source = '//能力=5\n// @tab 戦闘\n// @fold 攻撃\n2d6+{能力}\n// @fold 説明\n対象は1体\n// @end\n// @end\n// @tab 会話\nこんにちは';
  let fixture: ComponentFixture<PaletteBrowserComponent>;
  let component: PaletteBrowserComponent;
  let palette: any;
  beforeEach(async () => {
    await TestBed.configureTestingModule({ declarations: [PaletteBrowserComponent], imports: [FormsModule] }).compileComponents();
    fixture = TestBed.createComponent(PaletteBrowserComponent);
    component = fixture.componentInstance;
    palette = { value: source, identifier: 'palette-test-' + Math.random(), setPalette(value: string) { this.value = value; } };
    component.palette = palette;
    component.ngOnChanges();
    fixture.detectChanges();
  });
  afterEach(() => { localStorage.removeItem('lycoris-palette-view:' + palette.identifier); fixture.destroy(); });
  const button = (root: HTMLElement, label: string): HTMLButtonElement => Array.from(root.querySelectorAll('button')).find(b => b.textContent.trim() === label) as HTMLButtonElement;

  it('retains plain source, variable definitions and nested bodies without changing the palette', () => {
    const doc = parsePaletteDocument(source);
    expect(doc.tabs.map(t => t.name)).toEqual(['共通', '戦闘', '会話']);
    expect(doc.tabs[1].children[0].children[1].children[0].text).toBe('対象は1体');
    expect(doc.tabs[1].children[0].end).toBe(8);
    expect(palette.value).toBe(source);
    expect(flattenPalette(source)).toBe('//能力=5\n2d6+{能力}\n対象は1体\nこんにちは');
  });
  it('keeps legacy headings, unknown markers and malformed endings without losing lines', () => {
    const text = '◆判定\n//---戦闘---\n// @end\n// @unknown X\n// @fold 未閉鎖\n2d6\n// @tab 次\n1d6';
    const doc = parsePaletteDocument(text);
    expect(doc.lines.join('\n')).toBe(text);
    expect(doc.tabs[0].children[2].text).toBe('// @end');
    expect(doc.tabs[0].children[4].closed).toBeFalse();
    expect(doc.tabs[0].children[4].end).toBe(6);
    expect(doc.tabs[1].children[0].text).toBe('1d6');
  });
  it('never treats headings, definitions or structure as sendable commands', () => {
    ['// @tab A', '// @fold A', '// @end', '//能力=5', '◆判定', '//---戦闘---', ''].forEach(s => expect(isPaletteCommand(s)).toBeFalse());
    expect(isPaletteCommand('対象は1体')).toBeTrue();
    expect(isPaletteCommand('2d6+{能力}')).toBeTrue();
  });
  it('adds a tab through the visible button and form without typing a directive', async () => {
    const root = fixture.nativeElement as HTMLElement;
    button(root, '＋ タブ').click(); fixture.detectChanges(); await fixture.whenStable();
    const input = root.querySelector('input[name=name]') as HTMLInputElement;
    input.value = '魔法'; input.dispatchEvent(new Event('input')); fixture.detectChanges(); await fixture.whenStable();
    root.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    fixture.detectChanges();
    expect(palette.value).toBe(source + '\n// @tab 魔法');
    expect(component.activeTab.name).toBe('魔法');
  });
  it('adds a nested fold to the selected fold and edits its title', () => {
    component.selectTab(1); component.selected = 2;
    component.begin('add-fold'); component.insertInside = true; component.name = '補足'; component.body = '追加説明'; component.save();
    const parent = parsePaletteDocument(palette.value).tabs[1].children[0];
    const child = parent.children[0];
    expect(child.text).toBe('補足'); expect(child.children[0].text).toBe('追加説明');
    component.selected = child.start; component.begin('edit-node'); component.name = '注意'; component.save();
    expect(palette.value).toContain('// @fold 注意\n追加説明\n// @end');
    expect(palette.value).toContain('// @tab 会話\nこんにちは');
  });
  it('cancels editing without touching shared source', () => {
    component.begin('add-tab'); component.name = '破棄'; component.cancel();
    expect(palette.value).toBe(source);
  });
  it('detects a concurrent edit instead of overwriting it', () => {
    component.begin('add-tab'); component.name = '魔法'; palette.value += '\n別の人の更新'; component.save();
    expect(component.error).toContain('更新');
    expect(palette.value).toBe(source + '\n別の人の更新');
    expect(component.name).toBe('魔法');
  });
  it('unwraps a nested fold without deleting any of its body', () => {
    component.selected = 4; component.unwrap();
    expect(flattenPalette(palette.value)).toBe(flattenPalette(source));
    expect(palette.value).not.toContain('// @fold 説明');
    expect(parsePaletteDocument(palette.value).tabs[1].children[0].closed).toBeTrue();
  });
  it('renames and moves whole tabs without mixing their bodies or common variables', () => {
    component.selectTab(8); component.begin('rename-tab'); component.name = '台詞'; component.save();
    component.moveTab(-1);
    expect(component.document.tabs.map(t => t.name)).toEqual(['共通', '台詞', '戦闘']);
    expect(component.activeTab.name).toBe('台詞');
    expect(component.document.tabs[1].children[0].text).toBe('こんにちは');
    expect(component.document.lines[0]).toBe('//能力=5');
    component.moveTab(1);
    expect(component.document.tabs.map(t => t.name)).toEqual(['共通', '戦闘', '台詞']);
    expect(component.activeTab.name).toBe('台詞');
  });
  it('requires an explicit form submission before deleting tab contents', () => {
    component.selectTab(8); component.begin('delete-tab');
    expect(palette.value).toBe(source);
    component.save();
    expect(palette.value).not.toContain('こんにちは');
    expect(palette.value).toContain('2d6+{能力}');
  });
  it('opens folds without sending and sends only the double-clicked command once', () => {
    const send = spyOn(component.sendLine, 'emit'); const choose = spyOn(component.chooseLine, 'emit');
    const root = fixture.nativeElement as HTMLElement;
    const fold = root.querySelector('.fold') as HTMLButtonElement;
    fold.click(); fixture.detectChanges(); expect(send).not.toHaveBeenCalled(); expect(choose).not.toHaveBeenCalled();
    fold.click(); fixture.detectChanges();
    const command = button(root, '2d6+{能力}'); command.click();
    command.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(choose).toHaveBeenCalledOnceWith('2d6+{能力}'); expect(send).toHaveBeenCalledOnceWith('2d6+{能力}');
  });
  it('searches other tabs and collapsed descriptions without changing source or saved folds', () => {
    component.selectTab(8); component.expandAll(true); component.query = '対象'; fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('対象は1体');
    expect(component.collapsed.has(2)).toBeTrue(); expect(palette.value).toBe(source);
    component.query = ''; fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('対象は1体');
  });
  it('restores local view state but never writes it into the shared palette', () => {
    component.selectTab(8); component.expandAll(true);
    const other = new PaletteBrowserComponent({ nativeElement: document.createElement('div') });
    other.palette = palette; other.ngOnChanges();
    expect(other.active).toBe(8); expect(other.collapsed.has(4)).toBeTrue(); expect(palette.value).toBe(source);
  });
  it('supports creating the first content in an empty palette', () => {
    palette.value = ''; component.begin('add-lines'); component.body = '2d6'; component.save();
    expect(flattenPalette(palette.value).trim()).toBe('2d6');
  });
  it('clears stale selection when another participant inserts lines', () => {
    component.selectTab(8); component.selected = 9;
    palette.value = '新しい行\n' + source;
    fixture.detectChanges();
    expect(component.selected).toBe(-1); expect(component.active).toBe(-2);
    expect(component.selectedNode).toBeNull();
  });

  it('inserts new lines directly below the selected row, not at the end of the tab', () => {
    component.selected = 3; component.begin('add-lines'); component.body = '命中後の説明'; component.save();
    expect(palette.value).toContain('2d6+{能力}\n命中後の説明\n// @fold 説明');
  });
  it('inserts a new fold after a selected fold as a sibling by default', () => {
    component.selected = 4; component.begin('add-fold'); component.name = '補足'; component.body = '追加説明'; component.save();
    const parent = parsePaletteDocument(palette.value).tabs[1].children[0];
    expect(parent.children.map(n => n.text)).toEqual(['2d6+{能力}', '説明', '補足']);
  });

  function start(from: ComponentFixture<PaletteBrowserComponent>, row: number): DataTransfer {
    from.detectChanges();
    const transfer = new DataTransfer();
    from.nativeElement.querySelector('[data-palette-line="' + row + '"] .drag-handle')
      .dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    return transfer;
  }
  function over(to: ComponentFixture<PaletteBrowserComponent>, row: number, transfer: DataTransfer, placement = 'after', ctrlKey = false): HTMLElement {
    to.detectChanges();
    const target = to.nativeElement.querySelector('[data-palette-line="' + row + '"] .node-row') as HTMLElement;
    const box = target.getBoundingClientRect();
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, ctrlKey,
      clientY: placement === 'before' ? box.top + 1 : placement === 'inside' ? box.top + box.height / 2 : box.bottom - 1 }));
    return target;
  }
  function drop(target: HTMLElement, transfer: DataTransfer, ctrlKey = false) {
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, ctrlKey }));
    fixture.detectChanges();
  }
  function second(source: string, samePalette = false): ComponentFixture<PaletteBrowserComponent> {
    const f = TestBed.createComponent(PaletteBrowserComponent);
    f.componentInstance.palette = samePalette ? palette : { value: source, identifier: palette.identifier + '-other', setPalette(value: string) { this.value = value; } } as any;
    f.componentInstance.ngOnChanges(); f.detectChanges(); return f;
  }
  function destroySecond(f: ComponentFixture<PaletteBrowserComponent>) {
    localStorage.removeItem('lycoris-palette-view:' + f.componentInstance.palette.identifier); f.destroy();
  }
  it('moves a row down and back up via drag events without duplicating it', () => {
    palette.value = 'A\nB\nC'; fixture.detectChanges();
    let data = start(fixture, 0); drop(over(fixture, 2, data), data);
    expect(palette.value).toBe('B\nC\nA');
    data = start(fixture, 2); drop(over(fixture, 0, data, 'before'), data);
    expect(palette.value).toBe('A\nB\nC');
  });
  it('moves a fold as a whole including nested descriptions', () => {
    const data = start(fixture, 2); drop(over(fixture, 9, data), data);
    const doc = parsePaletteDocument(palette.value);
    expect(doc.tabs[1].children.length).toBe(0);
    expect(doc.tabs[2].children.map(n => n.text)).toEqual(['こんにちは', '攻撃']);
    expect(doc.tabs[2].children[1].children[1].children[0].text).toBe('対象は1体');
  });
  it('drops a row into a collapsed fold and reveals its new position', () => {
    component.expandAll(true); const data = start(fixture, 9); drop(over(fixture, 2, data, 'inside'), data);
    expect(parsePaletteDocument(palette.value).tabs[1].children[0].children[0].text).toBe('こんにちは');
    expect(component.collapsed.size).toBe(0);
  });
  it('refuses to move a fold inside its own descendants', () => {
    const data = start(fixture, 2); drop(over(fixture, 5, data), data);
    expect(palette.value).toBe(source); expect(component.notice).toContain('自分自身');
  });
  it('copies a complete fold to another palette while leaving its owner untouched', () => {
    const other = second('相手の行');
    try {
      const data = start(fixture, 2); drop(over(other, 0, data), data);
      expect(palette.value).toBe(source);
      const copied = parsePaletteDocument(String(other.componentInstance.palette.value)).tabs[0].children[1];
      expect(copied.text).toBe('攻撃'); expect(copied.children[1].children[0].text).toBe('対象は1体');
    } finally { destroySecond(other); }
  });
  it('moves rather than duplicates when normal and VN views point at the same palette', () => {
    palette.value = 'A\nB\nC'; fixture.detectChanges(); const other = second('', true);
    try {
      const data = start(fixture, 0); drop(over(other, 2, data), data);
      expect(palette.value).toBe('B\nC\nA');
    } finally { destroySecond(other); }
  });
  it('allows Ctrl-drag to copy inside the same palette', () => {
    palette.value = 'A\nB'; fixture.detectChanges();
    const data = start(fixture, 0); drop(over(fixture, 1, data, 'after', true), data, true);
    expect(palette.value).toBe('A\nB\nA');
  });
  it('copies into an empty palette using its drop area', () => {
    const other = second('');
    try {
      const data = start(fixture, 3);
      const target = other.nativeElement.querySelector('.drop-end');
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
      drop(target, data);
      expect(String(other.componentInstance.palette.value).trim()).toBe('2d6+{能力}');
      expect(palette.value).toBe(source);
    } finally { destroySecond(other); }
  });
  it('does not overwrite a drop destination modified after the insertion preview', () => {
    const other = second('B');
    try {
      const data = start(fixture, 3); const target = over(other, 0, data);
      other.componentInstance.palette.value = '新しい本文';
      drop(target, data);
      expect(other.componentInstance.palette.value).toBe('新しい本文'); expect(palette.value).toBe(source);
    } finally { destroySecond(other); }
  });
  it('cancels a transfer if its source was changed during the drag', () => {
    const other = second('B');
    try {
      const data = start(fixture, 3); const target = over(other, 0, data); palette.value += '\n更新';
      drop(target, data);
      expect(other.componentInstance.palette.value).toBe('B'); expect(palette.value).toBe(source + '\n更新');
    } finally { destroySecond(other); }
  });
  it('never sends a chat or toggles a fold as a consequence of dragging', () => {
    const send = spyOn(component.sendLine, 'emit'), choose = spyOn(component.chooseLine, 'emit');
    const data = start(fixture, 3); drop(over(fixture, 5, data), data);
    component.choose(component.document.tabs[1].children[0].children[0]);
    expect(send).not.toHaveBeenCalled(); expect(choose).not.toHaveBeenCalled();
  });
  it('rejects an incomplete fold at drag start without modifying the text', () => {
    palette.value = '// @fold 未閉鎖\nA'; fixture.detectChanges();
    const data = start(fixture, 0);
    expect(data.types.length).toBe(0); expect(palette.value).toBe('// @fold 未閉鎖\nA');
  });
});
