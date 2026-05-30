# Udonarium Lily Signaling Server

SkyWay の Peer シグナリングを置き換える最小 WebSocket サーバです。
盤面データ本体はサーバを経由せず、ブラウザ間の WebRTC DataChannel で流れます。

```bash
cd signaling-server
npm install
npm start
```

デフォルト:

- WebSocket: `ws://localhost:18793/signaling`
- Health check: `http://localhost:18793/health`

公開する場合は HTTPS/WSS のリバースプロキシ配下に置いてください。
