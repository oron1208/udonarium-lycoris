/**
 * 内容ハッシュ型identifier（SHA-256）とblobの整合を検証する共通ユーティリティ。
 *
 * 画像・音声のidentifierはblob内容のSHA-256（file-processing.worker の sha256Hex が生成）。
 * クラッシュ・破損・不正データで中身が変わったblobはハッシュが一致しないため検知できる。
 * サーバー応答・P2P受信・キャッシュ保存のすべての入口で検証に使う（破損拡散の遮断）。
 */
export class BlobIntegrity {
  /** blobのSHA-256がidentifierと一致するか検証する（中身が1bitでも壊れていればfalse） */
  static async isIntact(identifier: string, blob: Blob): Promise<boolean> {
    try {
      const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
      const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
      return hex === identifier.toLowerCase();
    } catch (e) {
      return false;
    }
  }
}
