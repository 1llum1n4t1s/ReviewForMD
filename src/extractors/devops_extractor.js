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
   * 全レビューコメントをスレッド単位で取得する（DOM ベース）
   * @returns {Array<Array<{author:string, body:string, filePath?:string, timestamp?:string}>>}
   */
  function getComments() {
    const threads = [];

    // Activity/Discussion タブのコメント
    _extractActivityComments(threads);

    // Files タブのインラインコメント
    _extractInlineComments(threads);

    return _deduplicateThreads(threads);
  }

  /**
   * Activity タブのディスカッションコメントをスレッド単位で抽出
   * @param {Array<Array>} out - スレッドの配列（各要素はコメントの配列）
   */
  function _extractActivityComments(out) {
    // .repos-discussion-thread を1スレッドとして扱う
    const threadEls = document.querySelectorAll('.repos-discussion-thread');
    if (threadEls.length > 0) {
      threadEls.forEach((threadEl) => {
        const threadComments = [];
        const commentEls = threadEl.querySelectorAll(
          '.repos-discussion-comment, .vc-discussion-thread-comment'
        );
        commentEls.forEach((el) => {
          const comment = _parseDevOpsComment(el);
          if (comment && comment.body) threadComments.push(comment);
        });
        if (threadComments.length > 0) out.push(threadComments);
      });
      return;
    }

    // フォールバック: discussion-thread / comment-thread を1スレッドとして扱う
    const legacyThreads = document.querySelectorAll('.discussion-thread, .comment-thread');
    legacyThreads.forEach((thread) => {
      const threadComments = [];
      const commentEls = thread.querySelectorAll('.comment-content');
      if (commentEls.length === 0) {
        const comment = _parseDevOpsComment(thread);
        if (comment && comment.body) threadComments.push(comment);
      } else {
        commentEls.forEach((el) => {
          const comment = _parseDevOpsComment(el);
          if (comment && comment.body) threadComments.push(comment);
        });
      }
      if (threadComments.length > 0) out.push(threadComments);
    });
  }

  /**
   * ファイル差分上のインラインコメントをスレッド単位で抽出
   * @param {Array<Array>} out - スレッドの配列（各要素はコメントの配列）
   */
  function _extractInlineComments(out) {
    const inlineThreads = document.querySelectorAll('.repos-discussion-thread');

    inlineThreads.forEach((thread) => {
      // ファイルパスと diff コンテキストを取得
      let filePath = '';
      let diffContext;
      const prevSibling = thread.previousElementSibling;
      if (prevSibling && prevSibling.classList.contains('comment-file-header')) {
        const linkEl = prevSibling.querySelector('.comment-file-header-link');
        if (linkEl) filePath = linkEl.textContent.trim();
        if (!filePath) {
          const pathEl = prevSibling.querySelector('.secondary-text');
          if (pathEl) filePath = pathEl.textContent.trim();
        }
        diffContext = _extractDiffContext(prevSibling);
      }
      // フォールバック: 従来のセレクタ
      if (!filePath) {
        const fileContainer = thread.closest('.repos-summary-item, .file-container');
        const filePathEl = fileContainer?.querySelector(
          '.repos-summary-header .file-name-link, .repos-summary-header-path'
        );
        if (filePathEl) filePath = filePathEl.textContent.trim();
      }

      const threadComments = [];
      const commentEls = thread.querySelectorAll(
        '.vc-discussion-thread-comment, .repos-discussion-comment, .comment-content'
      );
      commentEls.forEach((el) => {
        const comment = _parseDevOpsComment(el);
        if (comment && comment.body) {
          // ファイルパスと diff コンテキストは最初のコメントにのみ付与
          if (threadComments.length === 0) {
            if (filePath) comment.filePath = filePath;
            if (diffContext) comment.diffContext = diffContext;
          }
          threadComments.push(comment);
        }
      });

      if (threadComments.length > 0) out.push(threadComments);
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
      const apiThreads = [];

      if (threads && threads.value) {
        threads.value.forEach((thread) => {
          if (!thread.comments) return;
          const tc = thread.threadContext;
          // threadContext から行範囲を生成
          let lineRange = '';
          if (tc) {
            const start = tc.rightFileStart?.line || tc.leftFileStart?.line;
            const end = tc.rightFileEnd?.line || tc.leftFileEnd?.line;
            if (start && end && start !== end) {
              lineRange = `行 ${start}-${end}`;
            } else if (start) {
              lineRange = `行 ${start}`;
            }
          }
          const threadComments = [];
          thread.comments.forEach((c) => {
            if (c.commentType === 'system') return;
            const comment = {
              author: c.author?.displayName || '',
              body: c.content || '',
              filePath: tc?.filePath || undefined,
              timestamp: c.publishedDate || '',
            };
            // 行範囲はスレッドの最初のユーザーコメントにのみ付与
            if (threadComments.length === 0 && lineRange) {
              comment.diffContext = { lineRange, diffLines: [] };
            }
            threadComments.push(comment);
          });
          if (threadComments.length > 0) apiThreads.push(threadComments);
        });
      }

      return { title, body, threads: apiThreads };
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
   * comment-file-header 内の diff コンテキスト（行番号・ソースコード）を抽出する
   * @param {Element} fileHeader - .comment-file-header 要素
   * @returns {{ lineRange: string, diffLines: Array<{prefix: string, lineNum: string, code: string}> }|undefined}
   */
  function _extractDiffContext(fileHeader) {
    if (!fileHeader) return undefined;

    const diffContainer = fileHeader.querySelector('.comment-file-diff-container');
    if (!diffContainer) return undefined;

    const rows = diffContainer.querySelectorAll('.repos-diff-contents-row');
    if (rows.length === 0) return undefined;

    const diffLines = [];
    let firstLineNum = '';
    let lastLineNum = '';

    rows.forEach((row) => {
      const spans = row.children;
      if (spans.length < 3) return;

      // 旧行番号（SPAN[0] 内の .screen-reader-only）
      const oldSr = spans[0].querySelector('.screen-reader-only');
      let oldNum = oldSr ? oldSr.textContent.trim() : '';
      // "Commented 417" のような形式から数値だけ取得
      oldNum = oldNum.replace(/^Commented\s+/i, '');

      // 新行番号（SPAN[1] 内の .screen-reader-only）
      const newSr = spans[1].querySelector('.screen-reader-only');
      let newNum = newSr ? newSr.textContent.trim() : '';
      newNum = newNum.replace(/^Commented\s+/i, '');

      const lineNum = newNum || oldNum;

      // コード内容（SPAN[2] = .repos-line-content、screen-reader-only 除外）
      const contentSpan = spans[2];
      const contentCls = typeof contentSpan.className === 'string' ? contentSpan.className : '';
      const isAdded = contentCls.includes('added');
      const isRemoved = contentCls.includes('removed');
      const prefix = isAdded ? '+' : isRemoved ? '-' : ' ';

      let code = '';
      for (const child of contentSpan.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          code += child.textContent;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const cls = typeof child.className === 'string' ? child.className : '';
          if (!cls.includes('screen-reader-only')) {
            code += child.textContent;
          }
        }
      }

      diffLines.push({ prefix, lineNum, code: code.trimEnd() });

      // 行範囲の計算用
      if (lineNum && !firstLineNum) firstLineNum = lineNum;
      if (lineNum) lastLineNum = lineNum;
    });

    if (diffLines.length === 0) return undefined;

    // 行範囲テキストを生成
    let lineRange = '';
    if (firstLineNum && lastLineNum && firstLineNum !== lastLineNum) {
      lineRange = `行 ${firstLineNum}-${lastLineNum}`;
    } else if (firstLineNum) {
      lineRange = `行 ${firstLineNum}`;
    }

    return { lineRange, diffLines };
  }

  /**
   * 重複スレッドを除去する（先頭コメントのauthor+bodyで判定）
   * @param {Array<Array>} threads
   * @returns {Array<Array>}
   */
  function _deduplicateThreads(threads) {
    const seen = new Set();
    return threads.filter((thread) => {
      if (!thread || thread.length === 0) return false;
      const first = thread[0];
      const key = `${first.author}::${(first.body || '').substring(0, 100)}`;
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

    // ファイルパスと diff コンテキストを取得
    // 1) スレッドの前の兄弟要素 .comment-file-header からファイル名リンクを取得
    let filePath = '';
    let diffContext;
    const prevSibling = threadContainer.previousElementSibling;
    if (prevSibling && prevSibling.classList.contains('comment-file-header')) {
      const linkEl = prevSibling.querySelector('.comment-file-header-link');
      if (linkEl) filePath = linkEl.textContent.trim();
      // フォールバック: セカンダリテキスト（フルパス）
      if (!filePath) {
        const pathEl = prevSibling.querySelector('.secondary-text');
        if (pathEl) filePath = pathEl.textContent.trim();
      }
      // diff コンテキストを抽出
      diffContext = _extractDiffContext(prevSibling);
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
        // ファイルパスと diff コンテキストは親コメント（最初の1件）にのみ付与
        if (comments.length === 0) {
          if (filePath) comment.filePath = filePath;
          if (diffContext) comment.diffContext = diffContext;
        }
        comments.push(comment);
      }
    });

    return comments;
  }

  /**
   * DOM 上に未ロードのコメント（スピナー）が残っているかどうか判定する
   * @returns {boolean}
   */
  function _hasUnloadedComments() {
    // コメントスレッド内のスピナーを確認
    const threads = document.querySelectorAll('.repos-discussion-thread');
    for (const thread of threads) {
      const spinners = thread.querySelectorAll('.bolt-spinner');
      for (const sp of spinners) {
        // スピナーがあっても、同じコメント要素内にヘッダーがあればロード済み
        const comment = sp.closest('.repos-discussion-comment');
        if (comment && !comment.querySelector('.repos-discussion-comment-header')) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * 全データを取得して Markdown を生成する
   * DOM に未ロードコメントがある場合は API を優先使用する
   * @returns {Promise<string>}
   */
  async function extractAll() {
    let domTitle = getTitle();
    let body = getBody();
    let threads = getComments(); // Array<Array<comment>>

    // DOM でコメントが取れなかった場合、または未ロードのコメントがある場合、API を試す
    const domCommentCount = threads.reduce((sum, t) => sum + t.length, 0);
    const needApi = domCommentCount === 0 || _hasUnloadedComments();

    let title = '';
    if (needApi) {
      const apiData = await fetchViaApi();
      if (apiData) {
        // API タイトルを優先（DOM より確実）
        if (apiData.title) title = `${apiData.title} ${getPRNumber()}`;
        if (!body) body = apiData.body;
        // API から取得したコメントが DOM より多い場合のみ API を採用
        const apiCommentCount = apiData.threads.reduce((sum, t) => sum + t.length, 0);
        if (apiCommentCount > domCommentCount) {
          threads = apiData.threads;
        }
      }
    }

    // API タイトルが取れなかった場合は DOM タイトルにフォールバック
    if (!title) {
      title = domTitle ? `${domTitle} ${getPRNumber()}` : getPRNumber();
    }

    return MarkdownBuilder.buildFullMarkdown({ title: title.trim(), body, threads });
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
