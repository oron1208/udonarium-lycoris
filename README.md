<div align="center">

<img src="docs-site/assets/favicon.png" width="64" height="64" alt="Lycoris icon">

# 🌺 ユドナリウムリコリス

**Udonarium Lycoris** — ブラウザだけで、どこでもTRPGを。

[![GitHub license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/oron1208/udonarium-lycoris/blob/master/LICENSE)
[![GitHub release](https://img.shields.io/github/v/tag/oron1208/udonarium-lycoris?label=latest&color=e63946)](https://github.com/oron1208/udonarium-lycoris/releases)
[![Made with Angular](https://img.shields.io/badge/Angular-13-dd0031?logo=angular)](https://angular.io/)

### [▶ 今すぐ使う](https://udonarium-lycoris.ddns.net/) · [📖 取り扱い説明書](https://udonarium-lycoris.ddns.net/#guide) · [📦 更新履歴](https://udonarium-lycoris.ddns.net/#updates)

---

<img src="docs/images/hero-banner.png" width="100%" alt="ユドナリウムリコリス スクリーンショット">

</div>

## ✨ リコリスとは

ユドナリウムリコリスは、[ユドナリウムリリィ（Cylinder Lily）](https://cylinder-lily.com) をベースに、**TRPGのオンラインセッションをもっと楽しく** をテーマに大幅な改修を加えたフォーク版です。

原作者 [TK11235](https://github.com/TK11235/udonarium) とリリィ開発者の素晴らしい成果物に深く感謝します。

### 🔴 リコリス独自機能

| 機能 | 説明 |
|------|------|
| ⚔️ **イニシアチブ・戦闘管理** | ターン進行、ラウンドトラッカー、ダイスロール、計算式登録、GM秘密管理 |
| 🕯️ **照明エンジン** | 松明・魔法の光・懐中電灯・レーザー。壁による光遮断もレイキャストで再現 |
| 🎵 **ジュークボックス** | BGM・SE・環境音の3モード。ワンクリックで雰囲気をチェンジ |
| 🎭 **VNモード** | ビジュアルノベル風の立ち絵表示。自由配置・リサイズ・表情切り替え・チャットパレット連携 |
| 🎲 **ダイスカットイン** | ダイスロール時の演出アニメーション。BCDice全システム対応 |
| 🧭 **コマ演出** | 正面マーク表示・回転操作・高度な部屋設定 |
| ⌨️ **ホットバー** | よく使うマクロを登録してワンクリック発動 |
| 👁️ **視界・所有権管理** | ピースごとの所有権設定と視線管理（アドバンスモード） |
| 📝 **インベントリソート** | 任意の数で段階ソート、ドラッグ&ドロップで並び替え |

---

## 📸 スクリーンショット

<table>
<tr>
<td align="center" width="50%">

**🕯️ 照明システム**
<img src="docs/images/lighting.png" width="100%">
<em>松明・レーザー・壁の光遮断</em>

</td>
<td align="center" width="50%">

**🎵 ジュークボックス**
<img src="docs/images/jukebox.png" width="100%">
<em>BGM / SE / 環境音の3モード</em>

</td>
</tr>
<tr>
<td align="center" width="50%">

**🎭 VNモード**
<img src="docs/images/vn-mode.png" width="100%">
<em>ビジュアルノベル風の立ち絵表示</em>

</td>
<td align="center" width="50%">

**🎲 ダイスカットイン**
<img src="docs/images/dice-cutin.png" width="100%">
<em>ダイスロール演出</em>

</td>
</tr>
</table>

---

## 🚀 使い方

### すぐ遊ぶ（公開サーバー）

ブラウザでアクセスするだけ。アカウント登録不要。

👉 **[https://udonarium-lycoris.ddns.net/](https://udonarium-lycoris.ddns.net/)**

### 自前サーバーに設置する

1. [Releases](https://github.com/oron1208/udonarium-lycoris/releases) から最新版をダウンロード
2. Webサーバーに配置して `index.html` にアクセス
3. [SkyWay](https://webrtc.ecl.ntt.com/) のAPIキーを取得し、設定ファイルに記述

詳細は [📖 取り扱い説明書](https://udonarium-lycoris.ddns.net/#guide) をご覧ください。

### Docker で立てる

```bash
# ビルド
docker build -t udonarium-lycoris:latest .

# 起動（env-fileでSkyWay鍵などを指定）
docker run -d \
  --name udonarium-lycoris \
  -p 12081:12081 \
  --env-file /path/to/env \
  udonarium-lycoris:latest
```

---

## 🏗️ ビルド（開発者向け）

```bash
# 依存インストール
npm install

# 開発サーバー起動
ng serve

# プロダクションビルド
ng build --configuration=production
```

> ビルドには Node.js 16+ と Angular CLI 13 が必要です。

---

## 🌺 名前の由来

**リコリス（Lycoris）** — 彼岸花の英名。

「あの世とこの世の境界に咲く花」のように、TRPGという虚構と現実の境界で、プレイヤーたちに忘れられない体験を咲かせたい。そんな想いを込めて。

---

## 📜 クレジット

| 役割 | リンク |
|------|--------|
| **製作者** | [おれおん（@oron1208）](https://x.com/oron1208) |
| **ベースフォーク** | [ユドナリウムリリィ（Cylinder Lily）](https://cylinder-lily.com) |
| **オリジナル** | [ユドナリウム（TK11235）](https://github.com/TK11235/udonarium) |

## 📄 ライセンス

[MIT License](LICENSE) — オリジナルのユドナリウムのライセンスを引き継ぎます。

---

<div align="center">

**黄昏の物語が始まる場所で、あなただけの物語を。**

</div>
