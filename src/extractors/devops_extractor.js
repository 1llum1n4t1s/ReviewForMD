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
    // 処理済み要素の Set を受け取り、Inline 抽出で二重取得を防ぐ
    const processedEls = _extractActivityComments(threads);

    // Files タブのインラインコメント
    // Activity で既に取得したスレッド DOM 要素を除外して二重取得を防ぐ
    _extractInlineComments(threads, processedEls);

    return _deduplicateThreads(threads);
  }

  /**
   * Activity タブのディスカッションコメントをスレッド単位で抽出
   * @param {Array<Array>} out - スレッドの配列（各要素はコメントの配列）
   * @returns {Set<Element>} 処理済みスレッド要素の集合（二重取得防止用）
   */
  function _extractActivityComments(out) {
    const processedEls = new Set();

    // .repos-discussion-thread を1スレッドとして扱う
    const threadEls = document.querySelectorAll('.repos-discussion-thread');
    if (threadEls.length > 0) {
      threadEls.forEach((threadEl) => {
        processedEls.add(threadEl);
        const threadComments = [];
        const commentEls = threadEl.querySelectorAll(
          '.repos-discussion-comment, .vc-discussion-thread-comment'
        );
        commentEls.forEach((el) => {
          const comment = _parseDevOpsComment(el);
          if (comment) threadComments.push(comment);
        });
        if (threadComments.length > 0) out.push(threadComments);
      });
      return processedEls;
    }

    // フォールバック: discussion-thread / comment-thread を1スレッドとして扱う
    const legacyThreads = document.querySelectorAll('.discussion-thread, .comment-thread');
    legacyThreads.forEach((thread) => {
      processedEls.add(thread);
      const threadComments = [];
      const commentEls = thread.querySelectorAll('.comment-content');
      if (commentEls.length === 0) {
        const comment = _parseDevOpsComment(thread);
        if (comment) threadComments.push(comment);
      } else {
        commentEls.forEach((el) => {
          const comment = _parseDevOpsComment(el);
          if (comment) threadComments.push(comment);
        });
      }
      if (threadComments.length > 0) out.push(threadComments);
    });

    return processedEls;
  }

  /**
   * ファイル差分上のインラインコメントをスレッド単位で抽出
   * @param {Array<Array>} out - スレッドの配列（各要素はコメントの配列）
   * @param {Set<Element>} processedEls - Activity で処理済みのスレッド要素（二重取得防止用）
   */
  function _extractInlineComments(out, processedEls) {
    const inlineThreads = document.querySelectorAll('.repos-discussion-thread');

    inlineThreads.forEach((thread) => {
      // Activity タブで既に処理済みのスレッドはスキップ
      if (processedEls && processedEls.has(thread)) return;
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
      const rawApiThreads = []; // Items API 補完用に生スレッドデータを保持

      // threads.value が配列でない場合（API レスポンス異常）を安全にスキップ
      const threadValues = threads?.value;
      if (Array.isArray(threadValues)) {
        threadValues.forEach((thread) => {
          if (!Array.isArray(thread.comments)) return;
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
            // c.content が null/undefined の場合（削除済みコメント等）はスキップ
            const body = c.content ?? '';
            if (!body) return;
            const comment = {
              author: c.author?.displayName || '',
              body,
              filePath: tc?.filePath || undefined,
              timestamp: c.publishedDate || '',
            };
            // 行範囲はスレッドの最初のユーザーコメントにのみ付与
            if (threadComments.length === 0 && lineRange) {
              comment.diffContext = { lineRange, diffLines: [] };
            }
            threadComments.push(comment);
          });
          if (threadComments.length > 0) {
            apiThreads.push(threadComments);
            rawApiThreads.push(thread); // apiThreads と同期
          }
        });
      }

      return { title, body, threads: apiThreads, rawApiThreads, urlInfo };
    } catch (e) {
      console.warn('[ReviewForMD] API fetch failed:', e);
      return null;
    }
  }

  /**
   * DevOps の URL をパースして API ベース URL、リポジトリ名、PR ID を返す。
   * 貪欲マッチ (.*) を使い、最後の /_git/ の直前までをベースURLとする。
   * 例: /org/collection/project/_git/repo/pullrequest/123
   *   → baseUrl=/org/collection/project, repo=repo, prId=123
   * パスに /_git/ が複数含まれる場合でも最後のものを使用するため意図通り動作する。
   */
  function _parseDevOpsUrl() {
    const path = location.pathname;
    // 貪欲マッチで最後の /_git/ の直前まで取得する
    const match = path.match(/^(.*)\/_git\/([^/]+)\/pullrequest\/(\d+)/);
    if (!match) return null;

    return {
      baseUrl: `${location.origin}${match[1]}`,
      repo: match[2],
      prId: match[3],
    };
  }

  async function _fetchJson(url) {
    // セキュリティ: credentials:'include' を同一オリジンのみに制限し、
    // 認証情報の意図しない外部送信を防止する
    const parsed = new URL(url, location.origin);
    if (parsed.origin !== location.origin) {
      throw new Error(`クロスオリジンリクエストは許可されていません: ${parsed.origin}`);
    }
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // JSON パース失敗時にも呼び出し元の catch で捕捉できるよう await する
    return await res.json();
  }

  /**
   * テキスト（非JSON）を同一オリジンから安全に取得するヘルパー
   * @param {string} url
   * @returns {Promise<string|null>} テキスト内容。失敗時は null
   */
  async function _fetchText(url) {
    const parsed = new URL(url, location.origin);
    if (parsed.origin !== location.origin) return null;
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  }

  /* ── Items API による差分コード補完 ────────────── */

  /**
   * PR のイテレーション一覧を取得し、iterationId → commitId のマップを返す
   * @param {{ baseUrl: string, repo: string, prId: string }} urlInfo
   * @returns {Promise<Map<number, string>>} iterationId → commitId
   */
  async function _fetchIterations(urlInfo) {
    const data = await _fetchJson(
      `${urlInfo.baseUrl}/_apis/git/repositories/${urlInfo.repo}/pullRequests/${urlInfo.prId}/iterations?api-version=7.1`
    );
    const map = new Map();
    if (Array.isArray(data?.value)) {
      data.value.forEach((iter) => {
        if (iter.id && iter.sourceRefCommit?.commitId) {
          map.set(iter.id, iter.sourceRefCommit.commitId);
        }
      });
    }
    return map;
  }

  /**
   * 指定コミット時点のファイル内容を取得する
   * @param {{ baseUrl: string, repo: string }} urlInfo
   * @param {string} filePath - ファイルパス（/CooKai/... 形式）
   * @param {string} commitId - コミット SHA
   * @returns {Promise<string|null>} ファイル内容テキスト。404（削除/移動済み）は null
   */
  async function _fetchFileContent(urlInfo, filePath, commitId) {
    // path パラメータはパス区切り (/) を含むためそのまま渡す（encodeURIComponent 不可）
    const url = `${urlInfo.baseUrl}/_apis/git/repositories/${urlInfo.repo}/items`
      + `?path=${encodeURI(filePath)}&version=${commitId}&versionType=commit&api-version=7.1`;
    return _fetchText(url);
  }

  /**
   * ファイル内容から対象行の前後を含むコードスニペットを抽出する
   * @param {string} fileContent - ファイル全文テキスト
   * @param {number} startLine - 開始行番号（1-based）
   * @param {number} endLine - 終了行番号（1-based）
   * @param {number} [contextLines=3] - 前後に含めるコンテキスト行数
   * @returns {Array<{prefix: string, lineNum: string, code: string}>}
   */
  function _extractLinesAroundTarget(fileContent, startLine, endLine, contextLines = 3) {
    const lines = fileContent.split('\n');
    const from = Math.max(0, startLine - 1 - contextLines);
    const to = Math.min(lines.length, endLine + contextLines);
    const result = [];
    for (let i = from; i < to; i++) {
      result.push({
        prefix: ' ',
        lineNum: String(i + 1),
        code: lines[i],
      });
    }
    return result;
  }

  /**
   * Items API を使って API スレッドに差分コード（ファイル内容スニペット）を補完する
   *
   * _enrichWithDomContext で既に diffLines が設定済みのスレッドはスキップし、
   * 残りのスレッドについて iterations API → items API でファイル内容を取得する。
   * ファイルパス+コミットIDで重複排除し、並列フェッチする。
   *
   * @param {Array<Array>} apiThreads - 処理済みスレッド配列
   * @param {Array} rawApiThreads - API 生スレッドデータ（threadContext 等を持つ）
   * @param {{ baseUrl: string, repo: string, prId: string }} urlInfo
   */
  async function _enrichWithItemsApi(apiThreads, rawApiThreads, urlInfo) {
    // 1. イテレーション一覧を取得
    let iterationMap;
    try {
      iterationMap = await _fetchIterations(urlInfo);
    } catch {
      console.warn('[ReviewForMD] イテレーション取得失敗、Items API 補完をスキップ');
      return;
    }
    if (iterationMap.size === 0) return;

    // 2. フェッチ対象を収集（filePath + commitId で重複排除）
    const fetchTasks = new Map(); // "filePath\0commitId" → { filePath, commitId, entries: [{idx, rawThread}] }

    apiThreads.forEach((thread, idx) => {
      if (!thread || thread.length === 0) return;
      const first = thread[0];
      // DOM 補完で既に diffLines 取得済み → スキップ
      if (first.diffContext?.diffLines?.length > 0) return;
      // ファイルパスなし（全体コメント等）→ スキップ
      if (!first.filePath) return;

      const rawThread = rawApiThreads[idx];
      if (!rawThread) return;
      const iterCtx = rawThread.pullRequestThreadContext?.iterationContext;
      const iterationId = iterCtx?.secondComparingIteration;
      if (!iterationId) return;

      const commitId = iterationMap.get(iterationId);
      if (!commitId) return;

      const key = `${first.filePath}\0${commitId}`;
      if (!fetchTasks.has(key)) {
        fetchTasks.set(key, { filePath: first.filePath, commitId, entries: [] });
      }
      fetchTasks.get(key).entries.push({ idx, rawThread });
    });

    if (fetchTasks.size === 0) return;

    // 3. ファイル内容を並列取得（同時6件ずつ）
    const CONCURRENCY = 6;
    const tasks = Array.from(fetchTasks.values());
    const fileContents = new Map(); // key → content|null

    for (let i = 0; i < tasks.length; i += CONCURRENCY) {
      const batch = tasks.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (task) => {
          const content = await _fetchFileContent(urlInfo, task.filePath, task.commitId);
          return { key: `${task.filePath}\0${task.commitId}`, content };
        })
      );
      results.forEach(({ key, content }) => fileContents.set(key, content));
    }

    // 4. 各スレッドに diffLines を設定
    for (const [key, task] of fetchTasks) {
      const content = fileContents.get(key);
      if (!content) continue; // ファイル削除/移動 → lineRange のみ保持

      task.entries.forEach(({ idx, rawThread }) => {
        const thread = apiThreads[idx];
        const first = thread[0];
        const tc = rawThread.threadContext;
        if (!tc) return;

        const startLine = tc.rightFileStart?.line || tc.leftFileStart?.line;
        const endLine = tc.rightFileEnd?.line || tc.leftFileEnd?.line || startLine;
        if (!startLine) return;

        const diffLines = _extractLinesAroundTarget(content, startLine, endLine);
        if (diffLines.length === 0) return;

        if (!first.diffContext) {
          let lineRange = '';
          if (startLine && endLine && startLine !== endLine) {
            lineRange = `行 ${startLine}-${endLine}`;
          } else if (startLine) {
            lineRange = `行 ${startLine}`;
          }
          first.diffContext = { lineRange, diffLines };
        } else {
          first.diffContext.diffLines = diffLines;
        }
      });
    }
  }

  /**
   * comment-file-header 内の diff コンテキスト（行番号・ソースコード）を抽出する
   *
   * DevOps では "View original diff" / "View latest diff" の切り替えにより
   * SPAN[0] の .screen-reader-only テキストが変化する：
   *   - latest diff 表示時: "Commented 15 16" / "12 13" （旧行番号 新行番号）
   *   - original diff 表示時: "Commented 15" / "13" （旧行番号のみ）
   * 常に旧行番号（= コメントが付いた時点での行番号）を使うため、
   * テキスト内の最初の数値トークンだけを取り出す。
   * SPAN[1] は常に空なので使用しない。
   *
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

      // SPAN[0] の .screen-reader-only から旧行番号（最初の数値トークン）を取得
      // latest diff時: "Commented 15 16" / "12 13" → 最初の数値 = 旧行番号
      // original diff時: "Commented 15" / "13" → 最初の数値 = 旧行番号
      const srEl = spans[0].querySelector('.screen-reader-only');
      const srText = srEl ? srEl.textContent.trim() : '';
      const numTokens = srText.match(/\d+/g) || [];
      const lineNum = numTokens[0] || '';

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
   * 重複スレッドを除去する
   * スレッドの先頭コメント（author + body 全文 + filePath）でユニーク判定。
   * 100文字切り捨てだと、先頭が同じ長文コメントが誤って除去されるため全文を使用する。
   * @param {Array<Array>} threads
   * @returns {Array<Array>}
   */
  function _deduplicateThreads(threads) {
    const seen = new Set();
    return threads.filter((thread) => {
      if (!thread || thread.length === 0) return false;
      const first = thread[0];
      const key = `${first.author}::${first.filePath || ''}::${first.body || ''}`;
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
      // spinner（未ロード）はスキップ: ヘッダーがなければ完全に未ロード
      // ヘッダーがあっても本文が空なら _parseDevOpsComment で body が空になり除外される
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
   * API スレッドに DOM の diffContext（差分コード）を補完する
   *
   * API レスポンスには差分コードが含まれないため（lineRange のみ）、
   * DOM から取得した diffContext で補完する。
   * 同一ファイルに複数スレッドがある場合を考慮し、
   * filePath + lineRange の複合キーで対応する DOM スレッドを特定する。
   *
   * @param {Array<Array>} apiThreads - API から取得したスレッド配列
   */
  function _enrichWithDomContext(apiThreads) {
    const domThreadEls = document.querySelectorAll('.repos-discussion-thread');
    if (domThreadEls.length === 0) return;

    // DOM スレッドから複合キー(filePath + lineRange) → diffContext のマップを構築
    const compositeMap = new Map();  // "filePath\0lineRange" → diffContext
    const fileOnlyMap = new Map();   // filePath → diffContext（フォールバック用）
    domThreadEls.forEach((threadEl) => {
      const prevSibling = threadEl.previousElementSibling;
      if (!prevSibling || !prevSibling.classList.contains('comment-file-header')) return;

      const linkEl = prevSibling.querySelector('.comment-file-header-link');
      const pathEl = prevSibling.querySelector('.secondary-text');
      const filePath = (linkEl || pathEl)?.textContent.trim();
      if (!filePath) return;

      const diffContext = _extractDiffContext(prevSibling);
      if (!diffContext) return;

      // 複合キー: filePath + lineRange で同一ファイル内の複数スレッドを区別
      const key = `${filePath}\0${diffContext.lineRange || ''}`;
      if (!compositeMap.has(key)) {
        compositeMap.set(key, diffContext);
      }
      // filePath のみのフォールバック（同一ファイル1スレッドの場合に使用）
      if (!fileOnlyMap.has(filePath)) {
        fileOnlyMap.set(filePath, diffContext);
      }
    });

    if (compositeMap.size === 0) return;

    // API スレッドの先頭コメントに diffContext を補完
    apiThreads.forEach((thread) => {
      if (!thread || thread.length === 0) return;
      const first = thread[0];
      // filePath がない（全体コメント）、または既に diffLines がある場合はスキップ
      if (!first.filePath || first.diffContext?.diffLines?.length > 0) return;

      // API 側の lineRange を使って複合キーで正確にマッチ
      const apiLineRange = first.diffContext?.lineRange || '';
      const key = `${first.filePath}\0${apiLineRange}`;
      const ctx = compositeMap.get(key) || fileOnlyMap.get(first.filePath);
      if (ctx) {
        first.diffContext = ctx;
      }
    });
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
      // fetchViaApi 内部で catch しているが、予期しないランタイムエラーに備え外側でも保護
      let apiData = null;
      try {
        apiData = await fetchViaApi();
      } catch (e) {
        console.warn('[ReviewForMD] extractAll: API取得で予期しないエラー:', e);
      }
      if (apiData) {
        // API タイトルを優先（DOM より確実）
        if (apiData.title) title = `${apiData.title} ${getPRNumber()}`;
        if (!body) body = apiData.body;
        // API から取得したコメントが DOM より多い場合のみ API を採用
        const apiCommentCount = apiData.threads.reduce((sum, t) => sum + t.length, 0);
        if (apiCommentCount > domCommentCount) {
          // API スレッドには diffLines が空のため、DOM から差分コードを補完
          _enrichWithDomContext(apiData.threads);
          // DOM で補完できなかった残りのスレッドを Items API で補完
          try {
            await _enrichWithItemsApi(apiData.threads, apiData.rawApiThreads, apiData.urlInfo);
          } catch (e) {
            console.warn('[ReviewForMD] Items API 補完で予期しないエラー:', e);
          }
          threads = apiData.threads;
        }
      }
    }

    // API タイトルが取れなかった場合は DOM タイトルにフォールバック
    if (!title) {
      const prNum = getPRNumber();
      title = domTitle ? `${domTitle} ${prNum}` : prNum || 'Pull Request';
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
