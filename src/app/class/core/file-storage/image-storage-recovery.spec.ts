import { EventSystem } from '../system';
import { ImageContext, ImageFile, ImageState } from './image-file';
import { ImageStorage } from './image-storage';
import { MediaCache } from './media-cache';
import { ServerMediaStorage } from './server-media-storage';

describe('ImageStorage missing-image recovery', () => {
  const identifier = 'a'.repeat(64);
  const observer = {};
  let storage: ImageStorage;
  let changes: jasmine.Spy;

  const context = (): ImageContext => ({
    identifier, name: 'restored.png', type: 'image/png',
    blob: new Blob(['restored image'], { type: 'image/png' }), url: '',
    thumbnail: { blob: null, type: '', url: '' },
  });
  const missing = (): ImageFile => {
    const image = storage.get(identifier, false);
    EventSystem.trigger('SERVER_MEDIA_MISSING', { kind: 'image', identifier });
    expect(image.missing).toBeTrue();
    return image;
  };

  beforeEach(() => {
    storage = ImageStorage.instance;
    storage.delete(identifier);
    storage.missingOnServer.delete(identifier);
    (ServerMediaStorage as any).knownOnServer.delete(identifier);
    (ServerMediaStorage as any).missingNotified.delete(`image:${identifier}`);
    spyOn(storage, 'lazySynchronize');
    spyOn(ServerMediaStorage, 'uploadImage').and.resolveTo();
    spyOn(MediaCache, 'cacheImage').and.resolveTo();
    changes = jasmine.createSpy('image ready to render');
    EventSystem.register(observer).on('IMAGE_FILE_CHANGED', event => {
      if (event.data.identifier === identifier) changes(storage.get(identifier, false)?.url);
    });
  });

  afterEach(() => {
    EventSystem.unregister(observer);
    storage.delete(identifier);
    storage.missingOnServer.delete(identifier);
    (ServerMediaStorage as any).missingNotified.delete(`image:${identifier}`);
  });

  it('does not classify a MISSING display SVG as a complete URL resource', () => {
    const image = missing();
    expect(image.url).toBe(ImageFile.MISSING_PLACEHOLDER_URL);
    expect(image.state).toBe(ImageState.NULL);
    expect(image.isEmpty).toBeFalse(); // Keep the visible MISSING indication.
    expect(storage.getCatalog().some(item => item.identifier === identifier)).toBeFalse();
  });

  it('restores the original referenced instance through the ZIP replace path', () => {
    const reference = missing();
    changes.calls.reset();
    const restored = storage.replace(context());
    expect(restored).toBe(reference);
    expect(reference.missing).toBeFalse();
    expect(reference.url).toMatch(/^blob:/);
    expect(changes).toHaveBeenCalledWith(reference.url);
    expect(MediaCache.cacheImage).toHaveBeenCalledWith(reference);
    expect(storage.missingOnServer.has(identifier)).toBeTrue(); // Still awaiting server PUT.
  });

  it('restores context additions, which bypass the ImageFile _add path', () => {
    const reference = missing();
    expect(storage.add(context())).toBe(reference);
    expect(reference.missing).toBeFalse();
    expect(reference.url).toMatch(/^blob:/);
    expect(changes).toHaveBeenCalledWith(reference.url);
  });

  it('merges raw context rather than a source ImageFile presentation URL', () => {
    const reference = storage.get(identifier, false);
    const source = ImageFile.create(context());
    source.missing = true;
    expect(source.url).toBe(ImageFile.MISSING_PLACEHOLDER_URL);
    storage.add(source);
    expect(reference.context.url).not.toBe(ImageFile.MISSING_PLACEHOLDER_URL);
    expect(reference.url).toMatch(/^blob:/);
  });

  it('keeps local bytes visible when an earlier server fetch reports a late 404', () => {
    const reference = storage.get(identifier, false);
    storage.replace(context());
    EventSystem.trigger('SERVER_MEDIA_MISSING', { kind: 'image', identifier });
    expect(storage.get(identifier, false)).toBe(reference);
    expect(reference.missing).toBeFalse();
    expect(reference.url).toMatch(/^blob:/);
  });

  it('re-evaluates a display flag even if the server latch was already cleared', () => {
    const reference = missing();
    reference.replace(context());
    storage.missingOnServer.delete(identifier);
    EventSystem.trigger('MEDIA_REPLENISHED', { kind: 'image', identifier });
    expect(reference.missing).toBeFalse();
    expect(changes).toHaveBeenCalledWith(reference.url);
  });

  it('clears the display flag through the actual server recovery notification', async () => {
    const reference = missing();
    reference.replace(context());
    await (ServerMediaStorage as any).notifyRecovered('image', identifier);
    expect(storage.missingOnServer.has(identifier)).toBeFalse();
    expect(reference.missing).toBeFalse();
    expect(changes).toHaveBeenCalledWith(reference.url);
  });

  it('can report and recover a second server-missing cycle for the same identifier', async () => {
    const reference = storage.get(identifier, false);
    for (let attempt = 0; attempt < 2; attempt++) {
      (ServerMediaStorage as any).notifyMissing('image', identifier);
      expect(reference.missing).toBeTrue();
      expect(storage.missingOnServer.has(identifier)).toBeTrue();
      await (ServerMediaStorage as any).notifyRecovered('image', identifier);
      expect(reference.missing).toBeFalse();
      expect(storage.missingOnServer.has(identifier)).toBeFalse();
    }
  });

  it('clears a missing display on a normal ZIP upload, not just a replenish upload', async () => {
    const reference = missing();
    reference.replace(context());
    spyOn(window, 'fetch').and.returnValues(
      Promise.resolve(new Response(null, { status: 404 })),
      Promise.resolve(new Response(null, { status: 201 })),
    );
    await (ServerMediaStorage as any).upload('image', identifier, context().blob);
    expect(reference.missing).toBeFalse();
    expect(storage.missingOnServer.has(identifier)).toBeFalse();
  });

  it('does not report a rejected hash-mismatch upload as server recovery', async () => {
    const reference = missing();
    spyOn(window, 'fetch').and.returnValues(
      Promise.resolve(new Response(null, { status: 404 })),
      Promise.resolve(new Response('Hash mismatch', { status: 409 })),
    );
    await (ServerMediaStorage as any).upload('image', identifier, context().blob);
    expect(reference.missing).toBeTrue();
    expect(storage.missingOnServer.has(identifier)).toBeTrue();
    expect((ServerMediaStorage as any).knownOnServer.has(identifier)).toBeFalse();
  });
});
