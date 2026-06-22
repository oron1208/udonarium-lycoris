# 🎵 ミュージックライブラリ機能 設計書

> 生成AI BGMをサーバーに配置し、P2P同期せずストリーミング再生する機能

---

## 概要

ユドナリウムリコリスのP2P同期方式は、音声ファイルが大きいとSkyWayの帯域を圧迫し、セッションが重くなる原因になる。

本機能は、**生成AIで作成したBGMをVPSサーバーに配置**し、各クライアントがサーバーから直接ストリーミング再生する方式。P2Pで音声データを送らないため、軽量で快適。

---

## v1.42のBGM優先度システムとの統合（重要）

v1.42でBGM優先度エンジン（`_updateBgmPlayback()`）を再構築した。本機能はこのエンジンに統合する。

### 現在のBGM優先度アーキテクチャ

```
優先度: 戦闘BGM ＞ テーブル設定BGM ＞ ジュークボックスBGM

_updateBgmPlayback()
  ├─ _startCombatPlayback()   → combatAudioPlayer
  ├─ _startTablePlayback()    → tableAudioPlayers[]
  └─ _startJukeboxPlayback()  → audioPlayer / jukeboxLayerPlayers[]
```

### サーバー音声導入後の変更点

各`_startXxxPlayback()`メソッド内で、音源IDのプレフィックスを判定して再生プレイヤーを分岐する。

```
_startXxxPlayback()
  ├─ server: 場合 → HttpAudioPlayer でVPSから直接ストリーミング
  └─ upload: 場合 → 従来の AudioPlayer + AudioStorage で再生
```

### 重要：サーバー音声は「準備完了待ち」が不要

従来の`upload:`音声はP2Pでファイル転送が完了するまで再生できない。そのため：
- `_startXxxPlayback()`の戻り値`actuallyStarted`が`false`になる場合がある
- `_currentBgmSource = null`にして、`UPDATE_AUDIO_RESOURE`イベントで再評価

`server:`音声はURLを叩けば即再生できるため：
- `actuallyStarted`は常に`true`
- ファイル準備待ちの仕組み（`playAfterFileUpdate()`）は不要

---

## 同期用SyncVarとサーバー音声の連携

### 現在の同期仕組み（v1.42）

| SyncVar | 用途 | サーバー音声の扱い |
|---------|------|-------------------|
| `activeBgmSource` | 現在再生中のソース（`'combat'`/`'table'`/`'jukebox'`） | 変更なし（ソース種別のみ） |
| `combatBgmIdentifierSync` | 戦闘BGMの音声ID | `server:battle-001` がそのまま入る |
| `activeTableIdentifier` | 再生中のテーブルID | 変更なし |
| `audioIdentifier` | ジュークボックス再生中の音声ID | `server:town-003` がそのまま入る |
| `isPlaying` | ジュークボックス再生フラグ | 変更なし |

### 新規ログイン時の復元フロー

```
新規ユーザーが部屋にログイン
  ↓
Jukebox.apply() でSyncVarを受信
  ├─ activeBgmSource = "table"
  ├─ combatBgmIdentifierSync = "" （戦闘中でなければ空）
  └─ audioIdentifier = "server:battle-001"
  ↓
_updateBgmPlayback() が優先度を評価
  ↓
_startXxxPlayback() で音源IDを判定
  ├─ "server:" → HttpAudioPlayer.play(url)
  └─ "upload:" → AudioStorage から取得（ファイル準備待ちの場合あり）
```

### テーブル属性の遅延同期との連携

v1.42で`UPDATE_GAME_OBJECT`イベントリスナーを追加し、テーブル属性（BGM設定）が後から同期された場合に自動でBGM再評価する仕組みがある。

テーブルBGMレイヤーに`server:xxx`が入る場合も、同じ仕組みでキャッチされるため追加変更は不要。

### 戦闘管理のテーブルまたぎとの連携

v1.42で`getCombatTable()`が戦闘中テーブルを自動追跡するようになった。`combatBgmIdentifierSync`に`server:xxx`が入っても、テーブルをまたいで正しく追跡・再生される。

---

## 要件

### 1. サーバー側

| 項目 | 内容 |
|------|------|
| 音声配置 | `/var/www/audio-library/<カテゴリ>/<filename>.mp3` |
| API | `GET /api/audio-library` → 曲リストJSON |
| 配信 | nginx で `/audio/` を静的配信 |
| フォルダ分け | カテゴリごとにディレクトリを分ける（戦闘、日常、室内、自然 等） |

#### 曲リストJSON形式

```json
{
  "tracks": [
    {
      "id": "battle-001",
      "name": "激烈なる戦い",
      "category": "戦闘",
      "url": "/audio/battle/battle-001.mp3",
      "duration": 180
    },
    {
      "id": "town-003",
      "name": "夕暮れの街並み",
      "category": "日常",
      "url": "/audio/town/town-003.mp3",
      "duration": 210
    }
  ]
}
```

#### ディレクトリ構成案

```
/var/www/audio-library/
├── battle/          # 戦闘BGM
│   ├── battle-001.mp3
│   └── battle-002.mp3
├── town/            # 街・日常
│   ├── town-001.mp3
│   └── town-003.mp3
├── dungeon/         # ダンジョン
├── nature/          # 自然・野外
├── event/           # イベント・感情
└── index.json       # 自動生成される曲リスト
```

#### index.json自動生成

サーバー側スクリプト（またはunified-server.js起動時）に、ディレクトリをスキャンして`index.json`を生成する機能を持たせる。メタデータ（曲名等）はフォルダ構成から自動付与 + 手動で`meta.json`で上書き可能。

```
/var/www/audio-library/battle/meta.json
[{"file": "battle-001.mp3", "name": "激烈なる戦い", "duration": 180}]
```

---

### 2. AI利用確認ダイアログ

- 初回アクセス時（またはライブラリタブ初回開封時）に確認モーダル表示
- メッセージ：「この音源は生成AIを用いて作成されています。利用されますか？」
- 選択：**[はい]** / **[いいえ]**
- `localStorage` に `audioLibraryConsent` キーで保存（`true` / `false`）
- 「いいえ」→ ライブラリタブ非表示
- 設定（オプションパネル）からいつでも変更可能

---

### 3. ジュークボックスUI — ライブラリタブ

ココフォリア風のモーダル/UI。

#### タブ構成

```
[アップロード] [ライブラリ]
```

#### ライブラリタブの構成

```
┌─────────────────────────────────────┐
│  📁 カテゴリー: [すべて ▾]           │
│  🔍 [曲名・カテゴリで検索______]     │
├─────────────────────────────────────┤
│  ♪ 激烈なる戦い                      │
│    戦闘 / 3:00              [▶][使用]│
├─────────────────────────────────────┤
│  ♪ 夕暮れの街並み                    │
│    日常 / 3:30              [▶][使用]│
├─────────────────────────────────────┤
│  ♪ 魔の洞窟                          │
│    ダンジョン / 2:45         [▶][使用]│
└─────────────────────────────────────┘
```

- **検索バー**: 曲名・カテゴリ名でインクリメンタル検索
- **カテゴリーフィルター**: ドロップダウン（すべて / 戦闘 / 日常 / ...）
- **試聴（▶）**: その場で再生/停止（自分のみ）
- **使用ボタン**: その曲をルームのジュークボックスに登録

---

### 4. 既存UIへの統合

サーバー曲とアップロード曲を**同じセレクトボックス**に統合表示。

#### 音源ID形式

```
upload:<identifier>   → 従来のP2P同期音声（AudioStorage）
server:<trackId>      → サーバーストリーミング音声
```

プレフィックスなしの既存IDは`upload:`として扱う（後方互換性参照）。

#### 対象UI

| 場所 | 現在 | 変更後 |
|------|------|--------|
| テーブルBGM設定 | アップロード音声のみ | アップロード + サーバー曲 |
| 戦闘BGM設定 | アップロード音声のみ | アップロード + サーバー曲 |
| ジュークボックス再生 | アップロード音声のみ | アップロード + サーバー曲 |
| ジュークボックスレイヤー | アップロード音声のみ | アップロード + サーバー曲 |

セレクトボックスは optgroup で分ける：

```html
<select>
  <optgroup label="アップロード">
    <option value="upload:xxx">曲A</option>
  </optgroup>
  <optgroup label="ライブラリ">
    <option value="server:battle-001">激烈なる戦い</option>
  </optgroup>
</select>
```

---

### 5. 再生・同期システム

#### 基本方針

- 音声データはP2Pで送らない
- 再生コマンド（何を再生するか）だけSyncVarで同期
- 各クライアントがサーバーから各自ストリーミング

#### 再生フロー

```
GMが「使用」ボタン押下
  ↓
Jukebox.play("server:battle-001") またはテーブルBGMレイヤーに "server:battle-001" を設定
  ↓
_updateBgmPlayback() が優先度を評価
  ↓
_startXxxPlayback() で音源IDを判定
  ├─ "server:" → HttpAudioPlayer.play(url)  ← 即再生
  └─ "upload:" → AudioPlayer.play(audio)    ← ファイル準備待ちの場合あり
  ↓
activeBgmSource 等 SyncVar で全ピアに通知
  ↓
他ピアの apply() → _updateBgmPlayback() → 同様に再生
```

#### 3レイヤー対応

| レイヤー | 再生メソッド | サーバー曲対応 |
|----------|-------------|---------------|
| テーブルBGM | `_startTablePlayback()` | ✅ |
| 戦闘BGM | `_startCombatPlayback()` | ✅ |
| ジュークボックス | `_startJukeboxPlayback()` | ✅ |

---

### 6. データ構造

#### サーバー側（API レスポンス）

```typescript
interface ServerAudioTrack {
  id: string;          // 一意ID（例: "battle-001"）
  name: string;        // 曲名
  category: string;    // カテゴリ名
  url: string;         // 配信URL（例: "/audio/battle/battle-001.mp3"）
  duration: number;    // 再生時間（秒）
}
```

#### フロント側（キャッシュ）

```typescript
interface AudioLibraryCache {
  tracks: ServerAudioTrack[];
  fetchedAt: number;   // 最終取得時刻（5分キャッシュ等）
}
```

#### 統合音源ID

```typescript
type AudioSourceId = `upload:${string}` | `server:${string}`;

// 判定ヘルパー
function isServerAudio(id: string): boolean {
  return id.startsWith('server:');
}
function isUploadAudio(id: string): boolean {
  return id.startsWith('upload:');
}
```

---

### 7. HttpAudioPlayer

既存の`AudioPlayer`は`AudioStorage`（P2P同期）に依存しているため、URL直接再生用のプレイヤーを新設する。

```typescript
class HttpAudioPlayer {
  private audio: HTMLAudioElement | null = null;

  loop: boolean = false;
  volume: number = 0.5;

  play(url: string) {
    this.stop();
    this.audio = new Audio(url);
    this.audio.loop = this.loop;
    this.audio.volume = this.volume;
    this.audio.play();
  }

  stop() {
    if (this.audio) {
      this.audio.pause();
      this.audio.src = '';
      this.audio = null;
    }
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.audio) this.audio.volume = v;
  }
}
```

#### サーバー音声の特徴

| 項目 | upload: (P2P) | server: (HTTP) |
|------|---------------|----------------|
| ファイル準備 | P2P転送完了後に再生可能 | **即再生可能** |
| `actuallyStarted`戻り値 | `false`の場合あり（ファイル未準備） | **常に`true`** |
| `playAfterFileUpdate()` | 必要（`UPDATE_AUDIO_RESOURE`で再評価） | **不要** |
| 同期方式 | AudioStorage + SyncVar | URLのみSyncVar |

---

### 8. Jukebox拡張（v1.42アーキテクチャ準拠）

#### 各_startXxxPlayback()メソッドの拡張

`_startCombatPlayback()`, `_startTablePlayback()`, `_startJukeboxPlayback()`の各メソッド内で、音源IDのプレフィックスを判定して再生プレイヤーを分岐する。

```typescript
/**
 * 音源IDから適切なプレイヤーで再生
 * @returns 実際に再生開始したか
 */
private _playBySourceId(
  sourceId: string,
  players: AudioPlayer[] | HttpAudioPlayer[],
  loop: boolean,
  volume: number
): boolean {
  const resolved = resolveAudioSource(sourceId); // プレフィックス補完

  if (resolved.startsWith('server:')) {
    const trackId = resolved.substring(7);
    const track = AudioLibraryService.instance.getTrack(trackId);
    if (!track) return false;
    const player = new HttpAudioPlayer();
    player.loop = loop;
    player.volume = volume;
    player.play(track.url);
    (players as any[]).push(player);
    return true; // 即再生開始
  } else {
    const identifier = resolved.substring(7);
    const audio = AudioStorage.instance.get(identifier);
    if (!audio || !audio.isReady) return false; // ファイル未準備
    const player = new AudioPlayer(audio);
    player.loop = loop;
    player.volume = volume;
    player.play(audio);
    (players as any[]).push(player);
    return true;
  }
}
```

各メソッドでの使用例：

```typescript
private _startCombatPlayback(): boolean {
  const sourceId = resolveAudioSource(this._combatBgmIdentifier);
  return this._playBySourceId(sourceId, [/* combatAudioPlayer */], true, 0.6);
  // ※ combatAudioPlayerは単一なので配列ではなく直接代入
}

private _startTablePlayback(): boolean {
  const table = ObjectStore.instance.get<GameTable>(this.activeTableIdentifier);
  if (!table) return false;
  const layers = Jukebox.getTableAudioLayers(table)
    .filter(layer => layer.enabled && layer.audioIdentifier);
  let started = false;
  for (const layer of layers) {
    if (this._playBySourceId(
      resolveAudioSource(layer.audioIdentifier),
      this.tableAudioPlayers,
      layer.mode === 'loop',
      layer.volume
    )) started = true;
  }
  if (!started) this.playAfterFileUpdate();
  return started;
}

private _startJukeboxPlayback(): boolean {
  // メインジュークボックス
  const sourceId = resolveAudioSource(this.audioIdentifier);
  return this._playBySourceId(sourceId, [/* audioPlayer */], true, this.volume);
}
```

#### 曲切り替え検知（_jukeboxAudioLoadedFor）

v1.42でジュークボックス内の曲切り替えを検知するため`_jukeboxAudioLoadedFor`を導入済み。
`server:`音声でも同じ仕組みで曲切り替えを検知できる（`audioIdentifier`の値が変わるため）。

```typescript
// _updateBgmPlayback() 内の判定（変更なし）
if (desired === 'jukebox') {
  const currentJukeboxId = this._jukeboxLayerOverrideActive
    ? '__layers__'
    : this.audioIdentifier; // "server:town-003" 等が入る
  if (currentJukeboxId !== this._jukeboxAudioLoadedFor) {
    // 再スタート
  }
}
```

---

### 9. テーブルBGM・戦闘BGMのSyncVar拡張

現在のテーブルBGMは `table.getAttribute('lycorisTableAudioLayers')` にJSONで保存。戦闘BGMは `combatBgmIdentifierSync`（SyncVar）に保存。

これらの値に `server:` プレフィックスのIDも保存できるようにするだけ（既存の仕組みを変更なし、IDの形式だけ拡張）。

---

## 後方互換性

既存の部屋の音声IDにはプレフィックスがない。移行対応：

```typescript
function resolveAudioSource(id: string): string {
  if (id.startsWith('server:') || id.startsWith('upload:')) return id;
  return 'upload:' + id;  // プレフィックスなしは従来のアップロード音声
}
```

---

## 対象ファイル（修正予定）

| ファイル | 修正内容 |
|----------|---------|
| `unified-server.js` | `/api/audio-library` エンドポイント追加、index.json自動生成 |
| nginx設定（VPS） | `/audio/` の静的配信設定 |
| `src/app/class/Jukebox.ts` | `_playBySourceId()`追加、各`_startXxxPlayback()`拡張 |
| `src/app/class/core/file-storage/audio-player.ts` | `HttpAudioPlayer` クラス追加 |
| `src/app/service/audio-library.service.ts` | **新規** API取得・キャッシュ管理 |
| `src/app/component/jukebox/jukebox.component.*` | ライブラリタブUI |
| `src/app/component/initiative-panel/*` | 戦闘BGM選択枠にサーバー曲追加 |
| `src/app/component/game-table-setting/*` | テーブルBGM選択枠にサーバー曲追加 |
| `src/app/component/options-panel/*` | AI利用同意設定のトグル |

---

## マイルストーン

| フェーズ | 内容 | 優先度 |
|----------|------|--------|
| **1** | サーバー側: API + nginx配信設定 + 音源配置 | 高 |
| **2** | HttpAudioPlayer実装 | 高 |
| **3** | AudioLibraryService実装（API取得・キャッシュ） | 高 |
| **4** | Jukebox拡張（`_playBySourceId`・各`_startXxxPlayback`） | 高 |
| **5** | ジュークボックスUI（ライブラリタブ・検索・カテゴリ） | 中 |
| **6** | 既存UI統合（戦闘BGM・テーブルBGMのドロップダウン） | 中 |
| **7** | AI利用確認ダイアログ | 中 |
| **8** | テスト・調整 | — |

---

## フェーズ2：既存アップロードBGMのサーバー保存化

現状のアップロード音声もP2P同期からサーバー配信に切り替える。

### 基本方針
- ユーザーがアップロード → サーバーに保存（`/var/www/audio-uploads/<hash>.mp3`）
- ルームにはURL情報だけSyncVarで共有
- 各クライアントがサーバーからストリーミング
- 部屋削除時にサーバー側の曲もGC削除
- プリセット曲（生成AI）もアップロード曲も同じ仕組みで動く

### 容量目安（VPS: 空き75GB）

| 音質 | 1曲あたり | 100曲 | 500曲 | 1000曲 |
|------|----------|-------|-------|--------|
| MP3 192kbps 3分 | ~5MB | 500MB | 2.5GB | 5GB |
| MP3 320kbps 3分 | ~7.5MB | 750MB | 3.7GB | 7.5GB |

### 制限ルール
- アップロード曲：1ファイル最大10MB、1部屋あたり20曲まで
- **古いアップロード：10日以上アクセスなければGC削除**
- トータル上限：50GBでアラート

### メリット
- P2Pで音声データ流れない → セッション重くならない
- 同期ミス起きない
- ココフォリアと同じ方式
- プリセット・アップロード統一でシンプル

---

## 今後の拡張候補

- ライブラリ曲の追加・削除UI（管理画面）
- 曲のタグ付け（複数カテゴリ、ムード等）
- クロスフェード再生
- 音量フェードイン/アウト
- 再生キュー（プレイリスト）
