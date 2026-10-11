import { EventSystem, Network } from '../system';
import { AudioFile, AudioFileContext, AudioState } from './audio-file';
import { AudioStorage, CatalogItem } from './audio-storage';
import { BufferSharingTask } from './buffer-sharing-task';
import { FileReaderUtil } from './file-reader-util';
import { ServerMediaStorage } from './server-media-storage';
import { MediaLoadPriority } from './media-load-priority';
import { MediaCache } from './media-cache';
import { Logger } from '../system/util/logger';

export class AudioSharingSystem {
  private static _instance: AudioSharingSystem
  static get instance(): AudioSharingSystem {
    if (!AudioSharingSystem._instance) AudioSharingSystem._instance = new AudioSharingSystem();
    return AudioSharingSystem._instance;
  }

  private sendTaskMap: Map<string, BufferSharingTask<AudioFileContext>> = new Map();
  private receiveTaskMap: Map<string, BufferSharingTask<AudioFileContext>> = new Map();
  private maxSendTask: number = 6;
  private maxReceiveTask: number = 12;
  /** 直近に補充announceを出したidentifier（スパム防止） */
  private replenishAnnouncedAt: Map<string, number> = new Map();
  /** 補充待ち再取得の重複実行防止 */
  private replenishRetrying: Set<string> = new Set();


  private constructor() { }

  initialize() {
    Logger.debug('AudioSharingSystem ready...');
    this.destroy();
    EventSystem.register(this)
      .on('CONNECT_PEER', -1, event => {
        if (!event.isSendFromSelf) return;
        Logger.debug('CONNECT_PEER AudioStorageService !!!', event.data.peerId);
        // InitialRoomSync sends one room ZIP first.  Older peers are handled by
        // the explicit INITIAL_ROOM_SYNC_FALLBACK path below.
      })
      .on('INITIAL_ROOM_SYNC_FALLBACK', event => {
        if (!event.isSendFromSelf || !event.data?.peerId) return;
        AudioStorage.instance.synchronize(event.data.peerId);
      })
      .on('INITIAL_ROOM_MEDIA_CATALOG_FALLBACK', event => {
        if (!event.isSendFromSelf || !Array.isArray(event.data?.audios)) return;
        this.applyInitialCatalog(event.data.audios, event.data.sourcePeerId);
      })
      .on('SYNCHRONIZE_AUDIO_LIST', async event => {
        if (event.isSendFromSelf) return;
        Logger.debug('SYNCHRONIZE_AUDIO_LIST ' + event.sendFrom);

        let otherCatalog: CatalogItem[] = event.data;
        let request: CatalogItem[] = [];

        Logger.debug('SYNCHRONIZE_AUDIO_LIST active tasks ', this.sendTaskMap.size + this.receiveTaskMap.size);

        // name復元＋フィルタを先に処理
        const needFetch: CatalogItem[] = [];
        for (let item of otherCatalog) {
          let audio: AudioFile = AudioStorage.instance.get(item.identifier, false);
          if (audio === null) {
            audio = AudioFile.createEmpty(item.identifier);
            AudioStorage.instance.add(audio);
          }
          // カタログにnameが含まれていれば事前設定（ハッシュ値・空文字表示を防ぐ）
          if (item.name && (!audio.name || audio.name === audio.identifier)) {
            let ctx = audio.toContext();
            ctx.name = item.name;
            audio.apply(ctx);
          }
          if (audio.state < AudioState.COMPLETE && !this.receiveTaskMap.has(item.identifier)) {
            needFetch.push(item);
          }
        }

        // 再生中/参照中の音声を先に、未使用BGM素材は低優先度・少数並列で後回しにする
        const priorityScores = MediaLoadPriority.getAudioScoreMap();
        const prioritizedFetch = MediaLoadPriority.sortByScore(needFetch, priorityScores);
        const hasActiveAudio = prioritizedFetch.some(item => MediaLoadPriority.scoreOf(priorityScores, item.identifier) >= MediaLoadPriority.ACTIVE_AUDIO_SCORE);
        if (!hasActiveAudio && prioritizedFetch.length > 0) await this.sleep(750);
        for (let i = 0; i < prioritizedFetch.length;) {
          const score = MediaLoadPriority.scoreOf(priorityScores, prioritizedFetch[i].identifier);
          const batchSize = score >= MediaLoadPriority.ACTIVE_AUDIO_SCORE ? 8 : 3;
          const priority = MediaLoadPriority.fetchPriority(score, MediaLoadPriority.ACTIVE_AUDIO_SCORE);
          const batch = prioritizedFetch.slice(i, i + batchSize);
          i += batch.length;
          const results = await Promise.all(
            batch.map(async item => {
              try {
                const result = await MediaCache.fetchAudioWithCache(item.identifier, priority);
                return { item, result };
              } catch (e) {
                return { item, result: { status: 'unreachable' as const } };
              }
            })
          );
          for (const { item, result } of results) {
            if (result.status === 'ok') {
              AudioStorage.instance.add(result.file);
            } else if (result.status === 'missing') {
              // サーバーに存在しない音声はplaceholderを削除し、所持者が再アップロードして自己修復する
              AudioStorage.instance.delete(item.identifier);
              this.requestReplenish(item.identifier);
              Logger.debug(`[AudioSharingSystem] removed missing placeholder: ${item.identifier}`);
            } else {
              request.push(item);
            }
          }
        }

        // Peer切断時などのエッジケースに対応する
        if (request.length < 1 && !this.hasActiveTask() && otherCatalog.length < AudioStorage.instance.getCatalog().length) {
          AudioStorage.instance.synchronize(event.sendFrom);
        }

        if (request.length < 1 || this.isLimitReceiveTask()) {
          return;
        }
        let index = Math.floor(Math.random() * request.length);
        this.request([request[index]], event.sendFrom);
      })
      .on('REQUEST_AUDIO_RESOURE', event => {
        if (event.isSendFromSelf) return;

        let request: CatalogItem[] = event.data.identifiers;
        let randomRequest: CatalogItem[] = [];

        for (let item of request) {
          let audio: AudioFile = AudioStorage.instance.get(item.identifier, false);
          if (audio && item.state < audio.state) randomRequest.push({ identifier: item.identifier, state: item.state });
        }

        if (this.isLimitSendTask() === false && 0 < randomRequest.length && !this.existsSendTask(event.data.receiver)) {
          // 送信
          Logger.debug('REQUEST_AUDIO_RESOURE Send!!! ' + event.data.receiver + ' -> ' + randomRequest);
          let index = Math.floor(Math.random() * randomRequest.length);
          let item: { identifier: string, state: number } = randomRequest[index];
          let audio: AudioFile = AudioStorage.instance.get(item.identifier, false);
          this.startSendTask(audio, event.data.receiver);
        } else {
          // 中継
          let candidatePeers: string[] = event.data.candidatePeers;
          let index = candidatePeers.indexOf(Network.peerId);
          if (-1 < index) candidatePeers.splice(index, 1);

          for (let peerId of candidatePeers) {
            Logger.debug('REQUEST_AUDIO_RESOURE AudioStorageService Relay!!! ' + peerId + ' -> ' + event.data.identifiers);
            EventSystem.call(event, peerId);
            return;
          }
          Logger.debug('REQUEST_FILE_RESOURE AudioStorageService あぶれた...' + event.data.receiver, randomRequest.length);
        }
      })
      .on('UPDATE_AUDIO_RESOURE', 1000, event => {
        let updateAudios: AudioFileContext[] = event.data;
        Logger.debug('UPDATE_AUDIO_RESOURE AudioStorageService ' + event.sendFrom + ' -> ', updateAudios);
        for (let context of updateAudios) {
          if (context.blob) context.blob = new Blob([context.blob], { type: context.type });
          AudioStorage.instance.add(context);
        }
      })
      .on('START_AUDIO_TRANSMISSION', event => {
        Logger.debug('START_AUDIO_TRANSMISSION ' + event.data.fileIdentifier);
        let identifier: string = event.data.fileIdentifier;
        let audio: AudioFile = AudioStorage.instance.get(identifier, false);
        if (this.receiveTaskMap.has(identifier) || (audio && AudioState.COMPLETE <= audio.state)) {
          Logger.warn('CANCEL_TASK_ ' + identifier);
          EventSystem.call('CANCEL_TASK_' + identifier, null, event.sendFrom);
        } else {
          this.startReceiveTask(identifier);
        }
      })
      .on('REQUEST_MEDIA_REPLENISH', event => {
        if (event.isSendFromSelf) return;
        const identifier: string = event.data?.identifier;
        if (!identifier || event.data?.kind !== 'audio' || !/^[a-f0-9]{64}$/i.test(identifier)) return;
        const audio: AudioFile = AudioStorage.instance.get(identifier, false);
        // blob を完全所持しているピアだけが補充候補になる
        if (!audio || audio.state < AudioState.COMPLETE || audio.state >= AudioState.URL || !audio.blob) return;
        const blob: Blob = audio.blob;
        const name: string = audio.name;
        const waitMs = Math.floor(Math.random() * 1500);
        Logger.debug(`[AudioSharingSystem] replenish candidate ${identifier.slice(0, 12)} in ${waitMs}ms`);
        setTimeout(() => {
          void ServerMediaStorage.replenishUploadAudio(identifier, blob, name);
        }, waitMs);
      });
  }

  /** Re-enters the existing individual media synchronization path. */
  applyInitialCatalog(catalog: CatalogItem[], sourcePeerId: string) {
    if (!Array.isArray(catalog) || !sourcePeerId) return;
    EventSystem.trigger({
      eventName: 'SYNCHRONIZE_AUDIO_LIST',
      data: catalog,
      sendFrom: sourcePeerId
    });
  }

  private destroy() {
    EventSystem.unregister(this);
  }

  private async startSendTask(audio: AudioFile, sendTo: string) {
    let task = BufferSharingTask.createSendTask<AudioFileContext>(audio.identifier, sendTo);
    this.sendTaskMap.set(audio.identifier, task);

    EventSystem.call('START_AUDIO_TRANSMISSION', { fileIdentifier: audio.identifier }, sendTo);

    let context: AudioFileContext = {
      identifier: audio.identifier,
      name: audio.name,
      blob: null,
      type: '',
      url: null
    };

    if (audio.state === AudioState.URL) {
      context.url = audio.url;
    } else {
      context.blob = <any>await FileReaderUtil.readAsArrayBufferAsync(audio.blob);
      context.type = audio.blob.type;
    }

    task.onfinish = () => {
      this.stopSendTask(task.identifier);
      AudioStorage.instance.synchronize();
    }

    task.start(context);
  }

  private startReceiveTask(identifier: string) {
    let audio: AudioFile = AudioStorage.instance.get(identifier, false);
    let task = BufferSharingTask.createReceiveTask<AudioFileContext>(identifier);
    this.receiveTaskMap.set(identifier, task);

    task.onprogress = (task, loaded, total) => {
      // 進捗表示でnameを上書きしないようにblobのurlだけで進捗を通知
      // nameは受信完了時のonfinishで正しい値が復元される
    }
    task.onfinish = (task, data) => {
      this.stopReceiveTask(task.identifier);
      if (data) {
        // 受信完了時に確実に正しいnameを復元する
        let context = data as AudioFileContext;
        if (context.name && audio.identifier) {
          let audioCtx = audio.toContext();
          audioCtx.name = context.name;
          audio.apply(audioCtx);
        }
        EventSystem.trigger('UPDATE_AUDIO_RESOURE', [data]);
      }
      AudioStorage.instance.synchronize();
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
    EventSystem.call('REQUEST_AUDIO_RESOURE', { identifiers: request, receiver: Network.peerId, candidatePeers: peerIds }, peerId);
  }

  /** サーバー404を観測した音声の補充を部屋に依頼し、自分も後刻再取得を試みる */
  private requestReplenish(identifier: string) {
    if (!/^[a-f0-9]{64}$/i.test(identifier)) return;
    const now = Date.now();
    const last = this.replenishAnnouncedAt.get(identifier) ?? 0;
    if (now - last < 30000) return;
    this.replenishAnnouncedAt.set(identifier, now);
    Logger.debug(`[AudioSharingSystem] replenish announce: ${identifier.slice(0, 12)}`);
    // 自分がblob完全所持なら自分で再PUTする（1人部屋では他ピアに依頼できないため自己修復）
    const self = AudioStorage.instance.get(identifier, false);
    if (self && AudioState.COMPLETE <= self.state && self.state < AudioState.URL && self.blob) {
      const blob = self.blob;
      const name = self.name;
      const waitMs = Math.floor(Math.random() * 1500);
      setTimeout(() => { void ServerMediaStorage.replenishUploadAudio(identifier, blob, name); }, waitMs);
    }
    EventSystem.call('REQUEST_MEDIA_REPLENISH', { identifier, requester: Network.peerId, kind: 'audio' });
    this.scheduleReplenishRetry(identifier);
  }

  /** 補充を待って再取得（2.5/5/8秒後の最大3回）。取得できたらAudioStorageへ戻す */
  private scheduleReplenishRetry(identifier: string) {
    if (this.replenishRetrying.has(identifier)) return;
    this.replenishRetrying.add(identifier);
    void (async () => {
      try {
        const attempts = [2500, 5000, 8000];
        for (const delayMs of attempts) {
          await new Promise<void>(resolve => setTimeout(resolve, delayMs));
          const local: AudioFile = AudioStorage.instance.get(identifier, false);
          if (local && AudioState.COMPLETE <= local.state && local.state < AudioState.URL) return;
          try {
            const result = await MediaCache.fetchAudioWithCache(identifier);
            if (result.status === 'ok') {
              AudioStorage.instance.add(result.file);
              Logger.debug(`[AudioSharingSystem] replenished: ${identifier.slice(0, 12)}`);
              return;
            }
            if (result.status === 'unreachable') return;
          } catch { return; }
        }
      } finally {
        this.replenishRetrying.delete(identifier);
      }
    })();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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
