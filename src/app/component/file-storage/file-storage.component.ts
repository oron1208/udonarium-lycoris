import { AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { Logger } from '../../class/core/system/util/logger';

import { FileArchiver } from '@udonarium/core/file-storage/file-archiver';
import { ImageFile } from '@udonarium/core/file-storage/image-file';
import { ImageStorage } from '@udonarium/core/file-storage/image-storage';
import { EventSystem, Network } from '@udonarium/core/system';

import { PanelService } from 'service/panel.service';

import { ImageTag } from '@udonarium/image-tag';//本家PR #92より
import { MODEL3D_EXPERIMENT_ENABLED } from '@udonarium/experimental-features';

@Component({
    selector: 'file-storage',
    templateUrl: './file-storage.component.html',
    styleUrls: ['./file-storage.component.css'],
    changeDetection: ChangeDetectionStrategy.OnPush,
    standalone: false
})
export class FileStorageComponent implements OnInit, OnDestroy, AfterViewInit {

  private initTimestamp : number = 0;

  // 3Dモデル管理タブ（table-3d-spike試験機能のUI。window.__spike3d APIを経由）
  activeTab: 'image' | '3d' = 'image';
  readonly model3dExperimentEnabled = MODEL3D_EXPERIMENT_ENABLED;
  spikeModelList: { id: string; name: string; size: number; kind: string; thumb: string }[] = [];
  spikeSelected: string = null;

//本家PR #92より
  searchWord: string = '';
  private _searchWord!: string;
  private _searchWords!: string[];
  get searchWords(): string[] {
    if (this._searchWord !== this.searchWord) {
      this._searchWord = this.searchWord;
      this._searchWords = this.searchWord != null && 0 < this.searchWord.trim().length ? this.searchWord.trim().split(/\s+/) : [];
    }
    return this._searchWords;
  }

  getAllImage():ImageFile[]{
    let imageFileList: ImageFile[] = [];
    
    for (let imageFile of this.fileStorageService.images){
      let identifier = imageFile.context.identifier;
      let tag: string = '';
      if( ImageTag.get(identifier) ) tag = ImageTag.get(identifier).tag;
      
      if( tag != 'システム予約')   //システム予約名を非表示
        imageFileList.push(imageFile);
    }
    return imageFileList;
  }

  get images(): ImageFile[] {
      let imageFileList: ImageFile[] = [];
      if (this.selectTag == '全て') return this.getAllImage();
      for (let imageFile of this.fileStorageService.images){
        let identifier = imageFile.context.identifier;

        if( ImageTag.get(identifier) ){//
          let tag: string = ImageTag.get(identifier).tag;
          if( tag == this.selectTag ){
            imageFileList.push(imageFile);
          }
        }else{//タグ未設定の場合 画像投下直後は ImageTag.get(identifier) は空文字ではなく該当なしとなるため
          if( this.selectTag == '' ){
            imageFileList.push(imageFile);
          }
        }
      }
      return imageFileList;
  }

  selectedFile: ImageFile = null;
  get isSelected(): boolean { return this.selectedFile != null; }
  get selectedImageTag(): ImageTag {
    if (!this.isSelected) return null;
    const imageTag = ImageTag.get(this.selectedFile.identifier);
    return imageTag ? imageTag : ImageTag.create(this.selectedFile.identifier);
  }
  
  get tagList(): string[]{
    let tags:  string[] = [];
    for (let imageFile of this.fileStorageService.images){
      let identifier = imageFile.context.identifier;
      let imageTag = ImageTag.get(identifier);
      if( imageTag ){
        if( imageTag.tag ){
          if( imageTag.tag != 'システム予約')   //システム予約名を非表示
            tags.push(imageTag.tag);
        }
      }
    }
    
    let tags2:  string[] = Array.from(new Set(tags));
    tags2.unshift('全て');
    tags2.unshift('');
    return tags2;
    
  }
  
  fileStorageService = ImageStorage.instance;

  previewUrl(file: ImageFile): string {
    // ファイル一覧は本体画像よりサムネイルを優先表示して、一覧表示の描画負荷を下げる。
    // 本体しか無い画像・URL画像は従来通り file.url にフォールバックする。
    return file?.thumbnail?.url || file?.url || '';
  }

  inputNewTag(newTag: string) { 
    this.newTagName = newTag;
  }

  changeTag(){
   
    if( this.newTagName == '全て' ) return; //表示上混乱するタグの禁止
    if( this.newTagName == 'システム予約' )return; //システム予約名称
    
    let changeableImages = this.images; 
    Logger.debug("this.newTagName" + this.newTagName );
    
    for (let img of changeableImages) {
//    Logger.debug("img.context.identifier:"+img.context.identifier);
      let box = <HTMLInputElement>document.getElementById(img.context.identifier+'_'+ this.initTimestamp);
      if( box ){
        if( box.checked ){
          let imageTag = ImageTag.get(img.context.identifier);
          imageTag = imageTag ? imageTag : ImageTag.create(img.context.identifier);
          if( this.newTagName == '未設定' ){ 
            imageTag.tag = '';
          }else{
            imageTag.tag = this.newTagName;
          }
        }
      }
    }
  }

  selectTag :string = '';
  newTagName:string = '';
  
  resetBtn() {
//  処理なし
  }


//本家PR #92より
  constructor(
    private changeDetector: ChangeDetectorRef,
    private panelService: PanelService
  ) { 
    this.initTimestamp = Date.now();
  }

  ngOnInit() {
    Promise.resolve().then(() => this.panelService.title = 'ファイル一覧');
  }

  ngAfterViewInit() {
    EventSystem.register(this).on('IMAGE_FILE_CHANGED', () => this.changeDetector.markForCheck())
      .on('MODEL3D_CHANGED', () => { if (this.activeTab === '3d') this.refreshSpikeModels(); })
      .on('SYNCHRONIZE_FILE_LIST', event => {
      if (event.isSendFromSelf) {
        this.changeDetector.markForCheck();
      }
    });
  }

  ngOnDestroy() {
    EventSystem.unregister(this);
  }

  switch3d() {
    if (!this.model3dExperimentEnabled) return;
    this.activeTab = '3d';
    this.refreshSpikeModels();
  }

  refreshSpikeModels() {
    const api = (window as any).__spike3d;
    this.spikeModelList = api ? api.listModels() : [];
    this.spikeSelected = (api && api.selectedModel()) || null;
    this.changeDetector.markForCheck();
  }

  async onSpikeFileSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    const api = (window as any).__spike3d;
    if (!api) {
      alert('3D機能が初期化されていません。卓を3D表示モードで開いてください。');
      input.value = '';
      return;
    }
    for (const f of Array.from(input.files || [])) {
      try {
        if (f.size > 150 * 1024 * 1024) throw new Error('150MB以下のモデルを選んでください');
        const buf = await f.arrayBuffer();
        const id = await api.registerModel(f.name, buf, f.size);
        this.refreshSpikeModels(); // 一覧に先出し（サムネイルは生成後に差し替え）
        await api.buildThumb(id);
      } catch (error) { alert('3Dモデルを取り込めませんでした: ' + f.name + '\n' + String(error)); }
    }
    input.value = '';
    this.refreshSpikeModels();
  }

  onSpikeModelClick(id: string) {
    const api = (window as any).__spike3d;
    if (!api) return;
    if (this.spikeSelected === id) { api.clearSelection(); this.spikeSelected = null; }
    else { api.selectModel(id); this.spikeSelected = id; }
    this.changeDetector.markForCheck();
  }

  async onSpikeModelDelete(event: Event, id: string) {
    event.stopPropagation();
    const api = (window as any).__spike3d;
    if (!api) return;
    await api.removeModel(id);
    if (this.spikeSelected === id) { api.clearSelection(); this.spikeSelected = null; }
    this.refreshSpikeModels();
  }

  spikeSizeLabel(size: number): string {
    return size > 1024 * 1024 ? (size / 1024 / 1024).toFixed(1) + 'MB' : Math.round(size / 1024) + 'KB';
  }

  handleFileSelect(event: Event) {
    let input = <HTMLInputElement>event.target;
    let files = input.files;
    if (files.length) FileArchiver.instance.load(files);
    input.value = '';
  }

  onSelectedFile(file: ImageFile) {
    Logger.debug('onSelectedFile', file);
    EventSystem.call('SELECT_FILE', { fileIdentifier: file.identifier }, Network.peerId);

    this.selectedFile = file;//本家PR #92より
  }
  
  imgBlockClick(identifier){
    Logger.debug( "identifier:"+identifier);
    let box = <HTMLInputElement>document.getElementById(identifier+'_'+ this.initTimestamp);
    if (!box) return;
    box.checked = !box.checked;
  }
  
  onChange(identifier) {
    this.imgBlockClick(identifier);
  }

  
}
