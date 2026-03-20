/**
 * GitHub プルリクエスト データ抽出モジュール
 */
var GitHubExtractor = GitHubExtractor || (() => {
  /**
   * PR タイトルを取得する
   * @param {Document|Element} [root=document] - 検索対象のルート要素
   * @returns {string}
   */
  function getTitle(root) {
    const r = root || document;

    // セレクタ候補を順に試行
    const selectors = [
      'h1[class*="PageHeader-Title"] span.markdown-title',
      '[data-testid="pull-request-title"]',
      '[data-testid="issue-title"]',
      'h1 bdi.markdown-title',
      '.gh-header-title .js-issue-title',
    ];
    for (const sel of selectors) {
      const el = r.querySelector(sel);
      if (el) return el.textContent.trim();
    }

    // 最終フォールバック: h1 からタイトルテキストだけを取得
    const h1 = r.querySelector('.gh-header-title');
    if (h1) {
      const text = h1.textContent.trim();
      const cleaned = text.replace(/\s*#\d+\s*$/, '').trim();
      if (cleaned) return cleaned;
    }

    // document.title から取得（ライブ DOM のみ）
    if (!root || root === document) {
      const pageTitle = document.title;
      const ptMatch = pageTitle.match(/^(.+?)\s+by\s+/) ||
                      pageTitle.match(/^(.+?)\s*·/);
      if (ptMatch) {
        const extracted = ptMatch[1].trim();
        if (extracted) return extracted;
      }
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
   * @param {Document|Element} [root=document] - 検索対象のルート要素
   * @returns {string}
   */
  function getBody(root) {
    const r = root || document;
    // 旧 UI: 専用の PR 本文コンテナ
    const legacyBodyEl =
      r.querySelector('.js-issue-body .markdown-body') ||
      r.querySelector('.react-issue-body .markdown-body') ||
      r.querySelector('[data-testid="issue-body"] .markdown-body');
    if (legacyBodyEl) return MarkdownBuilder.htmlToMarkdown(legacyBodyEl);

    // 新 UI (2025〜): PR 本文は id="pullrequest-*" のコメント内にある
    const prBodyComment = r.querySelector('[id^="pullrequest-"]');
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
    return MarkdownBuilder.deduplicateThreads(threads);
  }

  /**
   * タイムラインコメント（一般コメント）を抽出
   * @param {Array} out - コメントの出力先配列
   * @param {Document|Element} [root=document] - 検索対象のルート要素
   */
  function _extractTimelineComments(out, root) {
    const r = root || document;
    const containers = r.querySelectorAll(
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
   * @param {Document|Element} [root=document] - 検索対象のルート要素
   */
  function _extractReviewThreadsGrouped(out, root) {
    const r = root || document;
    const threadEls = r.querySelectorAll(
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
   * 指定コメントコンテナから単一コメントデータを取得
   * @param {Element} container
   * @returns {{ author: string, body: string, filePath?: string, timestamp?: string }}
   */
  function extractSingleComment(container) {
    return _parseCommentContainer(container);
  }

  /**
   * GitHub PR ページの「N hidden items / Load more…」ボタンをクリックして
   * 折りたたまれた会話を展開する（ライブ DOM 専用）
   * @returns {Promise<void>}
   */
  async function _loadHiddenConversations() {
    const MAX_ROUNDS = 20; // 無限ループ防止
    const WAIT_MS = 1500;  // 各クリック後の待機時間

    for (let round = 0; round < MAX_ROUNDS; round++) {
      // GitHub の hidden items ボタンを検索
      // 旧 UI: ajax-pagination-btn、新 UI: turbo-frame 内ボタン
      const buttons = document.querySelectorAll([
        // Progressive disclosure (hidden conversations)
        '.ajax-pagination-btn',
        '.js-timeline-progressive-disclosure-waterfall button[type="submit"]',
        // Turbo frame 内の Load more ボタン
        'turbo-frame button[type="submit"]',
        // 汎用的な「Load more」ボタン（PR タイムライン内のみ）
        '.js-discussion button[data-disable-with]',
      ].join(', '));

      // クリック対象のボタンをフィルタリング（hidden items / Load more テキストを含むもののみ）
      const targets = Array.from(buttons).filter((btn) => {
        const text = btn.textContent.toLowerCase();
        return text.includes('hidden') || text.includes('load more');
      });

      if (targets.length === 0) break;

      console.log(`[ReviewForMD] ${targets.length} 個の "Load more" ボタンをクリックします (round ${round + 1})`);

      for (const btn of targets) {
        try {
          btn.click();
        } catch {
          // クリック失敗は無視（DOM 変更で要素が消える場合がある）
        }
      }

      // コンテンツが読み込まれるまで待機
      await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
    }
  }

  /**
   * 全データを取得して Markdown を生成する
   *
   * GitHub の PR ページでは、レビュースレッドの展開/折りたたみ状態がページロードごとに異なり、
   * ライブ DOM だけでは全てのインラインレビューコメントを取得できない場合がある。
   * そのため、DOM 抽出後に PR ページの HTML を fetch して DOMParser で再パースし、
   * 不足しているスレッドを補完する（DevOps の API フォールバックと同様のアプローチ）。
   * @returns {Promise<string>}
   */
  async function extractAll() {
    // 折りたたまれた会話を展開してから抽出
    await _loadHiddenConversations();
    const title = `${getTitle()} ${getPRNumber()}`;
    const body = getBody();

    // PR 本文の著者・日時を取得
    const prBodyContainer =
      document.querySelector('[id^="pullrequest-"]') ||
      document.querySelector('.js-issue-body')?.closest('.timeline-comment');
    // _parseCommentContainer は本文が空の場合 null を返すため、null 合体で安全にフォールバック
    const bodyMeta = (prBodyContainer ? _parseCommentContainer(prBodyContainer) : null) || {};

    const domThreads = getComments();

    // HTML fetch で DOM に表示されていないレビュースレッドを補完
    const fetchedThreads = await _fetchAndExtractComments();

    // DOM スレッドを優先し、fetch で追加取得したスレッドをマージして重複除去
    const threads = fetchedThreads.length > 0
      ? MarkdownBuilder.deduplicateThreads([...domThreads, ...fetchedThreads])
      : domThreads;

    if (fetchedThreads.length > 0) {
      const added = threads.length - domThreads.length;
      if (added > 0) {
        console.log(`[ReviewForMD] HTML fetch により ${added} 件のスレッドを補完しました`);
      }
    }

    return MarkdownBuilder.buildFullMarkdown({
      title,
      body,
      bodyAuthor: bodyMeta.author || '',
      bodyTimestamp: bodyMeta.timestamp || '',
      threads,
    });
  }

  /**
   * 現在の PR ページを fetch して DOMParser でパースし、コメントスレッドを抽出する。
   * ライブ DOM で取得できなかったレビュースレッド（折りたたみ・未ロード状態）を補完するために使用。
   * DevOps の fetchViaApi() に相当する HTML ベースのフォールバック。
   * @returns {Promise<Array<Array>>} スレッド配列（失敗時は空配列）
   */
  async function _fetchAndExtractComments() {
    try {
      const prUrl = location.origin + location.pathname;
      const res = await fetch(prUrl, { credentials: 'include' });
      if (!res.ok) {
        console.warn(`[ReviewForMD] HTML fetch 失敗: HTTP ${res.status}`);
        return [];
      }
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');

      // hidden conversations（turbo-frame）の追加読み込み
      await _fetchHiddenConversations(doc, prUrl);

      return _extractCommentsFromDoc(doc);
    } catch (e) {
      console.warn('[ReviewForMD] HTML fetch による補完取得に失敗:', e);
      return [];
    }
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

    // hidden conversations（turbo-frame）の追加読み込み
    await _fetchHiddenConversations(doc, prUrl);

    // タイトル抽出（getTitle に DOMParser 生成 doc を渡して共通処理）
    const title = getTitle(doc) || 'Pull Request';
    const prNum = (prUrl.match(/\/pull\/(\d+)/) || [])[1] || '';

    // 本文抽出（getBody に DOMParser 生成 doc を渡して共通処理）
    const body = getBody(doc);

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

  /**
   * DOMParser でパースした doc 内の turbo-frame / pagination リンクを
   * 追加 fetch して hidden conversations を doc に挿入する
   * @param {Document} doc - パース済みドキュメント
   * @param {string} baseUrl - 元の PR URL（相対 URL 解決用）
   */
  async function _fetchHiddenConversations(doc, baseUrl) {
    const MAX_ROUNDS = 20;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      // turbo-frame の src 属性、または pagination form の action 属性から URL を収集
      const frameSrcs = [];

      // turbo-frame[src] — GitHub がまだ読み込んでいない hidden items
      doc.querySelectorAll('turbo-frame[src]').forEach((frame) => {
        const src = frame.getAttribute('src');
        if (src) frameSrcs.push({ url: src, el: frame });
      });

      // ajax-pagination-btn の form の action
      // ※ el は form 自体を指す（親要素にすると兄弟のスレッドコンテナまで削除してしまう）
      doc.querySelectorAll('.ajax-pagination-btn').forEach((btn) => {
        const form = btn.closest('form');
        const action = form ? form.getAttribute('action') : null;
        if (action) frameSrcs.push({ url: action, el: form });
      });

      if (frameSrcs.length === 0) break;

      console.log(`[ReviewForMD] fetch: ${frameSrcs.length} 個の hidden conversations を取得 (round ${round + 1})`);

      // 各 frame/pagination を並列 fetch して高速化
      const results = await Promise.all(
        frameSrcs.map(async ({ url, el }) => {
          try {
            const absUrl = new URL(url, baseUrl).href;
            const resp = await fetch(absUrl, { credentials: 'include' });
            if (!resp.ok) return null;
            const fragmentHtml = await resp.text();
            return { el, fragmentHtml };
          } catch {
            return null;
          }
        })
      );

      // 取得した HTML フラグメントを元の doc に挿入
      for (const r of results) {
        if (!r) continue;
        const fragmentDoc = new DOMParser().parseFromString(r.fragmentHtml, 'text/html');
        const content = fragmentDoc.body;
        if (content) {
          while (content.firstChild) {
            r.el.parentNode.insertBefore(
              doc.importNode(content.firstChild, true),
              r.el
            );
            content.removeChild(content.firstChild);
          }
          r.el.remove();
        }
      }
    }
  }

  /**
   * パース済み Document からコメントスレッドを抽出
   * _extractTimelineComments / _extractReviewThreadsGrouped を root パラメータで共通化
   */
  function _extractCommentsFromDoc(doc) {
    const threads = [];
    const timelineComments = [];
    _extractTimelineComments(timelineComments, doc);
    timelineComments.forEach((c) => threads.push([c]));
    _extractReviewThreadsGrouped(threads, doc);
    return MarkdownBuilder.deduplicateThreads(threads);
  }

  return { getTitle, getPRNumber, getBody, getComments, extractAll, extractSingleComment, isPRBodyComment: _isPRBodyComment, extractByPrUrl };
})();
