/**
 * Popup スクリプト
 * 現在のタブが PR ページかどうかを判定して表示する。
 * カスタムドメインの場合は host_permissions が無いことがあるので、
 * ユーザーに「許可ボタン」を提示して動的に取得する。
 *
 * カスタムドメイン許可フロー（私的 DevOps テナント対応）:
 *   1. URL パスが DevOps 形状 (/_git/.../pullrequest/) に一致するか確認
 *   2. 合えば「許可ボタン」を提示（この時点ではパス形状のみの判定）
 *   3. ユーザークリック → chrome.permissions.request で user gesture 内にホスト権限取得
 *   4. 取得後、active tab 内で chrome.scripting.executeScript → DevOps シグナル検証
 *      （ユーザーの認証クッキー込みなので private テナントでも検証可能）
 *   5. シグナル無し → chrome.permissions.remove で権限返上、エラー表示
 *   6. シグナル有り → content script 注入リクエスト → タブリロード
 */

/** PR パス判定用の正規表現 */
const RE_GITHUB_HOST = /^https?:\/\/(www\.)?github\.com\//;
const RE_GITHUB_PR = /\/pull\/\d+/;
const RE_GITHUB_PR_LIST = /\/pulls(\?|$|#)/;
const RE_DEVOPS_HOST = /^https?:\/\/(dev\.azure\.com|[^/]+\.visualstudio\.com)\//;
const RE_DEVOPS_PR = /\/_git\/[^/]+\/pullrequest\/\d+/i;
const RE_DEVOPS_PR_LIST = /\/_git\/[^/]+\/pullrequests/i;
const RE_SHAREPOINT_HOST = /^https?:\/\/[^/]+\.sharepoint\.com\//;
const RE_SHAREPOINT_STREAM = /\/stream\.aspx/i;

/** DevOps PR ページ（詳細 or 一覧）を判定 */
function isDevOpsPRPath(url) {
  return RE_DEVOPS_PR.test(url) || RE_DEVOPS_PR_LIST.test(url);
}

/**
 * 現在のタブのオリジンに対して host_permissions が付与されているか
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
 * active tab 内で DevOps シグナルを検証する。
 * permission 取得後に呼ぶこと。
 * ユーザーの認証クッキー込みでページを評価できるため private テナントでも正確。
 *
 * @param {number} tabId
 * @returns {Promise<boolean>}
 */
async function verifyAzureDevOpsInTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // Azure DevOps 固有の DOM/グローバルシグナル
        // - `VSS` または `TfsContext` グローバル（Azure DevOps JS SDK）
        // - `bolt-` / `repos-pr-details-page` 等の Formula デザインシステムクラス
        // - `ms.vss-tfs-web` を含む script src
        try {
          if (typeof VSS !== 'undefined' || typeof TfsContext !== 'undefined') return true;
        } catch {}
        if (document.querySelector('.repos-pr-details-page')) return true;
        if (document.querySelector('[class*="bolt-header"]')) return true;
        if (document.querySelector('[class*="repos-pr-"]')) return true;
        // script src に VSS/Azure DevOps シグナル
        const scripts = document.querySelectorAll('script[src]');
        for (const s of scripts) {
          const src = s.getAttribute('src') || '';
          if (/VSS\.SDK|ms\.vss-tfs-web|_static\/tfs/.test(src)) return true;
        }
        // HTML 中に埋め込まれた DevOps シグナル
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

document.addEventListener('DOMContentLoaded', async () => {
  const statusEl = document.getElementById('status');
  const grantBtn = document.getElementById('grant-btn');
  const grantHint = document.getElementById('grant-hint');

  statusEl.textContent = '確認中...';

  let currentTab = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tab;
    if (!tab?.url) {
      _setInactive('PR ページを開いてください');
      return;
    }

    const url = tab.url;

    // 既知ドメイン（manifest 静的注入対象）→ そのまま動作
    if (RE_GITHUB_HOST.test(url) && (RE_GITHUB_PR.test(url) || RE_GITHUB_PR_LIST.test(url))) {
      _setActive('GitHub PR ページを検出しました');
      return;
    }
    if (RE_DEVOPS_HOST.test(url) && isDevOpsPRPath(url)) {
      _setActive('Azure DevOps PR ページを検出しました');
      return;
    }
    if (RE_SHAREPOINT_HOST.test(url) && RE_SHAREPOINT_STREAM.test(url)) {
      _setActive('SharePoint Stream ページを検出しました');
      return;
    }

    // カスタムドメイン Azure DevOps の可能性をチェック（URL パスベース）
    // PR 詳細 (/_git/.../pullrequest/<id>) と PR 一覧 (/_git/.../pullrequests) の両方に対応。
    // 一覧ページからもダウンロードできるように、両方で許可フローを動かす。
    if (isDevOpsPRPath(url)) {
      // 既にコンテンツスクリプトが動いているか確認
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'rfmd:ping' });
        if (response?.siteType === 'devops') {
          _setActive('Azure DevOps PR ページを検出しました（カスタムドメイン）');
          return;
        }
      } catch {
        // content script 未注入 → permission チェックして許可ボタン表示
      }

      const granted = await hasOriginPermission(url);
      if (granted) {
        // セキュリティ: 過去に許可済みのオリジンでも、DevOps シグナル検証してから注入する。
        // 一度正規の DevOps として許可した後、同オリジン上で偽装的な /_git/.../pullrequest 形式
        // URL を持つ非 DevOps ページが作られた場合にも、コンテンツスクリプト注入を防ぐ。
        _setInactive('Azure DevOps を検証中...');
        const isDevOps = await verifyAzureDevOpsInTab(tab.id);
        if (!isDevOps) {
          _setInactive('Azure DevOps として検証できませんでした');
          return;
        }
        // 権限あり + 検証 OK → 注入
        _setInactive('コンテンツスクリプトを注入中...');
        const ok = await injectContentScriptsInTab(tab.id);
        if (ok) {
          _setActive('Azure DevOps PR ページを検出しました（カスタムドメイン）');
        } else {
          _setInactive('注入に失敗しました。ページをリロードしてみてください');
        }
        return;
      }

      // 権限なし → 許可ボタン提示
      // 注意: この時点では DevOps かどうかは不明（URL パスだけの判定）。
      // 実際の検証は「許可取得後に active tab で DOM を調べる」フローで行う。
      // これにより private テナント（CORS 拒否 + 認証必須）でも正しく検証可能。
      _setNeedsPermission('カスタムドメインを検出しました。下のボタンで権限を許可してください');
      grantBtn.classList.add('grant-btn--visible');
      grantHint.classList.add('grant-hint--visible');

      grantBtn.addEventListener('click', async () => {
        grantBtn.disabled = true;
        grantBtn.textContent = '許可をリクエスト中...';
        const origin = new URL(url).origin + '/*';
        try {
          // chrome.permissions.request は user gesture (クリック) 内でのみ呼べる
          const permOk = await chrome.permissions.request({ origins: [origin] });
          if (!permOk) {
            grantBtn.disabled = false;
            grantBtn.textContent = 'このサイトでの動作を許可する';
            _setNeedsPermission('権限取得がキャンセルされました');
            return;
          }

          // 権限取得後、active tab で DevOps シグナル検証
          grantBtn.textContent = 'Azure DevOps を検証中...';
          const isDevOps = await verifyAzureDevOpsInTab(tab.id);
          if (!isDevOps) {
            // 偽装サイトの可能性 → 取った権限を返上
            try {
              await chrome.permissions.remove({ origins: [origin] });
            } catch {}
            grantBtn.disabled = false;
            grantBtn.textContent = 'このサイトでの動作を許可する';
            _setNeedsPermission('Azure DevOps として検証できませんでした。権限は返上しました');
            return;
          }

          // 検証OK → タブをリロードして service_worker 経由で正規ルートで注入させる。
          // ここで手動 inject すると reload で破棄されて二度手間になるため省略。
          await chrome.tabs.reload(tab.id);
          window.close();
        } catch (e) {
          grantBtn.disabled = false;
          grantBtn.textContent = 'このサイトでの動作を許可する';
          _setNeedsPermission('エラー: ' + (e?.message || e));
        }
      });
      return;
    }

    _setInactive('PR ページを開いてください');
  } catch {
    _setInactive('タブ情報を取得できませんでした');
  }

  function _setActive(msg) {
    statusEl.textContent = msg;
    statusEl.className = 'status status--active';
  }

  function _setInactive(msg) {
    statusEl.textContent = msg;
    statusEl.className = 'status status--inactive';
  }

  function _setNeedsPermission(msg) {
    statusEl.textContent = msg;
    statusEl.className = 'status status--needs-permission';
  }
});

/**
 * active tab にコンテンツスクリプト一式を popup から直接注入する。
 * service_worker 経由だと sender.tab が無くメッセージが届かない問題を回避。
 * @param {number} tabId
 * @returns {Promise<boolean>} 成否
 */
async function injectContentScriptsInTab(tabId) {
  try {
    // 既に注入済みか確認
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => typeof SiteDetector !== 'undefined',
    });
    if (results?.[0]?.result === true) return true;

    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['src/ui/styles.css'],
    });
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
    return true;
  } catch (e) {
    console.error('[ReviewForMD] Popup injection failed:', e?.message || e);
    return false;
  }
}
