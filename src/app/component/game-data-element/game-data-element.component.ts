import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  Input,
  OnDestroy,
  OnInit,
  HostListener,
  HostBinding,
  ViewChild,
  ElementRef,
} from '@angular/core';
import { EventSystem } from '@udonarium/core/system';
import { DataElement } from '@udonarium/data-element';
import { MarkDown } from '@udonarium/mark-down';

import { ImageFile } from '@udonarium/core/file-storage/image-file';
import { ImageStorage } from '@udonarium/core/file-storage/image-storage';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { FileSelecterComponent } from 'component/file-selecter/file-selecter.component';
import { ModalService } from 'service/modal.service';
import { PanelService } from 'service/panel.service';
import { TabletopService } from 'service/tabletop.service';

import { SafeHtml, DomSanitizer } from '@angular/platform-browser';

import { GameCharacter } from '@udonarium/game-character';

@Component({
  selector: 'game-data-element, [game-data-element]',
  templateUrl: './game-data-element.component.html',
  styleUrls: ['./game-data-element.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class GameDataElementComponent implements OnInit, OnDestroy, AfterViewInit {
  @Input() gameDataElement: DataElement = null;
  @Input() isEdit: boolean = false;
  @Input() isTagLocked: boolean = false;
  @Input() isValueLocked: boolean = false;

  @Input() isImage: boolean = false;
  @Input() indexNum: number = 0;

  @ViewChild('bulkFileInput') bulkFileInput: ElementRef<HTMLInputElement>;

  @HostBinding('class.auto-buff-row-up') get isAutoBuffRowUp(): boolean { return this.autoBuffClass === 'auto-buffed-up'; }
  @HostBinding('class.auto-buff-row-down') get isAutoBuffRowDown(): boolean { return this.autoBuffClass === 'auto-buffed-down'; }
  @HostBinding('class.auto-buff-row-neutral') get isAutoBuffRowNeutral(): boolean { return this.autoBuffClass === 'auto-buffed-neutral'; }

  private _name: string = '';
  get name(): string { return this._name; }
  set name(name: string) { this._name = name; this.setUpdateTimer(); }

  private _value: number | string = 0;
  get value(): number | string { return this._value; }
  set value(value: number | string) { this._value = value; this.setUpdateTimer(); }

  private _currentValue: number | string = 0;
  get currentValue(): number | string { return this._currentValue; }
  set currentValue(currentValue: number | string) { this._currentValue = currentValue; this.setUpdateTimer(); }

  private updateTimer: NodeJS.Timer = null;

  constructor(
    private panelService: PanelService,
    private modalService: ModalService,
    private changeDetector: ChangeDetectorRef,
    private domSanitizer: DomSanitizer,
    private tabletopService: TabletopService
  ) { }

  ngOnInit() {
    if (this.gameDataElement) this.setValues(this.gameDataElement);

    EventSystem.register(this)
      .on('UPDATE_GAME_OBJECT', event => {
        if (this.gameDataElement && event.data.identifier === this.gameDataElement.identifier) {
          this.setValues(this.gameDataElement);
          this.changeDetector.markForCheck();
        }
      })
      .on('DELETE_GAME_OBJECT', event => {
        if (this.gameDataElement && this.gameDataElement.identifier === event.data.identifier) {
          this.changeDetector.markForCheck();
        }
      })
      .on('UPDATE_GAME_OBJECT', event => {
        // 親キャラクターのautoBuffs変更を監視
        const char = this.findOwningCharacter();
        if (char && event.data.identifier === char.identifier) {
          this.changeDetector.markForCheck();
        }
      });
  }

  ngOnDestroy() {
    EventSystem.unregister(this);
  }

  ngAfterViewInit() {

  }

  get imageFileUrl(): string { 
     let image:ImageFile = ImageStorage.instance.get(<string>this.gameDataElement.value);
     if (image) return image.url;
     return '';
  }

  openModal(name: string = '', isAllowedEmpty: boolean = false) {
    this.modalService.open<string>(FileSelecterComponent, { isAllowedEmpty: isAllowedEmpty }).then(value => {
//      if (!this.tabletopObject || !this.tabletopObject.imageDataElement || !value) return;
      if (!value) return;
      let element = this.gameDataElement;
      if (!element) return;
      element.value = value;
    });
  }

  updateKomaIconMaxValue(root: DataElement){
    let image = root.getFirstElementByName('image');
    let icon = root.getElementsByName('ICON');
    if(icon){
      icon[0].value = image.children.length - 1;
      if( icon[0].currentValue > icon[0].value ) icon[0].currentValue = icon[0].value;
    }
  }

  addImageElement() {
    this.gameDataElement.appendChild(DataElement.create('imageIdentifier', '', { type: 'image' }));
    const root: DataElement = <DataElement>this.gameDataElement.parent;
    this.updateKomaIconMaxValue(root);
  }

  bulkImportImages() {
    const input = this.bulkFileInput?.nativeElement;
    if (input) {
      input.setAttribute('webkitdirectory', '');
      input.click();
    }
  }

  async onBulkFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input || !input.files || input.files.length < 1) return;
    const files = Array.from(input.files).filter(f => f.type.startsWith('image/'));
    input.value = '';
    if (files.length < 1) return;

    const confirmed = confirm(`${files.length}枚の画像が見つかりました。すべて登録しますか？`);
    if (!confirmed) return;

    const root: DataElement = <DataElement>this.gameDataElement.parent;
    const MAX_BYTES = 2 * 1024 * 1024;

    for (const file of files) {
      let processFile: Blob = file;
      const baseName = file.name.replace(/\.[^.]+$/, '');

      if (file.size > MAX_BYTES) {
        alert(`${baseName} は2MBを超えているため自動圧縮します。`);
        try {
          processFile = await this.compressImage(file);
        } catch (e) {
          console.error('compress failed', e);
          alert(`${baseName} の圧縮に失敗しました。スキップします。`);
          continue;
        }
      }

      try {
        const imageFile = await ImageStorage.instance.addAsync(processFile as File);
        if (imageFile && imageFile.identifier) {
          const child = DataElement.create('imageIdentifier', imageFile.identifier, { type: 'image' });
          child.name = baseName;
          child.currentValue = baseName;
          this.gameDataElement.appendChild(child);
        }
      } catch (e) {
        console.error('add failed', e);
        alert(`${baseName} の登録に失敗しました。`);
      }
    }
    this.updateKomaIconMaxValue(root);
    this.changeDetector.markForCheck();
  }

  private compressImage(file: File, maxDim: number = 1920, quality: number = 0.85): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          let w = img.width;
          let h = img.height;
          if (w > maxDim || h > maxDim) {
            const ratio = Math.min(maxDim / w, maxDim / h);
            w = Math.round(w * ratio);
            h = Math.round(h * ratio);
          }
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(img, 0, 0, w, h);
          canvas.toBlob(blob => {
            if (blob) resolve(blob);
            else reject(new Error('canvas toBlob failed'));
          }, 'image/jpeg', quality);
        };
        img.onerror = reject;
        img.src = reader.result as string;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  addElement() {
    this.gameDataElement.appendChild(DataElement.create('タグ', '', {}));
  }

  deleteElement() {
    this.gameDataElement.destroy();
  }

  deleteImageElement() {
    const root: DataElement = <DataElement>this.gameDataElement.parent.parent;
    if( this.gameDataElement.parent.children[0] != this.gameDataElement){
      this.gameDataElement.destroy();
      this.updateKomaIconMaxValue(root);
    }
  }


  upElement() {
    let parentElement = this.gameDataElement.parent;
    let index: number = parentElement.children.indexOf(this.gameDataElement);
    if (0 < index) {
      let prevElement = parentElement.children[index - 1];
      parentElement.insertBefore(this.gameDataElement, prevElement);
    }
  }

  downElement() {
    let parentElement = this.gameDataElement.parent;
    let index: number = parentElement.children.indexOf(this.gameDataElement);
    if (index < parentElement.children.length - 1) {
      let nextElement = index < parentElement.children.length - 2 ? parentElement.children[index + 2] : null;
      parentElement.insertBefore(this.gameDataElement, nextElement);
    }
  }


  setElementType(type: string) {
    this.gameDataElement.setAttribute('type', type);
  }

  private setValues(object: DataElement) {
    this._name = object.name;
    this._currentValue = object.currentValue;
    this._value = object.value;
  }

  private setUpdateTimer() {
    clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => {
      if (this.gameDataElement.name !== this.name) this.gameDataElement.name = this.name;
      if (this.gameDataElement.currentValue !== this.currentValue) this.gameDataElement.currentValue = this.currentValue;
      if (this.gameDataElement.value !== this.value) this.gameDataElement.value = this.value;
      this.updateTimer = null;
    }, 66);
  }

  escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
               .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  clickMarkDownBox(id: string) {
    console.log("マークダウンクリック:" + id);
  }

  get markdown(): MarkDown { return ObjectStore.instance.get<MarkDown>('markdwon'); }

  escapeHtmlMarkDown(text, baseId): SafeHtml{

    let textCheckBox = this.markdown.markDownCheckBox(text, baseId);
    let textTable =  this.markdown.markDownTable(textCheckBox);

    return this.domSanitizer.bypassSecurityTrustHtml("<div>" + textTable + "</div>");
  }

  @HostListener('click', ['$event'])
  click(event){
    if (this.markdown){
      console.log("event.timeStamp:" + event.timeStamp);
      this.markdown.changeMarkDownCheckBox(event.target.id, event.timeStamp);
    }
  }

  isEditMarkDown( dataElmIdentifier) {
    let box = <HTMLInputElement>document.getElementById(dataElmIdentifier);
    if( !box )return false;
    return box.checked;
  }

  isEditUrl( dataElmIdentifier) {
    let box = <HTMLInputElement>document.getElementById(dataElmIdentifier);
    if( !box )return false;
    return box.checked;
  }
  
  isUrlText( text ){
    if( text.match( /^https:\/\// ) )return true;
    if( text.match( /^http:\/\// ) )return true;
    return false;
  }
  
  changeChk(){
    //実処理なし
  }

  textFocus( dataElmIdentifier ){
    let box = <HTMLInputElement>document.getElementById(dataElmIdentifier);
    box.checked = true;
  }

  // ===== 自動計算バフ表示用 =====

  private _owningCharacter: GameCharacter | null = null;
  private _owningCharacterChecked: boolean = false;

  private findOwningCharacter(): GameCharacter | null {
    if (this._owningCharacterChecked) return this._owningCharacter;
    this._owningCharacterChecked = true;
    if (!this.gameDataElement) return null;
    // 親チェーンを辿ってルートを探す
    let el: any = this.gameDataElement;
    const allChars = ObjectStore.instance.getObjects<GameCharacter>(GameCharacter);
    for (const char of allChars) {
      // detailDataElementの階層にこのDataElementが含まれているか
      if (char.detailDataElement && char.detailDataElement.contains(this.gameDataElement)) {
        this._owningCharacter = char;
        return char;
      }
    }
    return null;
  }

  /** このステータスが自動計算バフで変更されているか */
  get autoBuffClass(): string {
    if (this.tabletopService.currentTable?.roomMode !== 'advanced') return '';
    if (!this.gameDataElement || this.gameDataElement.children.length > 0) return '';
    if (this.gameDataElement.type !== 'numberResource' && this.gameDataElement.type !== '') return '';
    const char = this.findOwningCharacter();
    if (!char) return '';
    const effect = char.getAutoBuffEffect(this.gameDataElement.name);
    if (!effect.isModified) return '';
    return effect.netDelta > 0 ? 'auto-buffed-up' : effect.netDelta < 0 ? 'auto-buffed-down' : 'auto-buffed-neutral';
  }
  
}
