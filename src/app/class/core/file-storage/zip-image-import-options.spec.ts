import * as JSZip from 'jszip';
import { FileArchiver } from './file-archiver';
import { FileReaderUtil } from './file-reader-util';
import { chooseZipImageImport, remapZipImageReferences, ZIP_IMAGE_LIMIT } from './zip-image-import-options';

describe('ZIP image import', () => {
  afterEach(() => document.querySelectorAll('dialog').forEach(dialog => dialog.remove()));

  it('defaults to preserving originals and exposes quality presets', async () => {
    const result = chooseZipImageImport(2, 6000000);
    const dialog = document.querySelector('dialog');
    expect(dialog.querySelector('select').disabled).toBeTrue();
    (dialog.querySelector('[data-import]') as HTMLElement).click();
    expect(await result).toBeFalse();
    const next = chooseZipImageImport(1, 3000000);
    const second = document.querySelector('dialog');
    (second.querySelector('input[value="compress"]') as HTMLElement).click();
    const select = second.querySelector('select');
    expect(select.disabled).toBeFalse();
    select.value = 'high';
    (second.querySelector('[data-import]') as HTMLElement).click();
    expect(await next).toEqual({ maxDim: 3840, quality: 0.95 });
  });

  it('rewrites XML text and attribute references without corrupting XML', () => {
    const xml = remapZipImageReferences('<root imageIdentifier="old&amp;id"><data type="image">old&amp;id</data><name>unchanged</name></root>', new Map([['old&id', 'newhash']]));
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    expect(doc.documentElement.getAttribute('imageIdentifier')).toBe('newhash');
    expect(doc.querySelector('data').textContent).toBe('newhash');
    expect(doc.querySelector('name').textContent).toBe('unchanged');
  });

  async function fixture(size: number) {
    const bytes = new Uint8Array(size);
    const original = new File([bytes], 'source.png', { type: 'image/png' });
    const hash = await FileReaderUtil.calcSHA256Async(original);
    const zip = new JSZip();
    zip.file('data.xml', `<root><data type="image">${hash}</data></root>`);
    zip.file(hash + '.png', bytes);
    return { file: new File([await zip.generateAsync({ type: 'arraybuffer' })], 'room.zip', { type: 'application/zip' }), original, hash };
  }
  async function waitDialog() {
    for (let i = 0; i < 300; i++) {
      const dialog = document.querySelector('dialog');
      if (dialog) return dialog;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Missing import dialog');
  }
  it('imports a small ZIP without prompting or compressing', async () => {
    const archive: any = FileArchiver.instance;
    const load = spyOn(archive, 'load').and.resolveTo();
    const compress = spyOn(archive, 'compressImage');
    await archive.handleZip((await fixture(128)).file);
    expect(document.querySelector('dialog')).toBeNull();
    expect(load).toHaveBeenCalled();
    expect(compress).not.toHaveBeenCalled();
  });
  it('cancels before importing any ZIP objects', async () => {
    const archive: any = FileArchiver.instance;
    const load = spyOn(archive, 'load').and.resolveTo();
    const run = archive.handleZip((await fixture(ZIP_IMAGE_LIMIT + 1)).file);
    const dialog = await waitDialog();
    (dialog.querySelector('[data-cancel]') as HTMLElement).click();
    await run;
    expect(load).not.toHaveBeenCalled();
  });
  it('keeps original bytes when quality priority is selected', async () => {
    const archive: any = FileArchiver.instance;
    const load = spyOn(archive, 'load').and.resolveTo();
    const input = await fixture(ZIP_IMAGE_LIMIT + 1);
    const run = archive.handleZip(input.file);
    (await waitDialog()).querySelector<HTMLElement>('[data-import]').click();
    await run;
    const image = load.calls.allArgs().map(args => args[0][0] as File).find(file => file.type === 'image/png');
    expect(await FileReaderUtil.calcSHA256Async(image)).toBe(input.hash);
  });
  it('uses the new content hash for both compressed bytes and XML references', async () => {
    const archive: any = FileArchiver.instance;
    const load = spyOn(archive, 'load').and.resolveTo();
    const compressed = new File(['compressed'], 'image.png', { type: 'image/png' });
    const compress = spyOn(archive, 'compressImage').and.resolveTo(compressed);
    const input = await fixture(ZIP_IMAGE_LIMIT + 1);
    const run = archive.handleZip(input.file);
    const dialog = await waitDialog();
    dialog.querySelector<HTMLElement>('input[value="compress"]').click();
    dialog.querySelector('select').value = 'small';
    dialog.querySelector<HTMLElement>('[data-import]').click();
    await run;
    expect(compress.calls.mostRecent().args.slice(1)).toEqual([1280, 0.7]);
    const hash = await FileReaderUtil.calcSHA256Async(compressed);
    const args = load.calls.allArgs();
    const image = args.find(args => args[0][0].type === 'image/png');
    expect(image[2]).toBe(hash);
    expect(image[1]).toBeTrue();
    const xml = await args.find(args => args[0][0].name === 'data.xml')[0][0].text();
    expect(xml).toContain(hash);
    expect(xml).not.toContain(input.hash);
  });
  for (const mode of ['original', 'compress', 'cancel', 'unsupported']) {
    it('direct image batch: ' + mode, async () => {
      const archive: any = FileArchiver.instance;
      const image = spyOn(archive, 'handleImage').and.resolveTo();
      for (const method of ['handleAudio', 'handleMediaManifest', 'handleText', 'handleZip']) spyOn(archive, method).and.resolveTo();
      const compressed = new File(['small'], 'source.png', { type: 'image/png' });
      const compress = spyOn(archive, 'compressImage').and.resolveTo(compressed);
      const original = new File([new Uint8Array(ZIP_IMAGE_LIMIT + 1)], 'source', { type: mode === 'unsupported' ? 'image/webp' : 'image/png' });
      const run = archive.load([original]);
      const dialog = await waitDialog();
      if (mode === 'compress' || mode === 'unsupported') {
        dialog.querySelector<HTMLElement>('input[value="compress"]').click();
        dialog.querySelector('select').value = 'high';
      }
      dialog.querySelector<HTMLElement>(mode === 'cancel' ? '[data-cancel]' : '[data-import]').click();
      await run;
      if (mode === 'cancel') expect(image).not.toHaveBeenCalled();
      else expect(image.calls.mostRecent().args[0]).toBe(mode === 'compress' ? compressed : original);
      if (mode === 'compress') expect(compress.calls.mostRecent().args.slice(1)).toEqual([3840, 0.95]);
      else expect(compress).not.toHaveBeenCalled();
    });
  }

});
