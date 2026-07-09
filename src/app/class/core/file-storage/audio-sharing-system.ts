import { EventSystem, Network } from '../system';
import { AudioFile, AudioFileContext, AudioState } from './audio-file';
import { AudioStorage, CatalogItem } from './audio-storage';
import { BufferSharingTask } from './buffer-sharing-task';
import { FileReaderUtil } from './file-reader-util';
import { ServerMediaStorage } from './server-media-storage';
import { MediaLoadPriority } from './media-load-priority';
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


  private constructor() { }

  initialize() {
    Logger.debug('AudioSharingSystem ready...');
    this.destroy();
    EventSystem.register(this)
      .on('CONNECT_PEER', -1, event => {
        if (!event.isSendFromSelf) return;
        Logger.debug('CONNECT_PEER AudioStorageService !!!', event.data.peerId);
        AudioStorage.instance.synchronize();
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
                const result = await ServerMediaStorage.fetchAudio(item.identifier, priority);
                return { item, result };
              } catch (e) {
                return { item, result: { status: 'unreachable' as const } };
              }
            })
          );
          for (const { item, result } of results) {
            if (result.status === 'ok') {
              AudioStorage.instance.add(result.file);
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
