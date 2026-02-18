/**
 * ReviewForMD - Service Worker
 *
 * カスタムドメインの DevOps を含む SPA ナビゲーションに対応するため、
 * webNavigation API を使って PR ページ遷移を監視し、
 * 必要に応じてコンテンツスクリプトを動的注入する。
 */

/** PR ページの URL パターン（パス部分のみ） */
const PR_PATH_PATTERNS = [
  /\/pull\/\d+/,                           // GitHub
  /\/_git\/[^/]+\/pullrequest\/\d+/,       // Azure DevOps
];

/**
 * URL が PR ページかどうかを判定する
 * @param {string} url
 * @returns {boolean}
 */
function isPRPageUrl(url) {
  try {
    const u = new URL(url);
    return PR_PATH_PATTERNS.some((re) => re.test(u.pathname));
  } catch {
    return false;
  }
}

/**
 * 既知ドメイン（manifest の matches で静的注入済み）かどうかを判定
 * @param {string} url
 * @returns {boolean}
 */
function isKnownDomain(url) {
  try {
    const host = new URL(url).hostname;
    return (
      host === 'github.com' ||
      host.endsWith('.github.com') ||
      host === 'dev.azure.com' ||
      host.endsWith('.visualstudio.com')
    );
  } catch {
    return false;
  }
}

/**
 * コンテンツスクリプトを動的に注入する（カスタムドメイン DevOps 対応）
 * @param {number} tabId
 */
async function injectContentScripts(tabId) {
  try {
    // 既に注入済みか確認
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => typeof SiteDetector !== 'undefined',
    });

    if (results?.[0]?.result === true) return; // 既に注入済み

    // CSS 注入
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['src/ui/styles.css'],
    });

    // JS 注入（順序維持）
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [
        'src/lib/site_detector.js',
        'src/lib/markdown_builder.js',
        'src/lib/clipboard.js',
        'src/extractors/github_extractor.js',
        'src/extractors/devops_extractor.js',
        'src/ui/button_injector.js',
        'src/content_script.js',
      ],
    });
  } catch (e) {
    // パーミッション不足等は想定内（カスタムドメインで未許可の場合）
    console.debug('[ReviewForMD] Injection skipped:', e.message);
  }
}

// ── webNavigation によるSPA遷移検出 ──

/** URL フィルタ: PR ページに該当するパスパターンのみ Service Worker を起動 */
const NAV_URL_FILTERS = {
  url: [
    { urlMatches: '.*/pull/\\d+.*' },                  // GitHub
    { urlMatches: '.*/_git/[^/]+/pullrequest/\\d+.*' }, // Azure DevOps
  ],
};

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return; // メインフレームのみ
  if (!isPRPageUrl(details.url)) return;
  if (isKnownDomain(details.url)) {
    // 既知ドメインは静的注入済みなので、再初期化のメッセージだけ送る
    chrome.tabs.sendMessage(details.tabId, { type: 'rfmd:navigate' }).catch(() => {});
  } else {
    // カスタムドメイン → 動的注入
    injectContentScripts(details.tabId);
  }
}, NAV_URL_FILTERS);

// タブ更新時にも検出（フルリロード時）
chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0) return;
  if (!isPRPageUrl(details.url)) return;
  if (!isKnownDomain(details.url)) {
    injectContentScripts(details.tabId);
  }
}, NAV_URL_FILTERS);
