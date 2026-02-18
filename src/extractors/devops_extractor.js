/**
 * Azure DevOps プルリクエスト データ抽出モジュール
 *
 * DevOps は SPA で DOM が動的にレンダリングされるため、
 * DOM ベースの抽出に加えて REST API をフォールバックとして利用する。
 */
const DevOpsExtractor = (() => {
  /**
   * PR タイトルを取得する
   * @returns {string}
   */
  function getTitle() {
    // bolt ヘッダータイトルエリア内のテキスト
    const headerTitle = document.querySelector('.bolt-header-title-area .body-l');
    if (headerTitle) return headerTitle.textContent.trim();

    // フォールバック: ページタイトルからパースする
    // 例: "Pull Request 123 - タイトル - Repos"
    const titleMatch = document.title.match(
      /Pull Request \d+\s*[-–]\s*(.+?)(?:\s*[-–]\s*Repos)?$/i
    );
    if (titleMatch) return titleMatch[1].trim();

    // さらにフォールバック: bolt-header 内の大きめテキスト
    const anyTitle = document.querySelector('.bolt-header-title-area');
    if (anyTitle) {
      const text = anyTitle.textContent.trim();
      return text.replace(/^\d+\s*[-–:]\s*/, '').trim();
    }

    return '';
  }

  /**
   * PR 番号を取得する
   * @returns {string}
   */
  function getPRNumber() {
    // URL から取得
    const match = location.pathname.match(/\/pullrequest\/(\d+)/);
    if (match) return `#${match[1]}`;

    // data 属性から取得
    const prIdEl = document.querySelector('[data-pullRequestId]');
    if (prIdEl) return `#${prIdEl.getAttribute('data-pullRequestId')}`;

    return '';
  }

  /**
   * PR 本文を取得する
   * @returns {string}
   */
  function getBody() {
    // Overview タブの説明セクション（複数のセレクタ候補で検索）
    const candidates = [
      '.repos-pr-description .rendered-markdown',
      '.repos-overview-description .rendered-markdown',
      '.bolt-card-content .rendered-markdown',
      '.repos-overview .rendered-markdown',
    ];

    for (const selector of candidates) {
      const el = document.querySelector(selector);
      if (el) return MarkdownBuilder.htmlToMarkdown(el);
    }

    return '';
  }

  /**
   * 全レビューコメントを取得する（DOM ベース）
   * @returns {Array<{author:string, body:string, filePath?:string, timestamp?:string}>}
   */
  function getComments() {
    const comments = [];

    // Activity/Discussion タブのコメント
    _extractActivityComments(comments);

    // Files タブのインラインコメント
    _extractInlineComments(comments);

    return _deduplicateComments(comments);
  }

  /**
   * Activity タブのディスカッションコメントを抽出
   */
  function _extractActivityComments(out) {
    // DevOps のコメントスレッドコンテナ（具体的なクラス名を優先）
    const specificSelectors = [
      '.vc-discussion-thread-comment',
      '.repos-discussion-comment',
    ];

    let found = false;

    for (const selector of specificSelectors) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        found = true;
        elements.forEach((el) => {
          const comment = _parseDevOpsComment(el);
          if (comment && comment.body) out.push(comment);
        });
      }
    }

    // 具体的なセレクタでヒットしなかった場合のフォールバック
    if (!found) {
      // discussion-thread 内の comment-content を探す
      const threads = document.querySelectorAll('.discussion-thread, .comment-thread');
      threads.forEach((thread) => {
        const commentEls = thread.querySelectorAll('.comment-content');
        if (commentEls.length === 0) {
          const comment = _parseDevOpsComment(thread);
          if (comment && comment.body) out.push(comment);
        } else {
          commentEls.forEach((el) => {
            const comment = _parseDevOpsComment(el);
            if (comment && comment.body) out.push(comment);
          });
        }
      });
    }
  }

  /**
   * ファイル差分上のインラインコメントを抽出
   */
  function _extractInlineComments(out) {
    const inlineThreads = document.querySelectorAll('.repos-discussion-thread');

    inlineThreads.forEach((thread) => {
      // ファイルパスを取得
      const fileContainer = thread.closest('.repos-summary-item, .file-container');
      const filePathEl = fileContainer?.querySelector(
        '.repos-summary-header .file-name-link, .repos-summary-header-path'
      );
      const filePath = filePathEl ? filePathEl.textContent.trim() : '';

      const commentEls = thread.querySelectorAll(
        '.vc-discussion-thread-comment, .comment-content'
      );
      commentEls.forEach((el) => {
        const comment = _parseDevOpsComment(el);
        if (comment && comment.body) {
          if (filePath) comment.filePath = filePath;
          out.push(comment);
        }
      });
    });
  }

  /**
   * DevOps コメント要素から情報を抽出する
   */
  function _parseDevOpsComment(container) {
    // 著者（具体的なセレクタから汎用へフォールバック）
    const authorSelectors = [
      '.repos-discussion-comment-header .font-weight-semibold',
      '.vc-discussion-thread-comment-header .identity-name',
      '.comment-header .identity-name',
      '.font-weight-semibold',
      '.identity-name',
    ];
    let author = '';
    for (const sel of authorSelectors) {
      const el = container.querySelector(sel);
      if (el) { author = el.textContent.trim(); break; }
    }

    // タイムスタンプ
    const timeSelectors = [
      '.vc-discussion-thread-comment-header .ago',
      '.comment-header .ago',
      'time',
      '.ago',
    ];
    let timestamp = '';
    for (const sel of timeSelectors) {
      const el = container.querySelector(sel);
      if (el) {
        timestamp = el.getAttribute('datetime') || el.getAttribute('title') || el.textContent.trim();
        break;
      }
    }

    // 本文（markdown-content / rendered-markdown を優先）
    const bodySelectors = [
      '.markdown-content',
      '.rendered-markdown',
      '.comment-content .rendered-markdown',
    ];
    let body = '';
    for (const sel of bodySelectors) {
      const el = container.querySelector(sel);
      if (el) { body = MarkdownBuilder.htmlToMarkdown(el); break; }
    }
    // フォールバック: コンテナ自体が markdown 系クラスの場合
    if (!body && (container.classList.contains('rendered-markdown') || container.classList.contains('markdown-content'))) {
      body = MarkdownBuilder.htmlToMarkdown(container);
    }

    return { author, body, timestamp };
  }

  /* ── REST API フォールバック ───────────────────── */

  /**
   * REST API 経由で PR データを取得する（フォールバック）
   * @returns {Promise<{title: string, body: string, comments: Array}|null>}
   */
  async function fetchViaApi() {
    const urlInfo = _parseDevOpsUrl();
    if (!urlInfo) return null;

    try {
      const [prData, threads] = await Promise.all([
        _fetchJson(
          `${urlInfo.baseUrl}/_apis/git/repositories/${urlInfo.repo}/pullRequests/${urlInfo.prId}?api-version=7.1`
        ),
        _fetchJson(
          `${urlInfo.baseUrl}/_apis/git/repositories/${urlInfo.repo}/pullRequests/${urlInfo.prId}/threads?api-version=7.1`
        ),
      ]);

      const title = prData.title || '';
      const body = prData.description || '';
      const comments = [];

      if (threads && threads.value) {
        threads.value.forEach((thread) => {
          if (!thread.comments) return;
          thread.comments.forEach((c) => {
            if (c.commentType === 'system') return;
            comments.push({
              author: c.author?.displayName || '',
              body: c.content || '',
              filePath: thread.threadContext?.filePath || undefined,
              timestamp: c.publishedDate || '',
            });
          });
        });
      }

      return { title, body, comments };
    } catch (e) {
      console.warn('[ReviewForMD] API fetch failed:', e);
      return null;
    }
  }

  /**
   * DevOps の URL をパースして API ベース URL、リポジトリ名、PR ID を返す。
   * 貪欲マッチ (.*) を使い、/_git/ の直前までをベースURLとする。
   */
  function _parseDevOpsUrl() {
    const path = location.pathname;
    // 貪欲マッチで /_git/ の直前まで取得する
    const match = path.match(/^(.*)\/_git\/([^/]+)\/pullrequest\/(\d+)/);
    if (!match) return null;

    return {
      baseUrl: `${location.origin}${match[1]}`,
      repo: match[2],
      prId: match[3],
    };
  }

  async function _fetchJson(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /**
   * 重複コメントを除去する
   */
  function _deduplicateComments(comments) {
    const seen = new Set();
    return comments.filter((c) => {
      const key = `${c.author}::${(c.body || '').substring(0, 100)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * 指定コメントコンテナから単一コメントデータを取得
   * @param {Element} container
   * @returns {{ author: string, body: string, filePath?: string, timestamp?: string }}
   */
  function extractSingleComment(container) {
    return _parseDevOpsComment(container);
  }

  /**
   * スレッド（.repos-discussion-thread）内の全コメント（親＋返信）を取得
   * @param {Element} threadContainer
   * @returns {Array<{ author: string, body: string, filePath?: string, timestamp?: string }>}
   */
  function extractThreadComments(threadContainer) {
    const comments = [];

    // ファイルパスを取得
    // 1) スレッドの前の兄弟要素 .comment-file-header からファイル名リンクを取得
    let filePath = '';
    const prevSibling = threadContainer.previousElementSibling;
    if (prevSibling && prevSibling.classList.contains('comment-file-header')) {
      const linkEl = prevSibling.querySelector('.comment-file-header-link');
      if (linkEl) filePath = linkEl.textContent.trim();
      // フォールバック: セカンダリテキスト（フルパス）
      if (!filePath) {
        const pathEl = prevSibling.querySelector('.secondary-text');
        if (pathEl) filePath = pathEl.textContent.trim();
      }
    }
    // 2) フォールバック: 従来のセレクタ
    if (!filePath) {
      const fileContainer = threadContainer.closest('.repos-summary-item, .file-container');
      const filePathEl = fileContainer?.querySelector(
        '.repos-summary-header .file-name-link, .repos-summary-header-path'
      );
      if (filePathEl) filePath = filePathEl.textContent.trim();
    }

    // スレッド内の全コメント要素
    const commentEls = threadContainer.querySelectorAll('.repos-discussion-comment');
    commentEls.forEach((el) => {
      // spinner（未ロード）はスキップ
      if (el.querySelector('.bolt-spinner') && !el.querySelector('.repos-discussion-comment-header')) return;
      const comment = _parseDevOpsComment(el);
      if (comment && comment.body) {
        // ファイルパスは親コメント（最初の1件）にのみ付与
        if (filePath && comments.length === 0) comment.filePath = filePath;
        comments.push(comment);
      }
    });

    return comments;
  }

  /**
   * 全データを取得して Markdown を生成する
   * DOM ベースで取得し、コメントが 0 件なら API フォールバック
   * @returns {Promise<string>}
   */
  async function extractAll() {
    let title = `${getTitle()} ${getPRNumber()}`;
    let body = getBody();
    let comments = getComments();

    // DOM でコメントが取れなかった場合、API を試す
    if (comments.length === 0) {
      const apiData = await fetchViaApi();
      if (apiData) {
        if (!title.trim() || title.trim() === '#') {
          title = `${apiData.title} ${getPRNumber()}`;
        }
        if (!body) body = apiData.body;
        comments = apiData.comments;
      }
    }

    return MarkdownBuilder.buildFullMarkdown({ title: title.trim(), body, comments });
  }

  return {
    getTitle,
    getPRNumber,
    getBody,
    getComments,
    extractAll,
    extractSingleComment,
    extractThreadComments,
    fetchViaApi,
  };
})();
