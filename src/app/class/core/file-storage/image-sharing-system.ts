import { EventSystem, Network } from '../system';
import { UUID } from '../system/util/uuid';
import { BufferSharingTask } from './buffer-sharing-task';
import { FileReaderUtil } from './file-reader-util';
import { ImageContext, ImageFile, ImageState } from './image-file';
import { CatalogItem, ImageStorage } from './image-storage';
import { MimeType } from './mime-type';
import { MediaLoadPriority } from './media-load-priority';
import { ServerMediaStorage } from './server-media-storage';
import { Logger } from '../system/util/logger';

export class ImageSharingSystem {
  private static _instance: ImageSharingSystem
  static get instance(): ImageSharingSystem {
    if (!ImageSharingSystem._instance) ImageSharingSystem._instance = new ImageSharingSystem();
    return ImageSharingSystem._instance;
  }

  private sendTaskMap: Map<string, BufferSharingTask<ImageContext[]>> = new Map();
  private receiveTaskMap: Map<string, BufferSharingTask<ImageContext[]>> = new Map();
  private maxSendTask: number = 6;
  private maxReceiveTask: number = 12;

  private constructor() {
    Logger.debug('FileSharingSystem ready...');
  }

  initialize() {
    EventSystem.register(this)
      .on('CONNECT_PEER', 1, event => {
        if (!event.isSendFromSelf) return;
        Logger.debug('CONNECT_PEER ImageStorageService !!!', event.data.peerId);
        // InitialRoomSync sends one room ZIP first.  Older peers are handled by
        // the explicit INITIAL_ROOM_SYNC_FALLBACK path below.
      })
      .on('INITIAL_ROOM_SYNC_FALLBACK', event => {
        if (!event.isSendFromSelf || !event.data?.peerId) return;
        ImageStorage.instance.synchronize(event.data.peerId);
      })
      .on('INITIAL_ROOM_MEDIA_CATALOG_FALLBACK', event => {
        if (!event.isSendFromSelf || !Array.isArray(event.data?.images)) return;
        this.applyInitialCatalog(event.data.images, event.data.sourcePeerId);
      })
      .on('XML_LOADED', event => {
        convertUrlImage(event.data.xmlElement);
      })
      .on('SYNCHRONIZE_FILE_LIST', async event => {
        if (event.isSendFromSelf) return;
        Logger.debug('SYNCHRONIZE_FILE_LIST ImageStorageService ' + event.sendFrom);

        let otherCatalog: CatalogItem[] = event.data;
        let request: CatalogItem[] = [];

        // サーバーfetchを並列バッチで実行
        // FirefoxはHTTP/2接続プール上限が厳しいため並列数を抑える
        const isFirefox = typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent);
        const BATCH_SIZE = isFirefox ? 6 : 16;
        const LOW_PRIORITY_BATCH = isFirefox ? 3 : 6;
        const needFetch: CatalogItem[] = [];

        const hashPattern = /^[a-f0-9]{64}$/i;
        for (let item of otherCatalog) {
          let image: ImageFile = ImageStorage.instance.get(item.identifier, false);
          if (image === null) {
            if (hashPattern.test(item.identifier)) {
              // SHA-256 hash: create empty placeholder, fetch from server later
              image = ImageFile.createEmpty(item.identifier);
              ImageStorage.instance.add(image);
            } else {
              // URL-based identifier (e.g. ./assets/images/trump/x02.gif):
              // add as a URL image so the browser loads it from the app assets
              image = ImageStorage.instance.add(item.identifier);
            }
          }
          if (image.state < ImageState.COMPLETE && !this.receiveTaskMap.has(item.identifier)) {
            needFetch.push(item);
          }
        }

        // 見える範囲（卓背景・卓上コマ・VN立ち絵など）を先に、未参照/控え画像を後で取得する
        const priorityScores = MediaLoadPriority.getImageScoreMap();
        const prioritizedFetch = MediaLoadPriority.sortByScore(needFetch, priorityScores);
        for (let i = 0; i < prioritizedFetch.length;) {
          const score = MediaLoadPriority.scoreOf(priorityScores, prioritizedFetch[i].identifier);
          const batchSize = score >= MediaLoadPriority.VISIBLE_IMAGE_SCORE ? BATCH_SIZE : LOW_PRIORITY_BATCH;
          const priority = MediaLoadPriority.fetchPriority(score, MediaLoadPriority.VISIBLE_IMAGE_SCORE);
          const batch = prioritizedFetch.slice(i, i + batchSize);
          i += batch.length;
          const results = await Promise.all(
            batch.map(async item => {
              try {
                const result = await ServerMediaStorage.fetchImage(item.identifier, priority);
                return { item, result };
              } catch (e) {
                return { item, result: { status: 'unreachable' as const } };
              }
            })
          );
          for (const { item, result } of results) {
            if (result.status === 'ok') {
              ImageStorage.instance.add(result.file);
            } else if (result.status === 'missing') {
              // サーバーに存在しない画像はplaceholderを削除して永久ぐるぐるを防止
              ImageStorage.instance.delete(item.identifier);
              Logger.debug(`[ImageSharingSystem] removed missing placeholder: ${item.identifier}`);
            } else {
              request.push(item);
            }
          }
        }

        // Peer切断時などのエッジケースに対応する
        if (request.length < 1 && !this.hasActiveTask() && otherCatalog.length < ImageStorage.instance.getCatalog().length) {
          ImageStorage.instance.synchronize(event.sendFrom);
        }

        if (request.length < 1 || this.isLimitReceiveTask()) {
          return;
        }
        this.request(request, event.sendFrom);
      })
      .on('REQUEST_FILE_RESOURE', async event => {
        if (event.isSendFromSelf) return;

        let request: CatalogItem[] = event.data.identifiers;
        let randomRequest: CatalogItem[] = [];

        for (let item of request) {
          let image: ImageFile = ImageStorage.instance.get(item.identifier, false);
          if (image && item.state < image.state)
            randomRequest.push({ identifier: item.identifier, state: item.state });
        }

        if (this.isLimitSendTask() === false && 0 < randomRequest.length && !this.existsSendTask(event.data.receiver)) {
          // 送信
          let updateImages: ImageContext[] = this.makeSendUpdateImages(randomRequest);
          Logger.debug('REQUEST_FILE_RESOURE ImageStorageService Send!!! ' + event.data.receiver + ' -> ' + updateImages.length);
          this.startSendTask(updateImages, event.data.receiver);
        } else {
          // 中継
          let candidatePeers: string[] = event.data.candidatePeers;
          let index = candidatePeers.indexOf(Network.peerId);
          if (-1 < index) candidatePeers.splice(index, 1);

          for (let peerId of candidatePeers) {
            Logger.debug('REQUEST_FILE_RESOURE ImageStorageService Relay!!! ' + peerId + ' -> ' + event.data.identifiers);
            EventSystem.call(event, peerId);
            return;
          }
          Logger.debug('REQUEST_FILE_RESOURE ImageStorageService あぶれた...' + event.data.receiver, randomRequest.length);
        }
      })
      .on('UPDATE_FILE_RESOURE', 1000, event => {
        let updateImages: ImageContext[] = event.data.updateImages;
        Logger.debug('UPDATE_FILE_RESOURE ImageStorageService ' + event.sendFrom + ' -> ', updateImages);
        for (let context of updateImages) {
          if (context.blob) context.blob = new Blob([context.blob], { type: context.type });
          if (context.thumbnail.blob) context.thumbnail.blob = new Blob([context.thumbnail.blob], { type: context.thumbnail.type });
          ImageStorage.instance.add(context);
        }
      })
      .on('START_FILE_TRANSMISSION', event => {
        Logger.debug('START_FILE_TRANSMISSION ' + event.data.taskIdentifier);
        let identifier = event.data.taskIdentifier;
        let image: ImageFile = ImageStorage.instance.get(identifier, false);
        if (this.receiveTaskMap.has(identifier) || (image && ImageState.COMPLETE <= image.state)) {
          Logger.warn('CANCEL_TASK_ ' + identifier);
          EventSystem.call('CANCEL_TASK_' + identifier, null, event.sendFrom);
        } else {
          this.startReceiveTask(identifier);
        }
      });
  }

  /**
   * Reuses the normal per-file HTTP/P2P path for a catalog embedded in the
   * initial room ZIP.  The event is local but carries the selected source peer
   * so missing server media can still fall back to that peer.
   */
  applyInitialCatalog(catalog: CatalogItem[], sourcePeerId: string) {
    if (!Array.isArray(catalog) || !sourcePeerId) return;
    EventSystem.trigger({
      eventName: 'SYNCHRONIZE_FILE_LIST',
      data: catalog,
      sendFrom: sourcePeerId
    });
  }

  private destroy() {
    EventSystem.unregister(this);
  }

  private async startSendTask(updateImages: ImageContext[], sendTo: string) {
    let identifier = updateImages.length === 1 ? updateImages[0].identifier : UUID.generateUuid();
    let task = BufferSharingTask.createSendTask<ImageContext[]>(identifier, sendTo);
    this.sendTaskMap.set(task.identifier, task);
    EventSystem.call('START_FILE_TRANSMISSION', { taskIdentifier: identifier }, sendTo);

    /* hotfix issue #1 */
    for (let context of updateImages) {
      if (context.thumbnail.blob) {
        context.thumbnail.blob = <any>await FileReaderUtil.readAsArrayBufferAsync(context.thumbnail.blob);
      } else if (context.blob) {
        context.blob = <any>await FileReaderUtil.readAsArrayBufferAsync(context.blob);
      }
    }
    /* */

    task.onfinish = (task, data) => {
      this.stopSendTask(task.identifier);
      ImageStorage.instance.synchronize();
    }

    task.start(updateImages);
  }

  private startReceiveTask(identifier: string) {
    let task = BufferSharingTask.createReceiveTask<ImageContext[]>(identifier);
    this.receiveTaskMap.set(identifier, task);
    task.onfinish = (task, data) => {
      this.stopReceiveTask(task.identifier);
      if (data) EventSystem.trigger('UPDATE_FILE_RESOURE', { identifier: task.identifier, updateImages: data });
      ImageStorage.instance.synchronize();
    }

    task.start();
    Logger.debug('startReceiveTask => ', this.receiveTaskMap.size);
  }

  private stopSendTask(identifier: string) {
    let task = this.sendTaskMap.get(identifier);
    if (task) { task.cancel(); }
    this.sendTaskMap.delete(identifier);

    Logger.debug('stopSendTask => ', this.sendTaskMap.size);
  }

  private stopReceiveTask(identifier: string) {
    let task = this.receiveTaskMap.get(identifier);
    if (task) { task.cancel(); }
    this.receiveTaskMap.delete(identifier);

    Logger.debug('stopReceiveTask => ', this.receiveTaskMap.size);
  }

  private request(request: CatalogItem[], peerId: string) {
    Logger.debug('requestFile() ' + peerId);
    let peerIds = Network.peerIds;
    peerIds.splice(peerIds.indexOf(Network.peerId), 1);
    EventSystem.call('REQUEST_FILE_RESOURE', { identifiers: request, receiver: Network.peerId, candidatePeers: peerIds }, peerId);
  }

  private makeSendUpdateImages(catalog: CatalogItem[], maxSize: number = 1024 * 1024 * 0.5): ImageContext[] {
    let updateImages: ImageContext[] = [];
    let byteSize: number = 0;

    // Fisher-Yates
    for (let i = catalog.length - 1; 0 <= i; i--) {
      let rand = Math.floor(Math.random() * (i + 1));
      [catalog[i], catalog[rand]] = [catalog[rand], catalog[i]];
    }

    catalog.sort((a, b) => {
      if (a.state < b.state) return -1;
      if (a.state > b.state) return 1;
      return 0;
    });

    for (let i = 0; i < catalog.length; i++) {
      let item: { identifier: string, state: number } = catalog[i];
      let image: ImageFile = ImageStorage.instance.get(item.identifier, false);

      let context: ImageContext = {
        identifier: image.identifier,
        name: image.name,
        type: '',
        blob: null,
        url: null, 
        thumbnail: { type: '', blob: null, url: null, }
      };

      if (image.state === ImageState.URL) {
        context.url = image.url;
      } else if (item.state === ImageState.NULL) {
        context.thumbnail.blob = image.thumbnail.blob;//
        context.thumbnail.type = image.thumbnail.type;
      } else {
        context.blob = image.blob;//
        context.type = image.blob.type;
      }

      let size = context.blob
        ? context.blob.size
        : context.thumbnail.blob
          ? context.thumbnail.blob.size
          : 100;

      updateImages.push(context);
      byteSize += size;
      if (maxSize < byteSize) break;
    }
    return updateImages;
  }

  private hasActiveTask(): boolean {
    return 0 < this.sendTaskMap.size || 0 < this.receiveTaskMap.size;
  }

  private isLimitSendTask(): boolean {
    return this.maxSendTask <= this.sendTaskMap.size;
  }

  private isLimitReceiveTask(): boolean {
    return this.maxReceiveTask <= this.receiveTaskMap.size;
  }

  private existsSendTask(peerId: string): boolean {
    for (let task of this.sendTaskMap.values()) {
      if (task && task.sendTo === peerId) return true;
    }
    return false;
  }
}

function convertUrlImage(xmlElement: Element) {
  let urls: string[] = [];

  let imageElements = xmlElement.querySelectorAll('*[type="image"]');
  for (let i = 0; i < imageElements.length; i++) {
    let url = imageElements[i].innerHTML;
    if (!ImageStorage.instance.get(url) && 0 < MimeType.type(url).length) {
      urls.push(url);
    }
  }

  imageElements = xmlElement.querySelectorAll('*[imageIdentifier]');
  for (let i = 0; i < imageElements.length; i++) {
    let url = imageElements[i].getAttribute('imageIdentifier');
    if (!ImageStorage.instance.get(url) && 0 < MimeType.type(url).length) {
      urls.push(url);
    }
  }
  for (let url of urls) {
    ImageStorage.instance.add(url)
  }
}
