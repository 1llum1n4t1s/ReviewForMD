/**
 * GitHub プルリクエスト データ抽出モジュール
 */
const GitHubExtractor = (() => {
  /**
   * PR タイトルを取得する
   * @returns {string}
   */
  function getTitle() {
    // Primer React UI (2025〜): h1 > span.markdown-title
    const prcTitle = document.querySelector(
      'h1[class*="PageHeader-Title"] span.markdown-title'
    );
    if (prcTitle) return prcTitle.textContent.trim();

    // React ベースの新 UI
    const reactTitle = document.querySelector('[data-testid="issue-title"]');
    if (reactTitle) return reactTitle.textContent.trim();

    // bdi.markdown-title (新 UI のフォールバック)
    const bdiTitle = document.querySelector('h1 bdi.markdown-title');
    if (bdiTitle) return bdiTitle.textContent.trim();

    // レガシー UI
    const legacyTitle = document.querySelector('.gh-header-title .js-issue-title');
    if (legacyTitle) return legacyTitle.textContent.trim();

    // 最終フォールバック: h1 からタイトルテキストだけを取得
    const h1 = document.querySelector('.gh-header-title');
    if (h1) {
      // #番号 部分を除いたテキスト
      const text = h1.textContent.trim();
      return text.replace(/\s*#\d+\s*$/, '').trim();
    }

    return '';
  }

  /**
   * PR 番号を取得する
   * @returns {string}
   */
  function getPRNumber() {
    const match = location.pathname.match(/\/pull\/(\d+)/);
    return match ? `#${match[1]}` : '';
  }

  /**
   * PR 本文を取得する
   * @returns {string}
   */
  function getBody() {
    // 旧 UI: 専用の PR 本文コンテナ
    const legacyBodyEl =
      document.querySelector('.js-issue-body .markdown-body') ||
      document.querySelector('.react-issue-body .markdown-body') ||
      document.querySelector('[data-testid="issue-body"] .markdown-body');
    if (legacyBodyEl) return MarkdownBuilder.htmlToMarkdown(legacyBodyEl);

    // 新 UI (2025〜): PR 本文は id="pullrequest-*" のコメント内にある
    const prBodyComment = document.querySelector('[id^="pullrequest-"]');
    if (prBodyComment) {
      const mdBody =
        prBodyComment.querySelector('.js-comment-body .markdown-body') ||
        prBodyComment.querySelector('.comment-body .markdown-body') ||
        prBodyComment.querySelector('.markdown-body');
      if (mdBody) return MarkdownBuilder.htmlToMarkdown(mdBody);
    }

    return '';
  }

  /**
   * 全レビューコメントを取得する
   * @returns {Array<{author:string, body:string, filePath?:string, timestamp?:string}>}
   */
  function getComments() {
    const comments = [];

    // ── Conversation タブのタイムラインコメント ──
    _extractTimelineComments(comments);

    // ── レビュースレッド（インラインコメント）──
    _extractReviewThreadComments(comments);

    // 重複除去（同じ内容・同じ著者のコメント）
    return _deduplicateComments(comments);
  }

  /**
   * タイムラインコメント（一般コメント）を抽出
   */
  function _extractTimelineComments(out) {
    // PR 本文以外のタイムラインコメントを取得
    const containers = document.querySelectorAll(
      '.timeline-comment, .react-issue-comment'
    );

    containers.forEach((container) => {
      // PR 本文コメントはスキップ（「## 本文」セクションで別途出力される）
      if (_isPRBodyComment(container)) return;

      const comment = _parseCommentContainer(container);
      if (comment && comment.body) {
        out.push(comment);
      }
    });
  }

  /**
   * レビュースレッド（コード上のインラインコメント）を抽出
   */
  function _extractReviewThreadComments(out) {
    const threads = document.querySelectorAll(
      '.js-resolvable-timeline-thread-container'
    );

    threads.forEach((thread) => {
      // ファイルパスを取得
      const filePathEl =
        thread.querySelector('.file-header [data-path]') ||
        thread.querySelector('.file-header .file-info a');
      const filePath = filePathEl
        ? filePathEl.getAttribute('data-path') || filePathEl.textContent.trim()
        : '';

      // スレッド内の各コメント
      const commentEls = thread.querySelectorAll(
        '.review-comment, .timeline-comment'
      );
      commentEls.forEach((el) => {
        const comment = _parseCommentContainer(el);
        if (comment && comment.body) {
          if (filePath) comment.filePath = filePath;
          out.push(comment);
        }
      });
    });
  }

  /**
   * コメントコンテナから情報を抽出する
   */
  function _parseCommentContainer(container) {
    // 著者
    const authorEl =
      container.querySelector('.author') ||
      container.querySelector('[data-testid="author-link"]') ||
      container.querySelector('a[data-hovercard-type="user"]');
    const author = authorEl ? authorEl.textContent.trim() : '';

    // タイムスタンプ
    const timeEl = container.querySelector('relative-time');
    const timestamp = timeEl
      ? timeEl.getAttribute('datetime') || timeEl.textContent.trim()
      : '';

    // 本文
    const bodyEl =
      container.querySelector('.js-comment-body .markdown-body') ||
      container.querySelector('.comment-body .markdown-body') ||
      container.querySelector('.markdown-body');
    const body = MarkdownBuilder.htmlToMarkdown(bodyEl);

    // ファイルパス（インラインコメントの場合）
    const thread = container.closest('.js-resolvable-timeline-thread-container');
    const filePathEl = thread
      ?.querySelector('.file-header [data-path]');
    let filePath = filePathEl ? filePathEl.getAttribute('data-path') : undefined;

    // 新 UI: summary 内の a タグからファイルパスを取得
    if (!filePath && thread) {
      const summaryLink = thread.querySelector('summary a');
      if (summaryLink) filePath = summaryLink.textContent.trim();
    }

    // diff コンテキスト（行番号・ソースコード）
    const diffContext = thread ? _extractDiffContext(thread) : undefined;

    return { author, body, filePath, timestamp, diffContext };
  }

  /**
   * レビュースレッドから diff コンテキスト（変更行・ソースコード）を抽出する
   * @param {Element} thread - .js-resolvable-timeline-thread-container
   * @returns {{ lineRange: string, diffLines: Array<{prefix: string, lineNum: string, code: string}> }|undefined}
   */
  function _extractDiffContext(thread) {
    // スレッドの展開部分（summary の次の div）
    const contentDiv = thread.children[1];
    if (!contentDiv) return undefined;

    // "Comment on lines +XX to +YY" テキスト
    const lineHeaderEl = contentDiv.querySelector('.f6.py-2');
    let lineRange = '';
    if (lineHeaderEl) {
      lineRange = lineHeaderEl.textContent.trim().replace(/\s+/g, ' ');
    }

    // diff テーブル
    const table = contentDiv.querySelector('.blob-wrapper table');
    if (!table) return undefined;

    const diffLines = [];
    table.querySelectorAll('tr').forEach((row) => {
      const blobNums = row.querySelectorAll('td.blob-num');
      const codeCell = row.querySelector('td.blob-code');
      if (!codeCell) return;

      const oldNum = blobNums[0] ? blobNums[0].getAttribute('data-line-number') || '' : '';
      const newNum = blobNums[1] ? blobNums[1].getAttribute('data-line-number') || '' : '';
      const isAddition = codeCell.classList.contains('blob-code-addition');
      const isDeletion = codeCell.classList.contains('blob-code-deletion');
      const prefix = isAddition ? '+' : isDeletion ? '-' : ' ';
      const lineNum = newNum || oldNum;
      // blob-code-inner からコードテキストを取得（余分な空白を回避）
      const innerEl = codeCell.querySelector('.blob-code-inner');
      const code = (innerEl || codeCell).textContent.trim();

      diffLines.push({ prefix, lineNum, code });
    });

    if (diffLines.length === 0) return undefined;
    return { lineRange, diffLines };
  }

  /**
   * PR 本文のコメントかどうかを判定
   */
  function _isPRBodyComment(container) {
    return !!(
      container.querySelector('#issue-body') ||
      container.querySelector('.js-issue-body') ||
      container.querySelector('.react-issue-body') ||
      container.closest('.js-discussion')?.querySelector('.js-issue-body') ||
      // 新 UI (2025〜): PR 本文コメントは id="pullrequest-*"
      (container.id && container.id.startsWith('pullrequest-'))
    );
  }

  /**
   * 重複コメントを除去する
   */
  function _deduplicateComments(comments) {
    const seen = new Set();
    return comments.filter((c) => {
      const key = `${c.author}::${c.body.substring(0, 100)}`;
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
    return _parseCommentContainer(container);
  }

  /**
   * 全データを取得して Markdown を生成する
   * @returns {string}
   */
  function extractAll() {
    const title = `${getTitle()} ${getPRNumber()}`;
    const body = getBody();

    // PR 本文の著者・日時を取得
    const prBodyContainer =
      document.querySelector('[id^="pullrequest-"]') ||
      document.querySelector('.js-issue-body')?.closest('.timeline-comment');
    const bodyMeta = prBodyContainer ? _parseCommentContainer(prBodyContainer) : {};

    const comments = getComments();
    return MarkdownBuilder.buildFullMarkdown({
      title,
      body,
      bodyAuthor: bodyMeta.author,
      bodyTimestamp: bodyMeta.timestamp,
      comments,
    });
  }

  return { getTitle, getPRNumber, getBody, getComments, extractAll, extractSingleComment };
})();
