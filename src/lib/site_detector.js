/**
 * サイト検出モジュール
 * GitHub / Azure DevOps のプルリクエストページ、
 * および SharePoint Stream (Teams 会議録画) ページを判定する。
 * DevOps は企業独自ドメインで運用されることが多いため、
 * URL だけでなく DOM 構造も併用して判定する。
 */
var SiteDetector = SiteDetector || (() => {
  /** @enum {string} */
  const SiteType = {
    GITHUB: 'github',
    AZURE_DEVOPS: 'devops',
    AWS_CODECOMMIT: 'codecommit',
    SHAREPOINT_TEAMS: 'sharepoint_teams',
    TEAMS_CHAT: 'teams_chat',
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
    return /\/_git\/[^/]+\/pullrequest\/\d+/i.test(location.pathname);
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
    const hasPRPath = _isDevOpsPRPath();

    // 既知ドメインでは URL が PR ページパターンに一致しない場合、
    // DOM 判定は不要（PR 一覧ページなどでの誤検出を防止）
    if (_isDevOpsKnownHost() && !hasPRPath) {
      return false;
    }

    // 2 つ以上のシグナルが一致すれば DevOps と判定
    // 軽量なチェックから順に評価し、閾値に達したら早期 return
    let count = 0;
    const THRESHOLD = 2;

    // PR 詳細ページ固有コンテナ（最も信頼性が高い・軽量）
    if (document.querySelector('.repos-pr-details-page')) count++;
    // URL パスパターン（DOM アクセスなし・最軽量）
    if (hasPRPath) count++;
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

  /* ── AWS CodeCommit 判定 ──────────────────────── */

  /**
   * AWS マネジメントコンソール（リージョン別 / グローバル）かどうかを判定する。
   * 対象: {region}.console.aws.amazon.com / console.aws.amazon.com
   */
  function _isCodeCommitByHost() {
    const host = location.hostname;
    return host === 'console.aws.amazon.com' || host.endsWith('.console.aws.amazon.com');
  }

  /**
   * URL ベースで CodeCommit の PR 詳細ページを検出する。
   * コンソールは Cloudscape の React SPA で DOM クラスがハッシュ化され揮発性が高いため、
   * 検出は安定した URL パス（/codesuite/codecommit/repositories/{repo}/pull-requests/{id}）で行う。
   * PR ID は数値。
   */
  function _isCodeCommitPRByUrl() {
    return (
      _isCodeCommitByHost() &&
      /\/codesuite\/codecommit\/repositories\/[^/]+\/pull-requests\/\d+/i.test(location.pathname)
    );
  }

  /* ── SharePoint Stream (Teams 会議録画) 判定 ──── */

  /**
   * SharePoint の Stream プレイヤーページかどうかを判定する。
   * URL 例: https://{tenant}.sharepoint.com/{site}/_layouts/15/stream.aspx?id=...
   */
  function _isSharePointStreamByUrl() {
    const host = location.hostname;
    if (!host.endsWith('.sharepoint.com')) return false;
    // stream.aspx を含むパス（大文字小文字不問）
    return /\/stream\.aspx/i.test(location.pathname);
  }

  /* ── Microsoft Teams チャット判定 ─────────────── */

  /**
   * Teams Web のドメインかどうかを判定する。
   * 対象: teams.microsoft.com / *.teams.microsoft.com / teams.live.com /
   *       teams.cloud.microsoft
   */
  function _isTeamsByHost() {
    const host = location.hostname;
    return (
      host === 'teams.microsoft.com' ||
      host.endsWith('.teams.microsoft.com') ||
      host === 'teams.live.com' ||
      host.endsWith('.teams.live.com') ||
      host === 'teams.cloud.microsoft' ||
      host.endsWith('.teams.cloud.microsoft')
    );
  }

  /**
   * Teams のチャット/チャネル会話が表示されているかを DOM シグナルで判定する。
   * Teams はハッシュルーティング SPA で URL からは会話か判別しにくいため、
   * メッセージリスト系の DOM の存在で判定する。
   */
  function _isTeamsChatByDom() {
    if (!_isTeamsByHost()) return false;
    // セレクタの単一の真実の源は teams_extractor の SELECTORS。判定はそちらへ委譲する
    // （detect 側と extract 側でセレクタが分裂し「検出できるが抽出は空」になる乖離を防ぐ）。
    // Teams content_scripts エントリでは teams_extractor が同梱されるため hasChatDom が使える。
    if (typeof TeamsExtractor !== 'undefined' && typeof TeamsExtractor.hasChatDom === 'function') {
      try {
        return TeamsExtractor.hasChatDom();
      } catch {
        /* フォールスルー */
      }
    }
    // TeamsExtractor 未ロード時の最小フォールバック（通常は Teams エントリで到達しない）
    return !!document.querySelector(
      '[data-tid="chat-pane-list"], [data-tid="messageListContainer"], [data-tid="message-pane-list-viewport"]'
    );
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

    // AWS CodeCommit: コンソールホスト + PR 詳細パスパターン
    if (_isCodeCommitPRByUrl()) {
      return SiteType.AWS_CODECOMMIT;
    }

    // SharePoint Stream (Teams 会議録画ページ)
    if (_isSharePointStreamByUrl()) {
      return SiteType.SHAREPOINT_TEAMS;
    }

    // Microsoft Teams チャット/チャネル（DOM シグナルで判定）
    if (_isTeamsChatByDom()) {
      return SiteType.TEAMS_CHAT;
    }

    return SiteType.UNKNOWN;
  }

  /* ── PR 一覧ページ判定 ───────────────────────── */

  /**
   * 現在のページが PR 一覧ページかどうかを判定する
   * @returns {string} SiteType（一覧ページでなければ UNKNOWN）
   */
  function detectList() {
    // GitHub: /pulls または /owner/repo/pulls
    if (_isGitHubByHost() && /\/pulls\b/.test(location.pathname)) {
      return SiteType.GITHUB;
    }

    // Azure DevOps: /_git/repo/pullrequests（一覧ページ）
    if (_isDevOpsKnownHost() && /\/_git\/[^/]+\/pullrequests/i.test(location.pathname)) {
      return SiteType.AZURE_DEVOPS;
    }

    // カスタムドメイン DevOps: URL パス + DOM シグナル
    if (/\/_git\/[^/]+\/pullrequests/i.test(location.pathname)) {
      if (document.querySelector('.repos-pr-list') ||
          document.querySelector('[class*="bolt-header"]')) {
        return SiteType.AZURE_DEVOPS;
      }
    }

    return SiteType.UNKNOWN;
  }

  return { detect, detectList, SiteType };
})();
