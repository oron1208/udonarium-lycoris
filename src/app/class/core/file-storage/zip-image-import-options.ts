export interface ZipImageImportOptions { maxDim: number; quality: number; }
export const ZIP_IMAGE_LIMIT = 2 * 1024 * 1024;

/** null cancels the ZIP; false preserves the original image bytes. */
export function chooseZipImageImport(count: number, bytes: number, source: 'zip' | 'files' = 'zip'): Promise<ZipImageImportOptions | false | null> {
  return new Promise(resolve => {
    const previous = document.activeElement as HTMLElement;
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-labelledby', 'zip-image-import-title');
    dialog.style.cssText = 'max-width:440px;width:calc(100% - 48px);padding:24px;border:1px solid #888;border-radius:8px;background:#fff;color:#222;box-shadow:0 8px 40px #0006;';
    dialog.innerHTML = `
      <h2 id="zip-image-import-title" style="margin-top:0;font-size:20px">${source === 'zip' ? 'ZIP内の大きな画像' : '大きな画像の取り込み'}</h2>
      <p>2MiBを超える画像が ${count} 枚（合計 ${(bytes / 1024 / 1024).toFixed(1)} MiB）あります。</p>
      <p><label><input type="radio" name="zip-image-mode" value="original" checked> 画質優先：圧縮せず取り込む</label></p>
      <p><label><input type="radio" name="zip-image-mode" value="compress"> 容量優先：大きな画像だけ圧縮する</label></p>
      <label>圧縮品質 <select disabled aria-label="圧縮品質">
        <option value="high">高画質（最大辺3840px・JPEG品質95%）</option>
        <option value="standard" selected>標準（最大辺1920px・JPEG品質85%）</option>
        <option value="small">容量優先（最大辺1280px・JPEG品質70%）</option>
      </select></label>
      <small style="display:block;margin:16px 0;color:#555;font-size:12px;line-height:1.6">
        圧縮すると、拡大時の細部が失われる場合があります。取り込み後は元の画質に戻せません。元の画像・ZIPは保管してください。<br>
        PNGは透過を保持して縮小し、JPEG品質の指定は適用しません。PNG・JPEG以外の形式（WebP・GIF等）は変換せず保持します。容量が減らない画像もそのまま取り込みます。<br>
        圧縮しない場合は、読み込み・同期時間やメモリ使用量が増えることがあります。
      </small>
      <div style="text-align:right"><button type="button" data-cancel>キャンセル</button> <button type="button" data-import>取り込む</button></div>`;
    const select = dialog.querySelector('select');
    const compress = dialog.querySelector<HTMLInputElement>('input[value="compress"]');
    dialog.addEventListener('change', () => select.disabled = !compress.checked);
    let settled = false;
    const finish = (value: ZipImageImportOptions | false | null) => {
      if (settled) return;
      settled = true;
      dialog.remove();
      previous?.focus();
      resolve(value);
    };
    dialog.querySelector('[data-cancel]').addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    dialog.querySelector('[data-import]').addEventListener('click', () => {
      const presets = { high: { maxDim: 3840, quality: 0.95 }, standard: { maxDim: 1920, quality: 0.85 }, small: { maxDim: 1280, quality: 0.7 } };
      finish(compress.checked ? presets[select.value] : false);
    });
    document.body.appendChild(dialog);
    (dialog as HTMLDialogElement & { showModal(): void }).showModal();
  });
}

/** Update archive references without keeping an old hash for changed bytes. */
export function remapZipImageReferences(xml: string, replacements: Map<string, string>): string {
  if (!replacements.size) return xml;
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.querySelector('parsererror')) throw new Error('Invalid archive XML');
  const replace = (value: string) => replacements.get(value.trim()) || value;
  for (const element of Array.from(document.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) attribute.value = replace(attribute.value);
    for (const node of Array.from(element.childNodes)) {
      if (node.nodeType === 3 || node.nodeType === 4) node.nodeValue = replace(node.nodeValue || '');
    }
  }
  return new XMLSerializer().serializeToString(document);
}
