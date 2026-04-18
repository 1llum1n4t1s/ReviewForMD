/**
 * ReviewForMD - Service Worker
 *
 * カスタムドメインの DevOps を含む SPA ナビゲーションに対応するため、
 * webNavigation API を使って対象ページ遷移を監視し、
 * 必要に応じてコンテンツスクリプトを動的注入する。
 *
 * 対象:
 *   - GitHub / Azure DevOps の PR ページ
 *   - SharePoint Stream (Teams 会議録画) ページ
 */

/** ナビゲーション対象ページの URL パターン（パス部分のみ） */
const NAV_PATH_PATTERNS = [
  /\/pull\/\d+/,                           // GitHub PR 詳細
  /\/_git\/[^/]+\/pullrequest\/\d+/i,       // Azure DevOps PR 詳細
  /\/pulls\b/,                             // GitHub PR 一覧
  /\/_git\/[^/]+\/pullrequests\b/i,         // Azure DevOps PR 一覧
  /\/stream\.aspx/i,                        // SharePoint Stream (Teams 会議録画)
];

/**
 * URL が対象ページかどうかを判定する
 * @param {string} url
 * @returns {boolean}
 */
function isTargetPageUrl(url) {
  try {
    const u = new URL(url);
    return NAV_PATH_PATTERNS.some((re) => re.test(u.pathname));
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
      host.endsWith('.visualstudio.com') ||
      host.endsWith('.sharepoint.com')
    );
  } catch {
    return false;
  }
}

/**
 * 指定 URL のオリジンに対して host_permissions が付与されているか確認
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function hasOriginPermission(url) {
  try {
    const origin = new URL(url).origin + '/*';
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}

/**
 * 指定タブが本物の Azure DevOps か検証する。
 * 過去に許可済みのオリジン（一度 DevOps として許可された後、同オリジン上で
 * 偽装 PR URL を持つ非 DevOps ページが作られたケース）への注入を防ぐため、
 * カスタムドメインの自動注入前にも検証する。
 * @param {number} tabId
 * @returns {Promise<boolean>}
 */
async function verifyAzureDevOpsInTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          if (typeof VSS !== 'undefined' || typeof TfsContext !== 'undefined') return true;
        } catch {}
        if (document.querySelector('.repos-pr-details-page')) return true;
        if (document.querySelector('[class*="bolt-header"]')) return true;
        if (document.querySelector('[class*="repos-pr-"]')) return true;
        const scripts = document.querySelectorAll('script[src]');
        for (const s of scripts) {
          const src = s.getAttribute('src') || '';
          if (/VSS\.SDK|ms\.vss-tfs-web|_static\/tfs/.test(src)) return true;
        }
        const html = document.documentElement?.outerHTML || '';
        return /VSS\.SDK|TfsContext|ms\.vss-tfs-web/.test(html);
      },
    });
    return results?.[0]?.result === true;
  } catch (e) {
    console.debug('[ReviewForMD] DevOps verification failed:', e?.message || e);
    return false;
  }
}

/**
 * 「権限が必要」をユーザーに知らせるバッジをアイコンに表示
 * @param {number} tabId
 */
async function showNeedPermissionBadge(tabId) {
  try {
    await chrome.action.setBadgeText({ tabId, text: '!' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#cf222e' });
    await chrome.action.setTitle({
      tabId,
      title: 'ReviewForMD: このサイトでの動作を許可するには拡張機能アイコンをクリック',
    });
  } catch {
    // タブが閉じた等
  }
}

/**
 * バッジをクリア（注入成功時）
 * @param {number} tabId
 */
async function clearBadge(tabId) {
  try {
    await chrome.action.setBadgeText({ tabId, text: '' });
    await chrome.action.setTitle({ tabId, title: '' });
  } catch {
    // タブが閉じた等
  }
}

/**
 * コンテンツスクリプトを動的に注入する（カスタムドメイン DevOps 対応）
 * @param {number} tabId
 * @param {string} url - パーミッション確認用
 */
async function injectContentScripts(tabId, url) {
  // カスタムドメインで host_permissions が無い場合、注入は失敗する。
  // ユーザーに分かるようバッジで通知し、popup 経由で許可を要求する。
  //
  // 例外: known domain (manifest host_permissions で静的許可済みのホスト) は
  // permission チェックをスキップする。
  // optional_host_permissions: ["https://*/*"] と既知ホスト範囲が重なるため、
  // chrome.permissions.contains() が false を返すケースがあり、
  // sendMessage 失敗時の動的注入リカバリ経路が no-op 化してしまうのを防ぐ。
  const isCustomDomain = url && !isKnownDomain(url);
  if (isCustomDomain && !(await hasOriginPermission(url))) {
    await showNeedPermissionBadge(tabId);
    return;
  }

  // セキュリティ: カスタムドメインで権限はあっても、必ず DevOps シグナル検証してから注入する。
  // 過去に正規 DevOps として許可した後、同オリジン上で偽装 /_git/.../pullrequest 形式 URL を
  // 持つ非 DevOps ページが作られた場合の注入バイパス攻撃を防止。
  if (isCustomDomain && !(await verifyAzureDevOpsInTab(tabId))) {
    console.debug('[ReviewForMD] Skip injection: not a verified Azure DevOps page');
    return;
  }

  try {
    // 既に注入済みか確認
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => typeof SiteDetector !== 'undefined',
    });

    if (results?.[0]?.result === true) {
      await clearBadge(tabId);
      return; // 既に注入済み
    }

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
        'src/extractors/sharepoint_extractor.js',
        'src/ui/button_injector.js',
        'src/content_script.js',
      ],
    });
    await clearBadge(tabId);
  } catch (e) {
    // 想定外のエラー（パーミッションは事前チェック済みなのでこちらは別の理由）
    console.debug('[ReviewForMD] Injection failed:', e?.message || e);
    // 念のためバッジ表示（ユーザーに状況を見せる）
    await showNeedPermissionBadge(tabId);
  }
}

// ── webNavigation によるSPA遷移検出 ──

/** URL フィルタ: 対象ページに該当するパスパターンのみ Service Worker を起動 */
const NAV_URL_FILTERS = {
  url: [
    { urlMatches: '.*/pull/\\d+.*' },                  // GitHub PR 詳細
    { urlMatches: '.*/_git/[^/]+/pull[Rr]equest/\\d+.*' }, // Azure DevOps PR 詳細
    { urlMatches: '.*/pulls(\\?.*)?$' },                // GitHub PR 一覧
    { urlMatches: '.*/_git/[^/]+/pullrequests(\\?.*)?$' }, // Azure DevOps PR 一覧
    { urlMatches: '.*/[Ss]tream\\.aspx.*' },            // SharePoint Stream
  ],
};

chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return; // メインフレームのみ
  if (!isTargetPageUrl(details.url)) return;
  if (isKnownDomain(details.url)) {
    // 既知ドメインは静的注入済みのはずなので、再初期化メッセージを送る。
    // コンテンツスクリプト未ロード時（PR 一覧→PR 詳細への SPA 遷移等）は
    // メッセージ送信が失敗するため、動的注入にフォールバックする。
    try {
      await chrome.tabs.sendMessage(details.tabId, { type: 'rfmd:navigate' });
    } catch {
      await injectContentScripts(details.tabId, details.url);
    }
  } else {
    // カスタムドメイン → 動的注入
    await injectContentScripts(details.tabId, details.url);
  }
}, NAV_URL_FILTERS);

// タブ更新時にも検出（フルリロード時）
chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0) return;
  if (!isTargetPageUrl(details.url)) return;
  if (!isKnownDomain(details.url)) {
    injectContentScripts(details.tabId, details.url);
  }
}, NAV_URL_FILTERS);

// popup / content script から「権限取得後に注入してね」リクエストを受信。
// セキュリティ: sender.tab がある場合は信頼できる送信元として優先使用。
// 悪意ある content script が他タブの tabId を指定して注入を試みる攻撃を防ぐ。
// popup からのメッセージには sender.tab が無いので、その場合のみ msg.tabId を採用。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'rfmd:request-injection') {
    const tabId = sender.tab?.id ?? msg.tabId;
    if (!tabId) {
      sendResponse({ ok: false, error: 'no tabId' });
      return;
    }
    const url = sender.tab?.url ?? msg.url;
    injectContentScripts(tabId, url).then(() => sendResponse({ ok: true }));
    return true; // 非同期 sendResponse
  }
});
