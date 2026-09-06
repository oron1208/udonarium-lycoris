import { saveAs } from 'file-saver';
import * as JSZip from 'jszip';
import { Logger } from '../system/util/logger';

import { EventSystem, Network } from '../system';
import { XmlUtil } from '../system/util/xml-util';
import { AudioFile } from './audio-file';
import { AudioStorage } from './audio-storage';
import { CanvasUtil } from './canvas-util';
import { FileReaderUtil } from './file-reader-util';
import { FileProcessingWorker } from './file-processing-worker';
import { ImageFile } from './image-file';
import { ImageStorage } from './image-storage';
import { MimeType } from './mime-type';
import { chooseZipImageImport, ZIP_IMAGE_LIMIT, remapZipImageReferences } from './zip-image-import-options';

import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { ReloadCheck } from '@udonarium/reload-check';
import { Jukebox } from '@udonarium/Jukebox';

type MetaData = { percent: number, currentFile: string };
type UpdateCallback = (metadata: MetaData) => void;

const MEGA_BYTE = 1024 * 1024;

export class FileArchiver {
  private static _instance: FileArchiver
  static get instance(): FileArchiver {
    if (!FileArchiver._instance) FileArchiver._instance = new FileArchiver();
    return FileArchiver._instance;
  }

  networkService = Network;
  get reloadCheck(): ReloadCheck { return ObjectStore.instance.get<ReloadCheck>('ReloadCheck'); }

  private maxImageSize = 2 * MEGA_BYTE;
  private maxAudioeSize = 10 * MEGA_BYTE;

  private callbackOnDragEnter;
  private callbackOnDragOver;
  private callbackOnDrop;

  private constructor() {
    Logger.debug('FileArchiver ready...');
  }

  initialize() {
    this.destroy();
    this.addEventListeners();
  }

  private destroy() {
    this.removeEventListeners();
  }

  private addEventListeners() {
    this.removeEventListeners();
    this.callbackOnDragEnter = (e) => this.onDragEnter(e);
    this.callbackOnDragOver = (e) => this.onDragOver(e);
    this.callbackOnDrop = (e) => this.onDrop(e);
    document.body.addEventListener('dragenter', this.callbackOnDragEnter, false);
    document.body.addEventListener('dragover', this.callbackOnDragOver, false);
    document.body.addEventListener('drop', this.callbackOnDrop, false);
  }

  private removeEventListeners() {
    document.body.removeEventListener('dragenter', this.callbackOnDragEnter, false);
    document.body.removeEventListener('dragover', this.callbackOnDragOver, false);
    document.body.removeEventListener('drop', this.callbackOnDrop, false);
    this.callbackOnDragEnter = null;
    this.callbackOnDragOver = null;
    this.callbackOnDrop = null;
  }

  private onDragEnter(event: DragEvent) {
    event.preventDefault();
  };

  private onDragOver(event: DragEvent) {
    event.preventDefault();
  };

  private onDrop(event: DragEvent) {
    event.preventDefault();

    this.reloadCheck.reloadCheckStart(this.networkService.peerContext.roomName != '');

    Logger.debug('onDrop', event.dataTransfer);
    let files = event.dataTransfer.files
    this.load(files);
  };

  async load(files: File[], preserveImageBytes?: boolean, archivedImageIdentifier?: string): Promise<void>
  async load(files: FileList, preserveImageBytes?: boolean, archivedImageIdentifier?: string): Promise<void>
  async load(files: any, preserveImageBytes: boolean = false, archivedImageIdentifier: string = ''): Promise<void> {
    if (!files) return;
    let loadFiles: File[] = files instanceof FileList ? toArrayOfFileList(files) : files;

    // Ask once per direct-file batch, before importing any files.
    if (!preserveImageBytes) {
      const large = loadFiles.filter(file => file.type.startsWith('image/') && file.size > ZIP_IMAGE_LIMIT);
      const options = large.length ? await chooseZipImageImport(large.length, large.reduce((sum, file) => sum + file.size, 0), 'files') : false;
      if (options === null) return;
      if (options) {
        const prepared: File[] = [];
        for (const file of loadFiles) {
          let image = file;
          if (file.size > ZIP_IMAGE_LIMIT && (file.type === 'image/png' || file.type === 'image/jpeg')) {
            const compressed = await this.compressImage(file, options.maxDim, options.quality);
            if (compressed && compressed.size < file.size) image = compressed;
          }
          prepared.push(image);
        }
        loadFiles = prepared;
      }
    }
    // ファイルは順次処理することでドロップ時の並び順を維持する。
    // 重い計算（SHA256・画像圧縮）は Web Worker にオフロード済みなので、
    // メインスレッドの逐次ループでも実用十分な速度となる。
    for (let i = 0; i < loadFiles.length; i++) {
      const file = loadFiles[i];
      try {
        await this.handleImage(file, true, archivedImageIdentifier);
        await this.handleAudio(file);
        await this.handleMediaManifest(file);
        await this.handleText(file);
        await this.handleZip(file);
        EventSystem.trigger('FILE_LOADED', { file: file });
      } catch (e) {
        Logger.warn(`FileArchiver: error processing ${file.name}`, e);
      }
    }
  }

  private async handleImage(file: File, preserveImageBytes: boolean = false, archivedImageIdentifier: string = '') {
    if (file.type.indexOf('image/') < 0) return;
    if (!this.reloadCheck.isLoadOk() ) return;
    
    let processedFile = file;
    Logger.debug(processedFile.name + ' type:' + processedFile.type);
    if (archivedImageIdentifier) {
      const image = await ImageFile.createAsync(processedFile);
      const context = image.toContext();
      context.identifier = archivedImageIdentifier;
      // Recreate object URLs in the stored ImageFile instead of sharing URLs
      // owned by this temporary ImageFile.
      context.url = '';
      context.thumbnail.url = '';
      image.destroy();
      ImageStorage.instance.replace(context);
    } else {
      await ImageStorage.instance.addAsync(processedFile);
    }
  }

  /**
   * 画像を自動圧縮する。
   * Worker + OffscreenCanvasを優先し、非対応環境では従来のメインスレッドCanvasへfallbackする。
   * - 最大幅1920px、最大高さ1920pxにリサイズ
   * - JPEG/WebP → quality 0.85で再圧縮
   * - PNG → PNGのまま（透過保持）
   */
  private async compressImage(file: File, maxDim = 1920, quality = 0.85): Promise<File | null> {
    try {
      const result = await FileProcessingWorker.compressImage(file, maxDim, quality);
      if (result?.blob && result.blob.size < file.size) {
        return new File([result.blob], file.name, { type: result.type || result.blob.type });
      }
      return null;
    } catch (e) {
      if (!FileProcessingWorker.isAvailable()) {
        // Worker非対応環境：フォールバックで処理（WARNは出さない）
      } else {
        Logger.warn('[FileArchiver] image compression worker fallback', e);
      }
      return await this.compressImageOnMainThread(file, maxDim, quality);
    }
  }

  private async compressImageOnMainThread(file: File, maxDim = 1920, quality = 0.85): Promise<File | null> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          let width = img.naturalWidth;
          let height = img.naturalHeight;
          // サイズオーバー時のみリサイズ（拡大はしない）
          if (width > maxDim || height > maxDim) {
            const ratio = Math.min(maxDim / width, maxDim / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
          }

          // 多段階縮小で高品質リサイズ
          const canvas = CanvasUtil.resizeCanvas(img, width, height);

          // フォーマット選択: PNGは透過保持、それ以外はJPEG
          const isPng = file.type === 'image/png';
          const mimeType = isPng ? 'image/png' : 'image/jpeg';

          canvas.toBlob((blob) => {
            if (blob && blob.size < file.size) {
              const compressed = new File([blob], file.name, { type: mimeType });
              resolve(compressed);
            } else {
              // 圧縮結果が元より大きくなったらnull
              resolve(null);
            }
          }, mimeType, isPng ? undefined : quality);
        };
        img.onerror = () => resolve(null);
        img.src = e.target.result as string;
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  private async handleAudio(file: File) {
    if (file.type.indexOf('audio/') < 0) return;
    if (this.maxAudioeSize < file.size) {
      Logger.warn(`File size limit exceeded. -> ${file.name} (${(file.size / 1024 / 1024).toFixed(2)}MB)`);
      return;
    }
    Logger.debug(file.name + ' type:' + file.type);
    await AudioStorage.instance.addAsync(file);
  }

  private async handleMediaManifest(file: File): Promise<void> {
    if (file.name !== 'media-manifest.json') return;
    try {
      const manifest = JSON.parse(await FileReaderUtil.readAsTextAsync(file));
      const audios = Array.isArray(manifest && manifest.audios) ? manifest.audios : [];
      for (const item of audios) {
        const identifier = String(item && item.identifier || '');
        if (!/^[a-f0-9]{64}$/i.test(identifier)) continue;
        let audio = AudioStorage.instance.get(identifier);
        if (audio === null) {
          audio = AudioFile.createEmpty(identifier);
          AudioStorage.instance.add(audio);
        }
        const name = String(item && item.name || '');
        if (name && (!audio.name || audio.name === audio.identifier)) {
          const context = audio.toContext();
          context.name = name;
          audio.apply(context);
        }
      }
      if (audios.length > 0) AudioStorage.instance.synchronize();

      const jukeboxSettings = manifest && manifest.jukebox;
      if (jukeboxSettings && typeof jukeboxSettings === 'object') {
        const jukebox = ObjectStore.instance.get<Jukebox>('Jukebox');
        if (jukebox) {
          if (jukeboxSettings.audioFolderMap && typeof jukeboxSettings.audioFolderMap === 'object') {
            jukebox.setAudioFolderMap(jukeboxSettings.audioFolderMap);
          }
          if (Array.isArray(jukeboxSettings.customFolderNames)) {
            jukebox.setCustomFolderNames(jukeboxSettings.customFolderNames.map(name => String(name)).filter(name => name.length > 0));
          }
          if (Array.isArray(jukeboxSettings.jukeboxLayers)) {
            jukebox.setJukeboxLayers(jukeboxSettings.jukeboxLayers);
          }
          if (Array.isArray(jukeboxSettings.pinnedLibraryTrackIds)) {
            jukebox.setPinnedLibraryTrackIds(jukeboxSettings.pinnedLibraryTrackIds.map(id => String(id)).filter(id => id.length > 0));
          }
          jukebox.update();
        }
      }
    } catch (reason) {
      Logger.warn('media-manifest.json load failed', reason);
    }
  }

  private async handleText(file: File): Promise<void> {
    if (file.type.indexOf('text/') < 0) return;

    let isLoadOk = true;
    // data.xmlはここでは通過させ後段で中身が部屋データ更新だった場合更新確認をする
    if(file.name == 'config.xml' || file.name == 'imagetag.xml' || file.name == 'summary.xml'){
      isLoadOk = this.reloadCheck.isLoadOk();
    }

    if(isLoadOk){
      Logger.debug(file.name + ' type:' + file.type);
      try {
        let xmlElement: Element = XmlUtil.xml2element(await FileReaderUtil.readAsTextAsync(file));
        if (xmlElement) EventSystem.trigger('XML_LOADED', { xmlElement: xmlElement });
      } catch (reason) {
        Logger.warn(reason);
      }
    }
  }

  private async handleZip(file: File) {
    if (!(0 <= file.type.indexOf('application/') || file.type.length < 1)) return;
    let zip = new JSZip();
    try {
      zip = await zip.loadAsync(file);
    } catch (reason) {
      Logger.warn(reason);
      return;
    }
    let zipEntries: JSZip.JSZipObject[] = [];
    zip.forEach((relativePath, zipEntry) => zipEntries.push(zipEntry));
    const archivedImageIdentifiers = await this.collectArchivedImageIdentifiers(zip);
    // Ask once before importing any objects or media from this ZIP.
    const largeImages: JSZip.JSZipObject[] = [];
    let largeBytes = 0;
    for (const entry of zipEntries) {
      if (entry.dir || !MimeType.type(entry.name).startsWith('image/')) continue;
      const knownSize = (entry as any)._data?.uncompressedSize;
      const size = typeof knownSize === 'number' ? knownSize : (await entry.async('uint8array')).byteLength;
      if (size > ZIP_IMAGE_LIMIT) { largeImages.push(entry); largeBytes += size; }
    }
    const options = largeImages.length ? await chooseZipImageImport(largeImages.length, largeBytes) : false;
    if (options === null) return;
    const prepared = new Map<string, File>();
    const replacements = new Map<string, string>();
    if (options) {
      for (const entry of largeImages) {
        const type = MimeType.type(entry.name);
        // Do not flatten animations or discard WebP transparency.
        if (type !== 'image/png' && type !== 'image/jpeg') continue;
        const original = new File([await entry.async('arraybuffer')], entry.name, { type });
        const compressed = await this.compressImage(original, options.maxDim, options.quality);
        if (!compressed || compressed.size >= original.size) continue;
        const oldHash = await FileReaderUtil.calcSHA256Async(original);
        const newHash = await FileReaderUtil.calcSHA256Async(compressed);
        replacements.set(oldHash, newHash);
        const archivedId = archivedImageIdentifiers.get(this.archiveImageStem(entry.name));
        if (archivedId) replacements.set(archivedId, newHash);
        prepared.set(entry.name, compressed);
      }
    }
    for (let zipEntry of zipEntries) {
      if (zipEntry.dir) continue;
      try {
        let arraybuffer = await zipEntry.async('arraybuffer');
        Logger.debug(zipEntry.name + ' 解凍...');
        let archivedImageIdentifier = archivedImageIdentifiers.get(this.archiveImageStem(zipEntry.name)) || '';
        let importedFile = prepared.get(zipEntry.name) || new File([arraybuffer], zipEntry.name, { type: MimeType.type(zipEntry.name) });
        if (prepared.has(zipEntry.name)) {
          archivedImageIdentifier = await FileReaderUtil.calcSHA256Async(importedFile);
        } else if (/\.xml$/i.test(zipEntry.name) && replacements.size) {
          importedFile = new File([remapZipImageReferences(await importedFile.text(), replacements)], zipEntry.name, { type: importedFile.type });
        }
        await this.load(
          [importedFile],
          true,
          archivedImageIdentifier,
        );
      } catch (reason) {
        Logger.warn(reason);
      }
    }
  }

  private async collectArchivedImageIdentifiers(zip: JSZip): Promise<Map<string, string>> {
    const identifiers = new Map<string, string>();
    const metadataNames = ['data.xml', 'chat.xml', 'imagetag.xml'];

    for (const metadataName of metadataNames) {
      const entry = zip.file(metadataName);
      if (!entry) continue;
      try {
        const xmlElement = XmlUtil.xml2element(await entry.async('string'));
        if (!xmlElement) continue;

        const imageElements = xmlElement.ownerDocument.querySelectorAll('*[type="image"]');
        for (let i = 0; i < imageElements.length; i++) {
          this.addArchivedImageIdentifier(identifiers, imageElements[i].textContent || '');
        }

        const attributeElements = xmlElement.ownerDocument.querySelectorAll('*[imageIdentifier], *[backgroundImageIdentifier]');
        for (let i = 0; i < attributeElements.length; i++) {
          this.addArchivedImageIdentifier(identifiers, attributeElements[i].getAttribute('imageIdentifier') || '');
          this.addArchivedImageIdentifier(identifiers, attributeElements[i].getAttribute('backgroundImageIdentifier') || '');
        }
      } catch (reason) {
        Logger.warn(`${metadataName} image identifier scan failed`, reason);
      }
    }
    return identifiers;
  }

  private addArchivedImageIdentifier(identifiers: Map<string, string>, identifier: string): void {
    const normalizedIdentifier = String(identifier || '').trim();
    if (!normalizedIdentifier) return;
    identifiers.set(this.normalizeArchivePath(normalizedIdentifier), normalizedIdentifier);
  }

  private archiveImageStem(name: string): string {
    const normalized = this.normalizeArchivePath(name);
    const extensionIndex = normalized.lastIndexOf('.');
    return extensionIndex > normalized.lastIndexOf('/') ? normalized.slice(0, extensionIndex) : normalized;
  }

  private normalizeArchivePath(name: string): string {
    return String(name || '').trim().replace(/^(?:\.\/|\/)+/, '');
  }

  async saveAsync(files: File[], zipName: string, updateCallback?: UpdateCallback): Promise<void>
  async saveAsync(files: FileList, zipName: string, updateCallback?: UpdateCallback): Promise<void>
  async saveAsync(files: any, zipName: string, updateCallback?: UpdateCallback): Promise<void> {
    if (!files) return;
    let saveFiles: File[] = files instanceof FileList ? toArrayOfFileList(files) : files;

    let zip = new JSZip();
    for (let file of saveFiles) {
      zip.file(file.name, file);
    }

    let blob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: {
        level: 6
      }
    }, updateCallback);
    saveAs(blob, zipName + '.zip');
  }
}

function toArrayOfFileList(fileList: FileList): File[] {
  let files: File[] = [];
  let length = fileList.length;
  for (let i = 0; i < length; i++) { files.push(fileList[i]); }
  return files;
}
