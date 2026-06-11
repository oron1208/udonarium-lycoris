# ユドナリウムリコリス 運用手順書

## リリィ（Lily）とリコリス（Lycoris）の違い

| | リリィ（旧称） | リコリス（現行） |
|---|---|---|
| **正式名称** | ユドナリウムリリィ | ユドナリウムリコリス |
| **プロジェクトパス** | `~/.openclaw/workspace/projects/udonarium_lily` | `~/.openclaw/workspace/projects/udonarium-lycoris/` |
| **Dockerコンテナ名** | `udonarium-lily` | `udonarium-lycoris` |
| **Docker image名** | `udonarium-lily` | `udonarium-lycoris` |
| **distディレクトリ** | `dist/udonarium_lily/`（アンダースコア） | `dist/udonarium-lycoris/`（ハイフン） |
| **現在の状態** | 廃止。互換性シンボリックリンクのみ残存 | 現行バージョン |

### 注意
- VPSのコンテナ名は `udonarium-lycoris` に変更済み（2026-05-25）
- VPSのenv-fileパスは `/etc/udonarium-lily.env` のまま（歴史的理由で名称未変更、中身はリコリス用）
- ローカルの互換性シンボリックリンク `udonarium_lily -> udonarium-lycoris` が存在

---

## 現行バージョン

**v1.33.0-lycoris.0**（2026-06-11）

---

## VPS（ConoHa）情報

| 項目 | 値 |
|---|---|
| **IP** | `160.251.182.194` |
| **ドメイン** | `udonarium-lycoris.ddns.net` |
| **SSH鍵** | `VPSサーバー設定/key-2026-05-23-15-23.pem` |
| **env-file** | `/etc/udonarium-lily.env`（`--env-file`方式必須） |
| **dev-admin token** | `/root/.udonarium-lycoris-dev-admin-token` |
| **Dockerコンテナ** | `udonarium-lycoris` |
| **Docker image** | `udonarium-lycoris:latest` |
| **ポート** | `127.0.0.1:12081:12081`（nginxがHTTPS終端） |
| **データボリューム** | `udonarium-lycoris-data` → `/app/data` |
| **ソースパス（VPS上）** | `/opt/udonarium-lycoris/` |

---

## ConoHa VPS デプロイ手順

### 前提
- ローカルでビルド済み（`dist/udonarium-lycoris/` が存在すること）
- SSH鍵が `VPSサーバー設定/key-2026-05-23-15-23.pem` にあること

### 1. デプロイ用tar.gzを作成

```bash
cd ~/.openclaw/workspace/projects/udonarium-lycoris
tar czf /tmp/udonarium-lycoris-deploy.tar.gz \
  unified-server.js \
  dev-admin.html \
  dist/udonarium-lycoris/ \
  Dockerfile
```

### 2. VPSに転送

```bash
VPSKEY=VPSサーバー設定/key-2026-05-23-15-23.pem
scp -i $VPSKEY /tmp/udonarium-lycoris-deploy.tar.gz root@udonarium-lycoris.ddns.net:/tmp/
```

### 3. VPSで展開・ビルド・再起動

```bash
ssh -i $VPSKEY root@udonarium-lycoris.ddns.net

# バックアップ
cd /opt/udonarium-lycoris
cp -r dist dist.bak-$(date +%Y%m%d-%H%M%S)

# 展開
tar xzf /tmp/udonarium-lycoris-deploy.tar.gz

# Docker image再ビルド
docker build -t udonarium-lycoris:latest .

# コンテナ再作成（env-file必須！）
docker stop udonarium-lycoris
docker rm udonarium-lycoris
docker create \
  --name udonarium-lycoris \
  --env-file /etc/udonarium-lily.env \
  -p 127.0.0.1:12081:12081 \
  -v udonarium-lycoris-data:/app/data \
  udonarium-lycoris:latest
docker start udonarium-lycoris

# ログ確認
docker logs udonarium-lycoris
```

### 4. 動作確認

```bash
# ローカルから実行
curl -sk https://udonarium-lycoris.ddns.net/ | head -2
# → <!DOCTYPE html>... が返ればOK

curl -sk https://udonarium-lycoris.ddns.net/v1/status
# → {"ok":true}

curl -sk https://udonarium-lycoris.ddns.net/dev-admin | head -2
# → <!doctype html>... が返ればOK

curl -sk -X POST https://udonarium-lycoris.ddns.net/v1/skyway2023/token \
  -H "Content-Type: application/json" \
  -d '{"formatVersion":1,"channelName":"test","peerId":"testPeer"}'
# → {"token":"eyJ..."} が返ればOK
```

### ⚠️ よくある失敗と対策

| 失敗 | 原因 | 対策 |
|---|---|---|
| SkyWay token発行エラー | env-file未設定 | `--env-file /etc/udonarium-lily.env` を必ず指定 |
| dev-admin forbidden | DEV_ADMIN_TOKEN未設定 | env-fileに `DEV_ADMIN_TOKEN=...` が含まれているか確認 |
| Not found | distディレクトリ不一致 | `dist/udonarium-lycoris/`（ハイフン）が存在するか確認 |
| コンテナ起動直後に停止 | npm install失敗 | `docker logs udonarium-lycoris` でエラー確認 |

---

## ローカルサーバー起動手順

### 起動スクリプト

`/tmp/udonarium-start.sh` を使用（execの引数長制限対策）：

```bash
#!/bin/bash
export DEV_ADMIN_TOKEN='<ローカル用トークン>'
export SKYWAY_APP_ID='<ローカル用APP_ID>'
export SKYWAY_SECRET_KEY='<ローカル用SECRET_KEY>'
cd /home/maco/.openclaw/workspace/projects/udonarium-lycoris
exec node unified-server.js
```

### 設定ファイルの場所

| 項目 | ファイル |
|---|---|
| SkyWay（ローカル用） | `ローカルサーバー設定/skyway設定.txt` |
| SkyWay（VPS用） | `/etc/udonarium-lily.env`（VPS上） |
| dev-admin token | `VPSサーバー設定/dev-admin-token.txt` |
| dev-admin token（VPS） | `/root/.udonarium-lycoris-dev-admin-token`（VPS上） |

### 起動コマンド

```bash
chmod +x /tmp/udonarium-start.sh
nohup /tmp/udonarium-start.sh &>/tmp/udonarium-signaling.log &
disown
```

### ⚠️ 注意
- `exec`の引数が長すぎるとSIGKILLされる → **必ずスクリプト方式**
- VPSとローカルでSkyWay APP_IDが違う（別々のSkyWayアプリケーション）

---

## ビルド手順

```bash
cd ~/.openclaw/workspace/projects/udonarium-lycoris
npx ng build --configuration=production
```

### ビルド時の注意
- CSS budget warning は4つ出るが**エラーではない**（無視してOK）
- distは `dist/udonarium-lycoris/` に生成される
- ビルド前に**必ずgit commit**すること（checkout -- . で変更消失を防ぐ）

---

## Git運用

```bash
# 現在のコミット確認
git log --oneline -5

# 作業前に必ずコミット
git add -A && git commit -m "作業前保存"

# バージョンタグ
git tag v1.22.0
```

### ⚠️ 絶対にやらないこと
- `git checkout -- .`（コミット前の変更が全消失する）
- `git stash` の乱用（戻し忘れで変更消失）
- ビルド前にコミットせずに編集を続けること

---

## バージョン履歴

| バージョン | 日付 | 主な変更 |
|---|---|---|
| v1.33.0 | 2026-06-11 | インベントリN段ソート、操作ガイド/アップデート内容の公式サイト化、ヘルプUI整理 |
| v1.32.0 | 2026-06-11 | 地形スナップ修正（浮きバグ解消）、地形自己スナップ防止、当たり判定修正 |
| v1.31.0 | 2026-06-10 | 音声ファイル同期修正、アドバンスモード表示修正、ADVANCEDバッジ、壁グリッドキャッシュ |
| v1.30.0 | 2026-06-09 | アドバンスモード、コマ権限管理、視界管理、ダイスロール演出 |
| v1.22.0 | 2026-06-01 | 正面マークドラッグ回転、照明レーザー、魔法の光ソナー演出 |
| v1.21.0 | 2026-05-30 | VNログイン修正、吹き出し同期、パフォーマンス改善 |
| v1.20.0 | 2026-05-29 | 照明システム、VNステージ、ホットバー |
| v1.13.1 | 2026-05-28 | ジュークボックス3モード、名前ラベルON/OFF |
| v1.13.0 | 2026-05-27 | ジュークボックス、名前ラベル |
| v1.12.0 | 2026-05-24 | プロジェクト名変更（lily→lycoris） |

### v1.33.0（2026-06-11）

- **インベントリN段ソート**：並び順のソートキーを第1・第2の2段固定から、任意の数に追加・削除可能に変更。ドラッグ&ドロップで順番の入れ替え、プルダウンで表示項目タグの選択が可能
- **操作ガイドの公式サイト化**：オプションパネルと接続状況パネルの操作ヘルプを、公式サイトの操作ガイドページへのリンクに変更
- **アップデート内容の公式サイト化**：アップデート履歴を公式サイトのアップデートセクションへのリンクに変更
- **ヘルプUI整理**：操作ガイド・アップデート内容・サンプルキャラ追加を独立したボタンに分離
- **バージョン表示**：オプションパネルのヘルプセクションにバージョン番号を表示

### v1.32.0（2026-06-11）

- **地形スナップ修正**：コマを立体地形から平面に移動した際、Z座標がリセットされず浮いたままになる問題を修正。`pointer3d.z`が0（地面）の時はZ=0にスナップするよう変更し、地形上では従来通り「開始Zより下に落ちない」挙動を維持
- **地形自己スナップ防止**：地形自身を移動した際、`getTerrainTopZ`が自分自身を判定対象に含めてしまい、ドロップのたびに少しずつ上昇する問題を修正。`identifier`で自分自身を除外するよう変更
- **地形当たり判定修正**：`getTerrainTopZ`のTerrain範囲判定で`width`/`depth`（グリッド単位）に`gridSize`を掛けていなかった問題を修正。1グリッドの地形でも正しいピクセル範囲で当たり判定が行われる

### v1.31.0（2026-06-10）

- **音声ファイル同期修正**：複数の音声ファイルを同時にアップロードした際、2曲目以降のファイル名がハッシュ値になる問題を修正
- **アドバンスモード表示修正**：部屋から退出後もアドバンスモードのUIが残る問題を修正。ロビーでは通常表示に戻る
- **ADVANCEDバッジ追加**：アドバンスモードの部屋ではサイドメニュー上部に「ADVANCED」バッジを表示
- **壁グリッドキャッシュ最適化**：アドバンスモードで壁を設置した際のパフォーマンスを改善（壁グリッドの再構築を200ms間隔に最適化）
- **ファビコン更新**：リコリスオリジナルファビコンに変更

### v1.30.0（2026-06-09）

- **アドバンスモード追加**：視界管理・所有権管理・ダイスロール演出強化の拡張部屋モードを追加。通常モードと使い分け可能
- **コマ権限管理**：アドバンスモードでコマの所有権設定を追加。自分のコマだけ操作可能に
- **視界管理**：コマの視線範囲を設定可能。所有権と組み合わせて戦闘の視界シミュレーションに
- **ダイスロール演出**：BCDiceの全ダイスロール（通常・有利不利・イニシアチブ・ダメージ）で自動カットイン演出。キャラアイコン表示・元コマンド表示・クリティカル/ファンブル演出付き

### v1.22.0（2026-06-01）

- **コマ正面マーク強化**：コマの向き（光源方向 rotate + 90）を表示する正面マークを追加。平面モードでは正面マークをドラッグしてコマを回転可能
- **照明レーザー追加**：照射形状に「レーザー」を追加。指定色の細い直線光を rotate + 90 方向へ照射し、壁で遮断
- **光源タイプ整理**：光源タイプを「松明」「魔法の光」「懐中電灯」の3種類に整理
- **魔法の光演出**：魔法の光にソナー風の脈動リング表現を追加
- コーン/レーザー/懐中電灯の近距離照明を調整し、光源の足元が自然に見えるよう改善

### v1.21.0（2026-05-30）

- **VNステージ ログイン修正**：VNモードONでログイン時のフリーズを解消。部屋に入る際にVNステージを一時的に非表示にし、同期完了後に自動復帰
- **立ち絵同期**：後から入室したプレイヤーのVNステージにも、既に登場中の立ち絵が正しく同期されるよう修正
- **セリフポップ同期**：他のプレイヤーのVNチャット発言の吹き出しが表示されない問題を修正
- 後からVNモードをONにした際も、既存の立ち絵が表示されるよう修正
- charactersゲッターのキャッシュ追加等、パフォーマンス改善

### v1.20.0（2026-05-29）

- **照明システム追加**：テーブルの暗さスライダー、キャラ/地形に光源設定（松明・焚き火・ランタン等）を追加。ペンツールの「壁として扱う」で光を遮断する壁を描ける（レイキャスト方式）
- **GMモード連動**：GM宣言中は暗闇が無効化され、光源の位置だけが確認できる
- **VNステージ**：立ち絵の表示・表情切り替え・吹き出しタイプライター演出を追加
- **ホットバー**：12枠×5ページ＝60個のマクロパレットを追加
- サイドメニューに「照明演出」ボタンを追加（トグル式）
- サンプルキャラ（魔窟マコ・桃鬼華）の画像が他ピアに正しく同期されるよう修正
