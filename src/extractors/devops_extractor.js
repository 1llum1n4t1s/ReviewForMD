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

        // ファイルパスと diff コンテキストを取得（インラインコメントの場合）
        let filePath = '';
        let diffContext;
        const prevSibling = threadEl.previousElementSibling;
        if (prevSibling && prevSibling.classList.contains('comment-file-header')) {
          const linkEl = prevSibling.querySelector('.comment-file-header-link');
          if (linkEl) filePath = linkEl.textContent.trim();
          if (!filePath) {
            const pathEl = prevSibling.querySelector('.secondary-text');
            if (pathEl) filePath = pathEl.textContent.trim();
          }
          diffContext = _extractDiffContext(prevSibling);
        }

        const threadComments = [];
        const commentEls = threadEl.querySelectorAll(
          '.repos-discussion-comment, .vc-discussion-thread-comment'
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
   * PR のイテレーション一覧を取得し、iterationId → { sourceCommitId, targetCommitId } のマップを返す
   * @param {{ baseUrl: string, repo: string, prId: string }} urlInfo
   * @returns {Promise<Map<number, { sourceCommitId: string, targetCommitId: string }>>}
   */
  async function _fetchIterations(urlInfo) {
    const data = await _fetchJson(
      `${urlInfo.baseUrl}/_apis/git/repositories/${urlInfo.repo}/pullRequests/${urlInfo.prId}/iterations?api-version=7.1`
    );
    const map = new Map();
    if (Array.isArray(data?.value)) {
      data.value.forEach((iter) => {
        if (iter.id && iter.sourceRefCommit?.commitId) {
          map.set(iter.id, {
            sourceCommitId: iter.sourceRefCommit.commitId,
            targetCommitId: iter.targetRefCommit?.commitId || iter.commonRefCommit?.commitId || '',
          });
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
   * FileDiffs API で行レベルの変更ブロック情報を取得する
   *
   * POST /_apis/git/repositories/{repo}/FileDiffs で
   * lineDiffBlocks（changeType + 行番号 + 行数）を取得する。
   * 行のテキスト内容は含まれないため、Items API と組み合わせて使用する。
   *
   * @param {{ baseUrl: string, repo: string }} urlInfo
   * @param {string} filePath - ファイルパス（/CooKai/... 形式）
   * @param {string} baseCommitId - ベースコミット SHA（target ブランチ側）
   * @param {string} targetCommitId - ターゲットコミット SHA（source ブランチ側）
   * @returns {Promise<Array<{changeType: number, originalLineNumberStart: number, originalLinesCount: number, modifiedLineNumberStart: number, modifiedLinesCount: number}>|null>}
   */
  async function _fetchFileDiffs(urlInfo, filePath, baseCommitId, targetCommitId) {
    const url = `${urlInfo.baseUrl}/_apis/git/repositories/${urlInfo.repo}/FileDiffs?api-version=7.2-preview.1`;
    const parsed = new URL(url, location.origin);
    if (parsed.origin !== location.origin) return null;
    try {
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseVersionCommit: baseCommitId,
          targetVersionCommit: targetCommitId,
          fileDiffParams: [{ path: filePath, originalPath: filePath }],
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      // レスポンスは FileDiff の配列（1ファイルのみリクエストしたので [0]）
      return data?.[0]?.lineDiffBlocks || null;
    } catch {
      return null;
    }
  }

  /**
   * ファイル内容から対象行の前後を含むコードスニペットを抽出する（フォールバック用）
   * FileDiffs API が使えない場合に使用。全行がコンテキスト行（prefix=' '）になる。
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
   * FileDiffs の lineDiffBlocks と両側のファイル内容から +/- 付き diff を生成する
   *
   * lineDiffBlocks の changeType:
   *   0 = None（変更なし）, 1 = Add（追加）, 2 = Delete（削除）, 3 = Edit（編集）
   *
   * コメント対象行（startLine〜endLine）の前後 contextLines 行を含む範囲で、
   * 変更ブロックに基づいて +/- prefix を付与する。
   *
   * @param {Array} lineDiffBlocks - FileDiffs API の lineDiffBlocks
   * @param {string} baseContent - ベース（target ブランチ）側のファイル内容
   * @param {string} modifiedContent - 変更（source ブランチ）側のファイル内容
   * @param {number} startLine - コメント対象の開始行番号（modified 側, 1-based）
   * @param {number} endLine - コメント対象の終了行番号（modified 側, 1-based）
   * @param {number} [contextLines=3] - 前後に含めるコンテキスト行数
   * @returns {Array<{prefix: string, lineNum: string, code: string}>}
   */
  function _buildDiffWithBlocks(lineDiffBlocks, baseContent, modifiedContent, startLine, endLine, contextLines = 3) {
    const baseLines = baseContent.split('\n');
    const modLines = modifiedContent.split('\n');

    // modified 側の行番号に対する変更種別マップを構築
    // modifiedLineMap[lineNum] = 'add' | 'edit-add'
    // baseLineMap[lineNum] = 'delete' | 'edit-delete'
    const modifiedLineMap = new Map(); // modified 側行番号(1-based) → 変更種別
    const baseLineMap = new Map();     // base 側行番号(1-based) → 変更種別
    // 各 modified 行が base のどの行の後に来るかの対応マップ（挿入位置の追跡用）
    // deletedBlocks: base 側の削除ブロック情報 [{baseStart, baseCount, afterModifiedLine}]
    const deletedBlocks = [];

    for (const block of lineDiffBlocks) {
      const ct = block.changeType;
      if (ct === 1) {
        // Add: modified 側にのみ存在する追加行
        for (let i = 0; i < block.modifiedLinesCount; i++) {
          modifiedLineMap.set(block.modifiedLineNumberStart + i, 'add');
        }
      } else if (ct === 2) {
        // Delete: base 側にのみ存在する削除行
        for (let i = 0; i < block.originalLinesCount; i++) {
          baseLineMap.set(block.originalLineNumberStart + i, 'delete');
        }
        // 削除ブロックの位置を記録（modified 側のどこに挿入するか）
        deletedBlocks.push({
          baseStart: block.originalLineNumberStart,
          baseCount: block.originalLinesCount,
          // modified 側の挿入位置: modifiedLineNumberStart の直前
          beforeModifiedLine: block.modifiedLineNumberStart,
        });
      } else if (ct === 3) {
        // Edit: base 側の行が削除され、modified 側の行が追加された
        for (let i = 0; i < block.originalLinesCount; i++) {
          baseLineMap.set(block.originalLineNumberStart + i, 'edit-delete');
        }
        for (let i = 0; i < block.modifiedLinesCount; i++) {
          modifiedLineMap.set(block.modifiedLineNumberStart + i, 'edit-add');
        }
        deletedBlocks.push({
          baseStart: block.originalLineNumberStart,
          baseCount: block.originalLinesCount,
          beforeModifiedLine: block.modifiedLineNumberStart,
        });
      }
    }

    // コメント対象範囲 + コンテキスト行の範囲を計算（modified 側基準）
    const from = Math.max(1, startLine - contextLines);
    const to = Math.min(modLines.length, endLine + contextLines);

    const result = [];

    for (let modLine = from; modLine <= to; modLine++) {
      // この行の直前に挿入すべき削除行があるか確認
      for (const db of deletedBlocks) {
        if (db.beforeModifiedLine === modLine && db.baseCount > 0) {
          // 削除行を出力（コンテキスト範囲内の場合のみ）
          for (let i = 0; i < db.baseCount; i++) {
            const baseLine = db.baseStart + i;
            result.push({
              prefix: '-',
              lineNum: String(baseLine),
              code: baseLines[baseLine - 1] ?? '',
            });
          }
          db.baseCount = 0; // 出力済みマーク
        }
      }

      const changeType = modifiedLineMap.get(modLine);
      if (changeType === 'add' || changeType === 'edit-add') {
        result.push({
          prefix: '+',
          lineNum: String(modLine),
          code: modLines[modLine - 1] ?? '',
        });
      } else {
        // 変更なしのコンテキスト行
        result.push({
          prefix: ' ',
          lineNum: String(modLine),
          code: modLines[modLine - 1] ?? '',
        });
      }
    }

    return result;
  }

  /**
   * FileDiffs API + Items API を使って API スレッドに +/- 付き差分コードを補完する
   *
   * _enrichWithDomContext で既に diffLines が設定済みのスレッドはスキップし、
   * 残りのスレッドについて:
   *   1. iterations API で sourceCommitId / targetCommitId を取得
   *   2. FileDiffs API で lineDiffBlocks（行レベル変更情報）を取得
   *   3. Items API で base / modified 両方のファイル内容を取得
   *   4. _buildDiffWithBlocks で +/- prefix 付き diff を生成
   * FileDiffs API が失敗した場合は _extractLinesAroundTarget（全行 prefix=' '）にフォールバック。
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

    // 2. フェッチ対象を収集（filePath + sourceCommitId + targetCommitId で重複排除）
    const fetchTasks = new Map(); // "filePath\0sourceCommitId" → { filePath, sourceCommitId, targetCommitId, entries }

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

      const iterInfo = iterationMap.get(iterationId);
      if (!iterInfo) return;

      // API の threadContext.filePath を使用（DOM の filePath は短縮形の場合がある）
      const apiFilePath = rawThread.threadContext?.filePath || first.filePath;
      const key = `${apiFilePath}\0${iterInfo.sourceCommitId}`;
      if (!fetchTasks.has(key)) {
        fetchTasks.set(key, {
          filePath: apiFilePath,
          sourceCommitId: iterInfo.sourceCommitId,
          targetCommitId: iterInfo.targetCommitId,
          entries: [],
        });
      }
      fetchTasks.get(key).entries.push({ idx, rawThread });
    });

    if (fetchTasks.size === 0) return;

    // 3. FileDiffs + Items API を並列取得（同時6件ずつ）
    const CONCURRENCY = 6;
    const tasks = Array.from(fetchTasks.values());
    // fetchResult: key → { modifiedContent, baseContent, lineDiffBlocks }
    const fetchResults = new Map();

    for (let i = 0; i < tasks.length; i += CONCURRENCY) {
      const batch = tasks.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (task) => {
          const key = `${task.filePath}\0${task.sourceCommitId}`;
          // modified 側（source ブランチ）のファイル内容を取得
          const modifiedContent = await _fetchFileContent(urlInfo, task.filePath, task.sourceCommitId);
          // base 側（target ブランチ）のファイル内容と FileDiffs を並列取得
          let baseContent = null;
          let lineDiffBlocks = null;
          if (modifiedContent && task.targetCommitId) {
            [baseContent, lineDiffBlocks] = await Promise.all([
              _fetchFileContent(urlInfo, task.filePath, task.targetCommitId),
              _fetchFileDiffs(urlInfo, task.filePath, task.targetCommitId, task.sourceCommitId),
            ]);
          }
          return { key, modifiedContent, baseContent, lineDiffBlocks };
        })
      );
      results.forEach((r) => fetchResults.set(r.key, r));
    }

    // 4. 各スレッドに diffLines を設定
    for (const [, task] of fetchTasks) {
      const key = `${task.filePath}\0${task.sourceCommitId}`;
      const result = fetchResults.get(key);
      if (!result?.modifiedContent) continue; // ファイル削除/移動 → lineRange のみ保持

      task.entries.forEach(({ idx, rawThread }) => {
        const thread = apiThreads[idx];
        const first = thread[0];
        const tc = rawThread.threadContext;
        if (!tc) return;

        const startLine = tc.rightFileStart?.line || tc.leftFileStart?.line;
        const endLine = tc.rightFileEnd?.line || tc.leftFileEnd?.line || startLine;
        if (!startLine) return;

        // FileDiffs + base 側が取得できていれば +/- 付き diff を生成
        let diffLines;
        if (result.lineDiffBlocks && result.baseContent) {
          diffLines = _buildDiffWithBlocks(
            result.lineDiffBlocks, result.baseContent, result.modifiedContent,
            startLine, endLine
          );
        } else {
          // フォールバック: 全行コンテキスト（prefix=' '）
          diffLines = _extractLinesAroundTarget(result.modifiedContent, startLine, endLine);
        }
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
      if (spans.length < 2) return;

      // 行番号: 最初の SPAN 内の .screen-reader-only テキストから数値を取得
      // latest diff時: "Commented 15 16" / "12 13" → 最初の数値 = 旧行番号
      // original diff時: "Commented 15" / "13" → 最初の数値 = 旧行番号
      const srEl = spans[0].querySelector('.screen-reader-only');
      const srText = srEl ? srEl.textContent.trim() : '';
      const numTokens = srText.match(/\d+/g) || [];
      const lineNum = numTokens[0] || '';

      // コード内容: .repos-line-content を持つ SPAN を探す（2 SPAN / 3 SPAN 両対応）
      let contentSpan = null;
      for (let i = spans.length - 1; i >= 1; i--) {
        const cls = typeof spans[i].className === 'string' ? spans[i].className : '';
        if (cls.includes('repos-line-content')) { contentSpan = spans[i]; break; }
      }
      if (!contentSpan) contentSpan = spans[spans.length - 1]; // フォールバック: 最後の SPAN

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
   * DOM スレッドの中に diffLines が欠落しているインラインコメントがあるか判定
   * @param {Array<Array>} threads
   * @returns {boolean}
   */
  function _hasMissingDiffLines(threads) {
    return threads.some((thread) => {
      if (!thread || thread.length === 0) return false;
      const first = thread[0];
      // filePath があるのに diffLines が無い → diff が欠落している
      return first.filePath && !(first.diffContext?.diffLines?.length > 0);
    });
  }

  /**
   * DOM スレッドに対して API 生データとマッチさせ、Items API で diffLines を補完する
   *
   * DOM パスで取得したスレッドの中に diffLines が欠落しているものがある場合、
   * API から rawApiThreads を取得し、filePath でマッチして Items API 経由で補完する。
   *
   * @param {Array<Array>} domThreads - DOM から取得したスレッド配列
   */
  async function _enrichDomThreadsViaItemsApi(domThreads) {
    // API データを取得
    let apiData = null;
    try {
      apiData = await fetchViaApi();
    } catch (e) {
      console.warn('[ReviewForMD] DOM補完用 API 取得失敗:', e);
      return;
    }
    if (!apiData || !apiData.rawApiThreads || !apiData.urlInfo) return;

    // DOM スレッドと API rawThread をマッチさせる
    // filePath + 先頭コメントの author で対応付け
    // マッチした DOM スレッドを仮の apiThreads 配列に入れ、対応する rawApiThreads と合わせて
    // _enrichWithItemsApi に渡す
    const matchedThreads = [];    // _enrichWithItemsApi に渡す apiThreads 相当
    const matchedRawThreads = []; // 対応する rawApiThreads

    // API rawThreads を配列で保持（DOM filePath がフルパスでない場合があるため endsWith で比較）
    const rawEntries = []; // { filePath, author, raw, used }
    apiData.rawApiThreads.forEach((raw) => {
      const tc = raw.threadContext;
      if (!tc?.filePath) return;
      const firstComment = raw.comments?.find((c) => c.commentType !== 'system' && c.content);
      if (!firstComment) return;
      const author = firstComment.author?.displayName || '';
      rawEntries.push({ filePath: tc.filePath, author, raw, used: false });
    });

    domThreads.forEach((thread) => {
      if (!thread || thread.length === 0) return;
      const first = thread[0];
      // filePath があるのに diffLines が無いスレッドのみ対象
      if (!first.filePath || first.diffContext?.diffLines?.length > 0) return;

      // DOM の filePath は短縮形（ファイル名のみ）の場合がある
      // API の filePath はフルパス（/CooKai/Models/Foo.cs）
      // endsWith で比較し、author も一致するものを探す
      const domPath = first.filePath || '';
      const domAuthor = first.author || '';
      const match = rawEntries.find((e) =>
        !e.used &&
        e.author === domAuthor &&
        (e.filePath === domPath || e.filePath.endsWith('/' + domPath))
      );
      if (!match) return;

      match.used = true;
      matchedThreads.push(thread);
      matchedRawThreads.push(match.raw);
    });

    if (matchedThreads.length === 0) return;

    try {
      await _enrichWithItemsApi(matchedThreads, matchedRawThreads, apiData.urlInfo);
    } catch (e) {
      console.warn('[ReviewForMD] DOM スレッド Items API 補完で予期しないエラー:', e);
    }
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
    let itemsApiDone = false; // Items API 補完が既に実行済みかどうか
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
          itemsApiDone = true;
          threads = apiData.threads;
        }
      }
    }

    // DOM パスで取得したスレッドに diffLines が欠落しているものがあれば Items API で補完
    // （diff コンテナが未ロード（スピナー表示中）のケースをカバー）
    // API パスで既に Items API 補完済みの場合は重複呼び出しを回避
    if (!itemsApiDone && _hasMissingDiffLines(threads)) {
      try {
        await _enrichDomThreadsViaItemsApi(threads);
      } catch (e) {
        console.warn('[ReviewForMD] DOM diffLines 補完で予期しないエラー:', e);
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
