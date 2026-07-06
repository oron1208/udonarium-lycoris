import { Injectable, NgZone } from '@angular/core';

import { ChatTab } from '@udonarium/chat-tab';
import { ChatTabList } from '@udonarium/chat-tab-list';

import { Config } from '@udonarium/config';

import { FileArchiver } from '@udonarium/core/file-storage/file-archiver';
import { AudioStorage } from '@udonarium/core/file-storage/audio-storage';
import { ImageFile, ImageState } from '@udonarium/core/file-storage/image-file';
import { ImageStorage } from '@udonarium/core/file-storage/image-storage';
import { MimeType } from '@udonarium/core/file-storage/mime-type';
import { ServerMediaStorage } from '@udonarium/core/file-storage/server-media-storage';
import { GameObject } from '@udonarium/core/synchronize-object/game-object';
import { PromiseQueue } from '@udonarium/core/system/util/promise-queue';
import { XmlUtil } from '@udonarium/core/system/util/xml-util';
import { DataSummarySetting } from '@udonarium/data-summary-setting';
import { Room } from '@udonarium/room';

import { saveAs } from 'file-saver';

import * as Beautify from 'vkbeautify';
//本家PR #92より
import { ImageTagList } from '@udonarium/image-tag-list';
import { Jukebox } from '@udonarium/Jukebox';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
//
import { ModalService } from './modal.service';
import { TextViewComponent } from '../component/text-view/text-view.component';

type UpdateCallback = (percent: number) => void;

@Injectable({
  providedIn: 'root'
})
export class SaveDataService {
  private static queue: PromiseQueue = new PromiseQueue('SaveDataServiceQueue');

  constructor(
    private ngZone: NgZone,
    private modalService: ModalService
  ) { }

  saveRoomAsync(fileName: string = 'ルームデータ', updateCallback?: UpdateCallback): Promise<void> {
    return SaveDataService.queue.add((resolve, reject) => resolve(this._saveRoomAsync(fileName, updateCallback)));
  }

  private async _saveRoomAsync(fileName: string = 'ルームデータ', updateCallback?: UpdateCallback): Promise<void> {
    let files: File[] = [];
    let roomXml = this.convertToXml(new Room());
    let chatXml = this.convertToXml(ChatTabList.instance);
    let configXml = this.convertToXml(Config.instance);
    let summarySetting = this.convertToXml(DataSummarySetting.instance);
    files.push(new File([roomXml], 'data.xml', { type: 'text/plain' }));
    files.push(new File([chatXml], 'chat.xml', { type: 'text/plain' }));

    files.push(new File([configXml], 'config.xml', { type: 'text/plain' }));

    files.push(new File([summarySetting], 'summary.xml', { type: 'text/plain' }));
    files.push(new File([this.createMediaManifestJson()], 'media-manifest.json', { type: 'application/json' }));
//本家PR #92より
//    files = files.concat(this.searchImageFiles(roomXml));
//    files = files.concat(this.searchImageFiles(chatXml));

    let images: ImageFile[] = [];
    images = images.concat(this.searchImageFiles(roomXml));
    images = images.concat(this.searchImageFiles(chatXml));
    await this.ensureImagesComplete(images);
    let incompleteCount = 0;
    for (const image of images) {
      if (image.state === ImageState.COMPLETE) {
        files.push(new File([image.blob], image.identifier + '.' + MimeType.extension(image.blob.type), { type: image.blob.type }));
      } else {
        incompleteCount++;
      }
    }
    this.warnIncompleteImages(incompleteCount);

    let imageTagXml = this.convertToXml(ImageTagList.create(images));
    files.push(new File([imageTagXml], 'imagetag.xml', { type: 'text/plain' }));

    return this.saveAsync(files, this.appendTimestamp(fileName), updateCallback);
  }

  saveGameObjectAsync(gameObject: GameObject, fileName: string = 'xml_data', updateCallback?: UpdateCallback): Promise<void> {
    return SaveDataService.queue.add((resolve, reject) => resolve(this._saveGameObjectAsync(gameObject, fileName, updateCallback)));
  }

  private async _saveGameObjectAsync(gameObject: GameObject, fileName: string = 'xml_data', updateCallback?: UpdateCallback): Promise<void> {
    let files: File[] = [];
    let xml: string = this.convertToXml(gameObject);

    files.push(new File([xml], 'data.xml', { type: 'text/plain' }));
//本家PR #92より
//    files = files.concat(this.searchImageFiles(xml));
    let images: ImageFile[] = [];
    images = images.concat(this.searchImageFiles(xml));
    await this.ensureImagesComplete(images);
    let incompleteCount = 0;
    for (const image of images) {
      if (image.state === ImageState.COMPLETE) {
        files.push(new File([image.blob], image.identifier + '.' + MimeType.extension(image.blob.type), { type: image.blob.type }));
      } else {
        incompleteCount++;
      }
    }
    this.warnIncompleteImages(incompleteCount);

    let imageTagXml = this.convertToXml(ImageTagList.create(images));
    files.push(new File([imageTagXml], 'imagetag.xml', { type: 'text/plain' }));

    return this.saveAsync(files, this.appendTimestamp(fileName), updateCallback);
  }

  private saveAsync(files: File[], zipName: string, updateCallback?: UpdateCallback): Promise<void> {
    let progresPercent = -1;
    return FileArchiver.instance.saveAsync(files, zipName, meta => {
      let percent = meta.percent | 0;
      if (percent <= progresPercent) return;
      progresPercent = percent;
      this.ngZone.run(() => updateCallback(progresPercent));
    });
  }

  /**
   * ZIP保存前に、サーバー上にあるがローカル未取得の画像を取得して保存漏れを防ぐ。
   * 大量画像でも待ちすぎないよう、サーバーfetchは16並列バッチ。
   */
  private async ensureImagesComplete(images: ImageFile[]): Promise<void> {
    const seen = new Set<string>();
    const targets: ImageFile[] = [];
    for (const image of images) {
      if (!image || image.state === ImageState.COMPLETE) continue;
      if (!/^[a-f0-9]{64}$/i.test(image.identifier || '')) continue;
      if (seen.has(image.identifier)) continue;
      seen.add(image.identifier);
      targets.push(image);
    }
    if (targets.length < 1) return;

    const BATCH_SIZE = 16;
    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
      const batch = targets.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(async image => {
        try {
          return await ServerMediaStorage.fetchImage(image.identifier);
        } catch (e) {
          return { status: 'unreachable' as const };
        }
      }));
      for (const result of results) {
        if (result.status === 'ok') ImageStorage.instance.add(result.file);
      }
    }
  }

  /**
   * サーバー/ローカルキャッシュに無く、取得できなかった画像がZIP保存で漏れた場合に警告表示。
   * P2P救済が間に合わなかった画像は保存データに含まれない。
   */
  private warnIncompleteImages(incompleteCount: number): void {
    if (incompleteCount < 1) return;
    const message = `${incompleteCount}枚の画像が取得できず、保存データに含まれませんでした。\nサーバーまたは他の参加者から取得できる場合がありますが、このままでは保存データから復元できません。`;
    this.modalService.open(TextViewComponent, { title: '画像の保存漏れ', text: message });
  }

  private convertToXml(gameObject: GameObject): string {
    let xmlDeclaration = '<?xml version="1.0" encoding="UTF-8"?>';
//    return xmlDeclaration + '\n' + gameObject.toXml();
    return xmlDeclaration + '\n' + Beautify.xml(gameObject.toXml(), 2);
  }

  private createMediaManifestJson(): string {
    const audios = AudioStorage.instance.getCatalog().map(audio => ({
      kind: 'audio',
      identifier: audio.identifier,
      name: audio.name || audio.identifier,
      state: audio.state
    }));
    const jukebox = ObjectStore.instance.get<Jukebox>('Jukebox');
    const jukeboxSettings = jukebox ? {
      audioFolderMap: jukebox.getAudioFolderMap(),
      customFolderNames: jukebox.getCustomFolderNames(),
      jukeboxLayers: jukebox.getJukeboxLayers(),
      pinnedLibraryTrackIds: jukebox.getPinnedLibraryTrackIds()
    } : null;
    return JSON.stringify({ version: 2, audios, jukebox: jukeboxSettings }, null, 2);
  }

//本家PR #92より
//  private searchImageFiles(xml: string): File[] {
  private searchImageFiles(xml: string): ImageFile[] {
//
    let xmlElement: Element = XmlUtil.xml2element(xml);

//本家PR #92より
//    let files: File[] = [];
    let files: ImageFile[] = [];
//
    if (!xmlElement) return files;

    let images: { [identifier: string]: ImageFile } = {};
    let imageElements = xmlElement.ownerDocument.querySelectorAll('*[type="image"]');

    for (let i = 0; i < imageElements.length; i++) {
      let identifier = imageElements[i].innerHTML;
      images[identifier] = ImageStorage.instance.get(identifier);
    }

    imageElements = xmlElement.ownerDocument.querySelectorAll('*[imageIdentifier], *[backgroundImageIdentifier]');

    for (let i = 0; i < imageElements.length; i++) {
      let identifier = imageElements[i].getAttribute('imageIdentifier');
      if (identifier) images[identifier] = ImageStorage.instance.get(identifier);
      let backgroundImageIdentifier = imageElements[i].getAttribute('backgroundImageIdentifier');
      if (backgroundImageIdentifier) images[backgroundImageIdentifier] = ImageStorage.instance.get(backgroundImageIdentifier);
    }
    for (let identifier in images) {
      let image = images[identifier];
//本家PR #92より
//      if (image && image.state === ImageState.COMPLETE) {
//        files.push(new File([image.blob], image.identifier + '.' + MimeType.extension(image.blob.type), { type: image.blob.type }));
//      }
    if (image) {
       files.push(image);
    }

    }
    return files;
  }

  saveHtmlChatLog(chatTab: ChatTab, fileName: string ){
    let text: string = chatTab.logHtml();
    let blob = new Blob( [text], {type: "text/plain;charset=utf-8"});
    saveAs(blob, fileName + ".html");
  }

  saveHtmlChatLogAll( fileName: string ){
    let text: string = ChatTabList.instance.logHtml();
    let blob = new Blob( [text], {type: "text/plain;charset=utf-8"});
    saveAs(blob, fileName + ".html");
  }

  saveHtmlChatLogCoc(chatTab: ChatTab, fileName: string ){
    let text: string = chatTab.logHtmlCoc();
    let blob = new Blob( [text], {type: "text/plain;charset=utf-8"});
    saveAs(blob, fileName + ".html");
  }

  saveHtmlChatLogAllCoc( fileName: string ){
    let text: string = ChatTabList.instance.logHtmlCoc();
    let blob = new Blob( [text], {type: "text/plain;charset=utf-8"});
    saveAs(blob, fileName + ".html");
  }


  private appendTimestamp(fileName: string): string {
    let date = new Date();
    let year = date.getFullYear();
    let month = ('00' + (date.getMonth() + 1)).slice(-2);
    let day = ('00' + date.getDate()).slice(-2);
    let hours = ('00' + date.getHours()).slice(-2);
    let minutes = ('00' + date.getMinutes()).slice(-2);

    return fileName + `_${year}-${month}-${day}_${hours}${minutes}`;
  }
}
