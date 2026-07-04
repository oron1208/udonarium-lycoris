import { GameCharacter } from './game-character';
import { DataElement } from './data-element';
import { ObjectNode } from './core/synchronize-object/object-node';
import { SyncObject, SyncVar } from './core/synchronize-object/decorator';

/**
 * キャラクターグループ(部位管理/乗り物用途)。
 * アドバンスモード限定機能。
 *
 * - GameCharacter を拡張するので、キャラシ/チャットパレット/立ち絵/ターゲット/イニシアチブの
 *   仕組みを将来そのまま再利用できる(Phase 2 以降)。
 * - CardStack の cardRoot パターン同様、partsRoot ObjectNode 子を持ち、
 *   部位(通常の GameCharacter)を子としてぶら下げる。
 * - 子の部位は location.name を 'parts' にして卓面の独立描画から除外する
 *   (getObjects(GameCharacter).filter(location.name==='table') から自動的に外れる)。
 * - インライン展開時は背景画像付きエリア内に子コマを配置する(座標はエリア内相対)。
 */
@SyncObject('character-group')
export class GameCharacterGroup extends GameCharacter {
  /** 展開時の背景画像識別子(SHA-256)。空なら背景画像なし。 */
  @SyncVar() backgroundImageIdentifier: string = '';
  /** 展開状態(ネットワーク同期)。収納中は1アイコン表示。 */
  @SyncVar() isExpanded: boolean = false;
  /** 展開エリアのサイズ(グリッド単位)。 */
  @SyncVar() areaWidth: number = 6;
  @SyncVar() areaHeight: number = 6;
  /** 子部位が格納される location.name。'table' でなければ卓面の独立描画から除外される。 */
  static readonly PARTS_LOCATION_NAME = 'parts';

  /** 部位を束ねる ObjectNode 子(CardStack の cardRoot 相当)。 */
  private get partsRoot(): ObjectNode {
    for (let node of this.children) {
      if (node.getAttribute('name') === 'partsRoot') return node;
    }
    return null;
  }

  /** 格納されている部位コマ(GameCharacter)。 */
  get parts(): GameCharacter[] {
    return this.partsRoot ? <GameCharacter[]>this.partsRoot.children.filter(c => c instanceof GameCharacter) : [];
  }

  get partsCount(): number { return this.parts.length; }

  /** 部位を追加。location を 'parts' にして卓面独立描画から外す。 */
  addPart(part: GameCharacter): void {
    if (!this.partsRoot) {
      // partsRoot が無い(古いグループ等)なら再構築
      let partsRoot = new ObjectNode('partsRoot_' + this.identifier);
      partsRoot.setAttribute('name', 'partsRoot');
      partsRoot.initialize();
      this.appendChild(partsRoot);
    }
    // 部位の座標をエリア内の初期位置にリセット。
    // 元の卓面座標(絶対座標)のままだと、パネルのエリアサイズ(数百分)から
    // はみ出して見えなくなるため。既存部位と重ならないよう少しずつずらす。
    const offset = this.partsCount * 30;
    const cx = (this.areaWidth * 50) / 2;
    const cy = (this.areaHeight * 50) / 2;
    part.location = { name: GameCharacterGroup.PARTS_LOCATION_NAME, x: cx + offset, y: cy };
    this.partsRoot.appendChild(part);
    this.update();
  }

  /** 部位を取り出し(卓面に戻す)。 */
  removePart(part: GameCharacter): void {
    if (!this.partsRoot) return;
    this.partsRoot.removeChild(part);
    part.location = { name: 'table', x: this.location.x, y: this.location.y };
    this.update();
  }

  static create(name: string, size: number, imageIdentifier: string): GameCharacterGroup {
    let group: GameCharacterGroup = new GameCharacterGroup();
    group.createDataElements();
    group.initialize();

    // グループ自身の基本データ要素を GameCharacter と同様に構築
    group.createTestGameDataElement(name, size, imageIdentifier);

    // 部位格納用の partsRoot を作成(CardStack の cardRoot と同様)
    let partsRoot = new ObjectNode('partsRoot_' + group.identifier);
    partsRoot.setAttribute('name', 'partsRoot');
    partsRoot.initialize();
    group.appendChild(partsRoot);

    return group;
  }
}
