/**
 * Popup スクリプト
 * 現在のタブが PR ページかどうかを判定して表示する。
 * URL 判定に加え、コンテンツスクリプトへの問い合わせでカスタムドメインにも対応。
 */

/** PR パス判定用の正規表現 */
const RE_GITHUB_HOST = /^https?:\/\/(www\.)?github\.com\//;
const RE_GITHUB_PR = /\/pull\/\d+/;
const RE_DEVOPS_HOST = /^https?:\/\/(dev\.azure\.com|[^/]+\.visualstudio\.com)\//;
const RE_DEVOPS_PR = /\/_git\/[^/]+\/pullrequest\/\d+/;

document.addEventListener('DOMContentLoaded', async () => {
  const statusEl = document.getElementById('status');

  // 判定中の中間状態を表示
  statusEl.textContent = '確認中...';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) {
      _setInactive('PR ページを開いてください');
      return;
    }

    const url = tab.url;

    // URL ベースの判定（既知ドメイン）
    if (RE_GITHUB_HOST.test(url) && RE_GITHUB_PR.test(url)) {
      _setActive('GitHub PR ページを検出しました');
      return;
    }
    if (RE_DEVOPS_HOST.test(url) && RE_DEVOPS_PR.test(url)) {
      _setActive('Azure DevOps PR ページを検出しました');
      return;
    }

    // カスタムドメイン判定: URL パスに /_git/.../pullrequest/ パターン
    if (RE_DEVOPS_PR.test(url)) {
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

    _setInactive('PR ページを開いてください');
  } catch {
    _setInactive('タブ情報を取得できませんでした');
  }

  function _setActive(msg) {
    statusEl.textContent = msg;
    statusEl.classList.remove('status--inactive');
    statusEl.classList.add('status--active');
  }

  function _setInactive(msg) {
    statusEl.textContent = msg;
    statusEl.classList.remove('status--active');
    statusEl.classList.add('status--inactive');
  }
});
