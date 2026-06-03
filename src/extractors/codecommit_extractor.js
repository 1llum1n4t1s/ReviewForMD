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
  };

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
   * 全コメントをスレッド単位で取得する（v1 は 1 コメント = 1 スレッド）。
   * 返信スレッドのグルーピングは実機調整時に SELECTORS とともに精緻化する。
   * @returns {Array<Array<{author:string, body:string, filePath?:string, timestamp?:string}>>}
   */
  function getComments() {
    const threads = [];
    const containers = _firstList(SELECTORS.commentContainer);
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
    const authorEl = _firstEl(SELECTORS.commentAuthor, container);
    const author = (authorEl ? authorEl.textContent.trim() : '') || '(unknown)';

    const timeEl = _firstEl(SELECTORS.commentTimestamp, container);
    const timestamp = timeEl
      ? (timeEl.getAttribute('datetime') || timeEl.textContent.trim())
      : '';

    const bodyEl = _firstEl(SELECTORS.commentBody, container);
    const body = bodyEl ? MarkdownBuilder.htmlToMarkdown(bodyEl) : '';
    if (!body) return null;

    const fileEl = _firstEl(SELECTORS.commentFilePath, container);
    const filePath = fileEl ? fileEl.textContent.trim() : '';

    const result = { author, body, timestamp };
    if (filePath) result.filePath = filePath;
    return result;
  }

  /**
   * 全データを取得して Markdown を生成する（popup の MDダウンロード/コピー用）。
   * 本文・コメントが両方取れなくても、タイトル見出しは必ず出す（GitHub/DevOps と同じく
   * 「空ファイル」にはしない）。両方空のときは実機調整のシグナルとして warn を出す。
   * @returns {Promise<string>}
   */
  async function extractAll() {
    const title = `${getTitle()} ${getPRNumber()}`.trim();
    const body = getBody();
    const threads = getComments();
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
