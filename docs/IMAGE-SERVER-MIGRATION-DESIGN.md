# 画像サーバー配信化 設計書

> 作成日: 2026-06-23  
> バージョン: ドラフト v0.1  
> 作成者: マコ  

---

## 1. 背景と目的

### 現状の課題
現在、ユドナリウムリコリスの画像同期は **P2P (DataChannel) 経由** で行われている。
BGM/音声は v1.43 でサーバー配信（ストリーミング）に移行済みだが、画像は依然としてP2P同期に依存している。

**問題点:**
- P2Pで画像バイナリをばら撒くため、参加者増加時に帯域が圧迫される
- NAT越え失敗時に画像同期ができない（テキストはDataChannel上だが画像バイナリが届かない）
- 新規参加者の画像取得が遅い（P2Pの接続確立を待つ必要がある）
- `BufferSharingTask` によるチャンク分割送信が複雑で、エラー復帰が脆弱

### 目標
画像ファイルのバイナリ配信を **サーバー経由** に統一し、P2PのDataChannelは **メタデータ（identifier等）の同期のみ** に特化させる。

---

## 2. 現状アーキテクチャ

### 2.1 画像を使用しているコンポーネント一覧

| クラス | 画像の用途 | imageIdentifier参照 | 備考 |
|--------|-----------|---------------------|------|
| `GameCharacter` | コマ画像 | `imageDataElement > imageIdentifier` | メインの使用箇所 |
| `GameTable` | 背景画像 | `imageIdentifier`, `backgroundImageIdentifier` | SyncVar |
| `Terrain` | 壁画像・床画像 | `wallImage`, `floorImage` (getImageFile) | |
| `Card` | 表画像・裏画像 | `frontImage`, `backImage` | |
| `CardStack` | 山札表示画像 | topCard経由 | |
| `DiceSymbol` | ダイス画像 | face別画像 | |
| `ChatMessage` | チャット内画像 | `imageIdentifier` | SyncVar |
| `ChatTab` | VN立ち絵（12スロット） | `imageIdentifier[]` | SyncVar |
| `PeerCursor` | カーソル画像 | `imageIdentifier` | SyncVar |
| `CutIn` | カットイン画像 | `imageIdentifier` | |
| `Alarm` | アラーム画像 | ImageStorage参照 | |
| `Vote` | 投票画像 | ImageStorage参照 | |
| `ImageTag` | 画像タグ管理 | `imageIdentifier` | SyncVar |
| `TabletopObject` (基底) | 汎用画像要素 | `imageDataElement > imageIdentifier` | ほぼ全オブジェクトの基底 |

### 2.2 現状のデータフロー

```
[画像アップロード]
ユーザー → FileArchiver.handleImage() → ImageStorage.addAsync()
  → ImageFile.createAsync() (SHA256ハッシュ計算, Blob作成, サムネイル生成)
  → ImageStorage._add()
    → ServerMediaStorage.uploadImage() [サーバーへ非同期アップロード]
    → ImageStorage.synchronize() [P2Pでカタログ同期]

[P2P画像同期 — 新規参加者/カタログ受信時]
他クライアント → SYNCHRONIZE_FILE_LIST (P2P Event)
  → ImageSharingSystem
    → ServerMediaStorage.fetchImage() [サーバーから取得を試行]
    → 取得できなければ REQUEST_FILE_RESOURE (P2P)
      → BufferSharingTask で32KBチャンク分割送信
      → UPDATE_FILE_RESOURE で受信
```

### 2.3 既存のサーバー連携（部分的実装済み）

`ServerMediaStorage` は既に実装されており、以下が動いている:
- `PUT /api/media/image/{identifier}` — アップロード
- `GET /api/media/image/{identifier}` — ダウンロード
- `fetchImage()` はP2P同期のフォールバックとして既に動作

**つまり、サーバーへのアップロード/ダウンロードは既に実装済み。**
P2P同期（`ImageSharingSystem` / `BufferSharingTask`）が**並行して動いている**状態。

### 2.4 クライアント側の画像キャッシュ

現在、画像はクライアントの **IndexedDB** には保存されていない。
`ImageFile` の `blob` は **メモリ上（`imageHash` オブジェクト）** に保持され、
`url` は `window.URL.createObjectURL(blob)` で生成されたBlob URL。

→ ページリロードで画像キャッシュは消滅し、毎回サーバーまたはP2Pから再取得する。

---

## 3. 移行設計

### 3.1 基本方針

1. **画像バイナリのP2P同期を廃止** — `ImageSharingSystem` のバイナリ転送部分を無効化
2. **サーバー配信に一本化** — `ServerMediaStorage.fetchImage()` を主経路にする
3. **メタデータ同期は維持** — `SYNCHRONIZE_FILE_LIST`（identifier カタログ）はP2Pで維持
4. **段階的移行** — フェーズ分けしてリスクを最小化

### 3.2 アーキテクチャ変更後のデータフロー

```
[画像アップロード]
ユーザー → FileArchiver.handleImage() → ImageStorage.addAsync()
  → ImageFile.createAsync() (SHA256, Blob, サムネイル)
  → ImageStorage._add()
    → ServerMediaStorage.uploadImage() [サーバーへアップロード ★唯一の配信経路]
    → ImageStorage.synchronize() [P2Pでカタログ同期（identifierのみ）]

[画像取得 — 新規参加者/カタログ受信時]
他クライアント → SYNCHRONIZE_FILE_LIST (P2P Event)
  → ImageSharingSystem (簡略化版)
    → ServerMediaStorage.fetchImage() [サーバーから取得 ★唯一の取得経路]
    → 取得失敗時はリトライ or プレースホルダー表示
```

### 3.3 変更対象ファイル

#### コア変更（必須）
| ファイル | 変更内容 |
|----------|---------|
| `image-sharing-system.ts` | `BufferSharingTask` 使用のバイナリP2P転送を廃止。`SYNCHRONIZE_FILE_LIST`受信時は`ServerMediaStorage.fetchImage()`のみ使用 |
| `image-storage.ts` | `synchronize()` はidentifierカタログのみ送信（現状維持）。`get()` の遅延fetchを維持 |
| `server-media-storage.ts` | リトライ機能、エラーハンドリング強化 |
| `buffer-sharing-task.ts` | 画像転送用としては廃止（音声等で使用がなければ全体廃止） |

#### 保存・エクスポート変更（必須）
| ファイル | 変更内容 |
|----------|---------|
| `save-data.service.ts` | `searchImageFiles()` で画像blobをzipに詰める際、メモリに無ければサーバーからfetchしてから詰める |
| `file-archiver.ts` | zip読み込み時の`handleImage()`は現状維持（ローカル→サーバーアップロード） |

#### コンポーネント側（影響確認のみ、基本的に変更不要）
画像参照はすべて `ImageStorage.instance.get(identifier)` → `ImageFile.url` 経由なので、
内部でblobがサーバー由来でもP2P由来でも **URLベースで透過的** に扱える。
→ **UIコンポーネント側の変更は原則不要**

---

## 4. トラブルシューティング・リスク分析

### 4.1 ユーザー目線のリスク

| リスク | 影響 | 対策 |
|--------|------|------|
| **サーバーdown時、画像が全滅** | 全部屋の画像が表示されない | IndexedDBキャッシュ実装（フェーズ2）でオフライン耐性確保 |
| **画像読み込みが遅くなる？** | 新規参加者の初期表示が遅延 | サムネイル先にfetch（サイズ小）、その後にフル画像。体感表示は現状と同等の見込み |
| **zip保存時に画像が欠ける** | サーバーからfetch失敗した画像がzipに入らない | fetchリトライ + 欠落画像のリスト表示 warning |
| **zip読み込み時の挙動変化** | 従来通りローカル登録→サーバーアップロードで問題なし | `handleImage()` → `ImageStorage.addAsync()` → `ServerMediaStorage.uploadImage()` のフロー維持 |
| **過去の部屋データ（zip）の互換性** | 既存zipに画像blob入り → 読み込み時にサーバーへアップロードされるだけ | 問題なし。後方互換は保たれる |
| **2MB超画像** | 現状 `maxImageSize = 2MB` で弾かれる | サーバー配信化しても制限は維持（クライアント側で事前圧縮） |

### 4.2 サーバー目線のリスク

| リスク | 影響 | 対策 |
|--------|------|------|
| **ディスク容量増大** | 全部屋の画像がサーバーに蓄積 | 既存の `[media-gc]` ゴミ収集で未参照画像を削除（実装済み） |
| **帯域・CPU負荷増** | 全画像リクエストがサーバーに集中 | HTTPキャッシュヘッダ（Cache-Control）、CDN検討、サムネイル別エンドポイント |
| **メモリ使用量** | 同時リクエスト増でNode.jsの負荷上昇 | 同時fetch数制限、ストリーミング転送 |
| **VPSの帯域制限** | ConoHa VPSの通信量上限 | モニタリング必要。画像平均サイズ×同時接続数で試算 |
| **サーバー再起動時のデータ消失** | Docker volume消えると画像全滅 | named volume または bind mount で永続化（現状確認必要） |

### 4.3 同期ロジックのエッジケース

| ケース | 現状 | 移行後 |
|--------|------|--------|
| 新規参加者の画像取得 | P2P or サーバー | サーバーのみ |
| P2P接続が不安定 | 画像同期失敗 | 影響なし（サーバー経由なので） |
| 同時アップロード競合 | サーバー409で処理済み | 同様 |
| 画像アップロード中に切断 | P2Pで他クライアントから補完可能 | サーバーに無ければ画像消失。カタログ同期で再アップロード要求が必要かも |
| 古いバージョンのクライアント混在 | — | P2P同期を期待する旧クライアントには画像が届かない。**バージョン統一が必須** |

---

## 5. 移行フェーズ

### フェーズ1: サーバー配信への完全切り替え（最小変更）
- [ ] `ImageSharingSystem` の `BufferSharingTask` バイナリ転送を無効化
- [ ] `SYNCHRONIZE_FILE_LIST` 受信時は `ServerMediaStorage.fetchImage()` のみ使用
- [ ] `REQUEST_FILE_RESOURE` / `UPDATE_FILE_RESOURE` / `START_FILE_TRANSMISSION` イベントハンドラ削除
- [ ] `ServerMediaStorage` のリトライ・タイムアウト強化
- [ ] テスト: ローカル環境で複数ブラウザタブ間同期確認

### フェーズ2: IndexedDBキャッシュ実装（オフライン耐性）
- [ ] `ImageStorage` にIndexedDBレイヤー追加
- [ ] サーバーから取得した画像をIndexedDBにキャッシュ
- [ ] ページリロード時にキャッシュから復元 → サーバーへの再fetchを削減
- [ ] キャッシュ容量上限設定（LRU eviction）

### フェーズ3: パフォーマンス最適化
- [ ] サーバー側でサムネイル別エンドポイント提供
- [ ] HTTP Cache-Control / ETag で再取得を最適化
- [ ] zip保存時の画像fetchをバッチ化・並列化
- [ ] `media-gc` の実行頻度・効率の見直し

---

## 6. 今までの部屋を使っていたユーザーへの影響

### 6.1 zipエクスポート（部屋の保存）
- **現状**: メモリ上のblobを直接zipに詰める
- **移行後**: サーバーからfetchしてからzipに詰める
- **影響**: 保存に時間がかかる可能性。進捗バー表示推奨。
- **互換性**: 出力されるzipの形式は変わらない → **他ユーザーへの共有に影響なし**

### 6.2 zipインポート（部屋の読み込み）
- **変化なし**: zip内の画像 → ローカルImageStorage登録 → サーバーアップロード
- 既存zipファイルはそのまま読み込み可能

### 6.3 セッション中の体験
- **改善**: 新規参加者の画像表示が安定する（P2Pに依存しない）
- **改善**: P2P接続が切れても画像同期が継続する
- **懸念**: サーバー依存度が上がるため、サーバーdown時の影響範囲が大きい

---

## 7. サーバー側API変更要件

### 現状のAPI（変更不要）
```
PUT  /api/media/image/{identifier}  — 画像アップロード
GET  /api/media/image/{identifier}  — 画像ダウンロード
```

### 検討すべき追加API
```
GET  /api/media/image/{identifier}/thumbnail  — サムネイル取得（フェーズ3）
GET  /api/media/catalog  — サーバー上の画像カタログ取得（フェーズ1のフォールバック用）
DELETE /api/media/image/{identifier}  — 個別削除（管理者用）
```

### キャッシュヘッダー設定（フェーズ1で推奨）
```
Cache-Control: public, max-age=31536000, immutable
ETag: {identifier}  (SHA256ハッシュなのでetagとして使える)
```

---

## 8. 懸念事項・未解決問題

### 8.1 画像アップロード中の切断
P2P同期があれば、アップロード中に切断しても他クライアントが画像を持っていた。
サーバー配信化後は、アップロード前に切断すると **画像が消失** する可能性。

**対策案**: アップロード完了をawaitしてからオブジェクト同期する？それとも非同期のままでリトライに頼る？

### 8.2 旧バージョンとの互換性
移行後に旧バージョンのクライアントが部屋に参加した場合、
P2Pで画像バイナリを要求してくるが、新バージョンは応答しない。

**対策**: **バージョン一致を必須化**。または移行直後にアナウンス + 強制アップデート。

### 8.3 サーバーのストレージ容量
長期間運用で画像が蓄積する。`media-gc` は未参照画像を削除するが、
部屋データが残っている間は参照されるため消えない。

**対策**: 定期的なデータサイズ監視。不要部屋の削除推奨。

### 8.4 音声のP2P同期 (`AudioSharingSystem`)
音声も `ServerMediaStorage` と `AudioSharingSystem`（P2P）の二重構成になっている可能性。
画像と同じ判断でP2Pを廃止すべきか検討。

---

## 9. テスト計画

### 単体テスト
- `ServerMediaStorage.fetchImage()` のリトライ動作
- `ImageStorage.get()` の遅延fetch動作
- `save-data.service.ts` の `searchImageFiles()` でサーバーfetchを含む動作

### 結合テスト
- 2ブラウザタブ間で画像同期（一方がアップロード → 他方が表示）
- 新規参加者の画像取得（全画像がサーバー経由で表示されるか）
- zip保存 → zip読み込みのラウンドトリップ
- サーバーdown時のフォールバック動作

### 負荷テスト
- 多人数（5-8人）参加時の画像取得 latency
- 大量画像（100枚以上）の部屋での初期表示時間
- サーバーのディスク使用量・帯域消費量

---

## 10. まとめ

サーバー配信化は **BGMで実績済み** のアプローチで、画像にも適用可能。
`ServerMediaStorage` は既に部分実装されているため、**やるべきことは「P2Pバイナリ転送の削除」がメイン**。

最大のリスクは **サーバー依存度の上昇** だが、IndexedDBキャッシュ（フェーズ2）で軽減可能。
移行は段階的に行い、各フェーズでテストを挟むことで安全に進める。

---

*この設計書はドラフトです。パパのレビュー後に実装計画を確定します💕*
