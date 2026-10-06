import { Component, ChangeDetectionStrategy, ChangeDetectorRef, OnDestroy } from '@angular/core';
import { EventSystem } from '@udonarium/core/system';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { GameCharacter } from '@udonarium/game-character';
import { DiceBot } from '@udonarium/dice-bot';
import { DictionaryService, DictCharacter, DictMaterial, DictPalette, DictPage, DictCollection, DictType } from 'service/dictionary.service';

@Component({
  selector: 'dictionary-panel',
  templateUrl: './dictionary-panel.component.html',
  styleUrls: ['./dictionary-panel.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DictionaryPanelComponent implements OnDestroy {
  selectedDictId = '';
  creating = false;
  newName = '';
  newType: DictType = 'characters';

  editCharId = '';
  selectedMaterialId = '';
  selectedPaletteId = '';
  applyTargetId = '';
  message = '';
  busy = false;
  searchText = '';

  /** 検索フィルタ(名前・タグ・内容を部分一致) */
  private matched(text: string | undefined): boolean {
    const q = this.searchText.trim().toLowerCase();
    return !q || !!(text || '').toLowerCase().includes(q);
  }

  private saveTimer = 0;
  private messageTimer = 0;

  get diceBotInfos() { return DiceBot.diceBotInfos; }

  get gameCharacters(): GameCharacter[] {
    return ObjectStore.instance.getObjects(GameCharacter);
  }

  /** 現在選択中の辞書(存在しなければ先頭にフォールバック) */
  get activeDict(): DictCollection | null {
    return this.dictionary.getCollection(this.selectedDictId) ?? this.dictionary.collections[0] ?? null;
  }

  get chars(): DictCharacter[] {
    const list = this.activeDict ? this.dictionary.entriesOfCharacters(this.activeDict.id) : [];
    return list.filter(c => this.matched(c.name) || (c.tags || []).some(t => this.matched(t)));
  }
  get mats(): DictMaterial[] {
    const list = this.activeDict ? this.dictionary.entriesOfMaterials(this.activeDict.id) : [];
    return list.filter(m => this.matched(m.title) || (m.pages || []).some(p => this.matched(p.title) || this.matched(p.text) || this.matched(p.imageName)));
  }
  get pals(): DictPalette[] {
    const list = this.activeDict ? this.dictionary.entriesOfPalettes(this.activeDict.id) : [];
    return list.filter(p => this.matched(p.name) || this.matched(p.text) || (p.tags || []).some(t => this.matched(t)));
  }

  get selectedMaterial(): DictMaterial | null {
    return this.selectedMaterialId ? this.dictionary.getMaterial(this.selectedMaterialId) : null;
  }

  get selectedPalette(): DictPalette | null {
    return this.selectedPaletteId ? this.dictionary.getPalette(this.selectedPaletteId) : null;
  }

  constructor(
    public dictionary: DictionaryService,
    private changeDetector: ChangeDetectorRef,
  ) {
    EventSystem.register(this)
      .on('DICTIONARY_CHANGED', () => {
        if (!this.dictionary.getCollection(this.selectedDictId)) {
          this.selectedDictId = this.dictionary.collections[0]?.id ?? '';
          this.selectedMaterialId = '';
          this.selectedPaletteId = '';
          this.editCharId = '';
        }
        this.changeDetector.markForCheck();
      });
  }

  ngOnDestroy() {
    EventSystem.unregister(this);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.messageTimer) clearTimeout(this.messageTimer);
  }

  private show(message: string) {
    this.message = message;
    this.changeDetector.markForCheck();
    if (this.messageTimer) clearTimeout(this.messageTimer);
    this.messageTimer = window.setTimeout(() => { this.message = ''; this.changeDetector.markForCheck(); }, 4000);
  }

  private saveSoon(entry: DictMaterial | DictPalette) {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = 0;
      if (entry instanceof Object && 'pages' in entry) this.dictionary.saveMaterial(entry as DictMaterial);
      else this.dictionary.savePalette(entry as DictPalette);
      this.changeDetector.markForCheck();
    }, 600);
  }

  // ── 辞書(コレクション)の選択・作成・改名・削除 ──
  typeLabel(type: DictType): string { return type === 'characters' ? '[コマ]' : type === 'materials' ? '[資料]' : '[チャパレ]'; }

  countOf(col: DictCollection): number { return this.dictionary.countOf(col.type, col.id); }

  selectDict(id: string) {
    if (this.selectedDictId === id) return;
    this.selectedDictId = id;
    this.selectedMaterialId = '';
    this.selectedPaletteId = '';
    this.editCharId = '';
    this.changeDetector.markForCheck();
  }

  openCreate() {
    this.creating = true;
    this.newName = '';
    this.newType = this.activeDict?.type ?? 'characters';
    this.changeDetector.markForCheck();
  }

  async createDict() {
    if (!this.newName.trim()) { this.show('辞書の名前を入れてね'); return; }
    const col = await this.dictionary.addCollection(this.newName, this.newType);
    this.creating = false;
    this.selectDict(col.id);
    this.show(`辞書「${col.name}」(${this.typeLabel(col.type)})を作ったよ`);
  }

  async renameDict() {
    const col = this.activeDict;
    if (!col) return;
    const name = window.prompt('辞書の名前を変える', col.name);
    if (name === null) return;
    await this.dictionary.renameCollection(col.id, name);
    this.show('名前を変えたよ');
  }

  async removeDict() {
    const col = this.activeDict;
    if (!col) return;
    const n = this.countOf(col);
    if (!window.confirm(`辞書「${col.name}」を削除する?${n > 0 ? `\n中に入ってる${n}件も消えるよ` : ''}`)) return;
    await this.dictionary.removeCollection(col.id);
    this.selectedDictId = this.dictionary.collections[0]?.id ?? '';
    this.show(`辞書「${col.name}」を削除したよ`);
  }

  // ── 共通: 入出力(選択中の辞書単位) ──
  async onImportFile(e: Event) {
    if (this.busy) return;
    const input = e.target as HTMLInputElement;
    const files = input.files;
    if (!files || files.length < 1) return;
    this.busy = true;
    try {
      let total = { characters: 0, materials: 0, palettes: 0 };
      const createdNames: string[] = [];
      let legacy = false;
      for (const file of Array.from(files)) {
        const r = await this.dictionary.importFile(file, this.selectedDictId);
        total.characters += r.characters; total.materials += r.materials; total.palettes += r.palettes;
        if (r.createdDictName) createdNames.push(r.createdDictName);
        if (r.legacy) legacy = true;
      }
      let msg = `読み込み完了: コマ${total.characters} 資料${total.materials} チャパレ${total.palettes}`;
      if (createdNames.length) msg += `（新しい辞書「${createdNames.join('」「')}」を作ったよ）`;
      else if (legacy) msg += '（各種の既定辞書に追加したよ）';
      this.show(msg);
    } catch (err) {
      this.show('読み込みに失敗した: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      this.busy = false;
      input.value = '';
      this.changeDetector.markForCheck();
    }
  }

  async exportFile(format: 'json' | 'zip') {
    const col = this.activeDict;
    if (!col) return;
    await this.dictionary.exportFile(format, col.id);
    this.show(`「${col.name}」を${format === 'json' ? 'JSON' : 'ZIP'}で書き出したよ`);
  }

  // ── コマ ──
  async onImportCharacterXml(e: Event) {
    if (this.busy) return;
    const input = e.target as HTMLInputElement;
    const files = input.files;
    if (!files || files.length < 1) return;
    this.busy = true;
    try {
      let count = 0;
      const failed: string[] = [];
      for (const file of Array.from(files)) {
        if (/\.zip$/i.test(file.name) || file.type === 'application/zip' || file.type === 'application/x-zip-compressed') {
          const entry = await this.dictionary.registerCharacterZip(file, this.selectedDictId);
          if (entry) count++; else failed.push(file.name);
          continue;
        }
        if (!/\.xml$/i.test(file.name) && file.type !== 'text/xml') continue;
        const xml = await file.text();
        const entry = await this.dictionary.registerCharacterXml(xml, file.name.replace(/\.xml$/i, ''), this.selectedDictId);
        if (entry) count++; else failed.push(file.name);
      }
      this.show(`コマを${count}件登録したよ` + (failed.length ? `（コマが見つからなかった: ${failed.join('、')}）` : ''));
    } catch (err) {
      this.show('コマの登録に失敗した: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      this.busy = false;
      input.value = '';
      this.changeDetector.markForCheck();
    }
  }

  spawn(entry: DictCharacter) {
    const character = this.dictionary.spawnCharacter(entry);
    if (character) this.show(`「${character.name}」を卓に出したよ`);
  }

  onCharacterDragStart(e: DragEvent, entry: DictCharacter) {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData('text/lycoris-dict-character', entry.id);
    e.dataTransfer.effectAllowed = 'copy';
  }

  async removeCharacter(entry: DictCharacter) {
    if (!window.confirm(`辞書から「${entry.name}」を削除する?`)) return;
    await this.dictionary.removeCharacter(entry.id);
  }

  saveCharacter(entry: DictCharacter) {
    this.dictionary.saveCharacter(entry);
    this.editCharId = '';
    this.show('保存したよ');
  }

  setCharTags(entry: DictCharacter, value: string) {
    entry.tags = value.split(',').map(s => s.trim()).filter(s => s);
  }

  // ── 資料 ──
  async addMaterial() {
    if (!this.activeDict) return;
    const material: DictMaterial = { id: this.newId(), dictId: this.activeDict.id, title: '新しいセクション', pages: [], createdAt: Date.now() };
    await this.dictionary.saveMaterial(material);
    this.selectedMaterialId = material.id;
  }

  async removeMaterial(material: DictMaterial) {
    if (!window.confirm(`セクション「${material.title}」を削除する?`)) return;
    await this.dictionary.removeMaterial(material.id);
    if (this.selectedMaterialId === material.id) this.selectedMaterialId = '';
  }

  moveMaterial(material: DictMaterial, dir: -1 | 1) {
    this.dictionary.moveEntry('materials', material.id, dir);
  }

  addTextPage(material: DictMaterial) {
    const page: DictPage = { id: this.newId(), type: 'text', title: '新しいページ', text: '' };
    material.pages.push(page);
    this.saveSoon(material);
  }

  async onAddImagePages(e: Event, material: DictMaterial) {
    const input = e.target as HTMLInputElement;
    const files = input.files;
    if (!files || files.length < 1) return;
    for (const file of Array.from(files)) {
      const dataUrl = await this.readFileAsDataURL(file);
      if (!dataUrl) continue;
      material.pages.push({ id: this.newId(), type: 'image', title: file.name, imageUrl: dataUrl, imageName: file.name });
    }
    input.value = '';
    await this.dictionary.saveMaterial(material);
  }

  movePage(material: DictMaterial, index: number, dir: -1 | 1) {
    const to = index + dir;
    if (to < 0 || material.pages.length <= to) return;
    const [page] = material.pages.splice(index, 1);
    material.pages.splice(to, 0, page);
    this.saveSoon(material);
  }

  removePage(material: DictMaterial, index: number) {
    material.pages.splice(index, 1);
    this.saveSoon(material);
  }

  private readFileAsDataURL(file: File): Promise<string> {
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => resolve('');
      reader.readAsDataURL(file);
    });
  }

  // ── チャパレ ──
  async addPalette() {
    if (!this.activeDict) return;
    const palette: DictPalette = { id: this.newId(), dictId: this.activeDict.id, name: '新しいチャパレ', dicebot: 'DiceBot', text: '', tags: [], createdAt: Date.now() };
    await this.dictionary.savePalette(palette);
    this.selectedPaletteId = palette.id;
  }

  async removePalette(palette: DictPalette) {
    if (!window.confirm(`チャパレ「${palette.name}」を削除する?`)) return;
    await this.dictionary.removePalette(palette.id);
    if (this.selectedPaletteId === palette.id) this.selectedPaletteId = '';
  }

  movePalette(palette: DictPalette, dir: -1 | 1) {
    this.dictionary.moveEntry('palettes', palette.id, dir);
  }

  duplicatePalette(palette: DictPalette) {
    const copy: DictPalette = { ...palette, id: this.newId(), name: palette.name + ' のコピー', createdAt: Date.now() };
    this.dictionary.savePalette(copy);
    this.selectedPaletteId = copy.id;
  }

  onPaletteDragStart(e: DragEvent, entry: DictPalette) {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData('text/lycoris-dict-palette', entry.id);
    e.dataTransfer.effectAllowed = 'copy';
  }

  applyPalette(mode: 'replace' | 'append') {
    const palette = this.selectedPalette;
    if (!palette) return;
    const character = this.gameCharacters.find(c => c.identifier === this.applyTargetId);
    if (!character) { this.show('適用先のコマを選んでね'); return; }
    this.dictionary.applyPaletteToCharacter(palette, character, mode);
    const label = mode === 'replace' ? '置換' : '追記';
    this.show(`「${character.name}」のチャパレに${label}適用したよ`);
  }

  private newId(): string {
    return 'D' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
}
