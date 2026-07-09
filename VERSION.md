# Udonarium Lycoris Versioning

Current local development version: **1.57.0-lycoris.0**

## Policy

- Upstream-compatible base: Udonarium Lycoris 1.11.0
- Local Lycoris feature builds use `1.xx.0-lycoris.0` aligned with the visible release line.
- Update `package.json`, `package-lock.json`, `VERSION.md`, and the in-app options panel display together.

## Release line for v1.5x

### v1.57.0 (current)
- 入室直後のメディア取得を優先度制御（卓背景・卓上コマ・再生中音声を先に取得）
- 未参照の画像・音声は低優先度/少数並列にして、初期表示と操作レスポンスを改善
- 大きい立ち絵/コマ画像を表示サイズ近くへ多段階縮小する高品質表示キャッシュを追加
- 画像リサイズ処理を多段階縮小化し、縮小時のジャギ・モアレを軽減

### v1.56.0
- 重いファイル処理をWorker側へ移し、画像処理中のUI停止を軽減
- Worker内リサイズも多段階縮小に対応し、圧縮後画像の品質を改善

### v1.55.0
- ファイル名表示修正、アップロード高速化、サーバー重複確認による再アップロード削減
- ZIP保存時にサーバー上の不足画像を取得して画像漏れを防止

### v1.54.0
- 画像・音声ファイルのサーバー配信化（P2P→サーバー優先、リトライ強化）
- 平面モードのマウスホイール拡大縮小、マウスポインタ共有
- ホットバー右クリック編集、マクロコピー、キャラクターグループ部位管理ホバーパネル開発

### v1.53.0
- BGM再生バグ修正（保存部屋でテーブルBGMが空でも優先度上書きされる問題）
- 一括判定ダメージパネルの式評価強化（固定値・`c()`計算記法・独自ダイスボット・数式）
- チャットパレット参照の入れ子対応（最大32回ループ）
- 対抗ロールカットイン・一括判定パネルにチャットパレットピッカー追加
- 画像アップロード時の自動圧縮（2MB超→最大1920px / quality 0.85）

### v1.52.0
- 一括判定ダメージパネル
- 自動効果音同期修正・アニメ調整
- ジュークボックスZIP保存拡張

### v1.50.0
- バフ機能大幅強化・バフマネージャー
- `&!` 構文
- トラッカードラッグ
- ローカル開発中のメディア管理 / dev-admin強化
