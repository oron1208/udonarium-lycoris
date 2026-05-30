import { SyncObject, SyncVar } from './core/synchronize-object/decorator';
import { ObjectNode } from './core/synchronize-object/object-node';
import { EventSystem } from './core/system';
import { GameTableMask } from './game-table-mask';
import { GameTableScratchMask } from './game-table-scratch-mask';
import { Terrain } from './terrain';

export enum GridType {
  NONE = -1,
  SQUARE = 0,
  HEX_VERTICAL = 1,
  HEX_HORIZONTAL = 2,
}

export enum FilterType {
  NONE = '',
  WHITE = 'white',
  BLACK = 'black',
}

@SyncObject('game-table')
export class GameTable extends ObjectNode {
  @SyncVar() name: string = 'テーブル';
  @SyncVar() width: number = 20;
  @SyncVar() height: number = 20;
  @SyncVar() gridSize: number = 50;
  @SyncVar() imageIdentifier: string = 'imageIdentifier';
  @SyncVar() backgroundImageIdentifier: string = 'imageIdentifier';
  @SyncVar() backgroundFilterType: FilterType = FilterType.NONE;
  @SyncVar() selected: boolean = false;
  @SyncVar() gridType: GridType = GridType.SQUARE;
  @SyncVar() gridColor: string = '#000000e6';
  @SyncVar() drawingData: string = '[]';
  @SyncVar() statusMarkerDictionary: string = '[]';

  // 照明設定
  @SyncVar() lightingEnabled: boolean = false;
  @SyncVar() lightingNightMode: boolean = true;
  @SyncVar() lightingIntensity: number = 0.55;
  @SyncVar() lightingTint: string = '#00030c';
  @SyncVar() lightingPaMode: boolean = false;
  @SyncVar() lightingSpotlights: boolean = false;
  @SyncVar() lightingSpotlightColor: string = '#fff3c4';
  @SyncVar() lightingSpotlightCount: number = 2;
  @SyncVar() lightingLasers: boolean = false;
  @SyncVar() lightingLaserColor: string = '#4cf3ff';
  @SyncVar() lightingLaserSpeed: number = 1;
  @SyncVar() lightingFlames: boolean = false;
  @SyncVar() lightingFlameLevel: number = 0.5;
  @SyncVar() lightingHaze: boolean = false;
  @SyncVar() drawingAsWall: boolean = false;
  @SyncVar() initialObjectsPlaced: boolean = false;

  gridClipRect: {top: number, right: number, bottom: number, left: number} = null;

  get terrains(): Terrain[] {
    let terrains: Terrain[] = [];
    this.children.forEach(object => {
      if (object instanceof Terrain) terrains.push(object);
    });
    return terrains;
  }

  get masks(): GameTableMask[] {
    let masks: GameTableMask[] = [];
    this.children.forEach(object => {
      if (object instanceof GameTableMask) masks.push(object);
    });
    return masks;
  }

  get scratchMasks(): GameTableScratchMask[] {
    let masks: GameTableScratchMask[] = [];
    this.children.forEach(object => {
      if (object instanceof GameTableScratchMask) masks.push(object);
    });
    return masks;
  }

  // GameObject Lifecycle
  onStoreAdded() {
    super.onStoreAdded();
    if (this.selected) EventSystem.trigger('SELECT_GAME_TABLE', { identifier: this.identifier });
  }
}
