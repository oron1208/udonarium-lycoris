# Udonarium Lycoris SkyWay-free Server Design

## Goal

SkyWay を使わず、1つの自前 Node.js サーバーで以下を提供する。

- 静的 Web UI 配信
- `/signaling` WebSocket シグナリング
- `/api/status` / `/health` 状態確認

ゲームデータ本体は従来通り WebRTC DataChannel(P2P) で流し、サーバーは盤面・チャット本文を保存しない。

## Architecture

```text
Browser A ─┐
           │ HTTP: /                  ┌─ static files (dist/udonarium-lycoris)
           ├ WS: /signaling ──────────┤
Browser B ─┘                           └─ offer/answer/ice relay only

Browser A ═════════ WebRTC DataChannel ═════════ Browser B
```

## Changes

### Client

- `Network.initializeConnection()` を SkyWay fallback なしの `WebSocketSignalingConnection` 固定に変更。
- `src/assets/config.yaml` の `signalingUrl` は空にし、実行時に `ws(s)://location.host/signaling` を自動利用。
  - LAN IP やポートをビルド成果物へ埋め込まない。
  - 別端末から開いたときに `localhost` へ誤接続しない。

### Server

- `unified-server.js` を Web + Signaling 統合サーバーとして運用。
- ルーム単位で peer 一覧と signaling relay を分離。
- WebSocket heartbeat/ping で死んだ接続を掃除。
- `maxPayload` で巨大 signaling を拒否。
- hashed asset は長期キャッシュ、それ以外は `no-cache`。
- `/api/status` で peers/rooms/signaling counters を確認可能。

## Efficiency

- SkyWay SDK/API 呼び出しゼロ。
- Web と WebSocket が同一ポートなので CORS/別ポート問題を回避。
- シグナリングサーバーは状態を peer ID と room key のみに限定。
- WebRTC DataChannel の既存圧縮処理は維持。

## New operational features

- `GET /api/status`
  - `ok`, `peers`, `rooms`, `connectionsTotal`, `relayedSignals`, `rejectedSignals`, `startedAt`
- room-aware peer discovery
  - 同一ルームの peer のみ一覧化・relay。
- automatic cleanup
  - WebSocket pong が返らない接続を terminate。

## Future ideas

- TURN サーバー設定 UI（NAT が厳しい環境向け）
- 部屋ごとの invite URL / QR コード
- サーバー側 optional relay mode（WebRTC が張れない場合のみ WebSocket relay）
- ルーム人数・遅延の小さなステータス表示
