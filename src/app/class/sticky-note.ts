import { SyncObject, SyncVar } from './core/synchronize-object/decorator';
import { TabletopObject } from './tabletop-object';

/**
 * 付箋（ローカル限定オブジェクト）
 * - ObjectStoreに登録しないため他のプレイヤーには同期されない（個人メモ用）
 * - 永続化は StickyNoteService が localStorage に行う
 */
@SyncObject('sticky-note')
export class StickyNote extends TabletopObject {
  @SyncVar() isLock: boolean = false;
  @SyncVar() rotate: number = 0;
  @SyncVar() zindex: number = 0;
  @SyncVar() text: string = '';
  @SyncVar() color: string = '#ffe973';
  @SyncVar() title: string = '';
  @SyncVar() collapsed: boolean = false;

  static create(text: string = '', color: string = '#ffe973'): StickyNote {
    let object: StickyNote = new StickyNote();
    object.text = text;
    object.color = color;
    // 注意: initialize()（ObjectStore登録）は呼ばない。ローカル限定のため。
    return object;
  }
}
