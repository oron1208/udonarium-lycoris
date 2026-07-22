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
import { ImageStorage } from './image-storage';
import { MimeType } from './mime-type';

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

  async load(files: File[], preserveImageBytes?: boolean): Promise<void>
  async load(files: FileList, preserveImageBytes?: boolean): Promise<void>
  async load(files: any, preserveImageBytes: boolean = false): Promise<void> {
    if (!files) return;
    let loadFiles: File[] = files instanceof FileList ? toArrayOfFileList(files) : files;

    // ファイルは順次処理することでドロップ時の並び順を維持する。
    // 重い計算（SHA256・画像圧縮）は Web Worker にオフロード済みなので、
    // メインスレッドの逐次ループでも実用十分な速度となる。
    for (let i = 0; i < loadFiles.length; i++) {
      const file = loadFiles[i];
      try {
        await this.handleImage(file, preserveImageBytes);
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

  private async handleImage(file: File, preserveImageBytes: boolean = false) {
    if (file.type.indexOf('image/') < 0) return;
    if (!this.reloadCheck.isLoadOk() ) return;
    
    let processedFile = file;
    // 2MB超の場合は自動圧縮
    // Room ZIP object data refers to images by the SHA-256 of the original
    // bytes. Recompressing an archived image changes that identifier while
    // data.xml keeps the old hash, leaving cards/dice with a missing image.
    // Direct user uploads can still use the existing size optimization.
    if (!preserveImageBytes && this.maxImageSize < file.size) {
      Logger.debug(`Image compression: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)}MB) → compressing...`);
      const compressed = await this.compressImage(file);
      if (compressed && compressed.size <= this.maxImageSize) {
        Logger.debug(`Image compressed: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)}MB → ${(compressed.size / 1024 / 1024).toFixed(2)}MB)`);
        processedFile = compressed;
      } else if (compressed) {
        // 圧縮しても2MB超の場合でも、元より小さければ許可
        if (compressed.size < file.size) {
          Logger.debug(`Image compressed (still large): ${file.name} (${(compressed.size / 1024 / 1024).toFixed(2)}MB)`);
          processedFile = compressed;
        } else {
          Logger.warn(`Image compression failed to reduce size: ${file.name}`);
          return;
        }
      } else {
        Logger.warn(`Image compression failed: ${file.name}`);
        return;
      }
    }
    
    Logger.debug(processedFile.name + ' type:' + processedFile.type);
    await ImageStorage.instance.addAsync(processedFile);
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
    for (let zipEntry of zipEntries) {
      try {
        let arraybuffer = await zipEntry.async('arraybuffer');
        Logger.debug(zipEntry.name + ' 解凍...');
        await this.load(
          [new File([arraybuffer], zipEntry.name, { type: MimeType.type(zipEntry.name) })],
          true,
        );
      } catch (reason) {
        Logger.warn(reason);
      }
    }
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
