import { CanvasUtil } from './canvas-util';
import { FileReaderUtil } from './file-reader-util';
import { FileProcessingWorker } from './file-processing-worker';
import { Logger } from '../system/util/logger';

export enum ImageState {
  NULL = 0,
  THUMBNAIL = 1,
  COMPLETE = 2,
  URL = 1000,
}

export interface ImageContext {
  identifier: string;
  name: string;
  type: string;
  blob: Blob;
  url: string;
  thumbnail: ThumbnailContext;
}

export interface ThumbnailContext {
  type: string;
  blob: Blob;
  url: string;
}

export class ImageFile {
  context: ImageContext = {
    identifier: '',
    name: '',
    blob: null,
    type: '',
    url: '',
    thumbnail: {
      blob: null,
      type: '',
      url: '',
    }
  };

  get identifier(): string { return this.context.identifier };
  get name(): string { return this.context.name };
  get blob(): Blob { return this.context.blob ? this.context.blob : this.context.thumbnail.blob; };
  get url(): string { return this.context.url ? this.context.url : this.context.thumbnail.url; };
  get thumbnail(): ThumbnailContext { return this.context.thumbnail };

  get state(): ImageState {
    if (!this.url && !this.blob) return ImageState.NULL;
    if (this.url && !this.blob) return ImageState.URL;
    if (this.blob === this.thumbnail.blob) return ImageState.THUMBNAIL;
    return ImageState.COMPLETE;
  }

  get isEmpty(): boolean { return this.state <= ImageState.NULL; }

  private constructor() { }

  static createEmpty(identifier: string): ImageFile {
    let imageFile = new ImageFile();
    imageFile.context.identifier = identifier;

    return imageFile;
  }

  static create(url: string): ImageFile
  static create(context: ImageContext): ImageFile
  static create(arg: any): ImageFile {
    if (typeof arg === 'string') {
      let imageFile = new ImageFile();
      imageFile.context.identifier = arg;
      imageFile.context.name = arg;
      imageFile.context.url = arg;
      return imageFile;
    } else {
      let imageFile = new ImageFile();
      imageFile.apply(arg);
      return imageFile;
    }
  }

  static async createAsync(file: File): Promise<ImageFile>
  static async createAsync(blob: Blob, name?: string): Promise<ImageFile>
  static async createAsync(arg: any, name?: string): Promise<ImageFile> {
    if (arg instanceof File) {
      return await ImageFile._createAsync(arg, arg.name);
    } else if (arg instanceof Blob) {
      return await ImageFile._createAsync(arg, name);
    }
  }

  private static async _createAsync(blob: Blob, name?: string): Promise<ImageFile> {
    let imageFile = new ImageFile();
    imageFile.context.identifier = await FileReaderUtil.calcSHA256Async(blob);
    imageFile.context.name = name;
    imageFile.context.blob = new Blob([blob], { type: blob.type });
    imageFile.context.url = window.URL.createObjectURL(imageFile.context.blob);

    try {
      imageFile.context.thumbnail = await ImageFile.createThumbnailAsync(imageFile.context);
    } catch (e) {
      throw e;
    }

    if (imageFile.context.name != null) imageFile.context.name = imageFile.context.identifier;

    return imageFile;
  }

  destroy() {
    this.revokeURLs();
  }

  apply(context: ImageContext) {
    if (!this.context.identifier && context.identifier) this.context.identifier = context.identifier;
    if (!this.context.name && context.name) this.context.name = context.name;
    if (!this.context.blob && context.blob) this.context.blob = context.blob;
    if (!this.context.type && context.type) this.context.type = context.type;
    if (!this.context.url && context.url) {
      if (this.state !== ImageState.URL) window.URL.revokeObjectURL(this.context.url);
      this.context.url = context.url;
    }
    if (!this.context.thumbnail.blob && context.thumbnail.blob) this.context.thumbnail.blob = context.thumbnail.blob;
    if (!this.context.thumbnail.type && context.thumbnail.type) this.context.thumbnail.type = context.thumbnail.type;
    if (!this.context.thumbnail.url && context.thumbnail.url) {
      if (this.state !== ImageState.URL) window.URL.revokeObjectURL(this.context.thumbnail.url);
      this.context.thumbnail.url = context.thumbnail.url;
    }
    this.createURLs();
  }

  toContext(): ImageContext {
    return {
      identifier: this.context.identifier,
      name: this.context.name,
      blob: this.context.blob,
      type: this.context.type,
      url: this.context.url,
      thumbnail: {
        blob: this.context.thumbnail.blob,
        type: this.context.thumbnail.type,
        url: this.context.thumbnail.url,
      }
    }
  }

  private createURLs() {
    if (this.state === ImageState.URL) return;
    if (this.context.blob && this.context.url === '') this.context.url = window.URL.createObjectURL(this.context.blob);
    if (this.context.thumbnail.blob && this.context.thumbnail.url === '') this.context.thumbnail.url = window.URL.createObjectURL(this.context.thumbnail.blob);
  }

  private revokeURLs() {
    if (this.state === ImageState.URL) return;
    window.URL.revokeObjectURL(this.context.url);
    window.URL.revokeObjectURL(this.context.thumbnail.url);
  }

  private static async createThumbnailAsync(context: ImageContext): Promise<ThumbnailContext> {
    try {
      const result = await FileProcessingWorker.createThumbnail(context.blob, 128);
      return {
        type: result.type || result.blob.type,
        blob: result.blob,
        url: window.URL.createObjectURL(result.blob),
      };
    } catch (e) {
      if (!FileProcessingWorker.isAvailable()) {
        // Worker非対応環境：フォールバックで処理（WARNは出さない）
      } else {
        Logger.warn('[ImageFile] thumbnail worker fallback', e);
      }
      return await ImageFile.createThumbnailOnMainThreadAsync(context);
    }
  }

  private static createThumbnailOnMainThreadAsync(context: ImageContext): Promise<ThumbnailContext> {
    return new Promise((resolve, reject) => {
      let image: HTMLImageElement = new Image();
      image.onload = (event) => {
        const maxDim = 128;
        const scale: number = Math.min(maxDim / Math.max(image.naturalWidth, image.naturalHeight), 1.0);
        const dstWidth = Math.max(1, Math.round(image.naturalWidth * scale));
        const dstHeight = Math.max(1, Math.round(image.naturalHeight * scale));

        // 多段階縮小で高品質なサムネイルを生成
        const canvas = CanvasUtil.resizeCanvas(image, dstWidth, dstHeight);

        canvas.toBlob(blob => {
          let thumbnail: ThumbnailContext = {
            type: blob.type,
            blob: blob,
            url: window.URL.createObjectURL(blob),
          };
          resolve(thumbnail);
        }, context.blob.type);
      };
      image.onabort = image.onerror = () => {
        reject();
      }
      image.src = context.url;
    });
  }

  static Empty: ImageFile = ImageFile.createEmpty('null');
}
