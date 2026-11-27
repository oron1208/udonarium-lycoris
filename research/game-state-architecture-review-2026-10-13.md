# ゲーム状態管理アーキテクチャ現状分析と改善案（2026-10-13）

依頼: 「Game State Store / Rendering Adapter / Network Adapter の分離」提案に対する現状分析・設計案。
方針: **既存の状態管理機構を最大限活かし、重複する新Storeを追加しない。最小限の変更から。**

---

## 1. 現在のゲーム状態管理の実態

**既に中央Storeが存在する。** 新規に作るべきものではなく、強化すべきものがある。

### ObjectStore + GameObject（事実上のGame State Store）
- `src/app/class/core/synchronize-object/`
- **正規化済みID管理**: `identifierMap: Map<id, GameObject>` ＋ `aliasNameMap`（種別別インデックス）
- **状態は各オブジェクトの `context.syncData` に格納**。`@SyncVar()` デコレータがgetter/setterを定義し、setterは自動で `update()` を発火
- **バージョン管理**: majorVersion（更新毎+1）＋ minorVersion（乱数）で衝突解決（`ObjectSynchronizer.updateObject`: 受信側は `受信version > 自version` のとき適用）
- **削除履歴**（garbageMap）: 受信済み削除オブジェクトの再生成を防ぐ
- **更新キューイング**: `queueMap` ＋ `setZeroTimeout` で同一ティック内の同一オブジェクト更新をマージ

### 変更通知（既に細粒度購読がある）
`object-event-extension.ts` の `markForChanged` が `queueMicrotask` でバッチ化しつつ、
- `UPDATE_GAME_OBJECT/aliasName/<種別>` 
- `UPDATE_GAME_OBJECT/identifier/<id>`（**オブジェクト単位の細粒度購読**）
- `UPDATE_OBJECT_CHILDREN/identifier/<id>`（親チェーン伝播）

の名前空間イベントを発火。コンポーネントは必要なid/種別だけ購読可能。

### 通信（ObjectSynchronizer + EventSystem）
- `EventSystem.call('UPDATE_GAME_OBJECT', context)` が **ローカル配信＋P2P送信を兼ねる**（`_call` → `Network.instance.send`）
- 送信単位は**オブジェクト単位**（そのオブジェクトのsyncData全体のdeepCopy）。ただしキャラクターの大きなデータ（common/detail等）は**別の子オブジェクト（DataElement）として独立同期**されるため、駒移動時に送られるのは親オブジェクトの小さなsyncData（location/posZ/flags等）だけ → **実効的には差分的**
- **初期同期と通常同期の分離は実装済み**: `InitialRoomSync`（ZIPスナップショット一括、ネゴシエーション失敗時はレガシーカタログfallback）
- 受信側の二重適用防止: `event.isSendFromSelf` チェック＋バージョン比較
- 大容量アセット（画像）は状態同期と分離済み（MediaPriority/バックグラウンドフェッチ、`data/rooms` relay保存）

### 描画
- **3Dエンジンは非存在**: Three.js等なし。CSS 3D transform（`matrix-3d.ts`）＋ canvasレイヤー（描画/照明/壁）
- 卓のcanvas/照明ループは `ngZone.runOutsideAngular` でAngular変更検知と分離済み
- 卓の更新は `scheduleTableUpdate`（80msマージ）でバーストを1回のグリッド/再描画に統合（本日実装のthrottle）
- ドラッグ中は `movable.directive` が**ローカル座標をCSS transformに直接適用**（Angualar CD・ネットワーク両方に触れない）。確定時のみモデルへコミット → **「ドラッグ中の高頻度更新と確定状態の更新の区別」も実装済み**

---

## 2. 具体例: 駒を1個動かすと何が起きるか

1. **pointerdown** → `movable.directive` ドラッグ開始（Angular zone外）
2. **pointermove毎**（60fps）: ローカル `_posX/_posY/_posZ` 更新 → `setUpdateTimer` → 対象DOMにCSS transform直接適用。**Angular変更検知ゼロ・ネットワークゼロ**。座標変化なしは早期return
3. **pointerup**（`onInputEnd`）: グリッドスナップ → モデルコミット:
   - `tabletopObject.location.x/y = ...`（ネスト変更のためイベント未発火）
   - `tabletopObject.posZ = ...`（@SyncVar setter → `update()`）
   - `update()`: version++ → `toContext()`（syncData全体deepCopy＝駒1個分で小さい） → `EventSystem.call('UPDATE_GAME_OBJECT')` → ローカル配信＋全ピアへP2P送信
   - Undoサービスに移動グループ記録
4. **ローカルUI**: `UPDATE_GAME_OBJECT` をgame-tableが受信 → 種別判定（GameCharacter→objectGeneration++/照明無効化、table本体でなければ早期return）。`markForChanged` がmicrotaskで `UPDATE_GAME_OBJECT/identifier/<id>` 等をバッチ発火 → 該当コンポーネントのみ更新
5. **リモートピア**: `ObjectSynchronizer` が受信 → `isSendFromSelf`除外 → バージョン比較（高い方勝ち）→ `apply()`（syncData置換）→ `markForChanged` → 相手側で駒が動く

**通信量**: 駒1個の移動 ≒ ObjectContext 1通（数百バイト〜程度）。チャットも画像も一緒に流れない。

---

## 3. 現状設計の問題点・リスク（調査で判明）

### (a) 疑似バグ: `_garbageCollection` の条件が逆転している疑い
```ts
if (timeStamp + ms < nowDate) continue;   // 期限切れ(古い)をスキップ？
this.garbageMap.delete(identifier);        // 期限前(新しい)を消している？
```
期限切れエントリが残り、新規削除履歴が消える可能性。また発動条件が `size > 100000` のみで、長時間プレイでgarbageMapが10万件まで無制限増加 → **メモリ目標に直結**。要検証＋修正。

### (b) 疑似バグ: 同一ティック内の連続更新の最終状態が欠落する可能性
`ObjectStore.update` は「そのティックの最初の更新」だけ即時配信し、以降の同一オブジェクト更新は `queueMap` にマージされるが、**`updateQueue()` はマージ結果を再送信せず破棄**する。
- 例: 同一同期ブロックで `a.x=1; a.y=2;` → xの配信時にy旧値、yの最終値はマージされて送信されない可能性
- 実害の有無は2ピアでの実測が必要（「動いている」ので大半の経路は明示的 `update()` 1回で済んでいる可能性大）
- 検証方法: ローカル2ブラウザで同一オブジェクトに連続setter→相手側の最終状態一致をassert

### (c) 更新毎の `toContext()` deepCopy
毎更新でsyncData全体を再帰コピー。小オブジェクトは問題ないが、属性の多いオブジェクト（山札・チャットタブ等）ではCPU無駄。バージョンスタンプ付きキャッシュでコピー削減可能。

### (d) 素の `UPDATE_GAME_OBJECT` 購読者は全更新をevalする
game-table等は種別/ID判定で早期returnするが、部屋の全オブジェクト更新×全リスナの文字列ディスパッチが走る。`/aliasName/` `/identifier/` 細粒度イベントへの移行で削減可能。

### (e) Angular CD は広範でzone依存
卓・movableは最適化済みだが、個々のパネル/コンポーネントは依然zone駆動。OnPush＋`markForCheck` の部分的導入状態。

---

## 4. 設計案: 既存Store強化の段階計画

**新Storeは作らない。** ObjectStore/EventSystem/ObjectSynchronizerの3層が既にStore/通知/通信Adapterの役割を担っているため、穴を埋める方向。

### Phase 1 — 検証と修正（数時間〜）
1. (b)の同一ティック連続更新の2ピア実測 → 欠落するなら `updateQueue` でマージ済contextを再配信
2. (a)garbageCollection条件修正 ＋ 定期実行化（メモリ目標に直結）
3. `toContext()` にバージョンキャッシュ（未変更なら前回コピー再利用）

### Phase 2 — 細粒度通知の完成（数日）
1. `@SyncVar` setterに変更フィールド名を記録 → `markForChanged` が `UPDATE_GAME_OBJECT/field/<名前>/identifier/<id>` を追加発火（**ワイヤー形式不变・互換性维持**）
2. 素の `UPDATE_GAME_OBJECT` を購読するコンポーネントを `/aliasName/` `/identifier/` `/field/` へ段階移行（game-tableのハンドラは種別イベントへ）
3. 高頻度コンポーネント（駒・卓グリッド）のOnPush化。Signalsは**計測でzone CDコストが確認された箇所のみ**（位置表示など）に限定導入 — 導入自体を目的にしない

### Phase 3 — 通信のフィールド差分（任意・ゲート付き）
- ObjectContextに `changedFields` を追加し、変更キーのみ送信。バージョン体系そのまま
- **後方互換**: ピア機能ネゴシエーション（InitialRoomSyncと同じパターン）で、対応ピアのみ差分、非対応には全体context
- 効果が見込めるのは大きなsyncDataを持つオブジェクトのみ。駒移動は既に小さいので**計測してから判断**

### ローカル状態の分離について
カメラ・ドラッグ中座標・UI開閉は既にsync対象外（movableのローカル座標、CSSクラス等）。この設計は維持する。

---

## 5. 互換性への影響

- **セーブデータ（XML）**: Phase 1-2は影響なし（ObjectSerializer不変）。Phase 3も不変
- **P2Pプロトコル**: Phase 1-2は完全不変。Phase 3はネゴシエーション＋fallbackで旧クライアントと相互接続維持
- **既存機能**: Phase 2のイベント移行はコンポーネント単位で切り分け可能。回帰検証はlycoris-cdp-e2eのbootチェック＋ダイスボットE2Eで担保

## 6. 性能検証方法

1. **ストレス計測**: 500駒部屋で「1分間のUPDATE_GAME_OBJECT配信回数・送信バイト・markForCheck回数」をカウント（EventSystemに簡易プローブ）
2. **駒移動レイテンシ**: 2ブラウザCDPで「ドラッグ確定→相手側描画」の時間を計測（Phase前後比較）
3. **メモリ**: 長時間（2h+）放置/操作ミックスでヒープスナップショット（garbageMap修正の効果確認）
4. **回帰**: 既存E2E＋セーブ/ロード往復テスト

---

## 結論

パパの要求の**過半は既に実装済み**（正規化Store・細粒度購読・2段階バッチング・バージョン衝突解決・初期/通常同期分離・アセット分離・ドラッグ/確定分離）。
本当に不足しているのは:
1. 疑似バグ2件の修正（同期欠落・メモリ）
2. deepCopy削減
3. 素イベント購読の細粒度移行
4. （計測後なら）フィールド差分通信

Signals全面採用・全面書き換えは不要。上記段階計画で「大量駒でも軽快・無関係UI更新なし」の目標に最小変更で到達できる見込み。
