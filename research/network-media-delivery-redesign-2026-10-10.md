# 通信の安定化・高速化・低スペック対応：1からの総合設計（2026-10-10）

## 依頼と範囲

「様々な文献・レポート・ネット情報、通信技術、オンラインゲームの方式等を参考に、通信の安定化と高速化、弱いPCでもシームレスに遊べる方法を1から考える」（13:15 おれおん依頼）。前回レビュー（room-media-retrieval-review-2026-10-10.md）の"保持管理"に対し、本稿は"配信パイプライン"を主対象にする。コード修正・デプロイは未実施。

## 現行パイプラインの実測構造（コード証拠）

### 経路は3層
1. **サーバーHTTP**: 個別GET `/api/media/:kind/:sha256`（immutable 1年キャッシュ付き＝優秀）、一括POST `/api/media/bundle`（192MiB/4096件上限、`no-store`）
2. **SkyWay P2P**: `REQUEST_FILE_RESOURE` リレー形式の参加者間転送（maxSend 6 / maxReceive 12、0.5MB単位、NULL stateはサムネイルのみ送る省略設計）
3. **部屋スナップショット同期**: relayモード（websocket-relay-connection.ts）とSkyWay初期同期（initial-room-sync.ts）の2経路

### 新たに判明した重要事実（前回レビュー未掲載）

**A. 入室がメディアZIPの完全ダウンロードでブロックされている（最大の体感問題）**
- `websocket-relay-connection.ts` receiveSnapshot: `await this.downloadMediaBundle(...)` が `applyObjectSnapshot(...)` の**前**に直列で走る。つまり卓・チャット・コマを含む部屋オブジェクトは、メディアZIPを全受信するまで1個も描画されない
- `app.component.ts` loadInitialRoomMediaBundle も `finally` で `fallback()` を呼ぶ構造＝バンドル完了まで初期同期が進まない（ただしこちらはlocalStorageフラグ `udonarium.initialMediaBundle.enabled.v1` でOFF可、既定OFF）
- **「数時間かかる」報告の直接原因はこれ。メディアが遅いのではなく、部屋そのものがメディアに人質にされている**

**B. fetchBundleにタイムアウトが存在しない**
- 個別GETは15秒固定タイムアウトがあるが、bundle POSTには無制限。回線がストールすると入室が永遠に固まる（Aと複合すると最悪）

**C. 転送中の進捗・キャンセル・再開が全滅**
- `response.blob()` で全受信→JSZip `loadAsync` で一括展開。進捗は展開フェーズのみ。切断＝ゼロからやり直し

**D. サーバーはHTTP/1.1のみ**（`http.createServer`。http2無し）
- 個別GETの並列はブラウザのHTTP/1.1接続プール上限（特にFirefox）に当たる。コードはFirefoxで並列6/16→バッチサイズを6/3に落として回避している＝プロトコル制約をアプリ層で我慢している状態

**E. ブラウザのディスクキャッシュが宝の持ち腐れ**
- 個別GETはimmutableヘッダ付きなのでブラウザキャッシュは効く。しかしblobをJSで握ってImageStorageに置く方式のため、**再訪時のキャッシュヒットがHTTP層に任せきり**で、ヒットしたか・しなかったかの制御もリストもない。Cache API/IndexedDBでの明示的永続キャッシュは無し

**F. bundle受信はmtimeを更新しない**（前回レビューどおり＝未参照化→容量削除ルートの温床）

## 外部知見との突き合わせ

- **Range/If-Range（MDN HTTP範囲リクエスト）**: `Accept-Ranges: bytes` 対応でバイト単位の部分取得・条件付き再開が標準技術として使える。チャンク化と切断再開の土台
- **Cache API（MDN）**: Service Worker無し（windowスコープ）で使える。Request/Responseをキー付きで永続保存、バージョン管理推奨、`StorageManager.estimate()`で容量把握、ブラウザが退避しうるので唯一の原本にしない——いずれも要件に合致。SHA-256アドレスのURLはそのままキーにできる
- **オンラインゲームの定石**: パッチャー系（WoW/FF14型）は「ハッシュ検証済みチャンク＋manifest＋優先度順の段階配信＋再生しながらダウンロード（streaming install）」。これはリコリスの「見える素材→控え素材」優先度（MediaLoadPriority）をチャンク単位に細分化すればそのまま再現できる
- **HTTP/2**: 単一TCPコネクションでの多重化により並列fetchの接続プール問題が消え、Firefox向けバッチ妥協も不要になる
- **低スペック系**: 仮想スクロール（一覧DOM数の抑制）、`createImageBitmap` のWorkerデコード、LQIP/サムネ先行描画、progressive JPEG

## 1からの設計：目指す体感

> **「部屋は数秒で見える。残りは裏で来る。切れても続きから。消えたら救済する。」**

### Layer 0：小パッチで即効（各1ファイル規模）

1. **ブロック解除**（最重要・最小努力）: relay受信の`downloadMediaBundle`を`applyObjectSnapshot`と並列化（awaitを外しバックグラウンド化）。これだけで「部屋が見えない時間」がメディア転送時間から切断される
2. **bundle受信にもタイムアウト＋キャンセル**: ストール検出（無通信N秒）＋ユーザーキャンセル。A+Bの複合事故を根絶
3. **bundle POSTでmtime更新**（前回P0と重複）: 未参照化→容量削除を塞ぐ
4. **bundleの`no-store`再考**: manifestに含まれない乱用を防ぎつつ、`private, max-age`程度は許容できれば再取得を減らせる（要検討）
5. **15秒固定→ストール判定**: 「無通信10秒」＋「総時間はサイズ比例の上限」に分離。低速回線の正常転送を打ち切らない

### Layer 1：進行形パイプライン（現行の延長で実装可能）

1. **manifest＋チャンク配信**: サーバーはID→(サイズ,ハッシュ,優先度候補)のmanifest JSONを返す。クライアントはMediaLoadPriority順に**チャンク（例: 64ID/32MiB）単位**でbundle POST。受信済みチャンクを記録し、切断時は欠損チャンクのみ再取得
2. **転送バイト進捗**: `response.body.getReader()` で読み取りながら進捗表示。JSZipの全受信待ちを廃止し、ストリームから逐次展開（fflate等のstreaming unzip）
3. **再試行は指数バックオフ＋ジッター**。unreachable時のP2Pフォールバックは現行維持（この二段構えは既に良い設計）
4. **バッチ内の頭打ち解消**: Promise.allのバッチ待ちを、完了済みスロットから即次を投入するスロットプール方式に

### Layer 2：永続キャッシュ（再訪・弱PCに効く）

1. **Cache APIでメディアを明示キャッシュ**: URL `/api/media/:kind/:sha256` をキーにput。入室時は`cache.match`→ missのみネットへ。バージョン付きキャッシュ名で運用
2. 容量は`StorageManager.estimate()`で監視、LRUで削除。「ブラウザが消すかもしれない=原本ではない」運用は現行のサーバー/P2P救済と両立する
3. ZIP保存やIndexedDBより実装が軽く、immutableヘッダとの整合も良い

### Layer 3：低スペックPC対応

1. ファイル一覧の**仮想スクロール**（全ImageFile分のDOM生成を止める）
2. 画像デコードを`createImageBitmap`でWorkerへ（メインスレッドのフリーズ防止）
3. bundle受信時にサムネ情報をmanifestへ乗せる（現行の再ハッシュ回避をさらに拡張し、一覧はサムネのみ描画・原画は参照時）
4. 音声は画像の初回表示待ちに巻き込まない（優先度分離は既存MediaPriorityを流用）

### Layer 4：プロトコル・インフラ

1. **HTTP/2化**: Node `http2`（TLS前提）またはフロントプロキシ（nginx/Caddy/CDN）でh2。個別GETの並列上限問題が消え、バッチ妥協コードも削れる
2. JSON APIにbrotli/gzip（bundle ZIP自体は圧縮済みなので不要）
3. 同一URLのままCDNを前置可能な構造（SHA-256アドレス＝コンテンツアドレスなのでキャッシュ亲和性が非常に高い）。将来的にVPS帯域が限界になった時の逃し先

## 実装順序の提案

1. **v1.93の柱にLayer 0-1（ブロック解除・タイムアウト・mtime）**: 数ファイル・低リスク・体感最大
2. 次にLayer 1-2（チャンク化＋Cache API）: 中規模・検証必須
3. 並行して検討: HTTP/2化（インフラ作業）
4. Layer 3はUI改善として独立リリース可能

## 検証すべきシナリオ

- 弱回線（帯域制限エミュレーション）での入室: 部屋描画までの時間がメディアと独立であること
- メディア転送中の切断→再入室: 欠損チャンプのみ再取得されること
- キャッシュ済み再訪: ネットワーク通信量が段差なく減ること
- Firefox実機での並列挙動
- 低スペック実機（またはCPUスロットリング）でのファイル一覧スクロール・画像展開

## 結論

前回の「保持管理」問題と今回の「配信パイプライン」問題は別物で、**両方直す必要がある**。ただし配信側は大改修不要で、①入室ブロックの解除②タイムアウト設計③チャンク化④Cache APIの4点が柱。特に①は変更1箇所で最大の体感改善が見込める。サーバー配信方式（SHA-256コンテンツアドレス）自体は業界の定石と合致しており、これを活かす方向で厚みを足すのが正解。

## 参考文献

- MDN: HTTP範囲付きリクエスト（Range/If-Range/206）
- MDN: Cache API（Service Worker不要・バージョン管理・StorageManager.estimate・退避リスク）
- オンラインゲームのアセット配信（パッチャーのチャンク＋manifest＋streaming install型の一般知見）
