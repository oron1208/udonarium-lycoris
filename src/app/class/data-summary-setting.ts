import { SyncObject, SyncVar } from './core/synchronize-object/decorator';
import { GameObject } from './core/synchronize-object/game-object';
import { InnerXml } from './core/synchronize-object/object-serializer';

export enum SortOrder {
  ASC = 'ASC',
  DESC = 'DESC'
}

export interface SortKeyEntry {
  tag: string;
  order: SortOrder;
}

function parseSortKeys(value: string): SortKeyEntry[] {
  if (!value || value.trim().length < 1) return [{ tag: 'HP', order: SortOrder.ASC }, { tag: 'name', order: SortOrder.ASC }];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch (e) { }
  return [{ tag: 'HP', order: SortOrder.ASC }, { tag: 'name', order: SortOrder.ASC }];
}

function stringifySortKeys(keys: SortKeyEntry[]): string {
  return JSON.stringify(keys);
}

@SyncObject('summary-setting')
export class DataSummarySetting extends GameObject implements InnerXml {
  // todo:シングルトン化するのは妥当？
  private static _instance: DataSummarySetting;
  static get instance(): DataSummarySetting {
    if (!DataSummarySetting._instance) {
      DataSummarySetting._instance = new DataSummarySetting('DataSummarySetting');
      DataSummarySetting._instance.initialize();
    }
    return DataSummarySetting._instance;
  }

  // 従来フィールド（互換性維持）
  @SyncVar() sortTag: string = 'HP';
  @SyncVar() sortOrder: SortOrder = SortOrder.ASC;
  @SyncVar() sortTag2nd: string = 'name';
  @SyncVar() sortOrder2nd: SortOrder = SortOrder.ASC;

  // 新: N段ソートキー配列（JSON）
  @SyncVar() sortKeysJson: string = '';

  private _sortKeys: SortKeyEntry[] | null = null;
  get sortKeys(): SortKeyEntry[] {
    if (this._sortKeys === null) {
      if (this.sortKeysJson && this.sortKeysJson.length > 2) {
        this._sortKeys = parseSortKeys(this.sortKeysJson);
      } else {
        // 従来フィールドからマイグレーション
        this._sortKeys = [
          { tag: this.sortTag || 'HP', order: this.sortOrder || SortOrder.ASC },
          { tag: this.sortTag2nd || 'name', order: this.sortOrder2nd || SortOrder.ASC }
        ];
      }
    }
    return this._sortKeys;
  }
  set sortKeys(keys: SortKeyEntry[]) {
    this._sortKeys = keys;
    this.sortKeysJson = stringifySortKeys(keys);
    // 従来フィールドも更新（互換性）
    if (keys.length > 0) {
      this.sortTag = keys[0].tag;
      this.sortOrder = keys[0].order;
    }
    if (keys.length > 1) {
      this.sortTag2nd = keys[1].tag;
      this.sortOrder2nd = keys[1].order;
    }
  }

  @SyncVar() dataTag: string = 'HP MP SAN 敏捷度 精神力 情報';

  private _dataTag: string;
  private _dataTags: string[];
  get dataTags(): string[] {
    if (this._dataTag !== this.dataTag) {
      this._dataTag = this.dataTag;
      this._dataTags = this.dataTag != null && 0 < this.dataTag.trim().length ? this.dataTag.trim().split(/\s+/) : [];
    }
    return this._dataTags;
  }

  innerXml(): string { return ''; }
  parseInnerXml(element: Element) {
    // XMLからの新規作成を許可せず、既存のオブジェクトを更新する
    let context = DataSummarySetting.instance.toContext();
    context.syncData = this.toContext().syncData;
    DataSummarySetting.instance.apply(context);
    DataSummarySetting.instance.update();

    this.destroy();
  }
}
