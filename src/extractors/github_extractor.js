/**
 * GitHub プルリクエスト データ抽出モジュール
 */
var GitHubExtractor = GitHubExtractor || (() => {
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

    // React ベースの新 UI（PR 専用 testid → issue 汎用 testid の順でフォールバック）
    const reactTitle =
      document.querySelector('[data-testid="pull-request-title"]') ||
      document.querySelector('[data-testid="issue-title"]');
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
      const cleaned = text.replace(/\s*#\d+\s*$/, '').trim();
      if (cleaned) return cleaned;
    }

    // document.title から取得
    // 形式: "タイトル by 著者 · Pull Request #123 · owner/repo"
    // または "タイトル · Pull Request #123 · owner/repo"
    const pageTitle = document.title;
    const ptMatch = pageTitle.match(/^(.+?)\s+by\s+/) ||
                    pageTitle.match(/^(.+?)\s*·/);
    if (ptMatch) {
      const extracted = ptMatch[1].trim();
      if (extracted) return extracted;
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
   * 全レビューコメントをスレッド単位で取得する
   * タイムラインコメントは1件=1スレッド、レビュースレッドは返信をまとめて1スレッド
   * @returns {Array<Array<{author:string, body:string, filePath?:string, timestamp?:string}>>}
   */
  function getComments() {
    const threads = [];

    // ── Conversation タブのタイムラインコメント（各コメントを1件のスレッドとして格納）──
    const timelineComments = [];
    _extractTimelineComments(timelineComments);
    timelineComments.forEach((c) => threads.push([c]));

    // ── レビュースレッド（インラインコメント）をスレッド単位で取得 ──
    _extractReviewThreadsGrouped(threads);

    // 重複除去（スレッド単位）
    return _deduplicateThreads(threads);
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
   * レビュースレッド（コード上のインラインコメント）をスレッド単位で抽出
   * 各 DOM スレッドコンテナ内のコメントを1つの配列にまとめ、out に追加する
   * @param {Array<Array>} out - スレッドの配列（各要素はコメントの配列）
   */
  function _extractReviewThreadsGrouped(out) {
    const threadEls = document.querySelectorAll(
      '.js-resolvable-timeline-thread-container'
    );

    threadEls.forEach((threadEl) => {
      // ファイルパスを取得
      const filePathEl =
        threadEl.querySelector('.file-header [data-path]') ||
        threadEl.querySelector('.file-header .file-info a');
      const filePath = filePathEl
        ? filePathEl.getAttribute('data-path') || filePathEl.textContent.trim()
        : '';

      // スレッド内の各コメントをグループ化
      const threadComments = [];
      const commentEls = threadEl.querySelectorAll(
        '.review-comment, .timeline-comment'
      );
      commentEls.forEach((el) => {
        const comment = _parseCommentContainer(el);
        if (comment) {
          // _parseCommentContainer でファイルパスが取れなかった場合、スレッドレベルのパスで補完
          if (!comment.filePath && filePath) {
            comment.filePath = filePath;
          }
          threadComments.push(comment);
        }
      });

      // コメントが1件以上あるスレッドのみ追加
      if (threadComments.length > 0) {
        out.push(threadComments);
      }
    });
  }

  /**
   * コメントコンテナから情報を抽出する
   * @returns {{ author: string, body: string, filePath?: string, timestamp?: string, diffContext?: object }|null}
   */
  function _parseCommentContainer(container) {
    // 著者: 取得できない場合は "(unknown)" をフォールバックとして使用
    const authorEl =
      container.querySelector('.author') ||
      container.querySelector('[data-testid="author-link"]') ||
      container.querySelector('a[data-hovercard-type="user"]');
    const author = (authorEl ? authorEl.textContent.trim() : '') || '(unknown)';

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
    const body = bodyEl ? MarkdownBuilder.htmlToMarkdown(bodyEl) : '';

    // 本文が空の場合は null を返し、呼び出し元でスキップさせる
    if (!body) return null;

    // ファイルパス（インラインコメントの場合）
    const thread = container.closest('.js-resolvable-timeline-thread-container');
    const filePathEl = thread?.querySelector('.file-header [data-path]');
    let filePath = filePathEl
      ? filePathEl.getAttribute('data-path') || ''
      : '';

    // 新 UI: summary 内の a タグからファイルパスを取得
    if (!filePath && thread) {
      const summaryLink = thread.querySelector('summary a');
      if (summaryLink) filePath = summaryLink.textContent.trim();
    }

    // diff コンテキスト（行番号・ソースコード）
    const diffContext = thread ? _extractDiffContext(thread) : undefined;

    // filePath が空文字の場合はプロパティ自体を含めない（undefined 漏れ防止）
    const result = { author, body, timestamp, diffContext };
    if (filePath) result.filePath = filePath;
    return result;
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
   * 注意: closest('.js-discussion') による祖先チェックは、同一 discussion 内の
   * 全コメントを PR 本文と誤判定するリスクがあるため、container 自身の直接判定のみ行う
   */
  function _isPRBodyComment(container) {
    // container 自身が PR 本文を含むかどうかを直接チェック
    if (
      container.querySelector('#issue-body') ||
      container.querySelector('.js-issue-body') ||
      container.querySelector('.react-issue-body')
    ) {
      return true;
    }

    // 新 UI (2025〜): PR 本文コメントは id="pullrequest-*"
    // id プロパティは空文字の場合があるため安全にチェック
    if (typeof container.id === 'string' && container.id.startsWith('pullrequest-')) {
      return true;
    }

    return false;
  }

  /**
   * 重複スレッドを除去する
   * スレッドの先頭コメント（author + body 全文 + filePath）でユニーク判定。
   * 100文字切り捨てだと、先頭が同じ長文コメントが誤って除去されるため全文を使用する。
   */
  function _deduplicateThreads(threads) {
    const seen = new Set();
    return threads.filter((thread) => {
      if (!thread || thread.length === 0) return false;
      const c = thread[0];
      const key = `${c.author}::${c.filePath || ''}::${c.body}`;
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
    // _parseCommentContainer は本文が空の場合 null を返すため、null 合体で安全にフォールバック
    const bodyMeta = (prBodyContainer ? _parseCommentContainer(prBodyContainer) : null) || {};

    const threads = getComments();
    return MarkdownBuilder.buildFullMarkdown({
      title,
      body,
      bodyAuthor: bodyMeta.author || '',
      bodyTimestamp: bodyMeta.timestamp || '',
      threads,
    });
  }

  /**
   * 任意の PR URL から HTML を取得し、DOMParser でパースして Markdown を返す。
   * PR 一覧ページから個別 PR をダウンロードする際に使用。
   * @param {string} prUrl - PR 詳細ページの URL
   * @returns {Promise<{title: string, markdown: string}>}
   */
  async function extractByPrUrl(prUrl) {
    const res = await fetch(prUrl, { credentials: 'include' });
    if (!res.ok) throw new Error(`GitHub PR fetch failed: HTTP ${res.status}`);
    const html = await res.text();

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // タイトル抽出（DOM セレクタを流用、document → doc に差し替え）
    const title = _extractTitleFromDoc(doc);
    const prNum = (prUrl.match(/\/pull\/(\d+)/) || [])[1] || '';

    // 本文抽出
    const bodyEl =
      doc.querySelector('.js-issue-body .markdown-body') ||
      doc.querySelector('.react-issue-body .markdown-body') ||
      doc.querySelector('[data-testid="issue-body"] .markdown-body');
    let body = '';
    if (bodyEl) {
      // DOMParser で取得した要素のリンク href は相対パスのまま残るが、
      // MarkdownBuilder.htmlToMarkdown はベース URL 無しで変換するため問題ない
      body = MarkdownBuilder.htmlToMarkdown(bodyEl);
    } else {
      const prBodyComment = doc.querySelector('[id^="pullrequest-"]');
      if (prBodyComment) {
        const mdBody =
          prBodyComment.querySelector('.js-comment-body .markdown-body') ||
          prBodyComment.querySelector('.comment-body .markdown-body') ||
          prBodyComment.querySelector('.markdown-body');
        if (mdBody) body = MarkdownBuilder.htmlToMarkdown(mdBody);
      }
    }

    // コメント抽出（パース済みドキュメントから）
    const threads = _extractCommentsFromDoc(doc);

    const fullTitle = prNum ? `${title} #${prNum}` : title;
    const markdown = MarkdownBuilder.buildFullMarkdown({
      title: fullTitle.trim(),
      body,
      threads,
    });

    return { title, markdown };
  }

  /** パース済み Document からタイトルを取得 */
  function _extractTitleFromDoc(doc) {
    const selectors = [
      'h1[class*="PageHeader-Title"] span.markdown-title',
      '[data-testid="pull-request-title"]',
      '[data-testid="issue-title"]',
      'h1 bdi.markdown-title',
      '.gh-header-title .js-issue-title',
    ];
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      if (el) return el.textContent.trim();
    }
    const h1 = doc.querySelector('.gh-header-title');
    if (h1) return h1.textContent.trim().replace(/\s*#\d+\s*$/, '').trim();
    return 'Pull Request';
  }

  /** パース済み Document からコメントスレッドを抽出 */
  function _extractCommentsFromDoc(doc) {
    const threads = [];

    // タイムラインコメント
    const containers = doc.querySelectorAll(
      '.timeline-comment, .react-issue-comment'
    );
    containers.forEach((container) => {
      if (_isPRBodyComment(container)) return;
      const comment = _parseCommentContainer(container);
      if (comment && comment.body) {
        threads.push([comment]);
      }
    });

    // レビュースレッド
    const threadEls = doc.querySelectorAll(
      '.js-resolvable-timeline-thread-container'
    );
    threadEls.forEach((threadEl) => {
      const filePathEl =
        threadEl.querySelector('.file-header [data-path]') ||
        threadEl.querySelector('.file-header .file-info a');
      const filePath = filePathEl
        ? filePathEl.getAttribute('data-path') || filePathEl.textContent.trim()
        : '';
      const threadComments = [];
      const commentEls = threadEl.querySelectorAll(
        '.review-comment, .timeline-comment'
      );
      commentEls.forEach((el) => {
        const comment = _parseCommentContainer(el);
        if (comment) {
          if (!comment.filePath && filePath) comment.filePath = filePath;
          threadComments.push(comment);
        }
      });
      if (threadComments.length > 0) threads.push(threadComments);
    });

    return _deduplicateThreads(threads);
  }

  return { getTitle, getPRNumber, getBody, getComments, extractAll, extractSingleComment, isPRBodyComment: _isPRBodyComment, extractByPrUrl };
})();
