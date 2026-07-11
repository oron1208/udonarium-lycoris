#!/bin/bash
# docs-site デプロイスクリプト
# ⚠️ --delete を使わない！VPSにしか存在しないファイル(library等)が消えるのを防ぐ
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DOCS_SRC="$PROJECT_ROOT/docs-site"
VPS_KEY="$PROJECT_ROOT/VPSサーバー設定/key-2026-05-23-15-23.pem"
VPS_HOST="160.251.182.194"
VPS_PATH="/var/www/docs-site/"

echo "📡 docs-site をVPSにデプロイ中..."
rsync -avz \
  -e "ssh -i \"$VPS_KEY\" -o StrictHostKeyChecking=no" \
  "$DOCS_SRC/" \
  "root@$VPS_HOST:$VPS_PATH"

echo ""
echo "✅ デプロイ完了"
echo "⚠️ --delete は意図的に外してあります。VPS独自のファイル(library/等)保護のため。"
