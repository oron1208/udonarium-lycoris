import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, NgZone, OnDestroy } from '@angular/core';
import { GameCharacter } from '@udonarium/game-character';
import { ModalService } from 'service/modal.service';
import { DictionaryService, DictCollection } from 'service/dictionary.service';

/** 右クリック「辞書に登録」の登録先コマ辞書を選ぶモーダル。登録して結果を表示してから自動で閉じる */
@Component({
  selector: 'dict-picker',
  templateUrl: './dict-picker.component.html',
  styleUrls: ['./dict-picker.component.css']
})
export class DictPickerComponent implements AfterViewInit, OnDestroy {
  selectedId = '';
  message = '';
  busy = false;
  private closeTimer = 0;

  get dicts(): DictCollection[] { return this.dictionary.collectionsOfType('characters'); }

  constructor(
    private ngZone: NgZone,
    public dictionary: DictionaryService,
    private modalService: ModalService,
    private elementRef: ElementRef<HTMLElement>,
    private changeDetector: ChangeDetectorRef,
  ) { }

  ngAfterViewInit() {
    this.ngZone.run(() => {
      const dicts = this.dicts;
      const last = this.dictionary.lastCharacterDictId;
      this.selectedId = dicts.some(d => d.id === last) ? last : (dicts[0]?.id ?? '');
      this.changeDetector.detectChanges();
    });
    Promise.resolve().then(() => {
      this.modalService.title = (this.modalService.option && this.modalService.option.title) || '辞書に登録';
    });
  }

  ngOnDestroy() {
    if (this.closeTimer) clearTimeout(this.closeTimer);
  }

  countOf(d: DictCollection): number { return this.dictionary.countOf('characters', d.id); }

  cancel() { this.modalService.resolve(null); }

  async register() {
    if (this.busy || !this.selectedId) return;
    const character: GameCharacter = this.modalService.option ? this.modalService.option.character : null;
    if (!character) { this.modalService.resolve(null); return; }
    this.busy = true;
    const col = this.dictionary.getCollection(this.selectedId);
    const entry = await this.dictionary.registerFromCharacter(character, this.selectedId);
    this.dictionary.lastCharacterDictId = this.selectedId;
    this.message = entry
      ? `「${entry.name}」を辞書「${col ? col.name : ''}」に登録したよ`
      : '登録に失敗したよ…';
    this.changeDetector.detectChanges();
    this.closeTimer = window.setTimeout(() => this.modalService.resolve(true), entry ? 1400 : 2600);
  }
}
