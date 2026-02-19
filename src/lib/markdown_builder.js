/**
 * Markdown 組み立てモジュール
 * 抽出したPRデータを Markdown テキストに変換する。
 */
const MarkdownBuilder = (() => {
  /* ── HTML → Markdown 変換 ─────────────────────── */

  /**
   * HTML 要素を Markdown テキストに変換する
   * @param {Element|null} el
   * @returns {string}
   */
  function htmlToMarkdown(el) {
    if (!el) return '';
    return _convertNode(el).replace(/\n{3,}/g, '\n\n').trim();
  }

  /** 再帰の最大深度（深くネストした DOM での Stack Overflow 防止） */
  const MAX_CONVERT_DEPTH = 80;

  /**
   * DOM ノードを再帰的に Markdown に変換する
   * @param {Node} node
   * @param {number} [depth=0] - 現在の再帰深度
   * @param {boolean} [insidePre=false] - pre 内ではテキストの空白正規化をスキップ
   * @returns {string}
   */
  function _convertNode(node, depth = 0, insidePre = false) {
    // 再帰深度制限: Stack Overflow を防止し、テキストのみ返す
    if (depth > MAX_CONVERT_DEPTH) {
      return node.textContent || '';
    }

    // テキストノード
    if (node.nodeType === Node.TEXT_NODE) {
      // pre/code ブロック内では空白・改行をそのまま保持する
      if (insidePre) return node.textContent;
      return node.textContent.replace(/\s+/g, ' ');
    }

    // 要素ノード以外は無視
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const el = /** @type {Element} */ (node);
    const tag = el.tagName.toLowerCase();

    // 非表示要素はスキップ
    if (tag === 'style' || tag === 'script' || tag === 'template') return '';

    // GitHub Suggested Change ブロックはスキップ（コメント本文で内容は説明済み）
    if (el.classList.contains('js-suggested-changes-blob')) {
      return '';
    }

    // Code Review Agent の重要度バッジ画像をスキップ（例: medium-priority.svg）
    if (_isCodeReviewAgentBadge(el)) {
      return '';
    }

    // 子ノードを先に変換（深度・pre 内フラグを伝播）
    const childText = _convertChildren(el, depth, insidePre);

    switch (tag) {
      // ── 見出し ──
      case 'h1': return `\n# ${childText.trim()}\n`;
      case 'h2': return `\n## ${childText.trim()}\n`;
      case 'h3': return `\n### ${childText.trim()}\n`;
      case 'h4': return `\n#### ${childText.trim()}\n`;
      case 'h5': return `\n##### ${childText.trim()}\n`;
      case 'h6': return `\n###### ${childText.trim()}\n`;

      // ── インライン装飾 ──
      case 'strong':
      case 'b':
        return childText.trim() ? `**${childText.trim()}**` : '';
      case 'em':
      case 'i':
        return childText.trim() ? `*${childText.trim()}*` : '';
      case 'del':
      case 's':
        return childText.trim() ? `~~${childText.trim()}~~` : '';

      // ── コード ──
      case 'code': {
        // 親が pre ならブロック処理に任せる
        if (el.parentElement && el.parentElement.tagName.toLowerCase() === 'pre') {
          return childText;
        }
        const codeText = el.textContent || '';
        return codeText.includes('`') ? `\`\` ${codeText} \`\`` : `\`${codeText}\``;
      }
      case 'pre': {
        const codeEl = el.querySelector('code');
        const raw = codeEl ? (codeEl.textContent || '') : (el.textContent || '');
        // 言語クラスを抽出 (例: language-js, highlight-source-js)
        const langClass = codeEl
          ? (codeEl.className || '').match(/(?:language-|highlight-source-)(\S+)/)
          : null;
        const lang = langClass ? langClass[1] : '';
        return `\n\`\`\`${lang}\n${raw.trimEnd()}\n\`\`\`\n`;
      }

      // ── リンク ──
      case 'a': {
        const href = (el.getAttribute('href') || '').trim();
        const text = childText.trim();
        if (!text) return '';
        // セキュリティ: 危険なスキーム（javascript: 等）はテキストのみ返す
        if (!href || href === '#' || _isDangerousScheme(href)) return text;
        // 相対パスを絶対 URL に変換（DOM が baseURI を持つ場合）
        let resolvedHref = href;
        try {
          if (!/^https?:\/\//i.test(href) && el.baseURI) {
            resolvedHref = new URL(href, el.baseURI).href;
          }
        } catch {
          // URL 解決に失敗した場合はそのまま使用
        }
        // 同じテキストならリンクだけ返す
        if (text === resolvedHref) return resolvedHref;
        // セキュリティ: ] と ) をエスケープして Markdown インジェクションを防止
        return `[${_sanitizeLinkText(text)}](${_sanitizeLinkUrl(resolvedHref)})`;
      }

      // ── 画像 ──
      case 'img': {
        const alt = el.getAttribute('alt') || '';
        const src = (el.getAttribute('src') || '').trim();
        // 装飾画像のスキップ: 幅/高さが小さい（バッジ等）、または alt も src もない場合
        const w = parseInt(el.getAttribute('width'), 10);
        const h = parseInt(el.getAttribute('height'), 10);
        if ((w > 0 && w <= 1) || (h > 0 && h <= 1)) return '';
        if (!src) return '';
        // セキュリティ: 危険なスキームをブロック（javascript: 等）
        if (_isDangerousScheme(src)) return alt ? `[画像: ${alt}]` : '[画像]';
        // data-uri は Markdown に含めると巨大になるためプレースホルダーに置換
        if (/^data:/i.test(src)) return alt ? `[画像: ${alt}]` : '[画像]';
        // 相対パスを絶対 URL に変換
        let resolvedSrc = src;
        try {
          if (!/^https?:\/\//i.test(src) && el.baseURI) {
            resolvedSrc = new URL(src, el.baseURI).href;
          }
        } catch {
          // URL 解決に失敗した場合はそのまま使用
        }
        // セキュリティ: ] と ) をエスケープして Markdown インジェクションを防止
        return `![${_sanitizeLinkText(alt)}](${_sanitizeLinkUrl(resolvedSrc)})`;
      }

      // ── リスト ──
      case 'ul':
      case 'ol':
        return '\n' + _convertListItems(el, tag === 'ol') + '\n';
      case 'li': {
        // li は _convertListItems から呼ばれるので、単独で来た場合
        return `- ${childText.trim()}\n`;
      }

      // ── テーブル ──
      case 'table':
        return '\n' + _convertTable(el) + '\n';

      // ── ブロック要素 ──
      case 'p':
        return `\n${childText.trim()}\n`;
      case 'br':
        return '\n';
      case 'hr':
        return '\n---\n';
      case 'blockquote':
        return '\n' + childText.trim().split('\n').map(l => `> ${l}`).join('\n') + '\n';

      // ── 入力 (チェックボックスリスト) ──
      case 'input': {
        if (el.getAttribute('type') === 'checkbox') {
          return el.checked ? '[x] ' : '[ ] ';
        }
        return '';
      }

      // ── div, span, その他 ──
      default:
        // ブロックレベル要素は前後に改行を入れる
        if (_isBlockElement(tag)) {
          return `\n${childText}\n`;
        }
        return childText;
    }
  }

  /**
   * 子ノードを連結する
   * @param {Element} el
   * @param {number} [depth=0] - 現在の再帰深度
   * @param {boolean} [insidePre=false] - pre 内フラグ
   */
  function _convertChildren(el, depth = 0, insidePre = false) {
    let result = '';
    for (const child of el.childNodes) {
      result += _convertNode(child, depth + 1, insidePre);
    }
    return result;
  }

  /**
   * リストアイテムを変換する
   * @param {Element} listEl - ul/ol 要素
   * @param {boolean} ordered
   * @param {number} [depth=0]
   * @returns {string}
   */
  function _convertListItems(listEl, ordered, depth = 0) {
    const lines = [];
    const indent = '  '.repeat(depth);
    let counter = 1;

    for (const child of listEl.children) {
      if (child.tagName.toLowerCase() !== 'li') continue;

      // li の直接テキストと子要素を分離
      let itemText = '';
      let subList = '';
      // li 内の input[type=checkbox] を追跡し重複処理を防ぐ
      let hasCheckbox = false;

      for (const node of child.childNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const childEl = /** @type {Element} */ (node);
          const childTag = childEl.tagName.toLowerCase();
          if (childTag === 'ul' || childTag === 'ol') {
            subList += _convertListItems(
              childEl,
              childTag === 'ol',
              depth + 1
            );
            continue;
          }
          // checkbox は li のプレフィックスとして一度だけ処理
          if (childTag === 'input' && childEl.getAttribute('type') === 'checkbox') {
            if (!hasCheckbox) {
              hasCheckbox = true;
              itemText += childEl.checked ? '[x] ' : '[ ] ';
            }
            continue;
          }
        }
        itemText += _convertNode(node, depth);
      }

      const prefix = ordered ? `${counter}.` : '-';
      const line = `${indent}${prefix} ${itemText.trim()}`;
      lines.push(line);
      // ネストリストは余分な空行を除去して連結
      if (subList) lines.push(subList.replace(/\n{2,}/g, '\n'));
      counter++;
    }

    return lines.join('\n');
  }

  /**
   * HTML テーブルを Markdown テーブルに変換する
   * thead/tbody/tfoot を考慮し、直接の子 tr のみ処理する（ネストテーブル混入防止）
   * @param {Element} tableEl
   * @returns {string}
   */
  function _convertTable(tableEl) {
    const rows = [];

    // thead → tbody → tfoot の順に直接の子 tr を収集
    // querySelectorAll('tr') だとネストしたテーブルの tr も拾ってしまうため、
    // children を直接走査して1階層のみ処理する
    const sections = [];
    for (const child of tableEl.children) {
      const childTag = child.tagName.toLowerCase();
      if (childTag === 'thead' || childTag === 'tbody' || childTag === 'tfoot') {
        sections.push(child);
      } else if (childTag === 'tr') {
        // thead/tbody/tfoot を使わない直接の tr もサポート
        sections.push(child);
      }
    }

    for (const section of sections) {
      const trs = section.tagName.toLowerCase() === 'tr'
        ? [section]
        : Array.from(section.children).filter(c => c.tagName.toLowerCase() === 'tr');
      for (const tr of trs) {
        const cells = [];
        for (const cell of tr.children) {
          const cellTag = cell.tagName.toLowerCase();
          if (cellTag === 'th' || cellTag === 'td') {
            cells.push(_convertChildren(cell).trim().replace(/\|/g, '\\|').replace(/\n/g, ' '));
          }
        }
        if (cells.length > 0) rows.push(cells);
      }
    }

    if (rows.length === 0) return '';

    // 全行で最大のセル数を算出し、不足分を空セルでパディング
    const maxCols = Math.max(...rows.map(r => r.length));
    for (const row of rows) {
      while (row.length < maxCols) {
        row.push('');
      }
    }

    const lines = [];
    // ヘッダー行
    lines.push('| ' + rows[0].join(' | ') + ' |');
    // セパレーター
    lines.push('| ' + rows[0].map(() => '---').join(' | ') + ' |');
    // ボディ行
    for (let i = 1; i < rows.length; i++) {
      lines.push('| ' + rows[i].join(' | ') + ' |');
    }

    return lines.join('\n');
  }

  /* ── コンテンツフィルターヘルパー ─────────────── */

  /** Code Review Agent の重要度バッジ URL パターン */
  const _CODE_REVIEW_AGENT_BADGE_RE = /gstatic\.com\/codereviewagent\/.+-priority\.svg/;

  /**
   * Code Review Agent の重要度バッジ要素かどうかを判定する
   * GitHub のコメントに挿入される重要度画像（medium-priority.svg 等）と、
   * それを囲むリンクをフィルタリングする
   * @param {Element} el
   * @returns {boolean}
   */
  function _isCodeReviewAgentBadge(el) {
    const tag = el.tagName.toLowerCase();

    if (tag === 'img') {
      const src = el.getAttribute('src') || '';
      const canonical = el.getAttribute('data-canonical-src') || '';
      return _CODE_REVIEW_AGENT_BADGE_RE.test(src) || _CODE_REVIEW_AGENT_BADGE_RE.test(canonical);
    }

    if (tag === 'a') {
      // リンクの子要素が重要度バッジ画像のみかチェック
      const img = el.querySelector('img');
      if (img && el.children.length === 1) {
        const src = img.getAttribute('src') || '';
        const canonical = img.getAttribute('data-canonical-src') || '';
        return _CODE_REVIEW_AGENT_BADGE_RE.test(src) || _CODE_REVIEW_AGENT_BADGE_RE.test(canonical);
      }
    }

    return false;
  }

  /* ── セキュリティヘルパー ────────────────────── */

  /**
   * 危険な URI スキームかどうかを判定する
   * セキュリティ: javascript:/vbscript:/data: スキームによる XSS を防止
   * 制御文字を除去し大文字小文字を無視して判定する
   * @param {string} url
   * @returns {boolean}
   */
  function _isDangerousScheme(url) {
    const normalized = url.replace(/[\x00-\x1f\x7f]/g, '').trim();
    return /^(javascript|vbscript|data):/i.test(normalized);
  }

  /**
   * Markdown リンクテキスト内の ] をエスケープしてインジェクションを防止する
   * @param {string} text
   * @returns {string}
   */
  function _sanitizeLinkText(text) {
    return text.replace(/\]/g, '\\]');
  }

  /**
   * Markdown リンク URL 内の ) をエンコードしてインジェクションを防止する
   * @param {string} url
   * @returns {string}
   */
  function _sanitizeLinkUrl(url) {
    return url.replace(/\)/g, '%29');
  }

  /** ブロックレベル要素の Set（毎回配列を生成する代わりに事前定義で O(1) 判定） */
  const _BLOCK_ELEMENTS = new Set([
    'div', 'section', 'article', 'aside', 'nav', 'main',
    'header', 'footer', 'figure', 'figcaption', 'details', 'summary',
  ]);

  /**
   * ブロックレベル要素かどうかを判定
   */
  function _isBlockElement(tag) {
    return _BLOCK_ELEMENTS.has(tag);
  }

  /* ── タイムスタンプ整形 ───────────────────────── */

  /**
   * ISO 8601 タイムスタンプを読みやすい形式に変換する
   * @param {string} raw
   * @returns {string}
   */
  function formatTimestamp(raw) {
    if (!raw) return '';
    try {
      const d = new Date(raw);
      if (isNaN(d.getTime())) return raw;
      return d.toLocaleString('ja-JP', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
    } catch {
      return raw;
    }
  }

  /* ── Markdown フォーマッタ ─────────────────────── */

  /**
   * PR 全体を Markdown にフォーマットする
   * @param {{
   *   title: string,
   *   body: string,
   *   bodyAuthor?: string,
   *   bodyTimestamp?: string,
   *   threads?: Array<Array<{author:string, body:string, filePath?:string, timestamp?:string}>>,
   *   comments?: Array<{author:string, body:string, filePath?:string, timestamp?:string}>
   * }} data
   * @returns {string}
   */
  function buildFullMarkdown(data) {
    const lines = [];

    // タイトル
    lines.push(`# ${data.title}`);
    lines.push('');

    // 本文
    if (data.body) {
      lines.push('## 本文');
      lines.push('');
      if (data.bodyAuthor) lines.push(`**投稿者:** ${data.bodyAuthor}`);
      if (data.bodyTimestamp) lines.push(`**日時:** ${formatTimestamp(data.bodyTimestamp)}`);
      if (data.bodyAuthor || data.bodyTimestamp) {
        lines.push('');
      }
      lines.push(data.body);
      lines.push('');
    }

    // レビューコメント
    // threads: Array<Array<comment>> 形式（スレッド階層あり）を優先
    // comments: Array<comment> 形式（GitHub 等のフラット配列）はフォールバック
    const threads = data.threads;
    const flatComments = data.comments;

    if (threads && threads.length > 0) {
      lines.push('## レビューコメント');
      lines.push('');
      threads.forEach((thread, i) => {
        lines.push(formatThreadAsComment(thread, i + 1));
        lines.push('');
      });
    } else if (flatComments && flatComments.length > 0) {
      lines.push('## レビューコメント');
      lines.push('');
      flatComments.forEach((c, i) => {
        lines.push(formatSingleComment(c, i + 1));
        lines.push('');
      });
    }

    return lines.join('\n').trim();
  }

  /**
   * スレッド（親コメント＋返信）を「コメント N」見出し付きで Markdown にフォーマットする
   * buildFullMarkdown 内で使用する（全体コピー用）
   * @param {Array<{author:string, body:string, filePath?:string, timestamp?:string, diffContext?:any}>} thread
   * @param {number} index - コメント番号（1始まり）
   * @returns {string}
   */
  function formatThreadAsComment(thread, index) {
    if (!thread || thread.length === 0) return '';

    const lines = [];

    // 「コメント N」見出し
    lines.push(`### コメント ${index}`);
    lines.push('');

    // 親コメント（見出しは既に出力済みなので index=null で呼ぶ）
    lines.push(formatSingleComment(thread[0]));

    // 返信（2件目以降）
    thread.slice(1).forEach((c, i) => {
      lines.push('');
      lines.push('---');
      lines.push('');
      lines.push(`**↩ 返信 ${i + 1}**`);
      lines.push('');
      lines.push(formatSingleComment(c));
    });

    return lines.join('\n');
  }

  /**
   * 単一コメントを Markdown にフォーマットする
   * @param {{ author: string, body: string, filePath?: string, timestamp?: string, diffContext?: { lineRange: string, diffLines: Array<{prefix: string, lineNum: string, code: string}> } }} comment
   * @param {number} [index]
   * @returns {string}
   */
  function formatSingleComment(comment, index) {
    const lines = [];
    // 「全てMDコピー」時のみ見出しを付与（個別コピー時は不要）
    if (index != null) {
      lines.push(`### コメント ${index}`);
      lines.push('');
    }

    // メタ情報（各項目を改行で区切る）
    if (comment.author) lines.push(`**投稿者:** ${comment.author}`);
    if (comment.timestamp) lines.push(`**日時:** ${formatTimestamp(comment.timestamp)}`);
    if (comment.filePath) lines.push(`**ファイル:** \`${comment.filePath}\``);
    if (comment.author || comment.timestamp || comment.filePath) {
      lines.push('');
    }

    // diff コンテキスト（対象ファイルの変更行・ソースコード）
    if (comment.diffContext) {
      const dc = comment.diffContext;
      if (dc.lineRange) {
        lines.push(`**対象行:** ${dc.lineRange}`);
        lines.push('');
      }
      if (dc.diffLines && dc.diffLines.length > 0) {
        lines.push('```diff');
        dc.diffLines.forEach((dl) => {
          lines.push(`${dl.prefix}${dl.code}`);
        });
        lines.push('```');
        lines.push('');
      }
    }

    // 本文
    lines.push(comment.body);

    return lines.join('\n');
  }

  /**
   * スレッド（親コメント＋返信）を Markdown にフォーマットする
   * @param {Array<{ author: string, body: string, filePath?: string, timestamp?: string }>} comments
   * @returns {string}
   */
  function formatThreadComments(comments) {
    if (!comments || comments.length === 0) return '';

    // コメントが 1 件だけの場合はシングルと同じ（ヘッダーなし）
    if (comments.length === 1) {
      return formatSingleComment(comments[0]);
    }

    // 複数コメント：親コメント + 返信
    const lines = [];

    // 親コメント（最初の1件）
    lines.push(formatSingleComment(comments[0]));

    // 返信（2件目以降）
    comments.slice(1).forEach((c, i) => {
      lines.push('');
      lines.push(`---`);
      lines.push('');
      lines.push(`**↩ 返信 ${i + 1}**`);
      lines.push('');
      lines.push(formatSingleComment(c));
    });

    return lines.join('\n');
  }

  return { buildFullMarkdown, formatSingleComment, formatThreadComments, htmlToMarkdown, formatTimestamp };
})();
