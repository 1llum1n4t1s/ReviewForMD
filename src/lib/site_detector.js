/**
 * サイト検出モジュール
 * GitHub と Azure DevOps のプルリクエストページを判定する。
 * DevOps は企業独自ドメインで運用されることが多いため、
 * URL だけでなく DOM 構造も併用して判定する。
 */
const SiteDetector = (() => {
  /** @enum {string} */
  const SiteType = {
    GITHUB: 'github',
    AZURE_DEVOPS: 'devops',
    UNKNOWN: 'unknown',
  };

  /* ── GitHub 判定 ──────────────────────────────── */

  function _isGitHubByHost() {
    const host = location.hostname;
    return host === 'github.com' || host.endsWith('.github.com');
  }

  function _isGitHubPRByUrl() {
    return _isGitHubByHost() && /\/pull\/\d+/.test(location.pathname);
  }

  // NOTE: _isGitHubPRByDom は GHES（GitHub Enterprise Server）対応時に使用予定
  // 現在は URL ベース判定のみで十分なため detect() からは呼んでいない

  /* ── Azure DevOps 判定 ────────────────────────── */

  /**
   * 既知ドメイン (dev.azure.com, *.visualstudio.com) かどうかを判定
   */
  function _isDevOpsKnownHost() {
    const host = location.hostname;
    return host === 'dev.azure.com' || host.endsWith('.visualstudio.com');
  }

  /**
   * URL パスが DevOps PR パターンに一致するかどうか
   */
  function _isDevOpsPRPath() {
    return /\/_git\/[^/]+\/pullrequest\/\d+/.test(location.pathname);
  }

  /**
   * URL ベースで Azure DevOps PR を検出する。
   * 既知ドメインの場合はパスパターンだけで確定。
   * カスタムドメインの場合は URL パスだけでは不十分なので false を返し、
   * DOM 判定に委ねる。
   */
  function _isDevOpsByUrl() {
    return _isDevOpsKnownHost() && _isDevOpsPRPath();
  }

  /**
   * DOM ベースで Azure DevOps を検出する。
   * bolt- / repos- プレフィクスのクラスは Azure DevOps Formula デザインシステム固有。
   * カスタムドメインでも URL パスと DOM シグナルの組み合わせで判定する。
   */
  function _isDevOpsPRByDom() {
    // 2 つ以上のシグナルが一致すれば DevOps と判定
    // 軽量なチェックから順に評価し、閾値に達したら早期 return
    let count = 0;
    const THRESHOLD = 2;

    // PR 詳細ページ固有コンテナ（最も信頼性が高い・軽量）
    if (document.querySelector('.repos-pr-details-page')) count++;
    // URL パスパターン（DOM アクセスなし・最軽量）
    if (_isDevOpsPRPath()) count++;
    if (count >= THRESHOLD) return true;
    // bolt UI フレームワークのヘッダー
    if (document.querySelector('[class*="bolt-header"]')) count++;
    if (count >= THRESHOLD) return true;
    // PR タブバー
    if (document.querySelector('.repos-pr-details-page-tabbar')) count++;
    if (count >= THRESHOLD) return true;
    // repos- プレフィクスのクラスが複数存在（重いセレクタなので最後に評価）
    if (document.querySelectorAll('[class*="repos-"]').length >= 3) count++;
    return count >= THRESHOLD;
  }

  /* ── 公開 API ─────────────────────────────────── */

  /**
   * 現在のページのサイト種別を判定する
   * @returns {string} SiteType
   */
  function detect() {
    // GitHub: URL ドメインが GitHub なら PR パスを確認
    if (_isGitHubPRByUrl()) {
      return SiteType.GITHUB;
    }

    // Azure DevOps: 既知ドメイン + PR パスパターン
    if (_isDevOpsByUrl()) {
      return SiteType.AZURE_DEVOPS;
    }

    // Azure DevOps: カスタムドメイン → DOM ベース判定
    if (_isDevOpsPRByDom()) {
      return SiteType.AZURE_DEVOPS;
    }

    return SiteType.UNKNOWN;
  }

  return { detect, SiteType };
})();
