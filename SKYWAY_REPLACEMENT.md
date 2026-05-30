# SkyWay 置き換えメモ

## 方針

SkyWay で使っていた機能は主に以下です。

- Peer ID の登録
- Peer 一覧取得
- offer / answer / ICE candidate の中継
- WebRTC DataChannel の作成

盤面データそのものは既存通り WebRTC DataChannel で送るため、サーバは同期データを保持しません。
今回の変更では SkyWay のシグナリング部分だけを、自前の WebSocket サーバに置き換えました。

## 追加ファイル

- `src/app/class/core/system/network/websocket-signaling-connection.ts`
  - SkyWayConnection と同じ `Connection` interface を実装
  - WebSocket シグナリング + WebRTC DataChannel を管理
- `src/app/class/core/system/network/webrtc-signaling-data-connection.ts`
  - 既存の `SkyWayDataConnection` に渡せる DataConnection 互換アダプタ
- `signaling-server/`
  - 最小の Node.js + ws シグナリングサーバ

## 設定

`src/assets/config.yaml`:

```yaml
webrtc:
  key: ''
  signalingUrl: ws://localhost:18793/signaling
  config:
    iceServers:
      - urls: stun:stun.l.google.com:19302
```

本番公開時は `wss://example.com/signaling` のように HTTPS/WSS 配下に置いてください。

## 起動

```bash
cd signaling-server
npm install
npm start
```

アプリ側:

```bash
npm install
npm run build
```

## 注意

- 現状は最小実装です。多人数・NAT越え環境の実運用では TURN サーバ設定を推奨します。
- シグナリングサーバは部屋認証を持っていません。Peer ID 側に既存の部屋名・パスワード digest が含まれるため接続判定は既存ロジックに寄せていますが、公開運用ではアクセス制限やレート制限を足すべきです。
- SkyWay CDN script は削除済みです。
