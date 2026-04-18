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
 *
 * ⚠️ 同期必須: popup/popup.js の verifyAzureDevOpsInTab と意図的な**コピー**である。
 *    Service Worker と popup はモジュール共有できない MV3 の制約のため、
 *    どちらかのシグナル判定を変更した際はもう一方にも必ず反映すること。
 *    シグナルが分裂するとセキュリティ検証が一方で緩くなる。
 *    変更の起点: **このファイル (service_worker.js) を正として変更し、popup.js に転記する**。
 *
 * @param {number} tabId
 * @returns {Promise<boolean>}
 */
async function verifyAzureDevOpsInTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // VSS グローバルで確実に判定できる最速パス
        try {
          if (typeof VSS !== 'undefined' || typeof TfsContext !== 'undefined') return true;
        } catch {}
        // DOM シグナル: Azure DevOps 固有の Formula DS クラス
        if (document.querySelector('.repos-pr-details-page')) return true;
        if (document.querySelector('[class*="bolt-header"]')) return true;
        if (document.querySelector('[class*="repos-pr-"]')) return true;
        // script src の URL パターン
        const scripts = document.querySelectorAll('script[src]');
        for (const s of scripts) {
          const src = s.getAttribute('src') || '';
          if (/VSS\.SDK|ms\.vss-tfs-web|_static\/tfs/.test(src)) return true;
        }
        // `outerHTML` を全体シリアライズするフォールバックは削除:
        // - 大規模ページで 1-5MB の文字列シリアライズ + IPC が発生する
        // - 上記の script src ループで同等のシグナルが検出可能
        return false;
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

    // JS 注入（順序維持）。
    // 動的注入は「カスタムドメインの Azure DevOps」専用経路（verifyAzureDevOpsInTab で検証済み）。
    // そのため GitHub/SharePoint 用 extractor は含めない（～55KB の無駄 parse 削減）。
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [
        'src/lib/site_detector.js',
        'src/lib/markdown_builder.js',
        'src/lib/clipboard.js',
        'src/lib/fetch_utils.js',
        'src/extractors/devops_extractor.js',
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

/**
 * onHistoryStateUpdated と onCompleted の重複発火ガード。
 * 同一タブ・同一 URL に対して短時間内に複数回 inject が走るのを抑止する。
 * MV3 SW は短命 (idle 30s) のため完全な永続化はできないが、1 ナビゲーションの範囲では有効。
 */
const _recentInjection = new Map(); // tabId → { url, ts }
const INJECT_DEBOUNCE_MS = 500;
function _shouldInject(tabId, url) {
  const rec = _recentInjection.get(tabId);
  const now = Date.now();
  if (rec && rec.url === url && now - rec.ts < INJECT_DEBOUNCE_MS) return false;
  _recentInjection.set(tabId, { url, ts: now });
  // タブ閉鎖時のリークを抑えるため、古いエントリは定期的に掃除
  if (_recentInjection.size > 50) {
    const cutoff = now - INJECT_DEBOUNCE_MS * 10;
    for (const [k, v] of _recentInjection) {
      if (v.ts < cutoff) _recentInjection.delete(k);
    }
  }
  return true;
}

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
    // onCompleted と同じ debounce ガードを適用（SPA ナビで両イベントが連続発火するケース対策）
    if (!_shouldInject(details.tabId, details.url)) return;
    await injectContentScripts(details.tabId, details.url);
  }
}, NAV_URL_FILTERS);

// タブ更新時にも検出（フルリロード時）
chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0) return;
  if (!isTargetPageUrl(details.url)) return;
  if (isKnownDomain(details.url)) return;
  // onHistoryStateUpdated と連続発火するときの二重注入を短時間 debounce で抑止。
  // injectContentScripts 内にも既に「注入済みか」チェックはあるが、
  // そこへの executeScript 自体が 1 RTT かかるので入口でスキップする方が軽い。
  if (!_shouldInject(details.tabId, details.url)) return;
  injectContentScripts(details.tabId, details.url);
}, NAV_URL_FILTERS);

// popup / content script から「権限取得後に注入してね」リクエストを受信。
// セキュリティ:
// 1. sender.id が拡張自身と一致することを検証 (外部拡張からの spoofing を遮断)
// 2. sender.tab がある場合は信頼できる送信元として優先使用。
//    悪意ある content script が他タブの tabId を指定して注入を試みる攻撃を防ぐ。
//    popup からのメッセージには sender.tab が無いので、その場合のみ msg.tabId を採用。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'rfmd:request-injection') {
    // 外部拡張からの spoof リクエストを弾く。sender.id は拡張のメッセージング送信元 ID で、
    // 自拡張内の content script / popup なら chrome.runtime.id と一致する。
    // sender.id が空文字や undefined のケース（偽値）でも必ず弾く。
    // `sender.id && sender.id !== id` だと sender.id が空文字のとき && が false を返し
    // チェックをスキップするため、allowlist 的に "一致しない全て" を拒否する形式にする。
    if (sender.id !== chrome.runtime.id) {
      sendResponse({ ok: false, error: 'forbidden' });
      return;
    }
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
