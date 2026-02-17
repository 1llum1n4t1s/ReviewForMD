/**
 * Popup スクリプト
 * 現在のタブが PR ページかどうかを判定して表示する。
 * URL 判定に加え、コンテンツスクリプトへの問い合わせでカスタムドメインにも対応。
 */
document.addEventListener('DOMContentLoaded', async () => {
  const statusEl = document.getElementById('status');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;

    const url = tab.url;

    // URL ベースの判定（既知ドメイン）
    const isGitHub = /^https?:\/\/(www\.)?github\.com\//.test(url) && /\/pull\/\d+/.test(url);
    const isDevOpsKnown =
      (/^https?:\/\/dev\.azure\.com\//.test(url) ||
        /^https?:\/\/[^/]+\.visualstudio\.com\//.test(url)) &&
      /\/_git\/[^/]+\/pullrequest\/\d+/.test(url);

    if (isGitHub) {
      _setActive('GitHub PR ページを検出しました');
      return;
    }
    if (isDevOpsKnown) {
      _setActive('Azure DevOps PR ページを検出しました');
      return;
    }

    // カスタムドメイン判定: URL パスに /_git/.../pullrequest/ パターン
    if (/\/_git\/[^/]+\/pullrequest\/\d+/.test(url)) {
      _setActive('Azure DevOps PR ページを検出しました（カスタムドメイン）');
      return;
    }

    // コンテンツスクリプトが動作しているか問い合わせ
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'rfmd:ping' });
      if (response?.siteType === 'github') {
        _setActive('GitHub PR ページを検出しました');
        return;
      }
      if (response?.siteType === 'devops') {
        _setActive('Azure DevOps PR ページを検出しました');
        return;
      }
    } catch {
      // コンテンツスクリプトが注入されていない場合
    }

    statusEl.textContent = 'PR ページを開いてください';
    statusEl.className = 'status status--inactive';
  } catch {
    // タブ情報が取得できない場合は初期表示のまま
  }

  function _setActive(msg) {
    statusEl.textContent = msg;
    statusEl.className = 'status status--active';
  }
});
