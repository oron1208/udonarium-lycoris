import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { EventSystem } from '@udonarium/core/system';
import { GameCharacter, AutoSoundTrigger } from '@udonarium/game-character';
import { ChatMessage } from '@udonarium/chat-message';
import { AudioStorage } from '@udonarium/core/file-storage/audio-storage';
import { AudioPlayer } from '@udonarium/core/file-storage/audio-player';

interface ActiveAutoSound {
  htmlAudio: HTMLAudioElement | null;  // server音の場合
  player: AudioPlayer | null;          // upload音の場合
  source: string;
  keyword: string;
  startedAt: number;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

interface AutoSoundFirePayload {
  characterIdentifier: string;
  audioIdentifier: string;
  animation: string;
  keyword: string;
}

export class AutoSoundService {
  private static _initialized = false;
  private static activeSounds: ActiveAutoSound[] = [];
  private static recentFireMap: { [key: string]: number } = {};

  static init() {
    if (AutoSoundService._initialized) return;
    AutoSoundService._initialized = true;
    console.log('[AutoSound] initializing AutoSoundService');

    const instance = new AutoSoundService();
    EventSystem.register(instance)
      .on('SEND_MESSAGE', 1000, event => {
        const chatMessage = ObjectStore.instance.get<ChatMessage>(event.data.messageIdentifier);
        if (!chatMessage) return;
        const character = AutoSoundService.findCharacterByName(chatMessage.name);
        if (!character) return;
        const text = chatMessage.text || '';
        AutoSoundService.checkChatTriggers(character, text);
      })
      .on('DICE_CUT_IN_STRUCTURED', event => {
        const rollResult = event.data?.rollResult;
        if (!rollResult) return;
        const character = AutoSoundService.findCharacterByName(rollResult.characterName || '');
        if (!character) return;
        if (rollResult.isCritical || rollResult.critical) AutoSoundService.fireReserved(character, '[CRITICAL]');
        if (rollResult.isFumble || rollResult.fumble) AutoSoundService.fireReserved(character, '[FUMBLE]');
        AutoSoundService.fireReserved(character, '[DICE]');
      })
      .on('AUTO_BUFF_APPLIED', event => {
        const id = event.data?.characterIdentifier;
        if (!id) return;
        const c = ObjectStore.instance.get<GameCharacter>(id);
        if (c) AutoSoundService.fireReserved(c, '[BUFF]');
      })
      .on('AUTO_SOUND_FIRE', event => {
        AutoSoundService.receiveFire(event.data as AutoSoundFirePayload);
      })
      .on('AUTO_SOUND_PLAY_UPLOAD', event => {
        const identifier = event.data?.identifier;
        const keyword = event.data?.keyword || '';
        if (!identifier) return;
        AutoSoundService.playUploadAudio(identifier, keyword);
      })
      .on('AUTO_SOUND_STOP_ALL', event => {
        AutoSoundService.stopLocalAll();
        EventSystem.trigger('AUTO_SOUND_STOPPED', {});
        console.log('[AutoSound] received STOP_ALL');
      });
  }

  private static findCharacterByName(name: string): GameCharacter | null {
    if (!name) return null;
    const chars = ObjectStore.instance.getObjects(GameCharacter);
    return chars.find(c => c.name === name) || null;
  }

  private static checkChatTriggers(character: GameCharacter, text: string) {
    for (const t of character.getAutoSoundTriggers()) {
      const kw = t.keyword?.trim();
      if (!kw || kw.startsWith('[')) continue;
      if (text.includes(kw)) AutoSoundService.fire(character, t);
    }
  }

  private static fireReserved(character: GameCharacter, reserved: string) {
    for (const t of character.getAutoSoundTriggers()) {
      if (t.keyword?.trim() === reserved) AutoSoundService.fire(character, t);
    }
  }

  private static fire(character: GameCharacter, trigger: AutoSoundTrigger) {
    if (!AutoSoundService.isEnabled()) return;
    EventSystem.call('AUTO_SOUND_FIRE', {
      characterIdentifier: character.identifier,
      audioIdentifier: trigger.audioIdentifier || '',
      animation: trigger.animation || '',
      keyword: trigger.keyword || ''
    } as AutoSoundFirePayload);
  }

  private static receiveFire(payload: AutoSoundFirePayload) {
    if (!AutoSoundService.isEnabled()) return;
    if (!payload || !payload.characterIdentifier) return;
    if (AutoSoundService.isDuplicateFire(payload)) return;

    if (payload.audioIdentifier) {
      if (payload.audioIdentifier.startsWith('server:')) {
        AutoSoundService.playServerAudio(payload.audioIdentifier, payload.keyword || '');
      } else {
        AutoSoundService.playUploadAudio(payload.audioIdentifier, payload.keyword || '');
      }
    }
    if (payload.animation) {
      EventSystem.trigger('CHARACTER_ANIMATION', { characterIdentifier: payload.characterIdentifier, animation: payload.animation });
    }
  }

  private static isDuplicateFire(payload: AutoSoundFirePayload): boolean {
    const now = Date.now();
    const key = `${payload.characterIdentifier}|${payload.audioIdentifier || ''}|${payload.animation || ''}|${payload.keyword || ''}`;
    for (const k of Object.keys(AutoSoundService.recentFireMap)) {
      if (now - AutoSoundService.recentFireMap[k] > 1200) delete AutoSoundService.recentFireMap[k];
    }
    if (AutoSoundService.recentFireMap[key] && now - AutoSoundService.recentFireMap[key] < 800) return true;
    AutoSoundService.recentFireMap[key] = now;
    return false;
  }

  private static playUploadAudio(identifier: string, keyword: string) {
    const audioFile = AudioStorage.instance.get(identifier);
    if (!audioFile) return;
    const player = new AudioPlayer();
    player.volume = 0.5;
    player.play(audioFile);
    const cleanupTimer = setTimeout(() => {
      AutoSoundService.removeEntry(entry);
      EventSystem.trigger('AUTO_SOUND_ENDED', { keyword });
    }, 60000);
    const entry: ActiveAutoSound = { htmlAudio: null, player, source: 'upload', keyword, startedAt: Date.now(), cleanupTimer };
    AutoSoundService.activeSounds.push(entry);
    EventSystem.trigger('AUTO_SOUND_STARTED', { source: 'upload', keyword });
  }

  private static playServerAudio(sourceId: string, keyword: string) {
    try {
      const trackId = sourceId.substring(7);
      const url = AutoSoundService.getAudioUrl(trackId);
      if (!url) return;
      const htmlAudio = new Audio(url);
      htmlAudio.volume = 0.5;
      htmlAudio.play().catch(e => console.warn('[AutoSound] play failed', e));
      const cleanupTimer = setTimeout(() => {
        AutoSoundService.removeEntry(entry);
        EventSystem.trigger('AUTO_SOUND_ENDED', { keyword });
      }, 60000);
      const entry: ActiveAutoSound = { htmlAudio, player: null, source: 'server', keyword, startedAt: Date.now(), cleanupTimer };
      htmlAudio.addEventListener('ended', () => {
        AutoSoundService.removeEntry(entry);
        EventSystem.trigger('AUTO_SOUND_ENDED', { keyword });
      });
      AutoSoundService.activeSounds.push(entry);
      EventSystem.trigger('AUTO_SOUND_STARTED', { source: 'server', keyword });
    } catch (e) { console.warn('[AutoSound] server audio error', e); }
  }

  private static removeEntry(entry: ActiveAutoSound) {
    const idx = AutoSoundService.activeSounds.indexOf(entry);
    if (idx >= 0) AutoSoundService.activeSounds.splice(idx, 1);
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
  }

  private static stopLocalAll() {
    for (const entry of AutoSoundService.activeSounds) {
      try { entry.htmlAudio?.pause(); } catch (_) { }
      try { entry.player?.stop(); } catch (_) { }
      if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
    }
    AutoSoundService.activeSounds = [];
  }

  static stopAll() {
    EventSystem.call('AUTO_SOUND_STOP_ALL', {});
    AutoSoundService.stopLocalAll();
    EventSystem.trigger('AUTO_SOUND_STOPPED', {});
    console.log('[AutoSound] stopped all');
  }

  static getActiveSoundsCount(): number {
    return AutoSoundService.activeSounds.length;
  }

  private static isEnabled(): boolean {
    try { return localStorage.getItem('udonarium.autoSound.enabled') !== '0'; } catch { return true; }
  }

  private static getAudioUrl(trackId: string): string | null {
    const svc = (window as any).__audioLibraryService;
    if (svc) return svc.getTrackUrl(trackId);
    return null;
  }
}
