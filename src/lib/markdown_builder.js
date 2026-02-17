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

  /**
   * DOM ノードを再帰的に Markdown に変換する
   * @param {Node} node
   * @returns {string}
   */
  function _convertNode(node) {
    // テキストノード
    if (node.nodeType === Node.TEXT_NODE) {
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

    // 子ノードを先に変換
    const childText = _convertChildren(el);

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
        const href = el.getAttribute('href') || '';
        const text = childText.trim();
        if (!text) return '';
        // 同じテキストならリンクだけ返す
        if (text === href) return href;
        return `[${text}](${href})`;
      }

      // ── 画像 ──
      case 'img': {
        const alt = el.getAttribute('alt') || '';
        const src = el.getAttribute('src') || '';
        return `![${alt}](${src})`;
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
   */
  function _convertChildren(el) {
    let result = '';
    for (const child of el.childNodes) {
      result += _convertNode(child);
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

      for (const node of child.childNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const childTag = /** @type {Element} */ (node).tagName.toLowerCase();
          if (childTag === 'ul' || childTag === 'ol') {
            subList += _convertListItems(
              /** @type {Element} */ (node),
              childTag === 'ol',
              depth + 1
            );
            continue;
          }
        }
        itemText += _convertNode(node);
      }

      const prefix = ordered ? `${counter}.` : '-';
      const line = `${indent}${prefix} ${itemText.trim()}`;
      lines.push(line);
      if (subList) lines.push(subList);
      counter++;
    }

    return lines.join('\n');
  }

  /**
   * HTML テーブルを Markdown テーブルに変換する
   * @param {Element} tableEl
   * @returns {string}
   */
  function _convertTable(tableEl) {
    const rows = [];
    const trList = tableEl.querySelectorAll('tr');

    trList.forEach((tr) => {
      const cells = [];
      tr.querySelectorAll('th, td').forEach((cell) => {
        cells.push(_convertChildren(cell).trim().replace(/\|/g, '\\|').replace(/\n/g, ' '));
      });
      rows.push(cells);
    });

    if (rows.length === 0) return '';

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

  /**
   * ブロックレベル要素かどうかを判定
   */
  function _isBlockElement(tag) {
    return [
      'div', 'section', 'article', 'aside', 'nav', 'main',
      'header', 'footer', 'figure', 'figcaption', 'details', 'summary',
    ].includes(tag);
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
   * @param {{ title: string, body: string, comments: Array<{author:string, body:string, filePath?:string, timestamp?:string}> }} data
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
      const meta = [];
      if (data.bodyAuthor) meta.push(`**投稿者:** ${data.bodyAuthor}`);
      if (data.bodyTimestamp) meta.push(`**日時:** ${formatTimestamp(data.bodyTimestamp)}`);
      if (meta.length > 0) {
        lines.push(meta.join('  '));
        lines.push('');
      }
      lines.push(data.body);
      lines.push('');
    }

    // レビューコメント
    if (data.comments && data.comments.length > 0) {
      lines.push('## レビューコメント');
      lines.push('');
      data.comments.forEach((c, i) => {
        lines.push(formatSingleComment(c, i + 1));
        lines.push('');
      });
    }

    return lines.join('\n').trim();
  }

  /**
   * 単一コメントを Markdown にフォーマットする
   * @param {{ author: string, body: string, filePath?: string, timestamp?: string }} comment
   * @param {number} [index]
   * @returns {string}
   */
  function formatSingleComment(comment, index) {
    const lines = [];
    const header = index != null ? `### コメント ${index}` : `### コメント`;
    lines.push(header);
    lines.push('');

    // メタ情報
    const meta = [];
    if (comment.author) meta.push(`**投稿者:** ${comment.author}`);
    if (comment.timestamp) meta.push(`**日時:** ${formatTimestamp(comment.timestamp)}`);
    if (comment.filePath) meta.push(`**ファイル:** \`${comment.filePath}\``);
    if (meta.length > 0) {
      lines.push(meta.join('  '));
      lines.push('');
    }

    // 本文
    lines.push(comment.body);

    return lines.join('\n');
  }

  return { buildFullMarkdown, formatSingleComment, htmlToMarkdown, formatTimestamp };
})();
