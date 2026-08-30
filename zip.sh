#!/bin/bash

set -euo pipefail

# ReviewForMD Chrome / Firefox パッケージ生成スクリプト
root_dir=$(cd "$(dirname "$0")" && pwd)
cd "$root_dir"

chrome_archive="$root_dir/ReviewForMD.zip"
firefox_archive="$root_dir/ReviewForMD-firefox.zip"
temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/reviewformd-build.XXXXXX")
trap 'rm -rf -- "$temp_dir"' EXIT

rm -f -- "$chrome_archive" "$firefox_archive"

# zipコマンドの確認
if ! command -v zip &> /dev/null; then
  echo "zipをインストールしてください"
  echo "   Linux: sudo apt install zip"
  echo "   macOS: brew install zip"
  exit 1
fi

# Chrome は Manifest V3 service worker のみを宣言する正本をそのまま梱包する。
zip -r "$chrome_archive" \
  manifest.json \
  src/ \
  icons/ \
  -x "*.DS_Store" "*.swp" "*~" \
     "src/**/.env*" "src/**/.*" "src/**/*.env"

# Firefox は同じ正本から background.scripts 形式の manifest.json を生成する。
node scripts/create-firefox-manifest.mjs manifest.json "$temp_dir/manifest.json"
zip -r "$firefox_archive" \
  src/ \
  icons/ \
  -x "*.DS_Store" "*.swp" "*~" \
     "src/**/.env*" "src/**/.*" "src/**/*.env"
(
  cd "$temp_dir"
  zip "$firefox_archive" manifest.json
)

unzip -tq "$chrome_archive"
unzip -tq "$firefox_archive"
ls -lh "$chrome_archive" "$firefox_archive"
