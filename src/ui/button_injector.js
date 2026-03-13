/**
 * UI ボタン注入モジュール
 * GitHub / DevOps のプルリクエストページにコピーボタンを挿入する。
 */
var ButtonInjector = ButtonInjector || (() => {
  const COPY_ICON_SVG = `<svg class="rfmd-btn-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>`;
  const CHECK_ICON_SVG = `<svg class="rfmd-btn-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>`;
  const DOWNLOAD_ICON_SVG = `<svg class="rfmd-btn-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z"/><path d="M7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06Z"/></svg>`;

  const DOWNLOAD_LABEL = `${DOWNLOAD_ICON_SVG} MDでダウンロード`;
  const SINGLE_COPY_LABEL = `${COPY_ICON_SVG} MDコピー`;

  /**
   * ボタンのコピー完了フィードバック（連打防止付き）
   */
  function _showFeedback(btn, success) {
    // フィードバック中なら無視
    if (btn.dataset.rfmdBusy === '1') return;
    btn.dataset.rfmdBusy = '1';

    // 前回のタイマーが残っていればクリアして積み重なりを防止
    if (btn._rfmdTimer) {
      clearTimeout(btn._rfmdTimer);
      btn._rfmdTimer = null;
    }

    const originalHtml = btn.dataset.rfmdOriginal;
    const isDownload = btn.dataset.rfmdAction === 'download';
    const cls = success ? 'rfmd-btn--success' : 'rfmd-btn--error';
    const label = success
      ? `${CHECK_ICON_SVG} ${isDownload ? 'ダウンロード完了' : 'コピー完了'}`
      : `${isDownload ? 'ダウンロード失敗' : 'コピー失敗'}`;

    btn.classList.add(cls);
    btn.innerHTML = label;

    btn._rfmdTimer = setTimeout(() => {
      btn.classList.remove(cls);
      btn.innerHTML = originalHtml;
      btn.dataset.rfmdBusy = '0';
      btn._rfmdTimer = null;
    }, 1500);
  }

  /**
   * ボタン生成ファクトリ
   * @param {{ className: string, dataRfmd: string, label: string, title: string, action?: 'copy'|'download', extractFn: Function }} opts
   *   action='copy'（デフォルト）: extractFn は Markdown 文字列を返す → クリップボードへコピー
   *   action='download': extractFn は {title, markdown} を返す → ファイルとしてダウンロード
   * @returns {HTMLButtonElement}
   */
  function _createButton({ className, dataRfmd, label, title, action = 'copy', extractFn }) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.setAttribute('data-rfmd', dataRfmd);
    btn.setAttribute('aria-label', title);
    btn.innerHTML = label;
    btn.dataset.rfmdOriginal = label;
    btn.dataset.rfmdBusy = '0';
    if (action === 'download') btn.dataset.rfmdAction = 'download';
    btn.title = title;

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.dataset.rfmdBusy === '1') return;
      try {
        const result = await Promise.resolve(extractFn());
        let ok;
        if (action === 'download') {
          const filename = _sanitizeFilename(result.title) + '.md';
          ok = RfmdClipboard.download(result.markdown, filename);
        } else {
          ok = await RfmdClipboard.copy(result);
        }
        _showFeedback(btn, ok);
      } catch (err) {
        console.error('[ReviewForMD]', err);
        _showFeedback(btn, false);
      }
    });

    return btn;
  }

  /** サイトタイプに対応する Extractor を返す */
  const _EXTRACTORS = {
    [SiteDetector.SiteType.GITHUB]: GitHubExtractor,
    [SiteDetector.SiteType.AZURE_DEVOPS]: DevOpsExtractor,
  };

  /**
   * ファイル名として使えない文字を除去する
   */
  function _sanitizeFilename(name) {
    return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || 'pullrequest';
  }

  function _createAllDownloadButton(siteType) {
    return _createButton({
      className: 'rfmd-btn rfmd-btn--primary',
      dataRfmd: 'all',
      action: 'download',
      label: DOWNLOAD_LABEL,
      title: 'PR タイトル・本文・全レビューコメントを Markdown ファイルでダウンロード',
      extractFn: async () => {
        const extractor = _EXTRACTORS[siteType];
        // タイトルは extractAll() の前に取得する
        // （API フォールバック中に DOM 状態が変わる可能性があるため）
        const title = extractor.getTitle();
        const markdown = await extractor.extractAll();
        return { title, markdown };
      },
    });
  }

  function _createCommentCopyButton(siteType, commentContainer) {
    return _createButton({
      className: 'rfmd-btn',
      dataRfmd: 'single',
      label: SINGLE_COPY_LABEL,
      title: 'このコメントを Markdown 形式でコピー',
      extractFn: () => {
        const comment = _EXTRACTORS[siteType].extractSingleComment(commentContainer);
        return MarkdownBuilder.formatSingleComment(comment);
      },
    });
  }

  function _createThreadCopyButton(threadContainer) {
    return _createButton({
      className: 'rfmd-btn',
      dataRfmd: 'single',
      label: SINGLE_COPY_LABEL,
      title: 'このスレッド（返信含む）を Markdown 形式でコピー',
      extractFn: () => {
        const comments = DevOpsExtractor.extractThreadComments(threadContainer);
        return MarkdownBuilder.formatThreadComments(comments);
      },
    });
  }

  /* ── GitHub 用ボタン注入 ──────────────────────── */

  /**
   * PR 本文コメントかどうかを判定する。
   * ロジックの重複・乖離を防ぐため GitHubExtractor.isPRBodyComment に委譲する。
   */
  function _isPRBodyContainer(container) {
    return GitHubExtractor.isPRBodyComment(container);
  }

  function _injectGitHub() {
    // 「全てMDコピー」ボタンをヘッダーに注入
    // 新 UI: Primer React Components (prc-PageHeader-Actions-*)
    // 旧 UI: .gh-header-actions / .gh-header-meta
    const headerActions =
      document.querySelector('[class*="PageHeader-Actions"]') ||
      document.querySelector('.gh-header-actions') ||
      document.querySelector('.gh-header-meta');

    if (!headerActions) {
      // ページ読み込みタイミングにより見つからない場合がある（次回 inject で再試行）
      console.debug('[ReviewForMD] headerActions が見つかりません。次回の inject で再試行します。');
    }

    if (headerActions && !headerActions.querySelector('[data-rfmd="all"]')) {
      const wrap = document.createElement('div');
      wrap.className = 'rfmd-all-copy-container';
      wrap.appendChild(_createAllDownloadButton(SiteDetector.SiteType.GITHUB));

      if (headerActions.classList.contains('gh-header-actions')) {
        headerActions.prepend(wrap);
      } else {
        headerActions.appendChild(wrap);
      }
    }

    // ── 通常コメント（タイムライン上）に「MDコピー」ボタンを注入 ──
    const timelineContainers = document.querySelectorAll(
      '.timeline-comment, .react-issue-comment'
    );

    timelineContainers.forEach((container) => {
      // 既に注入済みならスキップ（最も安価なチェックを最初に実行）
      if (container.querySelector('[data-rfmd="single"]')) return;

      // PR 本文はスキップ（GitHubExtractor.isPRBodyComment に委譲）
      if (_isPRBodyContainer(container)) {
        return;
      }

      // レビュースレッド内のコメントはスキップ（下で別処理）
      if (container.closest('.js-resolvable-timeline-thread-container')) return;

      const header =
        container.querySelector('.timeline-comment-header') ||
        container.querySelector('[data-testid="comment-header"]');

      if (header) {
        const wrap = document.createElement('span');
        wrap.className = 'rfmd-comment-btn-wrap';
        wrap.appendChild(
          _createCommentCopyButton(SiteDetector.SiteType.GITHUB, container)
        );

        const commentActions =
          header.querySelector('.timeline-comment-actions');
        if (commentActions) {
          commentActions.prepend(wrap);
        } else {
          header.prepend(wrap);
        }
      }
    });

    // ── レビュースレッド（インラインコメント）のファイルヘッダーに
    //    「MDコピー」ボタンを注入 ──
    const threads = document.querySelectorAll(
      '.js-resolvable-timeline-thread-container'
    );

    threads.forEach((thread) => {
      // 既に注入済みならスキップ
      if (thread.querySelector('summary [data-rfmd="single"]')) return;

      // スレッド内の最初のコメントコンテナを特定
      const commentContainer =
        thread.querySelector('.timeline-comment-group') ||
        thread.querySelector('.review-comment') ||
        thread.querySelector('.timeline-comment');
      if (!commentContainer) return;

      // ファイルヘッダー（summary 内の flex コンテナ）にボタンを配置
      const summary = thread.querySelector('summary');
      if (!summary) {
        // summary が存在しないレビュースレッド（展開済み等）はスキップ
        console.debug('[ReviewForMD] レビュースレッドに summary が見つかりません。スキップします。');
        return;
      }

      // flexDiv が見つからない場合は summary 自体にフォールバック
      const flexDiv = summary.querySelector('.d-flex');
      const insertTarget = flexDiv || summary;

      const wrap = document.createElement('span');
      wrap.className = 'rfmd-comment-btn-wrap';
      wrap.appendChild(
        _createCommentCopyButton(SiteDetector.SiteType.GITHUB, commentContainer)
      );
      insertTarget.appendChild(wrap);
    });
  }

  /* ── Azure DevOps 用ボタン注入 ───────────────── */

  function _injectDevOps() {
    // 「全てMDコピー」ボタンを Approve ボタンの左隣に注入
    const voteButton = document.querySelector('.repos-pr-header-vote-button');
    const headerArea =
      document.querySelector('.bolt-header-title-area') ||
      document.querySelector('.repos-pr-details-page-tabbar') ||
      document.querySelector('.repos-pr-details-page');
    const insertTarget = voteButton ? voteButton.parentElement : headerArea;

    if (insertTarget && !document.querySelector('[data-rfmd="all"]')) {
      const wrap = document.createElement('div');
      wrap.className = 'rfmd-all-copy-container';
      wrap.appendChild(_createAllDownloadButton(SiteDetector.SiteType.AZURE_DEVOPS));

      if (voteButton) {
        // Approve ボタンの直前に挿入
        voteButton.parentElement.insertBefore(wrap, voteButton);
      } else if (headerArea) {
        headerArea.appendChild(wrap);
      }
    }

    // 各ファイルヘッダー（ファイル名 + View original diff）に「MDコピー」ボタンを注入
    // ファイルヘッダーの隣接スレッド全体（親コメント＋返信）をまとめてコピーする
    const fileHeaders = document.querySelectorAll('.comment-file-header');

    fileHeaders.forEach((fileHeader) => {
      // 既に注入済みならスキップ
      if (fileHeader.querySelector('[data-rfmd="single"]')) return;

      // ファイルヘッダーの次の兄弟がスレッド
      const thread = fileHeader.nextElementSibling;
      if (!thread || !thread.classList.contains('repos-discussion-thread')) return;

      // タイトル行の右側エリア（View original diff ボタン等が並ぶ場所）
      const titleRow = fileHeader.querySelector('.comment-file-header-title');
      if (!titleRow) return;
      const rightArea = titleRow.querySelector('.flex-row.flex-noshrink.flex-center');
      if (!rightArea) return;

      // View original diff ボタンの前にMDコピーボタンを挿入
      const viewOrigBtn = rightArea.querySelector('button');
      const wrap = document.createElement('span');
      wrap.className = 'rfmd-comment-btn-wrap';
      wrap.appendChild(_createThreadCopyButton(thread));

      if (viewOrigBtn) {
        rightArea.insertBefore(wrap, viewOrigBtn);
      } else {
        rightArea.prepend(wrap);
      }
    });
  }

  /* ── PR 一覧ページ用ボタン注入 ─────────────────── */

  function _injectGitHubList() {
    // GitHub PR 一覧: 各 PR 行に「MDでダウンロード」ボタンを注入
    const prRows = document.querySelectorAll('.js-issue-row, [data-testid="list-view-item"]');

    prRows.forEach((row) => {
      if (row.querySelector('[data-rfmd="list-dl"]')) return;

      // PR リンクを取得
      const link =
        row.querySelector('a[data-hovercard-type="pull_request"]') ||
        row.querySelector('a[id^="issue_"]') ||
        row.querySelector('a[href*="/pull/"]');
      if (!link) return;
      const prUrl = link.href;
      if (!prUrl || !/\/pull\/\d+/.test(prUrl)) return;

      const btn = _createButton({
        className: 'rfmd-btn rfmd-btn--sm',
        dataRfmd: 'list-dl',
        action: 'download',
        label: DOWNLOAD_LABEL,
        title: 'この PR を Markdown ファイルでダウンロード',
        extractFn: () => GitHubExtractor.extractByPrUrl(prUrl),
      });

      const wrap = document.createElement('span');
      wrap.className = 'rfmd-list-btn-wrap';
      wrap.appendChild(btn);

      // コンテンツエリア（タイトル・説明の親）の3行目として追加
      const contentArea = row.querySelector('.flex-auto.min-width-0') ||
        row.querySelector('.d-flex.mt-1') || row;
      contentArea.appendChild(wrap);
    });
  }

  function _injectDevOpsList() {
    // DevOps PR 一覧: 各 PR 行に「MDでダウンロード」ボタンを注入
    // DevOps では行自体が <a class="bolt-table-row"> で PR 詳細へのリンクになっている
    const prRows = document.querySelectorAll(
      'a.bolt-table-row, a.bolt-list-row'
    );

    prRows.forEach((row) => {
      const prUrl = row.href;
      if (!prUrl || !/\/pullrequest\/\d+/i.test(prUrl)) return;

      // 既に注入済みならスキップ
      if (row.querySelector('[data-rfmd="list-dl"]')) return;

      const btn = _createButton({
        className: 'rfmd-btn rfmd-btn--sm',
        dataRfmd: 'list-dl',
        action: 'download',
        label: DOWNLOAD_LABEL,
        title: 'この PR を Markdown ファイルでダウンロード',
        extractFn: () => DevOpsExtractor.extractByPrUrl(prUrl),
      });

      const wrap = document.createElement('span');
      wrap.className = 'rfmd-list-btn-wrap';
      wrap.appendChild(btn);

      // bolt-table-cell-content（flex-column）の3行目として追加
      const cellContent = row.querySelector('.bolt-table-cell-content.flex-column') ||
        row.querySelector('.bolt-table-two-line-cell .bolt-table-cell-content');
      if (cellContent) {
        cellContent.appendChild(wrap);
      } else {
        const titleCell = row.querySelector('.bolt-table-two-line-cell') ||
          row.querySelector('td:nth-child(3)');
        if (titleCell) {
          titleCell.appendChild(wrap);
        } else {
          row.appendChild(wrap);
        }
      }
    });
  }

  /* ── 公開 API ─────────────────────────────────── */

  /**
   * 検出されたサイトタイプに応じてボタンを注入する（PR 詳細ページ用）
   * @param {string} siteType
   */
  function inject(siteType) {
    if (siteType === SiteDetector.SiteType.GITHUB) {
      _injectGitHub();
    } else if (siteType === SiteDetector.SiteType.AZURE_DEVOPS) {
      _injectDevOps();
    }
  }

  /**
   * PR 一覧ページにダウンロードボタンを注入する
   * @param {string} siteType
   */
  function injectList(siteType) {
    if (siteType === SiteDetector.SiteType.GITHUB) {
      _injectGitHubList();
    } else if (siteType === SiteDetector.SiteType.AZURE_DEVOPS) {
      _injectDevOpsList();
    }
  }

  return { inject, injectList };
})();
