import { GameCharacterComponent } from '../../../component/game-character/game-character.component';
import { CharacterGroupComponent } from '../../../component/character-group/character-group.component';

// Exercise the actual display-URL getters without constructing unrelated
// tabletop services. The old getter kept returning its small cached bitmap.
describe('Zoomable token image source', () => {
  for (const component of [GameCharacterComponent, CharacterGroupComponent]) {
    it(`${component.name} keeps original pixels through zoom and source changes`, async () => {
      const original = document.createElement('canvas');
      original.width = original.height = 1024;
      const ctx = original.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1024, 1024);
      ctx.fillStyle = '#000';
      for (let x = 0; x < 1024; x += 8) ctx.fillRect(x, 0, 4, 1024);
      const source = { url: original.toDataURL() };
      const instance: any = Object.create(component.prototype);
      Object.defineProperty(instance, 'imageFile', { get: () => source });
      instance.highQualityKomaImageSource = source.url;
      instance.highQualityKomaImageUrl = 'blob:obsolete-50px-thumbnail';
      const img = new Image();
      img.style.width = '50px';
      img.style.transform = 'scale(8)';
      document.body.appendChild(img);
      try {
        img.src = instance.komaDisplayImageUrl;
        await img.decode();
        expect(img.currentSrc).toBe(source.url);
        expect(img.naturalWidth).toBe(1024);
        expect(img.getBoundingClientRect().width).toBe(400);
        source.url = 'blob:new-character-image';
        expect(instance.komaDisplayImageUrl).toBe(source.url);
      } finally { img.remove(); }
    });
  }
});
