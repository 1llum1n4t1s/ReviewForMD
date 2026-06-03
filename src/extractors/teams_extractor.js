/**
 * Microsoft Teams チャット抽出モジュール
 *
 * Teams Web（teams.microsoft.com / teams.live.com / teams.cloud.microsoft）の
 * チャット・チャネルから、メッセージ全履歴を自動スクロールで収集し、
 * 送信者 / 日時 / 本文 / リアクション / 添付を Markdown としてエクスポートする。
 *
 * 動作の流れ:
 *   1. メッセージリストのスクロールコンテナを特定
 *   2. 下端（最新）から上端（最古）へ段階的にスクロールし、可視メッセージを
 *      逐次 Map に回収する（Teans Web は仮想スクロールで画面外要素が DOM から
 *      外れるため、スクロールしながら確保する必要がある）
 *   3. メッセージ id（または合成キー）で重複除去し時系列ソート
 *   4. Markdown を生成。ZIP 経路では添付実バイトも取得して同梱する
 *
 * ⚠️ Teams の DOM クラス/属性は頻繁に変わる。サイト固有セレクタは
 *    すべて SELECTORS に集約してあるので、UI 変更で動かなくなったら
 *    まずここを実機 DOM に合わせて調整する。
 *
 * 全コードはこのプロジェクトのためのオリジナル実装。
 */
var TeamsExtractor = TeamsExtractor || (() => {
  /* ── サイト固有セレクタ（実機調整ポイント）──────────────── */

  const SELECTORS = {
    // メッセージリストのスクロールコンテナ候補（上から優先）
    scroller: [
      '[data-tid="message-pane-list-viewport"]',
      '[data-tid="messageListContainer"]',
      '[data-tid="pane-list"]',
      '[role="main"] [data-tid*="messageList"]',
      '.ts-message-list-container',
    ],
    // 1 メッセージのコンテナ候補
    message: [
      '[data-tid="chat-pane-message"]',
      '[data-tid^="chat-pane-item"]',
      '[data-tid="messageBodyContainer"]',
      'div[role="listitem"][data-mid]',
      '.ui-chat__item',
      '.message-body',
    ],
    // row らしき祖先。message が body-level セレクタ（messageBodyContainer / .message-body）で
    // マッチしたとき、ファイルカードは body の兄弟（row 配下）にあるため、ここまで広げて探す。
    messageRow: [
      '[data-tid="chat-pane-message"]',
      '[data-tid^="chat-pane-item"]',
      'div[role="listitem"]',
      '.ui-chat__item',
    ],
    // 送信者名
    author: [
      '[data-tid="message-author-name"]',
      '[data-tid="messageSenderName"]',
      '.ui-chat__message__author',
      '[class*="authorName"]',
    ],
    // 本文（HTML→Markdown 変換対象）
    body: [
      '[data-tid="messageBodyContent"]',
      '[id^="content-"]',
      '.ui-chat__messagecontent',
      '[class*="messageContent"]',
      '.message-body-content',
    ],
    // リアクション
    reaction: [
      '[data-tid^="reaction"]',
      '[data-tid="messageReactionsCount"]',
      '.ui-reaction',
      '[class*="reactionsBar"] [class*="reaction"]',
    ],
    // 添付ファイルカード（本文と別枠のファイル）
    fileCard: [
      'a[data-tid="file-attachment"]',
      '[data-tid="file-preview"] a[href]',
      '[data-tid="cards"] a[href]',
      'a[href*="sharepoint.com"][download]',
    ],
    // チャット/チャネルのタイトル
    title: [
      '[data-tid="chat-header-title"]',
      '[data-tid="threadHeaderTitle"]',
      '[data-tid="channel-header-title"]',
      'h1[role="heading"]',
      '[class*="chatHeaderTitle"]',
    ],
  };

  /* ── 自動スクロールのガード値 ───────────────────────── */

  /** スクロール 1 段あたりの待機 (ms) */
  const STEP_WAIT_MS = 280;
  /** 上端で古いメッセージ読み込みを待つ時間 (ms) */
  const LOAD_WAIT_MS = 750;
  /** 上端で「これ以上増えない」と判断するまでの連続回数 */
  const STABLE_ROUNDS = 3;
  /** スクロール反復の上限 */
  const MAX_ITERATIONS = 1500;
  /** 自動スクロール全体の時間上限 (ms) */
  const MAX_DURATION_MS = 240000;
  /** 収集メッセージ数の上限（暴走防止） */
  const MAX_MESSAGES = 50000;
  /**
   * フォールバック sortKey のラウンド間ストライド。
   * 1 viewport 内のメッセージ数より十分大きくし、ラウンドをまたいだ順序が
   * viewport 内 DOM 順（domIndex）で乱れないようにする。
   */
  const FALLBACK_ROUND_STRIDE = 1e6;
  /** ZIP に同梱する添付の合計バイト上限（OOM 防止）。超過分はリモート URL リンクのまま残す。 */
  const MAX_ATTACH_TOTAL_BYTES = 512 * 1024 * 1024;
  /** 添付取得の並列度（直列だと添付数 × RTT で遅い） */
  const ATTACH_CONCURRENCY = 4;
  /**
   * 添付 1 件あたりのバイト上限（OOM 防止）。
   * 「並列度 × 単体上限 ≤ 合計上限」になるよう合計 / 並列度で決めることで、
   * 同時にバッファされる添付のピークが合計上限を超えないようにする。
   */
  const MAX_ATTACH_SINGLE_BYTES = Math.floor(MAX_ATTACH_TOTAL_BYTES / ATTACH_CONCURRENCY);

  /** 抽出の再入ガード（同一ページで収集ループの多重起動・DOM 奪い合いを防ぐ） */
  let _busy = false;

  /** 認証付き取得を許可する添付ホスト（cookie 漏洩防止の allowlist） */
  function _isAllowedAttachmentUrl(url) {
    try {
      const u = new URL(url, location.href);
      if (u.protocol === 'blob:') return true; // 同コンテキストの blob は安全
      if (u.protocol !== 'https:') return false;
      const h = u.hostname;
      return (
        h === 'teams.microsoft.com' ||
        h.endsWith('.teams.microsoft.com') ||
        h === 'teams.cloud.microsoft' ||
        h.endsWith('.teams.cloud.microsoft') ||
        // consumer Teams（manifest / site_detector が対応している teams.live.com）。
        // 同一オリジンの添付/画像なので CORS 制約を受けず取得できる。
        h === 'teams.live.com' ||
        h.endsWith('.teams.live.com') ||
        // 添付/画像の実配信ホストに限定して cookie 境界を最小化する（SSRF/cookie 流出対策）。
        // 取得できない添付が出たら、実機 Teams の Network から配信ホストを採取してここに追加する。
        // （広域サフィックス .microsoft.com/.office.com/.live.com 等は送信者制御 URL での
        //   クロスサービス cookie 送信を許すため意図的に除外）
        h.endsWith('.sharepoint.com') ||
        h.endsWith('.svc.ms')
      );
    } catch {
      return false;
    }
  }

  /* ── 状態 ─────────────────────────────────────────── */

  let _availabilityCache = null;
  let _availabilityCacheUrl = '';

  /* ── DOM 探索ヘルパ ─────────────────────────────── */

  function _qsFirst(root, selList) {
    for (const sel of selList) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch {
        /* 無効セレクタは無視 */
      }
    }
    return null;
  }

  function _qsAllFirst(root, selList) {
    for (const sel of selList) {
      try {
        const els = root.querySelectorAll(sel);
        if (els && els.length) return Array.from(els);
      } catch {
        /* 無効セレクタは無視 */
      }
    }
    return [];
  }

  /** スクロール可能な祖先を探す（セレクタが外れたときの保険）。 */
  function _findScrollableAncestor(el) {
    let node = el;
    let depth = 0;
    while (node && node !== document.body && depth < 30) {
      try {
        const style = getComputedStyle(node);
        const oy = style.overflowY;
        if (
          (oy === 'auto' || oy === 'scroll') &&
          node.scrollHeight > node.clientHeight + 20
        ) {
          return node;
        }
      } catch {
        /* getComputedStyle 失敗は無視 */
      }
      node = node.parentElement;
      depth++;
    }
    return null;
  }

  /** メッセージリストのスクロールコンテナを特定する。 */
  function _findScroller() {
    const direct = _qsFirst(document, SELECTORS.scroller);
    if (direct && direct.scrollHeight > direct.clientHeight + 20) return direct;
    // セレクタが外れている場合: メッセージ要素から上方向にスクロール可能祖先を探す
    const msgs = _findMessages();
    if (msgs.length) {
      const anc = _findScrollableAncestor(msgs[0]);
      if (anc) return anc;
    }
    return direct || null;
  }

  /** 現在レンダリングされているメッセージ要素一覧。 */
  function _findMessages() {
    return _qsAllFirst(document, SELECTORS.message);
  }

  /* ── メッセージ解析 ─────────────────────────────── */

  /**
   * メッセージの安定 id（重複除去キーの第一候補）。
   *
   * ⚠️ `data-tid` は「コンポーネント種別マーカー」で、SELECTORS.message が使う
   *    `chat-pane-message` / `chat-pane-item` / `messageBodyContainer` のように
   *    **行をまたいで同じ値が繰り返される**ことが多い。これをユニークキーにすると
   *    全メッセージが同一キーになり、`_captureInto` の `map.has(rawId)` 早期 continue で
   *    2 件目以降が丸ごと捨てられる（＝最初の 1 件しかエクスポートされない）。
   *    そのため data-tid は「メッセージ ID 由来の長い数字列を含む＝インスタンス固有」と
   *    判断できる場合のみ採用し、汎用 tid は無視して `_parseMessage` 側の合成キー
   *    （author::timestamp::body 先頭）に委ねる。
   *
   * @returns {string} 安定ユニーク id（取れなければ ''）
   */
  function _messageId(el) {
    const mid = el.getAttribute('data-mid');
    if (mid) return mid; // メッセージ ID（最も信頼できる一意値）
    const id = el.getAttribute('id');
    if (id) return id; // 要素 id は文書内で一意であるべき
    const tid = el.getAttribute('data-tid') || '';
    if (/\d{5,}/.test(tid)) return tid; // 長い数字列を含む tid のみインスタンス固有とみなす
    return '';
  }

  /** ソート用の数値キー（mid は概ね epoch ms ベースの単調増加値）。 */
  function _numericId(id) {
    const m = String(id).match(/(\d{10,})/);
    return m ? Number(m[1]) : NaN;
  }

  function _getAuthor(el) {
    const a = _qsFirst(el, SELECTORS.author);
    const text = a ? (a.textContent || '').trim() : '';
    if (text) return text;
    // aria-label フォールバック: "Alice, 10:30 AM, ..." 形式の先頭トークン
    const label = el.getAttribute('aria-label') || '';
    const m = label.match(/^([^,]{1,80}),/);
    return m ? m[1].trim() : '';
  }

  function _getBodyElement(el) {
    return _qsFirst(el, SELECTORS.body) || el;
  }

  function _getTimestamp(el) {
    const t = el.querySelector('time[datetime]');
    if (t) {
      const dt = t.getAttribute('datetime') || '';
      const ms = Date.parse(dt);
      return { raw: dt, ms: Number.isNaN(ms) ? NaN : ms };
    }
    // title 属性に日時が入るケース
    const titled = el.querySelector('[title]');
    if (titled) {
      const raw = titled.getAttribute('title') || '';
      const ms = Date.parse(raw);
      if (!Number.isNaN(ms)) return { raw, ms };
    }
    return { raw: '', ms: NaN };
  }

  function _getReactions(el) {
    const out = [];
    const pills = _qsAllFirst(el, SELECTORS.reaction);
    for (const p of pills) {
      const text = (p.textContent || '').replace(/\s+/g, ' ').trim();
      // 絵文字画像の alt も拾う
      const img = p.querySelector('img[alt]');
      const alt = img ? (img.getAttribute('alt') || '').trim() : '';
      const combined = [alt, text].filter(Boolean).join(' ').trim();
      if (combined) out.push(combined);
    }
    return out;
  }

  /**
   * body-level メッセージ要素から row らしき祖先まで広げる。
   * message が messageBodyContainer / .message-body でマッチした場合、ファイルカードは
   * body の兄弟（row 配下）にあるため、closest で row まで上がってから探す。
   * row らしき祖先が無ければ el 自身を返す（degrade）。
   */
  function _messageRow(el) {
    try {
      return el.closest(SELECTORS.messageRow.join(',')) || el;
    } catch {
      return el;
    }
  }

  /**
   * 本文クローンから添付（画像・ファイルカード）要素を抽出し、
   * クローン側からは除去する（本文 Markdown と添付一覧の二重化を避ける）。
   * @returns {Array<{kind:'image'|'file', name:string, url:string}>}
   */
  function _extractAttachments(messageEl, bodyClone) {
    const list = [];

    // 画像（絵文字・アバターは除外）
    const imgs = bodyClone.querySelectorAll('img');
    imgs.forEach((img) => {
      const src = img.getAttribute('src') || '';
      if (!src) return;
      const w = img.naturalWidth || parseInt(img.getAttribute('width') || '0', 10);
      const h = img.naturalHeight || parseInt(img.getAttribute('height') || '0', 10);
      const isEmoji =
        /emoji|emoticon|skypeemoji/i.test(src) ||
        img.closest('[class*="emoji"]') !== null;
      const isAvatar =
        /avatar|profilepic|userTile/i.test(src) ||
        img.closest('[class*="avatar"], [class*="persona"]') !== null;
      // 小さすぎる装飾画像はスキップ
      if (isEmoji || isAvatar || (w && w < 32) || (h && h < 32)) {
        img.remove();
        return;
      }
      const alt = (img.getAttribute('alt') || '').trim();
      list.push({ kind: 'image', name: alt || 'image', url: src });
      img.remove();
    });

    // ファイルカード（本文とは別枠のファイル）。body-level セレクタがマッチした場合は
    // カードが body の兄弟（row 配下）にあるため、row らしき祖先まで広げて探す。
    const cards = _qsAllFirst(_messageRow(messageEl), SELECTORS.fileCard);
    cards.forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (!href) return;
      const name =
        (a.getAttribute('title') || a.textContent || '').replace(/\s+/g, ' ').trim() ||
        'file';
      list.push({ kind: 'file', name, url: href });
    });

    return list;
  }

  /**
   * 1 メッセージ要素を解析してレコード化する。
   * @param {Element} el メッセージ要素
   * @param {number} round 収集ラウンド（_captureInto 呼び出し回数。下端=0 で上へ行くほど増える）
   * @param {number} domIndex そのラウンドの viewport 内 DOM 順インデックス（古→新で増加）
   * @returns {{id:string, sortKey:number, author:string, tsRaw:string,
   *            bodyMd:string, reactions:string[], attachments:object[]}|null}
   */
  function _parseMessage(el, round, domIndex) {
    const bodyEl = _getBodyElement(el);
    // 本文クローンから添付を抜いてから Markdown 化する
    const bodyClone = bodyEl.cloneNode(true);
    const attachments = _extractAttachments(el, bodyClone);
    let bodyMd = '';
    try {
      bodyMd =
        typeof MarkdownBuilder !== 'undefined'
          ? MarkdownBuilder.htmlToMarkdown(bodyClone)
          : (bodyClone.textContent || '').trim();
    } catch {
      bodyMd = (bodyClone.textContent || '').trim();
    }

    const author = _getAuthor(el);
    const ts = _getTimestamp(el);
    const reactions = _getReactions(el);

    // 本文も添付もリアクションも空なら、システム行などとみなしスキップ
    if (!bodyMd && attachments.length === 0 && reactions.length === 0) {
      return null;
    }

    const rawId = _messageId(el);
    // 合成キー（data-mid / 一意 id が無い行用）。本文だけだと、同一送信者・同一時刻の
    // 添付のみ / リアクションのみメッセージが `author::ts::`（空本文）に潰れて 2 件目以降が
    // 捨てられる。添付は **URL を弁別子に含める**（既定名 "image" の貼り付け画像連投でも
    // URL は異なるため区別できる）。収集は下→上の単調スクロールで、各メッセージは可視区間中
    // （mounted のまま）に隣接ラウンドで再キャプチャされるだけなので URL は安定し、重複除去も保てる。
    const attachSig = attachments.map((a) => `${a.kind}:${a.name}:${a.url}`).join('|');
    const reactSig = reactions.join(',');
    const id =
      rawId ||
      `${author}::${ts.raw}::${bodyMd.slice(0, 80)}::${attachments.length}:${attachSig}::${reactSig}`;
    const numeric = _numericId(rawId);
    // フォールバック sortKey（id も timestamp も無い行用）: _collectRecords は下端（最新）から
    // 上へ収集するため round が大きいほど古い。-(round*STRIDE)+domIndex とすることで
    // 「古い round ほど小さい値」かつ「同一 viewport 内は DOM 順（古→新）で増加」になり、
    // 昇順ソートで時系列に並ぶ（収集順 seq のままだと newest-block-first で逆順になる）。
    const sortKey = !Number.isNaN(numeric)
      ? numeric
      : !Number.isNaN(ts.ms)
        ? ts.ms
        : -(round * FALLBACK_ROUND_STRIDE) + domIndex;

    return {
      id,
      sortKey,
      author,
      tsRaw: ts.raw,
      bodyMd,
      reactions,
      attachments,
    };
  }

  /* ── 自動スクロール収集 ─────────────────────────── */

  function _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function _captureInto(map, roundRef) {
    // 1 回の _captureInto = 1 ラウンド。下端から上へ進むので round が大きいほど古い viewport。
    const round = roundRef.value++;
    const els = _findMessages();
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      // 安定 id があり既に収集済みなら、重い _parseMessage（cloneNode + htmlToMarkdown）を省く。
      // 仮想スクロールで同一要素が複数反復の viewport に跨るため、再パースの無駄が大きい。
      const rawId = _messageId(el);
      if (rawId && map.has(rawId)) continue;
      // domIndex は viewport 内 DOM 順（古→新）。フォールバック sortKey の時系列復元に使う。
      const rec = _parseMessage(el, round, i);
      if (!rec) continue;
      if (!map.has(rec.id)) {
        map.set(rec.id, rec);
      }
    }
  }

  /**
   * 下端から上端まで段階的にスクロールしながら全メッセージを収集する。
   * @returns {Promise<Array>} 時系列ソート済みレコード配列
   */
  async function _collectRecords() {
    const scroller = _findScroller();
    const map = new Map();
    const roundRef = { value: 0 };
    const startHref = location.href; // 収集中にページ/会話が変わったら中断する基準

    if (!scroller) {
      // スクローラ不明: 現在表示分だけでも回収して返す
      _captureInto(map, roundRef);
      return _finalizeWithWarn(map, scroller);
    }

    // まず下端（最新）に寄せて初回キャプチャ
    try {
      scroller.scrollTop = scroller.scrollHeight;
    } catch {
      /* スクロール不可は無視 */
    }
    await _delay(STEP_WAIT_MS);
    _captureInto(map, roundRef);

    const start = Date.now();
    let stagnant = 0;
    let iter = 0;

    while (iter < MAX_ITERATIONS) {
      iter++;
      if (Date.now() - start > MAX_DURATION_MS) break;
      if (map.size >= MAX_MESSAGES) break;
      // ユーザーが別会話へ切替 / ページ遷移したら中断（誤会話の収集と DOM 奪い合いを防ぐ）
      if (location.href !== startHref) break;

      const prevHeight = scroller.scrollHeight;
      const prevTop = scroller.scrollTop;

      if (prevTop <= 0) {
        // 上端: 古いメッセージの読み込みを待つ
        scroller.scrollTop = 0;
        await _delay(LOAD_WAIT_MS);
        _captureInto(map, roundRef);
        if (scroller.scrollHeight > prevHeight + 4) {
          stagnant = 0; // 古い分が読み込まれた → 継続
        } else {
          stagnant++;
          if (stagnant >= STABLE_ROUNDS) break; // 本当に先頭に到達
        }
      } else {
        // 読み込み済み範囲を 1 段ずつ上へ（全メッセージを viewport に通す）
        const step = Math.max(200, Math.floor(scroller.clientHeight * 0.8));
        scroller.scrollTop = Math.max(0, prevTop - step);
        await _delay(STEP_WAIT_MS);
        _captureInto(map, roundRef);
        stagnant = 0;
      }
    }

    return _finalizeWithWarn(map, scroller);
  }

  /** Map → 時系列ソート → 送信者の前方補完（グループ化された継続メッセージ対策）。 */
  function _finalize(map) {
    const records = Array.from(map.values());
    records.sort((a, b) => a.sortKey - b.sortKey);
    // Teams は同一送信者の連投で名前を 1 度しか出さない。
    // 時系列順に並べた後、空の送信者を直前の送信者で補完する。
    let lastAuthor = '';
    for (const r of records) {
      if (r.author) {
        lastAuthor = r.author;
      } else if (lastAuthor) {
        r.author = lastAuthor;
      }
    }
    return records;
  }

  /** _finalize に加え、0 件のときは切り分け用に必ず警告ログを残す。 */
  function _finalizeWithWarn(map, scroller) {
    const records = _finalize(map);
    if (records.length === 0) {
      // 0 件は最も壊れやすい「Teams DOM 変更でセレクタ全滅」のサイン。無言にしない。
      console.warn(
        '[ReviewForMD][Teams] 収集メッセージ 0 件 / scroller=', !!scroller,
        'msgEls=', _findMessages().length
      );
    }
    return records;
  }

  /* ── Markdown 生成 ─────────────────────────────── */

  /** ファイル名/パスとして安全な文字列にする。 */
  function _safeName(name, fallback) {
    let s = (typeof name === 'string' ? name : '').normalize('NFKC');
    s = s
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/[‎‏‪-‮⁦-⁩]/g, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+|\.+$/g, '')
      .trim();
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i.test(s)) {
      s = '_' + s; // Windows 予約名（button_injector の _sanitizeFilename と同方針）
    }
    if (s.length > 120) s = s.slice(0, 120).trim();
    return s || fallback || 'item';
  }

  /** URL のパス末尾から拡張子を推測する。 */
  function _extFromUrl(url) {
    try {
      const u = new URL(url, location.href);
      const m = u.pathname.match(/\.([A-Za-z0-9]{1,8})$/);
      return m ? '.' + m[1].toLowerCase() : '';
    } catch {
      return '';
    }
  }

  /** ログ用に URL から機微なクエリ（SAS トークン等）を落とし origin+pathname だけにする。 */
  function _redactUrl(url) {
    try {
      const u = new URL(url, location.href);
      return u.origin + u.pathname;
    } catch {
      return '(invalid url)';
    }
  }

  /**
   * Markdown のインライン構文位置（見出し・著者名等）に外部由来文字列を埋める前のエスケープ。
   * 改行除去 + raw HTML 無効化(<) + 構造文字の無害化（HTML 許容 MD ビューアでのインジェクション対策）。
   */
  function _escapeMdInline(s) {
    return String(s == null ? '' : s)
      .replace(/[\r\n]+/g, ' ')
      .replace(/</g, '&lt;')
      .replace(/([\\`*_#\[\]])/g, '\\$1')
      .trim();
  }

  /**
   * Markdown リンクのテキスト部 `[...]` を壊さないようエスケープする。
   * MarkdownBuilder のリンクエスケープを単一の真実の源として再利用し、
   * 未ロード時のみローカルフォールバック（[ と ] を退避）。
   */
  function _mdLinkText(s) {
    const t = String(s == null ? '' : s);
    return (typeof MarkdownBuilder !== 'undefined' && MarkdownBuilder.sanitizeLinkText)
      ? MarkdownBuilder.sanitizeLinkText(t)
      : t.replace(/[[\]]/g, '\\$&');
  }

  /**
   * Markdown リンクの URL 部 `(...)` を壊さないようエスケープする。
   * MarkdownBuilder のリンク URL エスケープを再利用（未ロード時のみローカルフォールバック）。
   */
  function _mdLinkUrl(s) {
    const t = String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]/g, '').trim();
    // 危険スキーム（javascript:/vbscript:/data:/file:/about:）はリンク化しない。
    // 添付 URL は送信者制御の外部由来なので、空を返して呼び出し側でプレーンテキストに落とす
    // （HTML 許容 MD ビューアでの XSS / 巨大 data: URL の埋め込みを防ぐ）。
    if (/^(javascript|vbscript|data|file|about):/i.test(t)) return '';
    return (typeof MarkdownBuilder !== 'undefined' && MarkdownBuilder.sanitizeLinkUrl)
      ? MarkdownBuilder.sanitizeLinkUrl(t)
      : t.replace(/\)/g, '%29').replace(/[ \t]/g, '%20').replace(/"/g, '%22').replace(/'/g, '%27');
  }

  /**
   * レコード配列から Markdown 本文を組み立てる。
   * @param {string} title 会話タイトル
   * @param {Array} records レコード
   * @param {Map<string,string>|null} localPaths url→ZIP内ローカルパス（ZIP 経路のみ）
   */
  function _buildMarkdown(title, records, localPaths) {
    const lines = [];
    lines.push(`# ${_escapeMdInline(title)}`);
    lines.push('');
    lines.push(`> Microsoft Teams チャット書き出し / メッセージ数: ${records.length}`);
    lines.push('');

    for (const r of records) {
      const ts = r.tsRaw
        ? (typeof MarkdownBuilder !== 'undefined'
            ? MarkdownBuilder.formatTimestamp(r.tsRaw)
            : r.tsRaw)
        : '';
      const author = _escapeMdInline(r.author || '不明');
      const head = ts ? `**${author}** · ${ts}` : `**${author}**`;
      lines.push(`### ${head}`);
      lines.push('');
      if (r.bodyMd) {
        lines.push(r.bodyMd);
        lines.push('');
      }
      if (r.attachments.length) {
        for (const att of r.attachments) {
          const ref = localPaths && localPaths.has(att.url)
            ? localPaths.get(att.url)
            : att.url;
          const icon = att.kind === 'image' ? '🖼' : '📎';
          // 添付名・URL は送信者が制御できるため、Markdown のリンク構文を壊す/注入する
          // メタ文字（]・) 等）を MarkdownBuilder と同じ規則でエスケープしてから埋め込む。
          const label = _mdLinkText(_safeName(att.name, att.kind));
          const safeRef = _mdLinkUrl(ref);
          // 危険スキーム等で safeRef が空のときはリンク化せずプレーンテキストにする
          lines.push(safeRef ? `- ${icon} [${label}](${safeRef})` : `- ${icon} ${label}`);
        }
        lines.push('');
      }
      if (r.reactions.length) {
        lines.push(`*リアクション: ${r.reactions.join(' / ')}*`);
        lines.push('');
      }
      lines.push('---');
      lines.push('');
    }

    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  /* ── 添付取得（ZIP 経路）─────────────────────────── */

  /**
   * Response を「上限バイト」を超えない範囲でストリーム読みして Uint8Array 化する。
   * Content-Length が判明していれば全読み前に弾き、不明/虚偽でも running limit で
   * 打ち切る。巨大ファイルを `arrayBuffer()` で丸ごとバッファしてからチェックする
   * （＝上限が効く前に OOM する）のを防ぐ。
   * @param {Response} res
   * @param {number} maxBytes
   * @returns {Promise<Uint8Array>}
   */
  async function _readBoundedBytes(res, maxBytes) {
    if (!(maxBytes > 0)) throw new Error('添付合計上限に到達');
    const len = Number(res.headers.get('content-length'));
    if (Number.isFinite(len) && len > maxBytes) {
      try { await res.body?.cancel(); } catch { /* 既に閉じている等 */ }
      throw new Error(`添付がサイズ上限を超過: ${len} bytes`);
    }
    // ストリーム非対応環境では arrayBuffer にフォールバック（事後に上限チェック）
    if (!res.body || typeof res.body.getReader !== 'function') {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > maxBytes) throw new Error(`添付がサイズ上限を超過: ${bytes.length} bytes`);
      return bytes;
    }
    // Content-Length 不明/虚偽でも、読みながら上限超過で即打ち切る
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* 既に閉じている等 */ }
        throw new Error(`添付がサイズ上限を超過: >${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  /**
   * 添付 1 件の実バイトを取得する。
   * 単体上限と「残り合計予算」の小さい方を上限にストリーム読みするため、
   * 巨大ファイル 1 件でも、複数大容量ファイルでも、バッファ前にサイズで弾ける。
   * @param {string} url
   * @param {{remaining:number}} [budget] ZIP 全体で共有する残り合計バイト予算
   * @returns {Promise<Uint8Array>}
   */
  async function _fetchAttachmentBytes(url, budget) {
    if (!_isAllowedAttachmentUrl(url)) {
      throw new Error('許可されていない添付オリジンです');
    }
    const u = new URL(url, location.href);
    const opts =
      u.protocol === 'blob:'
        ? { cache: 'no-store' }
        : { credentials: 'include', cache: 'no-store' };

    // 予算は「読み込み前に予約」する。読み込み後に消費する方式だと、4 並列が同時に
    // 各 MAX_ATTACH_SINGLE_BYTES を確保してから減算するため、ピークが合計上限を超えうる
    // （Codex 指摘: 約 640MB まで膨らむ）。予約方式なら同時に確保できるバッファの総和が
    // 常に予算（=合計上限）以内に収まる。
    let reserved = MAX_ATTACH_SINGLE_BYTES;
    if (budget) {
      reserved = Math.min(MAX_ATTACH_SINGLE_BYTES, Math.max(0, budget.remaining));
      if (reserved <= 0) throw new Error('添付合計上限に到達');
      budget.remaining -= reserved;
    }
    try {
      // 429/503/一時障害は 1 回までリトライ（添付の取りこぼし低減）
      const res = await RfmdFetch.withRetry(u.href, opts, 1);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const bytes = await _readBoundedBytes(res, reserved);
      if (budget) {
        budget.remaining += reserved - bytes.length; // 予約超過分（未使用枠）を返金
        reserved = 0; // 返金済み → finally での二重返金を防ぐ
      }
      return bytes;
    } finally {
      // 取得失敗・サイズ超過時は予約を全額返金して後続ワーカーへ回す
      if (budget && reserved > 0) budget.remaining += reserved;
    }
  }

  /* ── 公開 API ─────────────────────────────────── */

  /**
   * Teams チャット画面でメッセージが存在するかを判定する（軽量・スクロールしない）。
   * @returns {Promise<{available:boolean, reason?:string}>}
   */
  /**
   * チャット/チャネルのメッセージ系 DOM が存在するか。
   * Teams 判定セレクタの単一の真実の源として site_detector._isTeamsChatByDom が委譲する
   * （detect 側と extract 側でセレクタが分裂するのを防ぐ）。
   */
  function hasChatDom() {
    try {
      return _findMessages().length > 0 || !!_qsFirst(document, SELECTORS.scroller);
    } catch {
      return false;
    }
  }

  async function checkAvailability() {
    if (_availabilityCacheUrl === location.href && _availabilityCache) {
      return _availabilityCache;
    }
    const msgs = _findMessages();
    if (msgs.length > 0) {
      const result = { available: true };
      _availabilityCache = result;
      _availabilityCacheUrl = location.href;
      return result;
    }
    // 未検出はキャッシュしない（SPA でメッセージが後から描画されるため再評価を許す）
    return { available: false, reason: 'no-messages' };
  }

  /** 会話タイトルを取得する（DOM → document.title フォールバック）。 */
  function getTitle() {
    const el = _qsFirst(document, SELECTORS.title);
    const fromDom = el ? (el.textContent || '').trim() : '';
    if (fromDom) return fromDom;
    const dt = document.title
      .replace(/\s*[\|–\-]\s*Microsoft Teams.*$/i, '')
      .trim();
    return dt || 'teams-chat';
  }

  /**
   * 全履歴を収集して Markdown 文字列を返す（MD ダウンロード用）。
   * @returns {Promise<string>}
   */
  async function extractAll() {
    if (_busy) throw new Error('別の収集処理が実行中です。完了までお待ちください');
    _busy = true;
    try {
      const records = await _collectRecords();
      return { markdown: _buildMarkdown(getTitle(), records, null), count: records.length };
    } finally {
      _busy = false;
    }
  }

  /**
   * 全履歴 + 添付実バイトを収集し、ZIP（transcript.md + attachments/）を返す。
   * @returns {Promise<{blob: Blob, filename: string}>}
   */
  async function extractWithAttachments() {
    if (_busy) throw new Error('別の収集処理が実行中です。完了までお待ちください');
    _busy = true;
    try {
      const title = getTitle();
      const records = await _collectRecords();

      // 添付タスクを平坦化（同一 URL は 1 度だけ）。収集順を保持し採番を決定的にする。
      const seen = new Set();
      const tasks = [];
      for (const r of records) {
        for (const att of r.attachments) {
          if (seen.has(att.url)) continue;
          seen.add(att.url);
          tasks.push(att);
        }
      }

      // 並列度制限プールでバイト取得（直列だと添付数 × RTT で遅い）。
      // ZIP 全体で残り合計バイト予算を共有し、複数大容量ファイルでも合計上限を超える前に
      // 取得を打ち切ってバッファ蓄積による OOM を防ぐ。
      const budget = { remaining: MAX_ATTACH_TOTAL_BYTES };
      const bytesByIndex = new Array(tasks.length).fill(null);
      let cursor = 0;
      async function _worker() {
        while (true) {
          const i = cursor++;
          if (i >= tasks.length) break;
          try {
            bytesByIndex[i] = await _fetchAttachmentBytes(tasks[i].url, budget);
          } catch (e) {
            bytesByIndex[i] = null;
            // SAS トークンを含みうる URL はそのまま出さず redact する
            console.debug('[ReviewForMD][Teams] 添付取得失敗:', _redactUrl(tasks[i].url), e?.message || e);
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(ATTACH_CONCURRENCY, tasks.length) }, _worker)
      );

      /** url → ZIP 内ローカルパス */
      const localPaths = new Map();
      /** @type {Array<{name:string, data:Uint8Array}>} */
      const files = [];
      const usedNames = new Set();
      let counter = 0;
      let totalBytes = 0;

      // 採番・同梱はインデックス順で決定的に行う
      for (let i = 0; i < tasks.length; i++) {
        const att = tasks[i];
        const bytes = bytesByIndex[i];
        if (!bytes) continue; // 取得失敗 → リモート URL リンクのまま残す
        // 合計バイト上限を超えたら同梱せずリンクのまま残す（OOM 防止）
        if (totalBytes + bytes.length > MAX_ATTACH_TOTAL_BYTES) continue;
        totalBytes += bytes.length;
        counter++;
        let base = _safeName(att.name, att.kind);
        // 拡張子が無ければ URL から補う（_extFromUrl は英数字のみ抽出＝安全）
        if (!/\.[A-Za-z0-9]{1,8}$/.test(base)) {
          base += _extFromUrl(att.url) || (att.kind === 'image' ? '.png' : '');
        }
        // 衝突回避
        let name = base;
        let n = 1;
        while (usedNames.has(name.toLowerCase())) {
          const dot = base.lastIndexOf('.');
          name = dot > 0 ? `${base.slice(0, dot)}_${n}${base.slice(dot)}` : `${base}_${n}`;
          n++;
        }
        usedNames.add(name.toLowerCase());
        const path = `attachments/${String(counter).padStart(3, '0')}_${name}`;
        files.push({ name: path, data: bytes });
        localPaths.set(att.url, path);
      }

      const markdown = _buildMarkdown(title, records, localPaths);
      const entries = [{ name: 'transcript.md', data: markdown }, ...files];
      const blob = RfmdZip.create(entries);
      const filename = _safeName(title, 'teams-chat') + '.zip';
      return { blob, filename, count: records.length };
    } finally {
      _busy = false;
    }
  }

  /** ページ遷移時にキャッシュをクリアする。 */
  function reset() {
    _availabilityCache = null;
    _availabilityCacheUrl = '';
  }

  return { checkAvailability, hasChatDom, getTitle, extractAll, extractWithAttachments, reset };
})();
