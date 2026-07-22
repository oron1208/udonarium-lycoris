# SkyWay 2023 SDK — 接続安定化機能とベストプラクティス

> 調査日: 2026-07-13
> 対象: `@skyway-sdk/core` @ 2.5.1 / `@skyway-sdk/room` @ 2.5.1
> GitHub: https://github.com/skyway/js-sdk
> ドキュメント: https://skyway.ntt.com/ja/docs/

---

## 1. SDK 最新バージョンと Changelog (2024–2026)

### 最新バージョン（2026-07-07 時点）

| パッケージ | 最新版 | 公開日 |
|---|---|---|
| `@skyway-sdk/core` | **2.5.1** | 2026-07-07 |
| `@skyway-sdk/room` | **2.5.1** | 2026-07-07 |
| `@skyway-sdk/token` | **2.1.5** | 2026-07-07 |
| `@skyway-sdk/sfu-bot` | **2.2.8** | — |

### 主要リリースハイライト（2024–2026）

#### v2.5.x（2026-06 ～ 2026-07）
- **v2.5.1**: 一部環境の通信挙動改善、依存ライブラリ更新
- **v2.5.0**: `rtcConfig.stunPorts` オプション追加（STUN送信先ポートを 443/3478 から選択可能）
  - `Subscription.onConnectionStateChanged` が発火しない問題の修正（DataStream subscribe時、同一Peer上の2回目以降のsubscribe時）
  - Member leave時のメモリ解放改善

#### v2.4.x（2026-02 ～ 2026-06）
- **v2.4.6**: DataStream利用時の過剰エラーログ修正、SFU subscribe失敗時の不正subscription残留修正
- **v2.4.5**: `SkyWayContext.dispose` 後のリトライ停止、セキュリティアップデート
- **v2.4.4**: リソース解放問題修正
- **v2.4.3**: RemoteDataStream接続直後の安定化
- **v2.4.2**: Analytics有効時のネットワーク切断挙動改善、サーバ詳細エラー表示
- **v2.4.1**: **Analytics有効時のネットワーク切断時の再接続処理修正** ← 重要
- **v2.4.0**: **`onReconnectStart` / `onReconnectSuccess` イベント追加** ← 重要
  - TURNリクエスト失敗時のリソース作成失敗を修正

#### v2.3.x（2026-01）
- **v2.3.1**: P2P通信でunpublish/publish繰り返し後にメディア取得不可になる問題の修正 (**重要バグフィックス**)
- **v2.3.0**: 文字起こし機能トークンフィールド追加

#### v2.2.x（2025-12）
- **v2.2.1**: Chrome M143 サイマルキャスト問題対応、DataStream高頻度送信のオーバーフロー防止
- **v2.2.0**: DataChannelの `onWritable` / `onUnwritable` イベント追加

#### v2.1.0（2025-11）
- AudioStreamに音声レベル取得メソッド追加
- `replaceStream` 後の再実行で `AlreadyPublished` エラーが発生するバグ修正

#### v2.0.0（2025-10）— **Breaking Change**
- P2P/SFU 通信方式を混在できる新しいRoomタイプ追加
- `SkyWayRoom.Find` の引数変更
- 多数のdeprecated メソッド削除（`getStats`, `getRTCPeerConnection`, `getConnectionState`, `onConnectionStateChanged` が各Stream系クラスから削除）
- `SfuRoom` → `SFURoom` へ改名
- `updateReminderSec` → `updateRemindSec` へ改名

#### v1.15.x（2025-07 ～ 2025-09）
- **v1.15.2**: DataStream改善、ArrayBuffer送信バグ修正
- **v1.15.1**: **Chrome M140対応**（SFU動画通話が動作しなくなる問題）
- **v1.15.0**: `LocalMemberConfig` 追加（beforeunload で自動 leave するか選択可能）。`MemberKeepAliveConfig` は deprecated 化

#### v1.14.0（2025-07）
- クライアント通信ログ（Analytics）送信機能追加

#### v1.13.x（2025-06 ～ 2025-07）
- ライセンスファイル社名変更、依存パッケージ更新

#### v1.11.0（2025-01）
- この時期の機能追加

#### v1.9.x ～ v1.10.x（2024-06 ～ 2024-10）
- 各種バグフィックスと安定化

#### v1.7.x ～ v1.8.x（2024-01 ～ 2024-05）
- 継続的な安定化改良

---

## 2. 再接続・リカバリー機能

### 2.1 SDK 組み込みの再接続機能（v2.4.0 以降で正式追加）

**SkyWay 2023 SDK v2.4.0 以降では、シグナリングサーバ・バックエンドとの再接続がSDK内部で自動的に行われます。**

#### 再接続イベント（v2.4.0+）

```typescript
const context = await SkyWayContext.Create(tokenString);

// ネットワーク瞬断などで再接続が開始された時
context.onReconnectStart.add(() => {
  console.log('[SkyWay] 再接続を開始しました');
});

// 再接続が成功した時
context.onReconnectSuccess.add(() => {
  console.log('[SkyWay] 再接続が成功しました');
});

// 回復不能なエラー（別インスタンスを作り直す必要あり）
context.onFatalError.add((error) => {
  console.error('[SkyWay] 回復不能なエラー', error);
  // → アプリケーション側で Context を作り直す必要がある
});
```

#### 再接続の対象
- **シグナリングサーバとの接続**: SDK が自動的に再接続を試行
- **Analytics セッション**: v2.4.1 で切断時の再接続処理が改善
- **ICE/メディア接続**: RTCPeerConnection の ICE再起動はSDK内部で処理

#### 何が自動で何が手動か

| 機能 | 自動/手動 | 備考 |
|---|---|---|
| シグナリング再接続 | **自動** (v2.4.0+) | `onReconnectStart/Success` で通知 |
| ICE再起動 | **自動** | SDK内部で WebRTCの `restart()` を実行 |
| トークン更新リマインド | **イベント通知** | `onTokenUpdateReminder` で通知 → アプリ側で `updateAuthToken()` |
| Context 再作成 | **手動** | `onFatalError` 発火時はアプリ側で作り直し |
| Publication/Subscription 復元 | **自動** | 再接続後にSDKが自動的に再publish/subscribe |

### 2.2 TransportConnectionState（メディア通信状態）

```typescript
type TransportConnectionState = 'new' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
```

#### LocalStream（送信側）の監視

```typescript
// 送信側: 特定の購読者との接続状態
const state = localStream.getConnectionState(subscriberMember);
// 'new' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected'

localStream.onConnectionStateChanged.add(({ state, remoteMember }) => {
  console.log(`[${remoteMember.name}] 接続状態: ${state}`);
  if (state === 'disconnected') {
    // SDKが自動的に 'reconnecting' → 'connected' へ復旧を試みる
  }
});
```

#### RemoteStream（受信側）の監視

```typescript
const state = remoteStream.getConnectionState();

remoteStream.onConnectionStateChanged.add((state) => {
  console.log(`接続状態: ${state}`);
});
```

> **注意**: v2.0.0 で Stream クラスから `getConnectionState` / `onConnectionStateChanged` が **削除**されました。これらの機能は Publication / Subscription / Channel レベルに集約されています。v2.5.0 で `Subscription.onConnectionStateChanged` が発火しないバグが修正されました。

### 2.3 Channel/Room レベルのイベント

```typescript
// Channel（Core ライブラリ）
channel.onMemberJoined.add((e) => { /* ... */ });
channel.onMemberLeft.add((e) => { /* ... */ });
channel.onStreamPublished.add((e) => { /* ... */ });
channel.onStreamUnpublished.add((e) => { /* ... */ });

// Room ライブラリも同様のイベント構造
room.onMemberJoined.add(...);
room.onMemberLeft.add(...);
room.onStreamPublished.add(...);
room.onStreamUnpublished.add(...);
```

### 2.4 アプリ側で実装すべきリカバリー戦略

```typescript
// 包括的なリカバリー実装例
class SkyWayConnectionManager {
  private context: SkyWayContext;
  private retryCount = 0;
  private maxRetries = 3;

  async init(token: string) {
    this.context = await SkyWayContext.Create(token, {
      rtcConfig: {
        turnPolicy: 'enable',  // TURNを有効化
        stunPorts: [443, 3478], // v2.5.0+ 複数ポート指定
      },
      token: {
        updateRemindSec: 60,   // 期限60秒前にリマインド
      },
      member: {
        keepaliveIntervalSec: 30,
        keepaliveIntervalGapSec: 10,
        preventAutoLeaveOnBeforeUnload: false,
      },
      log: {
        level: 'info',  // 本番では 'warn' 推奨
      },
    });

    this.setupEventListeners();
  }

  private setupEventListeners() {
    // 1. トークン更新リマインド
    this.context.onTokenUpdateReminder.add(async () => {
      const newToken = await this.fetchNewTokenFromServer();
      await this.context.updateAuthToken(newToken);
    });

    // 2. トークン期限切れ（緊急）
    this.context.onTokenExpired.add(() => {
      console.warn('トークンが期限切れです。至急更新してください。');
    });

    // 3. 再接続イベント
    this.context.onReconnectStart.add(() => {
      console.log('再接続中...');
      // UI に「再接続中」インジケータを表示
    });

    this.context.onReconnectSuccess.add(() => {
      console.log('再接続成功');
      this.retryCount = 0;
      // UI のインジケータを非表示
    });

    // 4. 回復不能エラー → Context 再作成
    this.context.onFatalError.add(async (error) => {
      console.error('回復不能エラー:', error);
      if (this.retryCount < this.maxRetries) {
        this.retryCount++;
        await this.recreateContext();
      }
    });
  }

  private async fetchNewTokenFromServer(): Promise<string> {
    // アプリケーションサーバから新しい SkyWay Auth Token を取得
    const res = await fetch('/api/skyway-token');
    const { token } = await res.json();
    return token;
  }

  private async recreateContext() {
    this.context.dispose();
    const newToken = await this.fetchNewTokenFromServer();
    await this.init(newToken);
    // Channel/Room の再参加も必要
  }
}
```

---

## 3. SFU / TURN サーバーの活用

### 3.1 SFU サーバー

#### 基本的な使い方

```typescript
// Room ライブラリの場合: type で 'sfu' を指定
import { SkyWayContext, SkyWayRoom, SkyWayStreamFactory } from '@skyway-sdk/room';

const context = await SkyWayContext.Create(token);
const room = await SkyWayRoom.FindOrCreate(context, {
  name: 'room-name',
  type: 'sfu',  // SFU を指定
});
const member = await room.join();

// Publish時に SFU オプション指定
const video = await SkyWayStreamFactory.createCameraVideoStream();
await member.publish(video, {
  maxSubscribers: 50,  // 最大購読者数（デフォルト: 10、最大: 99）
  encodings: [
    { scaleResolutionDownBy: 4, id: 'low',  maxBitrate: 80_000,  maxFramerate: 5 },
    { scaleResolutionDownBy: 1, id: 'high', maxBitrate: 400_000, maxFramerate: 30 },
  ],
});
```

#### Core ライブラリの場合

Core では SFU Bot という特殊な Member として Channel に参加させます。`@skyway-sdk/sfu-bot` パッケージが必要です。

```typescript
import { SkyWayContext, SkyWayChannel } from '@skyway-sdk/core';
import { SfuBot } from '@skyway-sdk/sfu-bot';

const context = await SkyWayContext.Create(token);
context.registerPlugin(new SfuBot());

const channel = await SkyWayChannel.FindOrCreate(context, { name: 'room' });
```

#### SFU 利用時の重要ポイント
- `maxSubscribers`: 1 Publication あたりの最大購読者数（デフォルト10、最大99）
- **サイマルキャスト**: エンコード設定は **2つまで**推奨（3つ以上はデバイス負荷で無視される可能性）
- **DataStream は SFU で利用不可**（P2Pのみ）
- 料金: SFU通信料（40円/GB）+ SFUリソース確保料（映像 0.003円/分、音声 0.0003円/分）

#### 大規模会議（100人規模）のベストプラクティス

公式 Cookbook からの推奨設定:

```typescript
// カメラ解像度
const { audio, video } = await SkyWayStreamFactory.createMicrophoneAudioAndCameraStream({
  video: { height: 640, width: 360, frameRate: 15 },
});

// Publish
await member.publish(audio, { maxSubscribers: 50 });
await member.publish(video, {
  maxSubscribers: 50,
  encodings: [
    { scaleResolutionDownBy: 4, id: 'low',  maxBitrate: 80_000,  maxFramerate: 5 },
    { scaleResolutionDownBy: 1, id: 'high', maxBitrate: 400_000, maxFramerate: 30 },
  ],
});

// Subscribe（低画質で固定）
await member.subscribe(publication, { preferredEncodingId: 'low' });

// 動的切り替え
subscription.changePreferredEncoding('high');
```

**設計のポイント:**
- 総描画解像度がディスプレイ解像度を超えないようにする
- モバイル端末では表示本数を減らす（ページネーション）
- ネットワーク帯域に合わせてビットレートを制限

### 3.2 TURN サーバー

#### TURN の役割
P2P通信ができない環境（厳格なNAT、プロキシ、UDP不可）でデータを中継。

#### TURN 利用設定

TURNは**クライアントが自動的に判断**して利用しますが、設定で制御可能:

```typescript
const context = await SkyWayContext.Create(token, {
  rtcConfig: {
    turnPolicy: 'enable',    // 'enable' | 'disable' | 'turnOnly'
    turnProtocol: 'all',     // 'all' | 'udp' | 'tcp' | 'tls'
    stunPolicy: 'enable',    // 'enable' | 'disable'
    stunPorts: [443, 3478],  // v2.5.0+
  },
});
```

| 設定 | 説明 |
|---|---|
| `turnPolicy: 'enable'` | デフォルト。P2P失敗時にTURN使用 |
| `turnPolicy: 'turnOnly'` | TURN強制（最も安定だが通信量大） |
| `turnPolicy: 'disable'` | TURN不使用（一部ネットワークで接続不可） |
| `turnProtocol: 'tls'` | プロキシ環境で TCP443 が制限されている場合に有効 |

#### NAT種別とP2P/TURNの関係

| NAT種別 | フルコーン | 制限付きFC | ポート制限FC | シンメトリック |
|---|---|---|---|---|
| フルコーン | P2P | P2P | P2P | P2P |
| 制限付きFC | P2P | P2P | P2P | TURN |
| ポート制限FC | P2P | P2P | P2P | TURN |
| シンメトリック | P2P | TURN | TURN | TURN |

> **注意**: プロキシで HTTPS 以外の TCP443 通信を許可していない場合、TURN 経由でも通信不可のケースあり。

---

## 4. 接続監視 API

### 4.1 TransportConnectionState

```typescript
type TransportConnectionState = 'new' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
```

これは RTCPeerConnectionState をマッピングしたものです（内部で `convertConnectionState()` が変換）。

### 4.2 状態取得 API 一覧

```typescript
// SkyWayContext レベル
context.onReconnectStart: Event<void>      // v2.4.0+
context.onReconnectSuccess: Event<void>    // v2.4.0+
context.onFatalError: Event<SkyWayError>   // 回復不能エラー
context.onTokenExpired: Event<void>        // トークン期限切れ
context.onDisposed: Event<void>            // Context破棄

// Publication / Subscription レベル（v2.0.0 で Stream から移動）
// Channel イベント
channel.onMemberJoined / onMemberLeft
channel.onStreamPublished / onStreamUnpublished

// Stream レベルの接続状態
localStream.getConnectionState(remoteMember): TransportConnectionState
localStream.onConnectionStateChanged.add(({ state, remoteMember }) => {})
remoteStream.getConnectionState(): TransportConnectionState
remoteStream.onConnectionStateChanged.add((state) => {})

// WebRTC Stats
const stats = await channel.getStats(remoteMemberId);  // WebRTCStats
// Publication 経由でも取得可能
```

### 4.3 推奨する監視実装

```typescript
// 接続品質の総合監視
function monitorConnection(room, localMember) {
  // 1. バックエンド再接続
  room.context.onReconnectStart.add(() => {
    showNotification('再接続中...', 'warning');
  });

  room.context.onReconnectSuccess.add(() => {
    showNotification('再接続しました', 'success');
  });

  // 2. 回復不能エラー
  room.context.onFatalError.add((err) => {
    showNotification('接続エラーが発生しました。ページを再読み込みしてください。', 'error');
    console.error('Fatal SkyWay error:', err);
  });

  // 3. Publication/Subscription の接続状態
  room.publications.forEach((pub) => {
    if (pub.contentType === 'video' || pub.contentType === 'audio') {
      // Subscription ごとの監視
    }
  });

  // 4. Memberの入退出監視
  room.onMemberLeft.add((e) => {
    console.log(`Member left: ${e.member.name}`);
  });
}
```

### 4.4 WebRTC Stats API

SDK内部で `RTCPeerConnection.getStats()` をラップしたメソッドが利用可能です（v2.0.0でStreamクラスから削除され、Channel/Pluginレベルに集約）:

```typescript
// 内部的なメソッド（アンダースコア付き）
// channel._getStats(memberId): Promise<WebRTCStats>
// 戻り値は RTCStatsReport と同等
```

> **注意**: v2.0.0で `LocalStream.getStats()`, `RemoteStream.getStats()` 等は **削除** されました。Channel/Room API経由で統計情報にアクセスする設計に変更されています。

---

## 5. トークン更新・有効期限管理のベストプラクティス

### 5.1 トークンライフサイクル

```
[トークン取得] → [Context作成] → [期限リマインド(n秒前)] → [トークン更新] → ...
                                      ↓ 失敗
                              [トークン期限切れ] → [サービス利用不可]
```

### 5.2 本番環境の推奨アーキテクチャ

```
[ブラウザ] --fetch token--> [アプリサーバ] --SkyWay Auth Token--> [ブラウザ]
                                                                ↓
                                                     [SkyWayContext.Create(token)]
```

**シークレットキーは絶対にクライアントに埋め込まないこと。**

### 5.3 トークン更新実装

#### パターンA: サーバーサイドでトークン生成（本番推奨）

```typescript
// アプリサーバ側 (Node.js)
import { SkyWayAuthToken } from '@skyway-sdk/token';

export function generateToken(userId: string, roomId: string): string {
  const token = new SkyWayAuthToken({
    jti: crypto.randomUUID(),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600, // 1時間
    scope: {
      app: {
        id: process.env.SKYWAY_APP_ID,
        turn: true,
        actions: ['read'],
        channels: [
          {
            id: '*',
            name: roomId,
            actions: ['write'],
            members: [
              {
                id: '*',
                name: userId,
                actions: ['write'],
                publication: { actions: ['write'] },
                subscription: { actions: ['write'] },
              },
            ],
          },
        ],
      },
    },
  });
  return token.encode(process.env.SKYWAY_SECRET);
}

// クライアント側
const context = await SkyWayContext.Create(token, {
  token: { updateRemindSec: 300 }, // 期限5分前にリマインド
});

context.onTokenUpdateReminder.add(async () => {
  const res = await fetch('/api/skyway-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, roomId }),
  });
  const { token: newToken } = await res.json();
  await context.updateAuthToken(newToken);
});

context.onTokenExpired.add(() => {
  // 緊急: トークンが期限切れ
  console.error('Token expired! Service unavailable.');
});

context.onTokenUpdated.add((newTokenString) => {
  console.log('Token updated successfully');
});
```

#### パターンB: 開発環境向け（CreateForDevelopment）

```typescript
const context = await SkyWayContext.CreateForDevelopment(
  appId,
  secretKey,
  {
    token: { updateRemindSec: 30 }, // デフォルト30秒
  }
);
// SDK が内部で自動的にトークンを更新（24時間有効）
```

> `CreateForDevelopment` は呼ばれるたびに**警告ログが出力**されます。本番環境では絶対に使用しないでください。

### 5.4 トークン有効期限の設計指針

| 項目 | 推奨値 | 理由 |
|---|---|---|
| トークン有効期限 (exp) | 1～6 時間 | 長すぎるとセキュリティリスク、短すぎると更新頻度が高い |
| `updateRemindSec` | 60～300 秒 | ネットワーク遅延を考慮して余裕を持つ |
| サーバートークン生成時間 | < 500ms | ユーザー体験を損なわない |

### 5.5 トークンの権限スコープ例

```typescript
const scope = {
  app: {
    id: appId,
    turn: true,          // TURN利用を許可
    actions: ['read'],
    channels: [{
      id: '*',
      name: '*',
      actions: ['write'],
      members: [{
        id: '*',
        name: '*',
        actions: ['write'],
        publication: { actions: ['write'] },
        subscription: { actions: ['write'] },
      }],
    }],
  },
};
```

---

## 6. トラブルシューティング

### 6.1 既知の問題 (公式ドキュメント)

| 問題 | 対処 | 対象バージョン |
|---|---|---|
| BluetoothイヤホンでPublication disable/enable時に音が途切れる | `createMicrophoneAudioStream({ stopTrackWhenDisabled: false })` | 全バージョン |
| iOS Safari でタブ閉じ時に Member leave しない | `keepaliveIntervalSec: 30, keepaliveIntervalGapSec: 5` を設定 | 全バージョン |
| Chrome M143 でサイマルキャスト再publish失敗 | v2.2.1 以降へアップデート | < v2.2.1 |
| Chrome M140 で SFU 動作不良 | v1.15.1 以降へアップデート | < v1.15.1 |
| macOS Sequoia Safari 26.4+ で TURN 経由接続不可 | macOS アップデート | OS問題 |
| P2P で unpublish/publish 繰り返し後にメディア取得不可 | v2.3.1 以降へアップデート | v2.3.0 ～ v2.3.0 |
| Subscription.onConnectionStateChanged が発火しない | v2.5.0 以降へアップデート | < v2.5.0 |

### 6.2 デバッグに役立つ設定

```typescript
const context = await SkyWayContext.Create(token, {
  log: {
    level: 'debug',  // 'debug' | 'info' | 'warn' | 'error'
    // format: 'text' | 'json'
  },
});

// ログイベントのフック
import { logger } from '@skyway-sdk/common';
logger.onLog.add((log) => {
  // 外部ログサービスに送信など
  console.log(`[SkyWay ${log.level}]`, log.message);
});
```

### 6.3 よくある接続問題と対処

#### 「接続が確立できない」
1. `rtcConfig.turnPolicy` を確認（`'enable'` または `'turnOnly'`）
2. `turnProtocol` を確認（プロキシ環境では `'tls'` を試す）
3. ネットワークのファイアウォールが UDP/TCP 443 を許可しているか
4. トークンの `scope.app.turn: true` を確認

#### 「通信が頻繁に切れる」
1. `keepaliveIntervalSec` と `keepaliveIntervalGapSec` の調整
2. ネットワーク帯域の確認（SFUの場合、下り帯域が不足していないか）
3. エンコード設定の見直し（ビットレートを下げる）
4. `onReconnectStart/Success` で再接続状況をモニタリング

#### 「Member が Room から消えない / ゴミが残る」
1. `beforeunload` イベントで確実に `leave()` を呼ぶ
2. iOS Safari では `keepaliveIntervalGapSec` を短く設定
3. `preventAutoLeaveOnBeforeUnload: false`（デフォルト）を確認

#### 「トークンエラーで切断される」
1. `onTokenUpdateReminder` → `updateAuthToken` のフローが実装されているか
2. トークンの `exp` が十分な時間があるか
3. `onTokenExpired` イベントをハンドリングしているか

### 6.4 リソース解放

```typescript
// 適切なクリーンアップ
async function cleanup() {
  // 1. Member を leave
  await member.leave();

  // 2. Context を dispose（全 Channel インスタンスも解放される）
  context.dispose();
}

// beforeunload での確実な実行
window.addEventListener('beforeunload', () => {
  // 同期的に実行するため leave() より dispose() を優先
  context?.dispose();
});
```

---

## 7. Udonarium-Lycoris 移行に向けた推奨事項

### 7.1 SDK バージョン選定

**`@skyway-sdk/room` v2.5.1（最新）を推奨。**

理由:
- `onReconnectStart/onReconnectSuccess` が利用可能（v2.4.0+）
- `stunPorts` オプション（v2.5.0+）
- Subscription接続状態のバグ修正済み（v2.5.0+）
- P2P publish/unpublish繰り返しバグ修正済み（v2.3.1+）
- Chrome M140/M143 対応済み

### 7.2 移行時のアーキテクチャ提案

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Browser    │────→│ Token Server │────→│  SkyWay     │
│ (Room SDK)  │     │ (Node.js)    │     │  Backend    │
│             │←────│              │     │             │
└─────────────┘     └──────────────┘     └─────────────┘
      │                                           │
      │  WebRTC (P2P or SFU)                     │
      └───────────────────────────────────────────┘
```

### 7.3 設定テンプレート

```typescript
const context = await SkyWayContext.Create(token, {
  rtcConfig: {
    turnPolicy: 'enable',
    turnProtocol: 'all',
    stunPolicy: 'enable',
    stunPorts: [443, 3478],
  },
  token: {
    updateRemindSec: 120,
  },
  log: {
    level: __DEV__ ? 'debug' : 'warn',
  },
  member: {
    keepaliveIntervalSec: 30,
    keepaliveIntervalGapSec: 10,
    preventAutoLeaveOnBeforeUnload: false,
  },
});
```

### 7.4 v1.x → v2.x への移行注意点

- `SkyWayRoom.Find` の引数が変更（Breaking）
- Stream クラスの `getStats`, `getConnectionState`, `onConnectionStateChanged` が削除
  → Channel/Subscription/Publication レベルに集約
- `SfuRoom` → `SFURoom` へ改名
- `updateReminderSec` → `updateRemindSec` へ改名
- `MemberKeepAliveConfig` → `LocalMemberConfig` へ移行

---

## 参考リンク

- [SkyWay 開発者ドキュメント](https://skyway.ntt.com/ja/docs/)
- [JavaScript SDK API リファレンス](https://javascript-sdk.api-reference.skyway.ntt.com/core)
- [GitHub リリースノート](https://github.com/skyway/js-sdk/releases)
- [100人規模の会議アプリ Cookbook](https://skyway.ntt.com/ja/docs/cookbook/javascript-sdk/large-scale/)
- [既知の問題](https://skyway.ntt.com/ja/docs/user-guide/javascript-sdk/issues/)
- [SkyWay Auth Token サンプル](https://github.com/skyway/authentication-samples)
