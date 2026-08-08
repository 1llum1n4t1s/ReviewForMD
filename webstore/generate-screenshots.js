// Chrome Web Store用のスクリーンショット画像を自動生成するスクリプト
// puppeteer 25 で ESM 専用パッケージになったため、このスクリプトも ESM 化した
// （package.json に "type": "module" を追加。webstore/ 内で require() する他ファイルは無いため影響範囲はこの1本のみ）。
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const TEMPLATE_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(TEMPLATE_DIR, 'images');

const HTML_CONFIGS = [
  // スクリーンショット：1280x800
  {
    input: path.join(TEMPLATE_DIR, '01-feature-overview.html'),
    output: '01-feature-overview-1280x800.png',
    width: 1280,
    height: 800,
    type: 'screenshot'
  },
  {
    input: path.join(TEMPLATE_DIR, '02-how-to-use.html'),
    output: '02-how-to-use-1280x800.png',
    width: 1280,
    height: 800,
    type: 'screenshot'
  },
  {
    input: path.join(TEMPLATE_DIR, '03-hero-promo.html'),
    output: '03-hero-promo-1280x800.png',
    width: 1280,
    height: 800,
    type: 'screenshot'
  },
  // プロモーション タイル（小）：440x280
  {
    input: path.join(TEMPLATE_DIR, '04-promo-small.html'),
    output: 'promo-small-440x280.png',
    width: 440,
    height: 280,
    type: 'promo-small'
  },
  // マーキー プロモーション タイル：1400x560
  {
    input: path.join(TEMPLATE_DIR, '05-promo-marquee.html'),
    output: 'promo-marquee-1400x560.png',
    width: 1400,
    height: 560,
    type: 'promo-marquee'
  }
];

async function generateScreenshot(browser, htmlPath, outputPath, width, height) {
  const page = await browser.newPage();

  try {
    await page.setViewport({
      width: width,
      height: height,
      deviceScaleFactor: 1
    });

    const absolutePath = path.resolve(htmlPath);
    await page.goto(`file://${absolutePath}`, {
      waitUntil: 'networkidle0',
      timeout: 30000
    });

    await new Promise(resolve => setTimeout(resolve, 500));

    await page.screenshot({
      path: outputPath,
      type: 'png',
      omitBackground: false,
      clip: { x: 0, y: 0, width: width, height: height }
    });

    console.log(`✅ 生成完了: ${outputPath} (${width}x${height})`);
  } catch (error) {
    console.error(`❌ エラー: ${htmlPath} -> ${outputPath}`);
    console.error(error);
  } finally {
    await page.close();
  }
}

async function main() {
  console.log('🎨 Chrome Web Store用スクリーンショットを生成中...\n');

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none'],
    protocolTimeout: 300000
  });

  try {
    // 1つずつ順番に処理（並列だとリソース競合でタイムアウトする場合がある）
    for (const config of HTML_CONFIGS) {
      const outputPath = path.join(OUTPUT_DIR, config.output);
      await generateScreenshot(browser, config.input, outputPath, config.width, config.height);
    }
  } finally {
    await browser.close();
  }

  console.log('\n✨ すべての画像生成が完了しました！');
  console.log(`\n📂 生成された画像は ${OUTPUT_DIR} ディレクトリにあります。`);

  console.log('\n📋 生成された画像一覧:');
  const files = fs.readdirSync(OUTPUT_DIR);
  files.forEach(file => {
    const filePath = path.join(OUTPUT_DIR, file);
    const stats = fs.statSync(filePath);
    const sizeKB = (stats.size / 1024).toFixed(2);
    console.log(`   - ${file} (${sizeKB} KB)`);
  });

  console.log('\n📝 Chrome Web Storeアップロード仕様:');
  console.log('   ✓ スクリーンショット: 1280x800 または 640x400');
  console.log('   ✓ プロモーション タイル（小）: 440x280');
  console.log('   ✓ マーキー プロモーション タイル: 1400x560');
  console.log('   ✓ 形式: PNG (24ビット、アルファなし)');
}

main().catch(error => {
  console.error('❌ エラーが発生しました:', error);
  process.exit(1);
});
