# ココフォリア（CCFolia）技術的接続安定化手法 調査レポート

調査日: 2026-07-13
バージョン: CCFolia 1.35.5

---

## 1. ココフォリアはWebRTCを使っているか？ → **使っていない**

### 結論: WebRTC不使用、中央集権型アーキテクチャ

ココフォリアのJSバンドル（`main.c923adab.js`, 約4.4MB）を解析した結果、**RTCPeerConnection, RTCDataChannel, createOffer, ICECandidate等のWebRTC APIは一切含まれていない**。

ココフォリアはWebRTC/P2Pではなく、**クライアント・サーバー型**のアーキテクチャを採用している。

### 技術スタック（JSバンドル解析より確定）

| レイヤー | 技術 |
|---------|------|
| フロントエンド | React |
| リアルタイム通信 | **Socket.io** (WebSocket transport) |
| データ層 | **Firebase** (Firestore + Realtime Database + Auth + Storage) |
| バックエンド | **Google Cloud Run** + Cloud Functions |
| CDN | `storage.ccfolia-cdn.net` |
| エラートラッキング | Sentry |
| シリアライズ | 内部serialize関数 + protobuf（一部） |

### Socket.io接続設定（ソースコードから）

```javascript
const socket = io("wss://ccfolia-ws-ogjjhc5pra-an.a.run.app", {
  autoConnect: false,
  reconnection: true,
  transports: ["websocket"]
});
```

- WebSocketのみ（ポーリングフォールバックなし）
- `autoConnect: false` — ルーム入室時に必要に応じて接続
- `reconnection: true` — 自動再接続有効

### Firebase設定

```javascript
{
  apiKey: "AIzaSyAMlcPs4ekVSBdzpRdEloqQ8lIgP9lEnRI",
  authDomain: "ccfolia.com",
  databaseURL: "https://ccfolia-160aa.firebaseio.com",
  projectId: "ccfolia-160aa",
  storageBucket: "ccfolia-160aa.appspot.com"
}
```

### Cloud Functions エンドポイント
- `https://asia-northeast1-ccfolia-160aa.cloudfunctions.net`

---

## 2. ココフォリアの切断検知・再接続の仕組み

### Socket.io の再接続メカニズム

ココフォリアは Socket.io の組み込み再接続機能を利用:

```javascript
// 実際のコードパターン（minified bundleより復元）
socket.on("disconnect", (e) => { console.log("disconnected", e) });
socket.on("connect", () => {
  console.log("connected");
  socket.emit("join", { roomId, uid, displayName: "", color: "#000000" });
});
socket.on("connect_error", (e) => { console.error("connect_errored", e) });
socket.io.on("reconnect", () => { console.log("reconnected") });
socket.io.on("reconnect_attempt", (e) => { console.log("reconnect_attempted") });
```

**再接続パラメータ（Socket.io デフォルト）:**
| パラメータ | デフォルト値 |
|-----------|------------|
| reconnection | true |
| reconnectionAttempts | Infinity |
| reconnectionDelay | 1000ms |
| reconnectionDelayMax | 5000ms |
| randomizationFactor | 0.5 |

指数バックオフ + ジッタで再接続試行。

### Firebase Realtime Database の再接続

Firebase RTDB も独自の再接続ロジックを持つ:
- `reconnectDelay_` 初期値から `maxReconnectDelay_` (300秒最大) への指数バックオフ
- オンライン/オフライン検知 (`onOnline_` / `onOffline_`)
- ウィンドウ可視性検知 (`onVisible_`) — バックグラウンド時は再接続遅延を最大化
- 認証トークン無効時は再接続遅延を30秒に短縮

### Turbo Room 機能（Pro向け）

CDNベースの接続最適化:
```javascript
// Firestore の turbo_rooms コレクションで管理
{
  roomId: string,
  enabled: boolean,
  cdnUrl: string,      // ランダムに選ばれたCDNサーバー
  timestamp: Timestamp,
  createdAt: Timestamp,
  updatedAt: Timestamp
}
```
- 複数CDNサーバーからランダム選択で負荷分散
- 24時間（86400000ms）以上更新がないとクリーンアップ

---

## 3. ココフォリアの技術スタックまとめ

```
┌─────────────────────────────────────────────────────┐
│                   クライアント (React)                 │
│  ┌──────────┐  ┌───────────┐  ┌──────────────────┐  │
│  │ Socket.io │  │  Firebase │  │ Firebase Storage │  │
│  │ (WebSocket│  │  Firestore│  │  (画像・音声)     │  │
│  │  transport)│  │  (ルーム  │  │                  │  │
│  │            │  │   データ) │  │                  │  │
│  └─────┬─────┘  └─────┬─────┘  └────────┬─────────┘  │
└────────┼──────────────┼────────────────┼────────────┘
         │              │                │
         ▼              ▼                ▼
   ┌───────────┐  ┌──────────┐   ┌──────────────┐
   │Cloud Run  │  │ Firebase │   │  CDN         │
   │ (Socket   │  │  Project │   │ storage.     │
   │  server)  │  │ccfolia-  │   │ ccfolia-cdn  │
   │           │  │ 160aa    │   │ .net         │
   └───────────┘  └──────────┘   └──────────────┘
```

**通信の役割分担:**
- **Socket.io**: リアルタイム性が高い機能（タイマー、エモート、カーソル等）
- **Firestore**: ルームデータ、キャラクター、チャット等の永続データ
- **Firebase Storage**: 画像・音声ファイル
- **CDN**: 配布物の高速配信（Turbo Room機能）

---

## 4. ココフォリア公式ドキュメント・接続安定性情報

### 公式トラブルシューティング (https://docs.ccfolia.com/information/problems.md)

推奨される対処法:
- キャッシュ削除 / Cookie削除
- ログアウト → 再ログイン
- ブラウザ再起動
- `Ctrl+F5` でハードリロード
- ブラウザ変更 / プライベートモード
- PC・ルーターの再起動
- セキュリティソフト設定確認

### 既知の接続問題
1. **セキュリティソフト干渉**: 画像・音声ファイルがブロックされる
2. **大容量ルームデータ**: データ容量が大きいとメッセージウィンドウが表示されない
3. **モバイル端末**: 回線・セキュリティソフトの影響を受けやすい
4. **ZIP読み込み失敗**: ルームデータインポート時、利用者少ない時間帯を推奨

### 推奨環境
- Windows: 最新2バージョン + Chrome最新版
- Mac: 最新2バージョン + Safari/Chrome最新版
- iOS/iPadOS: 最新2バージョン + Safari/Chrome
- Android: 最新2バージョン + 標準ブラウザ/Chrome

---

## 5. ユーザーが報告している接続問題と解決策

### 公式FAQ・トラブルガイドから抽出した主要問題

| 問題 | 原因 | 解決策 |
|------|------|--------|
| ルームが表示されない | アカウント違い、セキュリティソフト | ログイン確認、セキュリティ設定確認 |
| ZIP読み込み失敗 | データ容量大、同梱物 | ブラウザ変更、時間帯変更 |
| 画像が他者に表示されない | 画像データが消去済み | 再アップロード |
| BGMが再生されない | 容量大、セキュリティ | 圧縮、外部URL取り込み |
| スマホで正常動作しない | 回線・セキュリティ | ブラウザリロード、BGM外部取り込み |

### アーキテクチャから推測される問題

ココフォリアの中央集権型アーキテクチャ固有の課題:
1. **サーバー障害時**: Firebase/Cloud Run障害で全機能停止（P2Pフォールバックなし）
2. **大人数ルーム**: Firestoreの読み書きレートリミット、Socket.ioサーバーのCPU負荷
3. **リアルタイム性**: Firestoreの同期遅延（チャット、コマ移動等の表示ラグ）
4. **通信量**: 全データがサーバー経由のため、P2Pより帯域消費が大きい可能性

---

## 6. ユドナリウムとの接続方式の違い

### アーキテクチャ比較

| 項目 | ココフォリア | ユドナリウム |
|------|------------|------------|
| **接続方式** | クライアント・サーバー | WebRTC (SkyWay SFU) |
| **P2P** | ❌ 使用しない | ✅ SkyWay経由でP2P的通信 |
| **シグナリング** | 不要（サーバー直結） | SkyWayバックエンドで認証トークン発行 |
| **データ転送** | Socket.io + Firestore | SkyWay DataStream (WebRTC DataChannel) |
| **シリアライズ** | 内部serialize + protobuf | MessagePack (msgpack-lite) |
| **圧縮** | 不明 | ✅ 1KB超で圧縮 (compressAsync) |
| **フレームワーク** | React | Angular 17 |
| **バックエンド** | Firebase + Cloud Run | Cloudflare Workers / AWS Lambda / Node.js (Hono) |
| **自己ホスティング** | ❌ 不可 | ✅ 可能（OSS） |
| **サーバー不要性** | ❌ 常にサーバー必要 | ⚠️ SkyWayバックエンドのみ必要 |

### ユドナリウムの接続安定化メカニズム（ソースコード解析）

#### SkyWay 2023 接続フロー
```
1. バックエンドAPI → SkyWay Auth Token 発行
2. SkyWayContext.Create(authToken)
3. SkyWayChannel.FindOrCreate(roomName)  — ルーム作成/参加
4. room.join({name: peerId})  — ルームに参加
5. SkyWayStreamFactory.createDataStream()  — データストリーム作成
6. roomPerson.publish(dataStream)  — パブリッシュ
7. publication.onSubscribed → 他ピアとのデータ通信開始
```

#### 再接続・復旧メカニズム

1. **Room Restore**: ルームチャンネルが閉じた際、自動的に再参加
```typescript
room.onClosed.add(async () => {
  await this.joinRoom();  // 自動再接続
  this.onRoomRestore(this.peer);  // 全ピア再接続
});
```

2. **Token Update**: SkyWayトークン期限切れ前に自動更新
```typescript
context.onTokenUpdateReminder.add(async () => {
  let authToken = await backend.createSkyWayAuthToken(...);
  context.updateAuthToken(authToken);
});
```

3. **Lobby System**: 最大300人/ロビーで水平分散
```
udonarium-lobby-1, udonarium-lobby-2, ...
→ メンバー数が最少のロビーを自動選択
```

4. **Relay System**: 直接接続していないピアへのデータ中継
```typescript
// DataContainer に TTL を設定し、中継ピア経由で転送
container.ttl = 1;  // 1ホップ中継
```

5. **データ圧縮**: 1KB超の配列データは自動圧縮
```typescript
if (1 * 1024 < container.data.byteLength && Array.isArray(data) && 1 < data.length) {
  let compressed = await compressAsync(container.data);
  if (compressed.byteLength < container.data.byteLength) {
    container.data = compressed;
    container.isCompressed = true;
  }
}
```

6. **バッチ送信**: キューシステムで最大128件まとめて送信
```typescript
let loopCount = this.queue.size < 128 ? this.queue.size : 128;
// broadcast / unicast / echocast に振り分け
```

### SkyWay 2023 の技術詳細

- SDK: `@skyway-sdk/core` ^1.9.2
- レガシーSDK: `skyway-js` ^4.4.5 (旧SkyWay互換)
- バックエンド: TypeScript + Hono フレームワーク
- デプロイ先: Cloudflare Workers / AWS Lambda / Node.js

---

## 7. Lycoris（我々のプロジェクト）への示唆

### ココフォリア方式の参考になる点
- **Socket.ioの再接続設定**: `reconnection: true, transports: ["websocket"]` は良い設定
- **Turbo Room CDN分散**: 複数CDNからのランダム選択は高負荷対策として有効
- **Firebase Firestore**: ルームデータの永続化・同期に実績あり

### ユドナリウム方式の参考になる点
- **SkyWay Room Restore**: チャンネル切断時の自動再接続ロジック
- **Token Update Reminder**: 期限切れ前のシームレスなトークン更新
- **MessagePack + 圧縮**: バイナリ効率が良い
- **バッチ送信**: キューシステムによる帯域最適化
- **Relay System**: 直接接続不全時のフォールバック

### ハイブリッド案の可能性
1. **WebRTC (SkyWay) + WebSocket フォールバック**: メインはP2P/SFU、切断時はSocket.io
2. **MessagePack + 圧縮**を採用しつつ、Firestoreライクな永続化も併用
3. **Room Restore**相当の再接続ロジックは必須

---

## 参考リンク

- ココフォリア公式: https://ccfolia.com/
- ココフォリア docs: https://docs.ccfolia.com/
- ココフォリアGitHub (i18nのみ): https://github.com/ccfolia/ccfolia-i18n
- ユドナリウム: https://github.com/TK11235/udonarium
- ユドナリウムバックエンド: https://github.com/TK11235/udonarium-backend
- SkyWay: https://skyway.ntt.com/
- ユドナリウム新SkyWay対応記事: https://qiita.com/hibohiboo/items/ae84dd1894fac8a852b7
- Udonarium With Fly (高度付): https://github.com/NanasuNANA/UdonariumWithFly
