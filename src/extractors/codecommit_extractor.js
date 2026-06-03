/**
 * AWS CodeCommit プルリクエスト データ抽出モジュール
 *
 * 対象: AWS マネジメントコンソール（CodeSuite）の CodeCommit PR 詳細ページ
 *   https://{region}.console.aws.amazon.com/codesuite/codecommit/repositories/{repo}/pull-requests/{id}/details
 *
 * ⚠️ AWS コンソールは Cloudscape デザインシステムの React SPA で、CSS クラス名が
 *    ハッシュ化（awsui_xxx_yyyy）され頻繁に変わる。**サイト固有セレクタの単一の真実の源は
 *    この SELECTORS**。UI 変更で動かなくなったら、ここだけ実機 DOM に合わせて調整すればよい
 *    （Teams extractor と同じ「セレクタ集約 + 実機調整」方針）。
 *
 * データ取得方針（なぜ DOM ベースか）:
 *   - 公開 CodeCommit API は SigV4 署名（IAM 秘密鍵）必須でブラウザから呼べない
 *   - コンソール内部 API は CSRF + セッション依存で未公開・脆い
 *   → 描画済み DOM から抽出するのが唯一の現実解。
 *
 * GitHub/DevOps との違い:
 *   - HTML fetch フォールバック不可（コンソールはクライアントレンダリングで、生 HTML に
 *     PR データが存在しない）。そのため extractByPrUrl（PR 一覧行の背景ダウンロード）は提供せず、
 *     **詳細ページ専用**とする（空ファイルの成功偽装を避ける既存方針に沿う）。
 *   - 検出は URL ベース（site_detector）。本モジュールは抽出のみを担う。
 */
var CodeCommitExtractor = CodeCommitExtractor || (() => {
  /* ── サイト固有セレクタ（実機調整の単一の真実の源）──────────────────────
   * 各項目は候補配列。前から順に試し、最初にヒットしたものを採用する。
   * 値はいずれも Cloudscape の一般的構造からの best-effort 推測であり、
   * 実 PR ページの DOM を採取して精緻化する前提（初期値はプレースホルダ）。
   *
   * 実機調整のしかた: CodeCommit の PR を開き、DevTools で
   *   - タイトル見出し（PR 名）
   *   - Details タブの「説明 / Description」本文
   *   - Activity タブの各コメント（投稿者 / 日時 / 本文）
   * の要素を Inspect し、安定して取れるセレクタ（data-* 属性優先、無ければ awsui_ クラスの
   * 前方一致 `[class*="awsui_..."]`）に各配列の先頭を差し替える。
   */
  const SELECTORS = {
    // PR タイトル（Cloudscape のページヘッダは通常 <h1>）
    title: [
      '[data-testid="pull-request-title"]',
      'h1[class*="awsui_heading-text"]',
      'main h1',
      'h1',
    ],
    // PR 説明（Details タブ「説明 / Description」セクションの本文コンテナ）
    description: [
      '[data-testid="pull-request-description"]',
      '[data-testid*="description"]',
    ],
    // 見出しテキストから説明本文へ辿るフォールバック用（小文字で前方一致判定）
    descriptionHeadingText: ['description', '説明'],
    // コメント 1 件分のコンテナ（Activity タブ／インライン）
    commentContainer: [
      '[data-testid*="comment-card"]',
      '[data-testid*="comment-item"]',
      '[data-testid*="comment"]',
    ],
    // コメント内の各要素（commentContainer をルートに検索）
    commentAuthor: ['[data-testid*="author"]', '[class*="author"]', '[class*="userName"]'],
    commentTimestamp: ['time', '[data-testid*="time"]', '[class*="timestamp"]', '[class*="time"]'],
    commentBody: ['[data-testid*="comment-body"]', '[class*="comment-body"]', '[class*="markdown"]'],
    // インラインコメントの対象ファイルパス（取れたら付与）
    commentFilePath: ['[data-testid*="file-path"]', '[class*="filePath"]', '[class*="file-path"]'],
    // タブ見出しテキスト（小文字・前方一致で判定）。本文＝Details、コメント＝Activity が別タブのため。
    detailsTabText: ['details', '詳細'],
    activityTabText: ['activity', 'アクティビティ'],
  };

  /** タブ切替後の描画待ち (ms)。 */
  const TAB_RENDER_WAIT_MS = 600;

  /* ── DOM ヘルパ ─────────────────────────────────── */

  /** selectors を順に試し、最初にヒットした 1 要素を返す（無効セレクタは黙殺）。 */
  function _firstEl(selectors, root) {
    const r = root || document;
    for (const sel of selectors) {
      try {
        const el = r.querySelector(sel);
        if (el) return el;
      } catch { /* 無効セレクタ等は無視して次の候補へ */ }
    }
    return null;
  }

  /** selectors を順に試し、最初に 1 件以上ヒットした NodeList を配列で返す。 */
  function _firstList(selectors, root) {
    const r = root || document;
    for (const sel of selectors) {
      try {
        const els = r.querySelectorAll(sel);
        if (els && els.length > 0) return Array.from(els);
      } catch { /* 無効セレクタ等は無視して次の候補へ */ }
    }
    return [];
  }

  /**
   * el 自身が selector に一致すれば el を、しなければ子孫を querySelector で探す。
   * コメントコンテナの広いフォールバック（[data-testid*="comment"]）が
   * `comment-body` 要素そのものを掴んだとき、querySelector は子孫しか見ないため
   * body を取りこぼす（＝コメントが丸ごとスキップされる）のを防ぐ。
   */
  function _selfOrFirst(el, selectors) {
    if (!el) return null;
    for (const sel of selectors) {
      try {
        if (typeof el.matches === 'function' && el.matches(sel)) return el;
        const found = el.querySelector(sel);
        if (found) return found;
      } catch { /* 無効セレクタ等は無視して次の候補へ */ }
    }
    return null;
  }

  /**
   * タイトル末尾の "#42" / "Pull request #42" / "Pull request 42" 等の番号サフィックスを除去。
   * `#` か "pull request" を伴う明示的なサフィックスのみ対象にし、"RFC 9110" や
   * "Protocol v2" のような末尾が数字の正規タイトルを誤って削らないようにする。
   */
  function _cleanTitle(raw) {
    if (!raw) return '';
    return raw
      .replace(/\s+/g, ' ')
      .replace(/\s*(?:[-–—]\s*)?(?:(?:pull request\s*)?#\d+|pull request\s*\d+)\s*$/i, '')
      .trim();
  }

  /* ── 公開 API ─────────────────────────────────── */

  /**
   * PR 番号を取得する（URL ベース・最も堅牢）。
   * @returns {string} 例: "#42"（取得不能なら ""）
   */
  function getPRNumber() {
    const m = location.pathname.match(/\/pull-requests\/(\d+)/i);
    return m ? `#${m[1]}` : '';
  }

  /**
   * PR タイトルを取得する。
   * 見出し要素 → document.title の順でフォールバックする。
   * @returns {string}
   */
  function getTitle() {
    const el = _firstEl(SELECTORS.title);
    if (el) {
      const t = _cleanTitle(el.textContent || '');
      if (t) return t;
    }
    // フォールバック: document.title（"... | CodeCommit | ..." 等の区切りで先頭だけ採用）
    const dt = (document.title || '').split(/[|·]/)[0].trim();
    const cleaned = _cleanTitle(dt);
    if (cleaned && !/^codecommit$/i.test(cleaned)) return cleaned;
    return 'Pull Request';
  }

  /**
   * PR 本文（説明）を取得する。Details タブが描画されている前提。
   * @returns {string} Markdown（取得不能なら ""）
   */
  function getBody() {
    let el = _firstEl(SELECTORS.description);
    if (!el) el = _findDescriptionByHeading();
    if (!el) return '';
    return MarkdownBuilder.htmlToMarkdown(el);
  }

  /**
   * 「説明 / Description」見出しの直後要素から本文コンテナを推定する（セレクタが外れたとき用）。
   * @returns {Element|null}
   */
  function _findDescriptionByHeading() {
    const heads = document.querySelectorAll('h1, h2, h3, h4, h5, [role="heading"]');
    for (const h of heads) {
      const t = (h.textContent || '').trim().toLowerCase();
      if (SELECTORS.descriptionHeadingText.some((k) => t === k || t.startsWith(k))) {
        const next = h.nextElementSibling;
        if (next && (next.textContent || '').trim()) return next;
      }
    }
    return null;
  }

  /**
   * el 内（自身含む）の「コメント本文(body)」数を数える。1 コメント単位の判定に使う。
   * markdown の入れ子等で過剰カウントしないよう、最外マッチだけを数える。
   */
  function _bodyCount(el) {
    for (const sel of SELECTORS.commentBody) {
      try {
        if (typeof el.matches === 'function' && el.matches(sel)) return 1; // 自身が body
        const found = Array.from(el.querySelectorAll(sel));
        if (found.length) {
          // 入れ子（markdown の多重マッチ等）は最外だけ数えて 1 コメント=1 本文とみなす
          return found.filter((m) => !found.some((o) => o !== m && o.contains(m))).length;
        }
      } catch { /* 無効セレクタ等は無視して次の候補へ */ }
    }
    return 0;
  }

  /**
   * 広いフォールバック（[data-testid*="comment"]）が「リスト」「wrapper」「body」「メタ要素
   * （comment-author / comment-time 等）」を混在して拾ったとき、各要素を 1 コメント単位に正規化する。
   *   - 本文をちょうど 1 つ含む要素＝1 コメント（wrapper でも body 自身でも可）を採用候補にする。
   *     メタ要素（author/time）は本文 0 で除外、comment-list 等のリストは本文 2 件以上で除外。
   *     ＝「matched ノード数」で判定すると wrapper(author+time+body を含む)を list と誤判定するため、
   *       本文数で判定する。
   *   - ネスト時は最も外側（wrapper）を残し、内側（その body）は落とす（wrapper+body 二重取り防止）。
   */
  function _selectCommentContainers(els) {
    const units = els.filter((el) => _bodyCount(el) === 1);
    return units.filter((el) => !units.some((o) => o !== el && o.contains(el)));
  }

  /**
   * 全コメントをスレッド単位で取得する（v1 は 1 コメント = 1 スレッド）。
   * 返信スレッドのグルーピングは実機調整時に SELECTORS とともに精緻化する。
   * @returns {Array<Array<{author:string, body:string, filePath?:string, timestamp?:string}>>}
   */
  function getComments() {
    const threads = [];
    // wrapper+body の二重取りとリストの飲み込みを避け、1 コメント単位に正規化してから解析する
    const containers = _selectCommentContainers(_firstList(SELECTORS.commentContainer));
    containers.forEach((c) => {
      const comment = _parseComment(c);
      if (comment && comment.body) threads.push([comment]);
    });
    return MarkdownBuilder.deduplicateThreads(threads);
  }

  /**
   * コメントコンテナ 1 件から {author, body, timestamp, filePath?} を抽出する。
   * 本文が空なら null（呼び出し側でスキップ）。
   * @returns {{author:string, body:string, timestamp:string, filePath?:string}|null}
   */
  function _parseComment(container) {
    // self-or-descendant で探す。コンテナの広いフォールバックが body 要素自体を
    // 掴んだ場合（card/item ラッパーが無い DOM 形状）でも取りこぼさない。
    const authorEl = _selfOrFirst(container, SELECTORS.commentAuthor);
    const author = (authorEl ? authorEl.textContent.trim() : '') || '(unknown)';

    const timeEl = _selfOrFirst(container, SELECTORS.commentTimestamp);
    const timestamp = timeEl
      ? (timeEl.getAttribute('datetime') || timeEl.textContent.trim())
      : '';

    const bodyEl = _selfOrFirst(container, SELECTORS.commentBody);
    const body = bodyEl ? MarkdownBuilder.htmlToMarkdown(bodyEl) : '';
    if (!body) return null;

    const fileEl = _selfOrFirst(container, SELECTORS.commentFilePath);
    const filePath = fileEl ? fileEl.textContent.trim() : '';

    const result = { author, body, timestamp };
    if (filePath) result.filePath = filePath;
    return result;
  }

  function _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 表示テキストが labelPatterns に一致する role=tab 要素をクリックする（best-effort）。
   * Cloudscape のタブは role="tab" を持つ。誤クリックを避けるため role=tab に限定する。
   * @returns {boolean} クリックできたら true
   */
  function _clickTabByLabel(labelPatterns) {
    const tabs = document.querySelectorAll('[role="tab"]');
    for (const tab of tabs) {
      const text = (tab.textContent || '').trim().toLowerCase();
      if (text && labelPatterns.some((p) => text === p || text.startsWith(p))) {
        try {
          tab.click();
          return true;
        } catch { /* クリック不可は無視 */ }
      }
    }
    return false;
  }

  /** タブを開いて描画を待つ（クリックできたときのみ待つ）。 */
  async function _activateTab(labelPatterns) {
    if (_clickTabByLabel(labelPatterns)) {
      await _delay(TAB_RENDER_WAIT_MS);
      return true;
    }
    return false;
  }

  /**
   * 全データを取得して Markdown を生成する（popup の MDダウンロード/コピー用）。
   *
   * 本文（Details タブ）とコメント（Activity タブ）は別タブに描画されるため、
   * それぞれのタブを開いてから収集する（best-effort）。タブ切替に失敗しても、
   * 現在表示中の内容から取れる範囲で抽出して degrade する。
   * 本文・コメントが両方取れなくても、タイトル見出しは必ず出す（GitHub/DevOps と同じく
   * 「空ファイル」にはしない）。両方空のときは実機調整のシグナルとして warn を出す。
   * @returns {Promise<string>}
   */
  async function extractAll() {
    // Details タブを開いてから本文を取る（Activity 開始時の本文欠落を防ぐ）
    await _activateTab(SELECTORS.detailsTabText);
    const body = getBody();
    // Activity タブを開いてからコメントを取る（Details 開始時のコメント欠落を防ぐ）
    await _activateTab(SELECTORS.activityTabText);
    const threads = getComments();

    const title = `${getTitle()} ${getPRNumber()}`.trim();
    if (!body && threads.length === 0) {
      console.warn(
        '[ReviewForMD][CodeCommit] PR 本文・コメントを抽出できませんでした' +
        '（コンソールの DOM 構成変更の可能性）。codecommit_extractor.js の SELECTORS を実機に合わせて調整してください。'
      );
    }
    return MarkdownBuilder.buildFullMarkdown({ title, body, threads });
  }

  return { getTitle, getPRNumber, getBody, getComments, extractAll };
})();
