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

**v1.22.0-lycoris.0**（2026-06-01）

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
| v1.22.0 | 2026-06-01 | 正面マークドラッグ回転、照明レーザー、魔法の光ソナー演出 |
| v1.21.0 | 2026-05-30 | VNログイン修正、吹き出し同期、パフォーマンス改善 |
| v1.20.0 | 2026-05-29 | 照明システム、VNステージ、ホットバー |
| v1.13.1 | 2026-05-28 | ジュークボックス3モード、名前ラベルON/OFF |
| v1.13.0 | 2026-05-27 | ジュークボックス、名前ラベル |
| v1.12.0 | 2026-05-24 | プロジェクト名変更（lily→lycoris） |
