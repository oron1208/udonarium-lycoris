# 軽量化・第一段階（2026-11-10）

## 範囲

通常の画像コマ卓を軽くする。画質を下げる変更、公開Add-onストア、通信方式の全面置換は含まない。
3Dコマは既存の実験フラグで既定OFFのまま（[実験機能](model3d-experiment.md)）。
サーバープロトコル・保存形式を変えず、まずクライアントの不要な仕事と同時処理の集中を減らした。

## 実装

- **照明**: 常時requestAnimationFrameを廃止。状態変更で一度描画し、炎などの動的光源がある間だけ従来相当の約15fpsで更新。非表示タブでは停止する。移動・サイズ・高度・地形・平面表示の変更でも更新する。
- **画像**: ファイル処理Workerの実行中ジョブを2件、サムネイルのメインスレッド代替処理を1件に制限。Worker異常時は待機を含めて失敗を確定し、代替経路へ戻す。縮小用の中間Canvasを解放。PNG/WebPのサムネイルは透過を維持する。
- **原画維持**: 原画バイト・ハッシュ・コマ表示の解像度は変更しない。画像一覧だけ`loading="lazy"`/`decoding="async"`と安定ID追跡を適用。
- **個別メディアGET**: 共通キューで最大4件。待機時間はI/Oタイムアウトに含めない。同じIDはHTTP取得だけでなく画像/音声オブジェクトの構築までPromiseを共有する。高優先度の待機処理を先に開始する。
- **Relay入室**: snapshot→順序付き差分適用が完了したら操作を解禁。素材はキャッシュ優先・個別GETで背景取得する（背景側2ワーカー、上記共通キューを利用）。卓上素材を優先し、進捗は画面端へ出す。従来のSkyWay任意ZIP経路は変更しない。
- **同期の保護**: 状態適用途中のsnapshot保存を抑止。ACKによる受信カーソルの更新も受信キューに並べ、保留中の適用を追い越させない。キュー実行時にも重複・部屋世代を検査する。退室済みの背景取得は新しい部屋に追加しない（共有HTTP取得自体は完了してキャッシュされる場合がある）。
- **VN表示**: 空の舞台でも動いていた100ms周期時計を廃止。発話/吹き出しの期限がある間だけ次の期限にタイマーを設定。非表示タブの文字送りや、舞台クリア/破棄時の表示用タイマーを停止。接続維持用の心拍は停止しない。

背景素材の件数は「処理済み/処理対象」であり、全件の取得成功やサーバー保存成功を示すものではない。素材が欠落していても部屋状態の同期完了と区別する。

## 計測

同じPC上の隔離ローカルRelay・新規プロファイル・ヘッドレスChromeで、各条件を安定後3秒観測。
64体条件は既存の画像コマに64体を追加した構成。実際の利用者端末やVPSでの負荷試験ではない。

- 通常待機: 照明描画入口 **181回 → 0回 / 3秒**。
- 静的光源の待機: **155回 → 0回 / 3秒**。
- 64体追加の待機: **176回 → 0回 / 3秒**。
- 動的光源: **156回 → 45回 / 3秒**。常時確認分を除き、必要なアニメーションは維持。
- 画像一覧: 観測した5枚すべて遅延読込指定（変更前0枚）。

これは照明確認やページ内処理の計測であって、「PC全体が何%速い」「消費メモリが何%減った」という結果ではない。
原画を保持するため、大量/巨大画像の常駐メモリ問題をすべて解決したわけでもない。

証拠（ローカル生成物）:

- 基準: `tmp/lightweight/baseline-1794296197276/results.json`
- 最終比較: `tmp/lightweight/final-1794298043281/results.json`
- 最終機能確認: `tmp/lightweight/behavior-1794298043287/results.json`
- production Enter入室: `tmp/password-entry/1794298043257-enter-standard/results.json`

## 確認手順

```sh
node tools/test-lightweight.cjs
npx ng build --configuration development --output-path tmp/lightweight/dev
npx ng build --configuration production --output-path tmp/lightweight/production
node tools/verify-lightweight.cjs tmp/lightweight/dev/browser comparison
node tools/verify-lightweight-behavior.cjs tmp/lightweight/dev/browser
node tools/verify-password-entry.cjs tmp/lightweight/production/browser enter
node tools/verify-model3d-hidden.cjs tmp/lightweight/dev/browser
```

ブラウザ機能確認では、実Workerで2048px透過PNG8枚の同時投入、原画SHA-256一致、代替処理のエラー後復旧、VNの実DOM期限表示、実Relayのsnapshot適用を検査する。素材HTTPを意図的に保留し、同時4件以内・操作解除・コマ変更の受信カーソル進行・後着画像の実DOM表示・同一IDの取得共有を確認する。
照明条件や短い発話期限は開発ビルドへ投入した試験用データであり、実ユーザー操作と区別する。productionのパスワード入室はCDPの信頼されたキーボード入力で確認する。ACK順序と旧部屋イベント破棄は実接続の確認に加え、受信キューを意図的に保留する制御試験を行う。

## 次の段階（未実装）

- 長い一覧の仮想化、画面表示用画像の段階解像度とズーム時原画切替。
- 機能単位の遅延モジュール/依存関係整理。Add-on SDK・権限・互換性・ストアは別設計。
- 大規模卓・長時間接続・低メモリ端末・実SkyWay経路での計測。
- アップロード成功確認・再試行・サーバー削除後の復旧保証は、従来のネットワーク改善資料に残る別作業。

公開対象はローカル試用版のみ。VPSへの反映やサーバー再起動は今回の範囲外。

## ローカル反映記録

2026-11-10、ローカル試用版へ静的ファイルを反映。設定を保持し、旧indexを退避、既存chunkを残してindexを最後に原子置換した。

- main: `main-DGX4FJNF.js`
- SHA-256: `f59b570e7702fdf32531e815fe643e126be73a7333efaef99b2833da00171b83`
- 配信資産594件を照合。記録と旧index: `tmp/lightweight/deploy/`。
- 新規productionブラウザで上記main・通常卓表示・例外0・3D非起動・WebGL context生成0・3D chunk未取得を確認。
- 3D隠し機能の回帰証拠: `tmp/spike-3d/hidden-check-1794298074374/results.json`。
- VPS変更・push・サーバー再起動なし。

### 同日、その後のVPS公開

17:15のユーザー指示「現状の軽量化バージョンをVPS更新して」により、同じproduction資産をVPSへ公開した。
595件のmanifestを照合（環境固有configを保持）、318件を追加/差し替え。新規productionブラウザで同mainの実ロード、卓表示、例外0、WebGL生成0、3D chunk未取得を確認した。
VPSのserver SHA-256は `c48ab1c8abaf4c29a407df7a449c43d3b503480eeb8993607fca64c257f3695e` のまま。コンテナID・起動時刻不変、SkyWay設定も維持。部屋・素材データには触れていない。
旧indexと公式サイトindex・配布ZIPは `/root/release-backups/v2.3-lightweight-20261110/` に保存。
同版v2.3の配布ZIPも更新し、全資産バイト照合・CRC・公開download SHA-256 `dc03000180d3a393f52fae14711077bcf122c9dd51837bb8941b16fadc2838a4` を確認。
配信記録は `tmp/lightweight-vps-20261110/`。Git pushはしていない。
