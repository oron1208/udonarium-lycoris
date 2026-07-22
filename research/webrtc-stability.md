# WebRTC P2P接続の安定化ベストプラクティス（2024-2026年）

> 作成日: 2026-07-13
> 対象: Udonarium-Lycoris（ブラウザベースTRPGツール）のDataChannel通信安定化

---

## 1. ICE再接続の最適化

### 1.1 ICE Restart の実装

ICE Restart は、ネットワーク変更時や接続失敗時に新しいICE候補ペアを再収集・再交渉する仕組み（RFC 8445 §2.4）。メディアストリームを切断することなく新しいパスに移行できる。

**実装パターン:**

```javascript
// 接続状態の監視
pc.oniceconnectionstatechange = () => {
  const state = pc.iceConnectionState;
  console.log(`ICE state: ${state}`);

  if (state === "failed") {
    // 即座にICE Restartを実行
    performIceRestart();
  } else if (state === "disconnected") {
    // 一定時間待ってから復帰しない場合Restart
    setTimeout(() => {
      if (pc.iceConnectionState === "disconnected") {
        performIceRestart();
      }
    }, 5000); // 5秒待機
  }
};

async function performIceRestart() {
  try {
    // 必要に応じて新しいICEサーバー設定を適用
    pc.setConfiguration({
      iceServers: getUpdatedIceServers()
    });
    // ICE Restartをフラグ付け
    pc.restartIce();
    // 新しいOfferを作成して交渉
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    // Offerをシグナリングサーバー経由で相手に送信
    signaling.send({ type: "offer", sdp: offer.sdp });
  } catch (err) {
    console.error("ICE restart failed:", err);
  }
}
```

**ベストプラクティス:**
- `iceConnectionState === "failed"` で即座にICE Restartを実行
- `disconnected` 状態が5〜10秒以上続いた場合もRestartを検討
- Restart後も古い接続上のメディア/DataChannelは新しい接続確立まで継続動作する
- 短時間に連続Restartを避けるためのバックオフ（exponential backoff）を実装

### 1.2 TURNサーバーの活用

symmetric NATや厳格なファイアウォール環境では、TURNサーバーが必須。

**推奨構成:**

```javascript
const pcConfig = {
  iceServers: [
    // 複数のSTUNサーバー（地理的に分散）
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    // 自前STUNサーバー（Coturn推奨）
    { urls: "stun:stun.example.com:3478" },
    // TURNサーバー（リレーfallback）
    {
      urls: "turn:turn.example.com:3478",
      username: "user",
      credential: "pass",
      credentialType: "password"
    },
    // TURN over TLS（ポート443でファイアウォール回避）
    {
      urls: "turns:turn.example.com:5349",
      username: "user",
      credential: "pass"
    }
  ],
  iceTransportPolicy: "all" // デフォルト。relay-onlyも可能
};
```

**重要ポイント:**
- **Coturn** がデフォルト選択として最も実績がある（オープンソース）
- TURN over TLS (ポート5349/443) は企業ファイアウォール回避に有効
- クラウド提供のTURN: Twilio NAT Traversal Service、Cloudflare TURN、Xirsys等
- 2024年以降、CloudflareのTURNサービスが無料枠で人気
- TURNサーバーはSTUN機能も兼ねるため、TURNのみでもSTUN要件を満たす

### 1.3 STUNサーバー複数設定

**推奨事項:**
- **3〜5個のSTUNサーバー**を設定（地理的に分散）
- ただし**多すぎると**候補収集時間が長くなるため、5個以内が目安
- Google公共STUNサーバーは無料だがrate limitがあるため、本番環境では自前STUN推奨
- Trickle ICE（RFC 8838）を活用し、候補が見つかり次第順次交換することで接続時間を短縮

### 1.4 Trickle ICEの活用

```javascript
// Trickle ICEパターン
pc.onicecandidate = (event) => {
  if (event.candidate) {
    // 候補が見つかったら即座に送信（全候補の収集を待たない）
    signaling.send({
      type: "ice-candidate",
      candidate: event.candidate
    });
  } else {
    // 候補収集完了
    signaling.send({ type: "ice-candidate", candidate: null });
  }
};
```

Trickle ICEにより、ICE候補の収集と接続性チェックを並行実行でき、接続確立時間を大幅に短縮可能。

---

## 2. DataChannelの安定化

### 2.1 書き込みバッファ管理

`RTCDataChannel.bufferedAmount` で送信待ちバッファサイズを監視し、バックプレッシャーを制御する。

**コア実装:**

```javascript
const MAX_BUFFERED_AMOUNT = 1 * 1024 * 1024; // 1MB
const LOW_THRESHOLD = 256 * 1024;            // 256KB
const MAX_MESSAGE_SIZE = 16 * 1024;          // 16KB（安全なチャンクサイズ）

class StableDataChannel {
  constructor(dc) {
    this.dc = dc;
    this.dc.bufferedAmountLowThreshold = LOW_THRESHOLD;
    this.dc.addEventListener("bufferedamountlow", () => this.onDrained());
    this.queue = [];
    this.readyToSend = true;
  }

  send(data) {
    // 大きなメッセージはチャンク分割
    if (typeof data === "string" && data.length > MAX_MESSAGE_SIZE) {
      this.sendChunked(data);
      return;
    }

    if (this.dc.bufferedAmount > MAX_BUFFERED_AMOUNT) {
      // バッファが満杯 - キューに溜める
      this.queue.push(data);
      this.readyToSend = false;
      return;
    }

    try {
      this.dc.send(data);
    } catch (e) {
      console.error("DataChannel send error:", e);
      this.queue.push(data);
    }
  }

  onDrained() {
    // バッファが閾値以下になったらキューを再送
    this.readyToSend = true;
    while (this.queue.length > 0 && this.dc.bufferedAmount < MAX_BUFFERED_AMOUNT) {
      const data = this.queue.shift();
      try {
        this.dc.send(data);
      } catch (e) {
        console.error("DataChannel resend error:", e);
        break;
      }
    }
  }

  sendChunked(data) {
    // 大きなメッセージをヘッダー付きチャンクに分割
    const chunkSize = MAX_MESSAGE_SIZE;
    const msgId = crypto.randomUUID();
    const chunks = Math.ceil(data.length / chunkSize);

    for (let i = 0; i < chunks; i++) {
      const header = JSON.stringify({
        chunked: true,
        msgId,
        index: i,
        total: chunks
      });
      const chunk = header + "\n" + data.slice(i * chunkSize, (i + 1) * chunkSize);
      this.send(chunk);
    }
  }
}
```

### 2.2 パケットサイズ最適化

| メッセージサイズ | 動作 | 推奨 |
|---|---|---|
| ≤ 16KB | ほぼ全環境で安全に送信可能 | ✅ 推奨 |
| 16KB〜64KB | ほとんどのブラウザで動作 | ⚠️ チャンク分割推奨 |
| 64KB〜256KB | モダンブラウザで動作 | ⚠️ 分割必須 |
| > 256KB | Head-of-line blocking リスク | ❌ 分割必須 |

**重要事項:**
- SCTPレイヤーのデフォルトメッセージサイズは64KB（RFC 8841）
- `max-message-size` SDP属性で交渉可能（0 = 無制限）
- **Head-of-line blocking**: 大メッセージが他のDataChannelメッセージの遅延を引き起こす（RFC 8260 の message interleaving が未実装のブラウザが多い）
- TRPGツールの場合：ダイスロール、チャットなどの小メッセージはそのまま送信、大きなキャラクタシートJSONはチャンク分割

### 2.3 DataChannel設定のベストプラクティス

```javascript
// 信頼性重視のDataChannel設定
const dcOptions = {
  ordered: true,          // 順序保証（デフォルト）
  maxRetransmits: null,   // 再送回数制限なし（maxPacketLifeTimeと排他）
  maxPacketLifeTime: null,// タイムアウトなし
  negotiated: false,      // 自動交渉（インバンド）
  // priority: "high"    // 優先度（Chrome/Firefox対応）
};

// リアルタイム性重視（再送なし、順序保証なし）
const dcLowLatency = {
  ordered: false,
  maxRetransmits: 0       // 再送なし
};
```

**TRPGツール向け推奨:**
- チャット・ダイスロール: `ordered: true`, `maxRetransmits: 3`（軽量・信頼性バランス）
- ファイル共有・画像: 別DataChannelで`ordered: true`, 大きなデータはチャンク分割
- 接続監視用: 別DataChannelでハートビート専用

### 2.4 複数DataChannelの活用

```javascript
// 用途別にDataChannelを分離
const channels = {
  control: pc.createDataChannel("control", { negotiated: true, id: 0 }),
  chat: pc.createDataChannel("chat", { negotiated: true, id: 1 }),
  file: pc.createDataChannel("file", { negotiated: true, id: 2 })
};
```

`negotiated: true` + 固定 `id` により、双方のピアが独立してチャネルを作成可能。シグナリングの往復を減らせる。

---

## 3. ハートビート / キープアライブ

### 3.1 WebRTC標準のキープアライブ

WebRTCのICE実装は標準でSTUN binding request/responseをキープアライブとして使用：
- **ICEの標準間隔**: 15秒（RFC 8445の推奨値）
- **DTLS/SCTPレイヤー**: 独自のキープアライブ間隔を維持
- ただし、これらは**接続維持**用であり、**Dead Peer Detection（DPD）** としては不十分な場合がある

### 3.2 アプリケーション層ハートビート（推奨）

```javascript
const HEARTBEAT_INTERVAL = 5000;  // 5秒間隔
const HEARTBEAT_TIMEOUT = 15000;  // 15秒でタイムアウト
const MAX_MISSED_HEARTBEATS = 3;

class HeartbeatMonitor {
  constructor(dc, onTimeout) {
    this.dc = dc;
    this.onTimeout = onTimeout;
    this.missed = 0;
    this.lastPong = Date.now();
    this.timer = null;
    this.alive = true;
  }

  start() {
    this.timer = setInterval(() => {
      if (!this.alive) return;
      if (Date.now() - this.lastPong > HEARTBEAT_TIMEOUT) {
        this.missed++;
        if (this.missed >= MAX_MISSED_HEARTBEATS) {
          console.warn("Peer considered dead after missed heartbeats");
          this.alive = false;
          this.onTimeout();
          return;
        }
      }
      try {
        this.dc.send(JSON.stringify({ type: "ping", t: Date.now() }));
      } catch (e) {
        // DataChannel送信エラー = 接続断の可能性
        this.missed++;
      }
    }, HEARTBEAT_INTERVAL);
  }

  // 受信側での処理
  onMessage(msg) {
    if (msg.type === "ping") {
      this.dc.send(JSON.stringify({ type: "pong", t: msg.t }));
    } else if (msg.type === "pong") {
      this.lastPong = Date.now();
      this.missed = 0;
      // RTT計測も可能
      const rtt = Date.now() - msg.t;
      // console.log(`RTT: ${rtt}ms`);
    }
  }

  stop() {
    clearInterval(this.timer);
  }
}
```

### 3.3 Dead Peer Detection (DPD) 戦略

| レイヤー | 手法 | 間隔 | 検出時間 |
|---|---|---|---|
| ICE (標準) | STUN binding request | ~15秒 | 30〜45秒 |
| DTLS/SCTP | SCTP heartbeat | ~10秒（実装依存） | 20〜30秒 |
| アプリ層 | Application ping/pong | 5秒 | 15秒 |
| 接続状態 | `connectionstatechange` | - | 即座（failed時） |

**推奨戦略:**
1. **第一防衛線**: `iceconnectionstatechange` → `disconnected` 検知
2. **第二防衛線**: アプリ層ハートビート（5秒間隔、3回連続でpongなし = dead）
3. **最終判断**: `iceConnectionState === "failed"` → ICE Restart または接続破棄

### 3.4 ハートビート間隔の目安

- **TRPGツール（リアルタイム性低）**: 10〜15秒間隔、30秒タイムアウト
- **チャットツール**: 5〜10秒間隔、15〜30秒タイムアウト
- **ゲーム/ストリーミング**: 2〜3秒間隔、6〜9秒タイムアウト

---

## 4. Firefox特有のWebRTC問題

### 4.1 Firefox DataChannel の既知の問題

FirefoxのSCTP実装にはいくつかのクロスブラウザ差異がある：

#### a) `bufferedAmount` の更新タイミング差異
- **Chrome**: `send()`呼び出し直後に`bufferedAmount`が更新される
- **Firefox**: 送信キューが実際に処理されてから更新されるため、遅延が生じる
- **対策**: Firefoxでは`bufferedAmount`を過信せず、アプリ側でも送信量をトラッキング

#### b) DataChannel再接続時の挙動差異
- **Firefox**: DataChannelが`closed`になると再オープンできない場合がある
- **Chrome**: ICE Restart後もDataChannelが維持されることが多い
- **対策**: ICE Restart後、FirefoxではDataChannelが`closed`になった場合、再作成する仕組みが必要

#### c) SCTPストリーム数の上限
- **Firefox**: 最大255 DataChannels（実質的には~200程度が安全）
- **Chrome**: 最大65534 DataChannels
- **対策**: 用途別にDataChannelを分離する場合でも、10個以内に留める

### 4.2 ICE候補収集の差異

- **Firefox**: mDNS候補（`.local`ホスト名）をデフォルトで生成。プライバシー保護目的だが、ローカルネットワークでの直接接続に問題が生じることがある
- **Chrome**: 2020年以降同様にmDNS候補をサポート
- **対策**: ローカルテスト時は `iceCandidatePoolSize` やブラウザ設定を確認

### 4.3 Firefox接続プール問題

- Firefoxは最大 **32接続** のRTCPeerConnectionに制限される場合がある（設定依存）
- 複数ピア接続を行うシステム（メッシュ型P2P等）では、この制限に注意
- `about:config` の `media.peerconnection.enabled` および `dom.rtcrtpsender.maxrtcpusrdatachannels` で関連設定確認可能

### 4.4 Firefox/Safari間の相互接続性

- **SCTP PPIDの差異**: FirefoxとSafari間でSCTP Payload Protocol Identifierの扱いに差異があり、バイナリ/テキストの判別エラーが発生することがある
- **対策**: `binaryType` を明示的に `"arraybuffer"` に設定し、アプリ層でメッセージタイプを管理

### 4.5 Firefox固有の回避策まとめ

```javascript
function isFirefox() {
  return navigator.userAgent.includes("Firefox");
}

// Firefox向けのDataChannelラッパー
function createStableDataChannel(pc, label, options = {}) {
  const dc = pc.createDataChannel(label, {
    ...options,
    // Firefoxでは ordered + 再送保証が確実
    ordered: options.ordered ?? true,
  });

  if (isFirefox()) {
    // Firefox: bufferedAmountの更新が遅いため、
    // 送信後に微小遅延を入れて状態確認
    dc.addEventListener("open", () => {
      console.log("DataChannel open (Firefox mode)");
    });
  }

  return dc;
}
```

---

## 5. モバイル / 不安定ネットワーク対策

### 5.1 NAT Traversal の基本

| NATタイプ | 特徴 | P2P可否 |
|---|---|---|
| Full Cone | 最も寛容。任意の外部ホストから着信可能 | ✅ STUNのみでOK |
| Restricted Cone | 送信先のみ着信許可 | ✅ STUNで対応可能 |
| Port Restricted Cone | 送信先+ポート限定 | ⚠️ STUN困難な場合あり |
| Symmetric NAT | 接続先ごとに異なるポート | ❌ TURN必須 |

**対策:**
- Symmetric NAT環境（特にキャリアグレードNAT/CGNAT）ではTURNサーバーが必須
- IPv6が利用可能な場合はIPv6経由の直接接続を試みる（NATをバイパス可能）
- `iceTransportPolicy: "relay"` でTURN専用モードにフォールバック可能

### 5.2 ネットワーク切り替え対応（WiFi → LTE等）

```javascript
// Network Information API（Chrome限定、Firefox未対応）
if ("connection" in navigator) {
  const conn = navigator.connection;
  conn.addEventListener("change", () => {
    console.log(`Network changed: ${conn.effectiveType}, type: ${conn.type}`);
    // ネットワーク変更を検知したらICE Restartを予め実行
    if (pc.iceConnectionState === "connected" || 
        pc.iceConnectionState === "completed") {
      console.log("Network change detected, preemptive ICE restart");
      performIceRestart();
    }
  });
}

// Visibility Change でも接続確認
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    // タブがアクティブになった際、接続状態をチェック
    if (pc.iceConnectionState === "disconnected") {
      performIceRestart();
    }
  }
});

// Online/Offlineイベント
window.addEventListener("online", () => {
  console.log("Back online, checking WebRTC connection");
  setTimeout(() => {
    if (pc.iceConnectionState !== "connected" && 
        pc.iceConnectionState !== "completed") {
      performIceRestart();
    }
  }, 1000);
});
```

### 5.3 モバイル特有の課題と対策

#### a) IPアドレス変更
- **問題**: WiFi→LTE切り替えでローカルIPが変わり、既存のICE候補ペアが全て無効化
- **対策**: `iceconnectionstatechange` で `disconnected`/`failed` を検知し、即座にICE Restart

#### b) バッテリー最適化によるソケット凍結
- **問題**: iOS/Androidのバックグラウンド制限でソケットが凍結され、接続がサイレントに切断
- **対策**: 
  - アプリ層ハートビートで早期検知
  - 再接続時は完全なハンドシェイクからやり直す（セッション復元ではなく新規セッション）
  - WebSocket等のフォールバックシグナリング経路を保持

#### c) モバイルネットワークの遅延・パケットロス
- **問題**: モバイルネットワークはRTTが高く、パケットロス率も高い
- **対策**:
  - DataChannelのメッセージを小さく保つ（1メッセージ ≤ 4KB推奨）
  - 重要なメッセージは確認応答（ACK）を実装
  - チャットメッセージはバッチ送信せず1件ずつ送信

### 5.4 モバイル向け推奨タイムアウト値

| パラメータ | デスクトップ | モバイル推奨 |
|---|---|---|
| ICE候補収集タイムアウト | 5秒 | 10秒 |
| 接続確立タイムアウト | 10秒 | 20秒 |
| ハートビート間隔 | 5秒 | 3秒 |
| Dead peer タイムアウト | 15秒 | 9秒 |
| ICE Restart バックオフ | 5秒 → 10秒 → 30秒 | 3秒 → 5秒 → 15秒 |

### 5.5 フォールバック戦略

```
直接P2P (host candidate)
  ↓ 失敗
STUN経由P2P (srflx candidate)
  ↓ 失敗
TURNリレー (relay candidate)
  ↓ 失敗
WebSocket フォールバック
  ↓ 失敗
再接続待機（exponential backoff）
```

TRPGツールのようなテキストベース通信が中心の用途では、TURNリレー経由でも実用上問題ないレイテンシ（50〜100ms）が得られる。フォールバック戦略を明確に実装することが安定性の鍵。

---

## 6. Udonarium-Lycoris向け統合推奨事項

### 6.1 最小実装チェックリスト

- [ ] ICE Restart実装（`iceConnectionState === "failed"` で発火）
- [ ] 複数STUN + TURNサーバー設定（TLS対応含む）
- [ ] Trickle ICE有効化
- [ ] DataChannel `bufferedAmount` 監視 + バックプレッシャー制御
- [ ] 大メッセージのチャンク分割（16KB単位）
- [ ] アプリ層ハートビート（5秒間隔、15秒タイムアウト）
- [ ] `connectionstatechange` / `iceconnectionstatechange` の全状態ハンドリング
- [ ] ネットワーク変更・オンライン復帰時の再接続ロジック
- [ ] Firefox向け `bufferedAmount` 更新遅延対策
- [ ] 指数バックオフ再接続（3秒 → 5秒 → 15秒 → 30秒 → 60秒）

### 6.2 アーキテクチャ推奨

```
[DataChannel Layer]
├── control channel (id:0) — ハートビート、接続管理
├── chat channel (id:1) — チャットメッセージ、ダイスロール
├── data channel (id:2) — キャラクタシート、共有メモ（チャンク分割）
└── file channel (id:3) — 画像・ファイル転送（チャンク分割 + flow control）

[Connection Manager]
├── ICE state monitor — state machine管理
├── Heartbeat manager — ping/pong, DPD
├── Reconnect manager — バックオフ制御
└── Fallback controller — TURN/WebSocketフォールバック
```

---

## 参考資料

- [RFC 8445] ICE: A Protocol for NAT Traversal (2018)
- [RFC 8838] Trickle ICE: Incremental Provisioning of Candidates (2021)
- [RFC 8841] SDP Offer/Answer Procedures for SCTP over DTLS
- [RFC 8260] Stream Schedulers and User Message Interleaving for SCTP
- [MDN] WebRTC API - Session Lifetime, Perfect Negotiation, Data Channels
- [W3C] WebRTC: Real-Time Communication in Browsers (Living Standard)
- Coturn: Open-source TURN server (https://github.com/coturn/coturn)
- Cloudflare TURN Service (2024〜)

---

*このドキュメントは2026年7月時点でのベストプラクティスをまとめたものです。ブラウザのWebRTC実装は継続的に改善されているため、定期的な見直しを推奨します。*