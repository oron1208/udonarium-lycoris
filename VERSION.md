# Udonarium Lycoris Versioning

Current local development version: **1.53.0-lycoris.0**

## Policy

- Upstream-compatible base: Udonarium Lycoris 1.11.0
- Local Lycoris feature builds use `1.xx.0-lycoris.0` aligned with the visible release line.
- Update `package.json`, `package-lock.json`, `VERSION.md`, and the in-app options panel display together.

## Release line for v1.5x

### v1.53.0 (current)
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
