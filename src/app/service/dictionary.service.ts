import { Injectable } from '@angular/core';
import { ObjectSerializer } from '@udonarium/core/synchronize-object/object-serializer';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { EventSystem } from '@udonarium/core/system';
import { UUID } from '@udonarium/core/system/util/uuid';
import { ImageStorage } from '@udonarium/core/file-storage/image-storage';
import { ImageFile } from '@udonarium/core/file-storage/image-file';
import { ChatPalette } from '@udonarium/chat-palette';
import { DataElement } from '@udonarium/data-element';
import { GameCharacter } from '@udonarium/game-character';
import { PresetSound, SoundEffect } from '@udonarium/sound-effect';
import * as JSZip from 'jszip';
import { Logger } from '../class/core/system/util/logger';

export interface DictImageRef {
  identifier: string;
  name: string;
  url: string; // dataURL
}

export interface DictCharacter {
  id: string;
  dictId?: string;
  name: string;
  tags: string[];
  xml: string;
  images: DictImageRef[];
  createdAt: number;
  updatedAt?: number;
  order?: number;
}

export interface DictPage {
  id: string;
  type: 'text' | 'image';
  title: string;
  text?: string;
  imageUrl?: string;
  imageName?: string;
  isZoom?: boolean;
}

export interface DictMaterial {
  id: string;
  dictId?: string;
  title: string;
  pages: DictPage[];
  createdAt: number;
  updatedAt?: number;
  order?: number;
}

export interface DictPalette {
  id: string;
  dictId?: string;
  name: string;
  dicebot: string;
  text: string;
  tags: string[];
  createdAt: number;
  updatedAt?: number;
  order?: number;
}

export type DictType = 'characters' | 'materials' | 'palettes';

/** ユーザーが作れる辞書(コレクション)。タイプは作成時に決めて以後固定 */
export interface DictCollection {
  id: string;
  name: string;
  type: DictType;
  createdAt: number;
  order?: number;
}

export interface DictData {
  version: number;
  exportedAt?: number;
  /** v2: 辞書単位の書き出し時に付く */
  dictionary?: { name: string; type: DictType };
  characters: DictCharacter[];
  materials: DictMaterial[];
  palettes: DictPalette[];
}

export interface DictImportResult {
  characters: number;
  materials: number;
  palettes: number;
  skipped?: number;
  createdDictId?: string;
  createdDictName?: string;
  legacy?: boolean;
}

const DB_NAME = 'lycoris-dictionary';
const DB_VERSION = 2;
const STORES = ['characters', 'materials', 'palettes', 'dictionaries'] as const;
const DEFAULT_DICT_NAMES: Record<DictType, string> = { characters: 'コマ辞書', materials: '資料辞書', palettes: 'チャパレ辞書' };
type StoreName = typeof STORES[number];

/**
 * FVTT風の辞書機能。
 * - コマ辞書: キャラXMLを登録し、卓へドラッグ＆ドロップまたはボタンで出す(名前は(1)(2)と連番)
 * - 資料辞書: セクション→ページ構成のテキスト/画像資料
 * - チャパレ辞書: チャットパレットの定型を登録し、コマへ適用(置換/追記)
 *
 * データはこの端末ローカル(IndexedDB)。JSON/ZIPで入出力できる。
 */
@Injectable({ providedIn: 'root' })
export class DictionaryService {
  characters: DictCharacter[] = [];
  materials: DictMaterial[] = [];
  palettes: DictPalette[] = [];
  collections: DictCollection[] = [];
  isReady = false;
  /** 右クリック「辞書に登録」で最後に使ったコマ辞書（ピッカー初期選択用・メモリ上のみ） */
  lastCharacterDictId = '';

  private db: IDBDatabase | null = null;
  private openPromise: Promise<IDBDatabase> | null = null;

  constructor() {
    this.open()
      .then(async db => {
        this.collections = (await this.getAll<DictCollection>('dictionaries')).sort(this.byOrder);
        this.characters = (await this.getAll<DictCharacter>('characters')).sort(this.byOrder);
        this.materials = (await this.getAll<DictMaterial>('materials')).sort(this.byOrder);
        this.palettes = (await this.getAll<DictPalette>('palettes')).sort(this.byOrder);
        await this.migrate();
        this.isReady = true;
        Logger.debug(`[Dictionary] loaded dictionaries=${this.collections.length} characters=${this.characters.length} materials=${this.materials.length} palettes=${this.palettes.length}`);
        EventSystem.trigger('DICTIONARY_CHANGED', {});
      })
      .catch(e => {
        Logger.error('[Dictionary] IndexedDB open failed. in-memory mode. ' + e);
        this.collections = this.fallbackCollections();
        this.isReady = true;
        EventSystem.trigger('DICTIONARY_CHANGED', {});
      });
  }

  private fallbackCollections(): DictCollection[] {
    const now = Date.now();
    return (['characters', 'materials', 'palettes'] as DictType[]).map((type, i) => ({ id: 'Dmem' + i, name: DEFAULT_DICT_NAMES[type], type, createdAt: now + i }));
  }

  /** v1→v2移行: 辞書が無ければ既定3辞書を作り、所属が決まっていない/不正なエントリを既定辞書へ振り分ける */
  private async migrate() {
    let changed = false;
    for (const type of ['characters', 'materials', 'palettes'] as DictType[]) {
      if (!this.collections.some(c => c.type === type)) {
        const col: DictCollection = { id: 'D' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), name: DEFAULT_DICT_NAMES[type], type, createdAt: Date.now() };
        this.collections.push(col);
        await this.put('dictionaries', col).catch(() => { });
        changed = true;
      }
    }
    this.collections.sort(this.byOrder);
    const ids = new Set(this.collections.map(c => c.id));
    const fix = async (store: StoreName, entries: { dictId?: string }[]) => {
      const target = this.collections.find(c => c.type === store)!.id;
      for (const e of entries) {
        if (e.dictId && ids.has(e.dictId)) continue;
        e.dictId = target;
        await this.put(store, e).catch(() => { });
        changed = true;
      }
    };
    await fix('characters', this.characters);
    await fix('materials', this.materials);
    await fix('palettes', this.palettes);
    if (changed) Logger.debug('[Dictionary] migrated: dictionaries=' + this.collections.length);
  }

  private open(): Promise<IDBDatabase> {
    if (this.openPromise) return this.openPromise;
    this.openPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const store of STORES) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => { this.db = req.result; resolve(req.result); };
      req.onerror = () => reject(req.error);
    });
    return this.openPromise;
  }

  private async getAll<T>(store: StoreName): Promise<T[]> {
    const db = await this.open();
    return new Promise<T[]>((resolve, reject) => {
      const req = db.transaction(store, 'readonly').objectStore(store).getAll();
      req.onsuccess = () => resolve((req.result || []) as T[]);
      req.onerror = () => reject(req.error);
    });
  }

  private async put<T>(store: StoreName, value: T): Promise<void> {
    const db = await this.open();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  private async deleteFrom(store: StoreName, id: string): Promise<void> {
    const db = await this.open();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  private notify() { EventSystem.trigger('DICTIONARY_CHANGED', {}); }

  private byOrder = (a: { order?: number, createdAt: number }, b: { order?: number, createdAt: number }) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt);

  /** 表示順を入れ替える(order値を交換して永続化)。同じ辞書(コレクション)内でのみ並べ替える */
  async moveEntry(store: 'characters' | 'materials' | 'palettes', id: string, dir: -1 | 1) {
    const array: { id: string, order?: number, createdAt: number, dictId?: string }[] = store === 'characters' ? this.characters : store === 'materials' ? this.materials : this.palettes;
    const entry = array.find(e => e.id === id);
    if (!entry) return;
    const list = array.filter(e => e.dictId === entry.dictId);
    const i = list.findIndex(e => e.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || list.length <= j) return;
    const tmp = list[i].order ?? list[i].createdAt;
    list[i].order = list[j].order ?? list[j].createdAt;
    list[j].order = tmp;
    array.sort(this.byOrder);
    await Promise.all([this.put(store, list[i]), this.put(store, list[j])]);
    this.notify();
  }

  // ── 辞書(コレクション)管理 ──
  getCollection(id: string): DictCollection | null { return this.collections.find(c => c.id === id) ?? null; }
  collectionsOfType(type: DictType): DictCollection[] { return this.collections.filter(c => c.type === type); }
  countOf(type: DictType, dictId: string): number {
    const arr: { dictId?: string }[] = type === 'characters' ? this.characters : type === 'materials' ? this.materials : this.palettes;
    return arr.filter(e => e.dictId === dictId).length;
  }
  entriesOfCharacters(dictId: string): DictCharacter[] { return this.characters.filter(c => c.dictId === dictId); }
  entriesOfMaterials(dictId: string): DictMaterial[] { return this.materials.filter(m => m.dictId === dictId); }
  entriesOfPalettes(dictId: string): DictPalette[] { return this.palettes.filter(p => p.dictId === dictId); }

  async addCollection(name: string, type: DictType): Promise<DictCollection> {
    const col: DictCollection = { id: 'D' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), name: (name || '').trim() || DEFAULT_DICT_NAMES[type], type, createdAt: Date.now() };
    col.name = this.uniqueCollectionName(col.name, type);
    this.collections.push(col);
    this.collections.sort(this.byOrder);
    await this.put('dictionaries', col).catch(() => { });
    this.notify();
    return col;
  }

  async renameCollection(id: string, name: string) {
    const col = this.getCollection(id);
    if (!col || !(name || '').trim()) return;
    col.name = name.trim();
    await this.put('dictionaries', col).catch(() => { });
    this.notify();
  }

  async removeCollection(id: string) {
    const col = this.getCollection(id);
    if (!col) return;
    this.collections = this.collections.filter(c => c.id !== id);
    await this.deleteFrom('dictionaries', id).catch(() => { });
    const remove = col.type === 'characters' ? (x: string) => this.removeCharacter(x) : col.type === 'materials' ? (x: string) => this.removeMaterial(x) : (x: string) => this.removePalette(x);
    for (const e of this.entriesOf(col.type, id).slice()) await remove(e.id);
    this.notify();
  }

  private entriesOf(type: DictType, dictId: string): { id: string }[] {
    return type === 'characters' ? this.entriesOfCharacters(dictId) : type === 'materials' ? this.entriesOfMaterials(dictId) : this.entriesOfPalettes(dictId);
  }

  private uniqueCollectionName(base: string, type: DictType): string {
    const names = new Set(this.collections.filter(c => c.type === type).map(c => c.name));
    if (!names.has(base)) return base;
    let max = 0;
    const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\((\\d+)\\)$');
    for (const n of names) { const m = re.exec(n); if (m) max = Math.max(max, Number(m[1])); }
    return `${base}(${max + 1})`;
  }

  getCharacter(id: string): DictCharacter | null { return this.characters.find(c => c.id === id) ?? null; }
  getMaterial(id: string): DictMaterial | null { return this.materials.find(m => m.id === id) ?? null; }
  getPalette(id: string): DictPalette | null { return this.palettes.find(p => p.id === id) ?? null; }

  async saveCharacter(entry: DictCharacter) {
    entry.updatedAt = Date.now();
    const i = this.characters.findIndex(c => c.id === entry.id);
    if (0 <= i) this.characters[i] = entry; else this.characters.push(entry);
    await this.put('characters', entry);
    this.notify();
  }

  async removeCharacter(id: string) {
    this.characters = this.characters.filter(c => c.id !== id);
    await this.deleteFrom('characters', id);
    this.notify();
  }

  async saveMaterial(entry: DictMaterial) {
    entry.updatedAt = Date.now();
    const i = this.materials.findIndex(m => m.id === entry.id);
    if (0 <= i) this.materials[i] = entry; else this.materials.push(entry);
    await this.put('materials', entry);
    this.notify();
  }

  async removeMaterial(id: string) {
    this.materials = this.materials.filter(m => m.id !== id);
    await this.deleteFrom('materials', id);
    this.notify();
  }

  async savePalette(entry: DictPalette) {
    entry.updatedAt = Date.now();
    const i = this.palettes.findIndex(p => p.id === entry.id);
    if (0 <= i) this.palettes[i] = entry; else this.palettes.push(entry);
    await this.put('palettes', entry);
    this.notify();
  }

  async removePalette(id: string) {
    this.palettes = this.palettes.filter(p => p.id !== id);
    await this.deleteFrom('palettes', id);
    this.notify();
  }

  private async toDataURL(url: string): Promise<string> {
    if (!url) return '';
    if (url.startsWith('data:')) return url;
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    } catch (e) {
      return '';
    }
  }

  /**
   * キャラXMLを辞書へ登録する。
   * identifier属性は取り除いて保存する(出すたびに新しいidentifierが振られ、同じモンスターを複数出せる)。
   */
  async registerCharacterXml(xml: string, fallbackName: string = '名称未設定', dictId?: string): Promise<DictCharacter | null> {
    if (!xml) return null;
    const target = (dictId ? this.getCollection(dictId) : null) ?? this.collectionsOfType('characters')[0] ?? null;
    if (!target) return null;
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const root = doc.querySelector('character') || doc.documentElement;
    if (!root) return null;
    // 名前: name属性 → 直下の<name>子要素 → 共通データ要素(name) → fallback の順
    const nameChild = root.querySelector(':scope > name');
    const nameFromChild = nameChild ? (nameChild.textContent || '').trim() : '';
    const nameDataEl = doc.querySelector('data[name="name"]');
    const nameFromData = nameDataEl ? (nameDataEl.textContent || '').trim() : '';
    const name = (root.getAttribute('name') || nameFromChild || nameFromData || fallbackName).trim() || fallbackName;

    const images: DictImageRef[] = [];
    const imageIds = new Set<string>();
    const rootImageId = root.getAttribute('imageIdentifier');
    if (rootImageId) imageIds.add(rootImageId);
    for (const el of Array.from(doc.querySelectorAll('[imageIdentifier]'))) {
      const id = el.getAttribute('imageIdentifier');
      if (id) imageIds.add(id);
    }
    // ユドナリウム保存形式の画像参照（<data type="image" name="imageIdentifier">ID</data>。属性ではなくデータ要素に入る）
    for (const el of Array.from(doc.querySelectorAll('data[name="imageIdentifier"]'))) {
      const id = (el.textContent || '').trim();
      if (id) imageIds.add(id);
    }
    for (const id of imageIds) {
      const imageFile = ImageStorage.instance.get(id, false);
      if (!imageFile || imageFile.isEmpty) continue;
      const url = await this.toDataURL(imageFile.url);
      if (url) images.push({ identifier: id, name: imageFile.name || name, url });
    }

    for (const el of Array.from(doc.querySelectorAll('*'))) el.removeAttribute('identifier');
    const stripped = new XMLSerializer().serializeToString(doc);

    // 同一内容の二重インポートガード（setFileInputFilesのchange発火は環境により二重になることがあるため）。判定は同じ辞書内のみ
    const existing = this.characters.find(c => c.dictId === target.id && c.xml === stripped);
    if (existing) {
      // 旧バージョンで登録済みのエントリ（画像なし・無意味名）は新しい取り込み結果で補完する
      let dirty = false;
      if (images.length > existing.images.length) { existing.images = images; dirty = true; }
      if (/^(data|date|character|xml_data)$/i.test(existing.name) && !/^(data|date|character|xml_data)$/i.test(name)) { existing.name = name; dirty = true; }
      if (dirty) await this.saveCharacter(existing);
      return existing;
    }

    const entry: DictCharacter = { id: UUID.generateUuid(), dictId: target.id, name, tags: [], xml: stripped, images, createdAt: Date.now() };
    await this.saveCharacter(entry);
    return entry;
  }

  /**
   * キャラZIPを辞書へ登録。対応形式:
   * - character.xml + 画像群（キャラコマサイト等）
   * - コマ保存形式: data.xml + <画像ID>.png + imagetag.xml
   * - <キャラ名>.xml + 画像群
   * 画像はidentifier=拡張子なしファイル名でImageStorageへ復元する。
   */
  async registerCharacterZip(file: File, dictId?: string): Promise<DictCharacter | null> {
    try {
      const zip = await JSZip.loadAsync(file);
      const META_XML = new Set(['imagetag.xml', 'chat.xml', 'config.xml', 'summary.xml']);
      const isXml = (p: string) => /\.xml$/i.test(p);
      const baseName = (p: string) => p.split('/').pop() || p;
      // 1) XML候補: 浅い階層優先、メタデータXMLは除外
      const xmlPaths = Object.keys(zip.files)
        .filter(p => { const e = zip.files[p]; return !e.dir && isXml(p) && !META_XML.has(baseName(p).toLowerCase()); })
        .sort((a, b) => (a.split('/').length - b.split('/').length) || a.localeCompare(b));
      let xml = '';
      let xmlPath = '';
      const charIdx = xmlPaths.findIndex(p => baseName(p).toLowerCase() === 'character.xml');
      if (0 <= charIdx) {
        xmlPath = xmlPaths[charIdx];
        xml = await zip.files[xmlPath].async('text');
      } else {
        // 2) ルートが<character>のXMLを探す（コマ保存のdata.xml等）
        for (const p of xmlPaths) {
          const text = await zip.files[p].async('text');
          const doc = new DOMParser().parseFromString(text, 'text/xml');
          const root = doc.documentElement;
          if (root && (root.tagName === 'character' || doc.querySelector('character'))) { xml = text; xmlPath = p; break; }
        }
      }
      if (!xml) { Logger.warn('registerCharacterZip: character XML not found in ' + file.name); return null; }
      // 3) 画像復元（XML以外の画像ファイル。identifier=拡張子なしファイル名）
      const restoredIds = new Set<string>();
      for (const path of Object.keys(zip.files)) {
        const entry = zip.files[path];
        if (entry.dir || isXml(path)) continue;
        const base = baseName(path);
        if (!/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(base)) continue;
        const id = base.replace(/\.[^.]+$/, '');
        if (!id) continue;
        const existing = ImageStorage.instance.get(id, false);
        if (existing && !existing.isEmpty) { restoredIds.add(id); continue; }
        try {
          const b64 = await entry.async('base64');
          const ext = (base.split('.').pop() || '').toLowerCase();
          const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : ext === 'svg' ? 'image/svg+xml' : ext === 'bmp' ? 'image/bmp' : 'image/jpeg';
          const image = ImageFile.createEmpty(id);
          image.context.name = base;
          image.context.url = 'data:' + mime + ';base64,' + b64;
          ImageStorage.instance.add(image);
          restoredIds.add(id);
        } catch { }
      }
      // 名前: XML内のname属性/<name>子要素/共通データ要素(name)を最優先。ファイル名が「data」等の無意味名のときはzip名へ
      const zipDoc = new DOMParser().parseFromString(xml, 'text/xml');
      const zipRoot = zipDoc.documentElement;
      let xmlName = (zipRoot?.getAttribute('name') || '').trim();
      if (!xmlName) {
        const nameChild = zipRoot?.querySelector(':scope > name');
        xmlName = nameChild ? (nameChild.textContent || '').trim() : '';
      }
      if (!xmlName) {
        const nameData = zipDoc.querySelector('data[name="name"]');
        xmlName = nameData ? (nameData.textContent || '').trim() : '';
      }
      // XMLのimageIdentifierがZIP内画像のファイル名と不一致のとき（キャラ作成サイトのZIP等）:
      // 画像がちょうど1枚ならそれをコマの画像として再紐付けする
      let xmlImageId = (zipRoot?.getAttribute('imageIdentifier') || '').trim();
      const dataImageRefs = Array.from(zipDoc.querySelectorAll('data[name="imageIdentifier"]')).map(el => (el.textContent || '').trim()).filter(Boolean);
      if (!xmlImageId && dataImageRefs.length === 0 && restoredIds.size === 1) {
        // 画像参照（属性・データ要素とも）が一切無く画像が1枚だけなら、それをコマの画像として紐付ける
        const onlyId = Array.from(restoredIds)[0];
        zipRoot.setAttribute('imageIdentifier', onlyId);
        xml = new XMLSerializer().serializeToString(zipDoc);
        xmlImageId = onlyId;
      }
      if (xmlImageId && !restoredIds.has(xmlImageId)) {
        const restoredList = Array.from(restoredIds);
        if (restoredList.length === 1) {
          const only = ImageStorage.instance.get(restoredList[0], false);
          if (only && !only.isEmpty) {
            const rebound = ImageFile.createEmpty(xmlImageId);
            rebound.context.name = only.name;
            rebound.context.url = only.url;
            ImageStorage.instance.add(rebound);
          }
        }
      }
      const MEANINGLESS = new Set(['data', 'character', 'xml_data']);
      const xmlBase = xmlPath ? baseName(xmlPath).replace(/\.xml$/i, '') : '';
      const zipBase = file.name.replace(/\.zip$/i, '');
      const fallback = xmlName || (!MEANINGLESS.has(xmlBase.toLowerCase()) ? xmlBase : '') || zipBase;
      return await this.registerCharacterXml(xml, fallback, dictId);
    } catch (e) {
      Logger.warn('registerCharacterZip failed: ' + e);
      return null;
    }
  }

  /** 盤面にいるコマをそのままコマ辞書へ登録(dictId省略時は既定コマ辞書) */
  async registerFromCharacter(gc: GameCharacter, dictId?: string): Promise<DictCharacter | null> {
    if (!gc) return null;
    const xml = ObjectSerializer.instance.toXml(gc);
    return await this.registerCharacterXml(xml, gc.name || '名称未設定', dictId);
  }

  private uniqueCharacterName(base: string): string {
    const names = new Set<string>(ObjectStore.instance.getObjects(GameCharacter).map(c => c.name));
    if (!names.has(base)) return base;
    let max = 0;
    const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\((\\d+)\\)$');
    for (const n of names) {
      const m = re.exec(n);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `${base}(${max + 1})`;
  }

  /** 辞書のコマを卓へ出す。imagesをImageStorageへ復元してからXMLをパースする。 */
  spawnCharacter(entry: DictCharacter, position?: { x: number, y: number, z: number }): GameCharacter | null {
    if (!entry) return null;
    for (const img of entry.images) {
      const current = ImageStorage.instance.get(img.identifier, false);
      if (!current || current.isEmpty) {
        // blobを持たないcontextをapplyに渡すと例外になるため、createEmptyでURL状態のImageFileを作って登録する
        const image = ImageFile.createEmpty(img.identifier);
        image.context.name = img.name;
        image.context.url = img.url;
        ImageStorage.instance.add(image);
      }
    }
    const object = ObjectSerializer.instance.parseXml(entry.xml);
    if (!(object instanceof GameCharacter)) {
      Logger.warn('[Dictionary] spawned object is not GameCharacter');
      return null;
    }
    // 名前は共通データ要素(name)から読まれるため、登録時に採取したXMLルート属性の名前を流し込む
    const baseName = (entry.name || '').trim() || 'モンスター';
    const finalName = this.uniqueCharacterName(baseName);
    const nameElement = object.commonDataElement ? object.commonDataElement.getFirstElementByName('name') : null;
    if (nameElement) {
      object.name = finalName;
    } else {
      // createDataElementsはprotectedのためany経由で呼ぶ（create()と同じ標準データ構造を作る）
      if (!object.commonDataElement) (object as any).createDataElements();
      object.commonDataElement.appendChild(DataElement.create('name', finalName, {}, 'name_' + object.identifier));
    }
    // 画像参照もデータ要素(imageDataElement内のimageIdentifier)で保持されるため、登録済み画像のidentifierを流し込む
    if (entry.images.length > 0 && object.imageDataElement) {
      const imgIdElm = object.imageDataElement.getFirstElementByName('imageIdentifier');
      if (imgIdElm) {
        imgIdElm.value = entry.images[0].identifier;
      } else {
        object.imageDataElement.appendChild(DataElement.create('imageIdentifier', entry.images[0].identifier, {}, 'imageIdentifier_' + object.identifier));
      }
    }
    object.location.x = position ? position.x - 25 : 0;
    object.location.y = position ? position.y - 25 : 0;
    object.setLocation('table');
    // location確定後のupdateは登録時のキューに吸収されてイベントが飛ばないため、キャッシュ再評価のために明示的に再通知する
    EventSystem.call('UPDATE_GAME_OBJECT', object.toContext());
    EventSystem.trigger('DICTIONARY_OBJECT_SPAWNED', { identifier: object.identifier });
    SoundEffect.play(PresetSound.piecePut);
    return object;
  }

  /** チャパレ辞書のコマへの適用。replace=全置換 append=既存パレットに追記 */
  applyPaletteToCharacter(entry: DictPalette, character: GameCharacter, mode: 'replace' | 'append' = 'replace') {
    if (!entry || !character) return;
    let palette = character.chatPalette;
    if (!palette) {
      palette = new ChatPalette('ChatPalette_' + character.identifier);
      palette.initialize();
      character.appendChild(palette);
    }
    const base = mode === 'append' && palette.value ? (<string>palette.value).replace(/\s+$/, '') + '\n' : '';
    palette.setPalette(base + entry.text);
    if (entry.dicebot) palette.dicebot = entry.dicebot;
  }

  /** 辞書(コレクション)1件をv2形式で書き出す */
  exportCollection(dictId: string): DictData | null {
    const col = this.getCollection(dictId);
    if (!col) return null;
    const data: DictData = { version: 2, exportedAt: Date.now(), dictionary: { name: col.name, type: col.type }, characters: [], materials: [], palettes: [] };
    if (col.type === 'characters') data.characters = this.entriesOfCharacters(dictId);
    else if (col.type === 'materials') data.materials = this.entriesOfMaterials(dictId);
    else data.palettes = this.entriesOfPalettes(dictId);
    return data;
  }

  async importData(data: DictData, targetDictId?: string): Promise<DictImportResult> {
    const result: DictImportResult = { characters: 0, materials: 0, palettes: 0 };
    if (!data) return result;
    if (data.dictionary && data.dictionary.type) {
      // v2: 辞書単位の読み込み → 新しい辞書を作ってそこへ入れる
      const type: DictType = data.dictionary.type;
      const col = await this.addCollection(data.dictionary.name || '読み込んだ辞書', type);
      result.createdDictId = col.id;
      result.createdDictName = col.name;
      if (type === 'characters') for (const c of (data.characters || [])) { if (!c || !c.xml) continue; await this.saveCharacter({ ...c, id: UUID.generateUuid(), dictId: col.id, createdAt: Date.now() }); result.characters++; }
      else if (type === 'materials') for (const m of (data.materials || [])) { if (!m) continue; await this.saveMaterial({ ...m, id: UUID.generateUuid(), dictId: col.id, createdAt: Date.now() }); result.materials++; }
      else for (const p of (data.palettes || [])) { if (!p || !p.text) continue; await this.savePalette({ ...p, id: UUID.generateUuid(), dictId: col.id, createdAt: Date.now() }); result.palettes++; }
      return result;
    }
    // v1レガシー(全体ダンプ): 種類ごとに既定辞書へ振り分け(読み込み時に辞書を選択していて種類が一致すればそこへ)
    result.legacy = true;
    const dictFor = (type: DictType): string | undefined => {
      const t = targetDictId ? this.getCollection(targetDictId) : null;
      if (t && t.type === type) return t.id;
      return this.collectionsOfType(type)[0]?.id;
    };
    const dc = dictFor('characters');
    if (dc) for (const c of (data.characters || [])) { if (!c || !c.xml) continue; await this.saveCharacter({ ...c, id: UUID.generateUuid(), dictId: dc, createdAt: Date.now() }); result.characters++; }
    const dm = dictFor('materials');
    if (dm) for (const m of (data.materials || [])) { if (!m) continue; await this.saveMaterial({ ...m, id: UUID.generateUuid(), dictId: dm, createdAt: Date.now() }); result.materials++; }
    const dp = dictFor('palettes');
    if (dp) for (const p of (data.palettes || [])) { if (!p || !p.text) continue; await this.savePalette({ ...p, id: UUID.generateUuid(), dictId: dp, createdAt: Date.now() }); result.palettes++; }
    return result;
  }

  private downloadBlob(blob: Blob, filename: string) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  private timeStamp(): string {
    const d = new Date();
    const p = (n: number) => ('0' + n).slice(-2);
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  async exportFile(format: 'json' | 'zip', dictId: string) {
    const data = this.exportCollection(dictId);
    if (!data) return;
    const colName = this.getCollection(dictId)?.name || 'dictionary';
    const json = JSON.stringify(data, null, 2);
    const base = `lycoris-dict-${colName.replace(/[\\/:*?"<>|]/g, '_')}-${this.timeStamp()}`;
    if (format === 'json') {
      this.downloadBlob(new Blob([json], { type: 'application/json' }), base + '.json');
    } else {
      const zip = new JSZip();
      zip.file('dictionary.json', json);
      const blob = await zip.generateAsync({ type: 'blob' });
      this.downloadBlob(blob, base + '.zip');
    }
  }

  async importFile(file: File, targetDictId?: string): Promise<DictImportResult> {
    let text = '';
    if (/\.zip$/i.test(file.name) || file.type === 'application/zip' || file.type === 'application/x-zip-compressed') {
      const zip = await JSZip.loadAsync(file);
      const entryFile = zip.file('dictionary.json') || zip.file(/dictionary\.json$/i)[0];
      if (!entryFile) throw new Error('ZIPの中に dictionary.json が見つかりません');
      text = await entryFile.async('string');
    } else {
      text = await file.text();
    }
    const data = JSON.parse(text) as DictData;
    return this.importData(data, targetDictId);
  }
}
