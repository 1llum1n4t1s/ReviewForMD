#!/bin/bash

# Web Loading Assist拡張機能パッケージ生成スクリプト

# スクリプトのディレクトリに移動
cd "$(dirname "$0")" || exit 1

echo "拡張機能パッケージを生成中..."
echo ""

# アイコン生成（オプション: manifest.jsonにアイコン設定がある場合のみ）
if grep -q '"icons"' manifest.json 2>/dev/null; then
  echo "アイコンを生成中..."

  # ImageMagick (convert または magick) の確認
  if ! command -v convert &> /dev/null && ! command -v magick &> /dev/null; then
    echo "警告: ImageMagickがインストールされていません。アイコン生成をスキップします。"
    echo "   Linux: sudo apt install imagemagick"
    echo "   macOS: brew install imagemagick"
  else
    # icons ディレクトリが存在しない場合は作成
    mkdir -p ./icons

    # マスターアイコンが存在するか確認
    if [ -f "./icons/icon.png" ]; then
      # ImageMagick コマンドの決定 (magick または convert)
      if command -v magick &> /dev/null; then
        IMG_CMD="magick"
      elif command -v convert &> /dev/null; then
        IMG_CMD="convert"
      fi

      # 必要なサイズのアイコンを生成
      for size in 16 48 128; do
        output_file="./icons/icon-${size}x${size}.png"
        $IMG_CMD "./icons/icon.png" -resize "${size}x${size}!" "$output_file" 2>/dev/null
        if [ $? -eq 0 ]; then
          echo "  $output_file を生成しました"
        fi
      done
    else
      echo "警告: マスターアイコン (icons/icon.png) が見つかりません。アイコン生成をスキップします。"
    fi
  fi
  echo ""
fi

# 古いZIPファイルを削除
rm -f ./WebLoadingAssist.zip
echo "既存のZIPファイルを削除しました"

echo "ZIPファイルを作成中..."

# zipコマンドの確認
if ! command -v zip &> /dev/null; then
  echo "zipをインストールしてください"
  echo "   Linux: sudo apt install zip"
  echo "   macOS: brew install zip"
  exit 1
fi

# 必要なファイルのみをZIPに含める
zip -r ./WebLoadingAssist.zip \
  manifest.json \
  src/ \
  icons/ \
  -x "*.DS_Store" "*.swp" "*~"

if [ $? -eq 0 ]; then
  echo "ZIPファイルを作成しました: WebLoadingAssist.zip"
  echo ""
  echo "ファイルサイズ:"
  ls -lh ./WebLoadingAssist.zip
  echo ""
  echo "含まれているファイル:"
  unzip -l ./WebLoadingAssist.zip
else
  echo "ZIPファイルの作成に失敗しました"
  exit 1
fi