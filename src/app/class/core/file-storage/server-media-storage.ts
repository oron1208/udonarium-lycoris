import { EventSystem } from '../system';
import { AudioFile } from './audio-file';
import { ImageFile } from './image-file';

export class ServerMediaStorage {
  private static uploading: Set<string> = new Set();
  private static fetching: Set<string> = new Set();
  private static missingNotified: Set<string> = new Set();

  static async uploadImage(image: ImageFile): Promise<void> {
    const context = image.toContext();
    if (!context || !context.identifier || !context.blob) return;
    await this.upload('image', context.identifier, context.blob, context.name);
  }

  static async uploadAudio(audio: AudioFile): Promise<void> {
    const context = audio.toContext();
    if (!context || !context.identifier || !context.blob) return;
    await this.upload('audio', context.identifier, context.blob, context.name);
  }

  static async fetchImage(identifier: string): Promise<ImageFile | null> {
    const blob = await this.fetchBlob('image', identifier);
    if (!blob) return null;
    return await ImageFile.createAsync(blob);
  }

  static async fetchAudio(identifier: string): Promise<AudioFile | null> {
    const blob = await this.fetchBlob('audio', identifier);
    if (!blob) return null;
    return await AudioFile.createAsync(blob);
  }

  private static async upload(kind: 'image' | 'audio', identifier: string, blob: Blob, name?: string): Promise<void> {
    const key = `${kind}:${identifier}`;
    if (this.uploading.has(key)) return;
    this.uploading.add(key);
    try {
      const response = await fetch(`/api/media/${kind}/${encodeURIComponent(identifier)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': blob.type || 'application/octet-stream',
          'X-File-Name': encodeURIComponent(name || identifier),
        },
        body: blob,
      });
      if (!response.ok && response.status !== 409) console.warn(`media upload failed ${kind}:${identifier}`, response.status, await response.text().catch(() => ''));
    } catch (error) {
      console.warn(`media upload failed ${kind}:${identifier}`, error);
    } finally {
      this.uploading.delete(key);
    }
  }

  private static async fetchBlob(kind: 'image' | 'audio', identifier: string): Promise<Blob | null> {
    const key = `${kind}:${identifier}`;
    if (this.fetching.has(key)) return null;
    this.fetching.add(key);
    try {
      const response = await fetch(`/api/media/${kind}/${encodeURIComponent(identifier)}`);
      if (!response.ok) {
        if (response.status === 404) this.notifyMissing(kind, identifier);
        return null;
      }
      return await response.blob();
    } catch (error) {
      console.warn(`media fetch failed ${kind}:${identifier}`, error);
      return null;
    } finally {
      this.fetching.delete(key);
    }
  }

  private static notifyMissing(kind: 'image' | 'audio', identifier: string) {
    const key = `${kind}:${identifier}`;
    if (this.missingNotified.has(key)) return;
    this.missingNotified.add(key);
    EventSystem.trigger('SERVER_MEDIA_MISSING', { kind, identifier });
  }
}
