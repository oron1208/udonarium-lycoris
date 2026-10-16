import { SyncObject, SyncVar } from './core/synchronize-object/decorator';
import { GameObject, ObjectContext } from './core/synchronize-object/game-object';
import { ObjectStore } from './core/synchronize-object/object-store';
import { EventSystem } from './core/system';
import { GameTable } from './game-table';
import { Logger } from './core/system/util/logger';

@SyncObject('TableSelecter')
export class TableSelecter extends GameObject {
  private static _instance: TableSelecter;
  static get instance(): TableSelecter {
    if (!TableSelecter._instance) {
      TableSelecter._instance = new TableSelecter('TableSelecter');
      TableSelecter._instance.initialize();
    }
    return TableSelecter._instance;
  }

  @SyncVar() viewTableIdentifier: string = '';
  @SyncVar() tableGridDummy: boolean = false;
  gridShow: boolean = false; // true=常時グリッド表示
  gridSnap: boolean = true;

  resetForRoomJoin(): void {
    // Bootstrap tables reuse fixed IDs. Their local versions must not win
    // against the destination room, and clearing them must not broadcast deletes.
    for (const table of ObjectStore.instance.getObjects(GameTable)) {
      ObjectStore.instance.remove(table);
    }
    for (const selecter of ObjectStore.instance.getObjects(TableSelecter)) {
      if (selecter !== this) ObjectStore.instance.remove(selecter);
    }
    const context = this.toContext();
    context.majorVersion = 0;
    context.minorVersion = 0;
    context.syncData = { ...context.syncData, viewTableIdentifier: '' };
    this.apply(context);
  }

  // GameObject Lifecycle
  onStoreAdded() {
    super.onStoreAdded();
    EventSystem.register(this)
      .on('SELECT_GAME_TABLE', event => {
        Logger.debug('SELECT_GAME_TABLE ' + this.identifier);

        if (this.viewTable) this.viewTable.selected = false;
        this.viewTableIdentifier = event.data.identifier;
        if (this.viewTable) this.viewTable.selected = true;
      });
  }

  // GameObject Lifecycle
  onStoreRemoved() {
    super.onStoreRemoved();
    EventSystem.unregister(this);
  }

  get viewTable(): GameTable {
    let table: GameTable = ObjectStore.instance.get<GameTable>(this.viewTableIdentifier);
    if (!table) {
      table = ObjectStore.instance.getObjects<GameTable>(GameTable)[0];
      if (table && (this.viewTableIdentifier.length < 1 || ObjectStore.instance.isDeleted(this.viewTableIdentifier))) {
        this.viewTableIdentifier = table.identifier;
        EventSystem.trigger('SELECT_GAME_TABLE', { identifier: table.identifier });
      }
    }
    return table;
  }

  // SyncVarの変更を検知してローカルでイベント発火（全クライアントのBGM・照明などを同期）
  apply(context: ObjectContext) {
    const oldIdentifier = this.viewTableIdentifier;
    super.apply(context);
    if (oldIdentifier !== this.viewTableIdentifier && this.viewTableIdentifier) {
      EventSystem.trigger('SELECT_GAME_TABLE', { identifier: this.viewTableIdentifier });
    }
  }
}
