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
 *   4. Markdown を生成
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
  /** 収集メッセージ数の上限（暴走防止。50000 だとピーク ~180MB に達しうるため 15000 に縮小） */
  const MAX_MESSAGES = 15000;
  /**
   * フォールバック sortKey のラウンド間ストライド。
   * 1 viewport 内のメッセージ数より十分大きくし、ラウンドをまたいだ順序が
   * viewport 内 DOM 順（domIndex）で乱れないようにする。
   */
  const FALLBACK_ROUND_STRIDE = 1e6;

  /** 抽出の再入ガード（同一ページで収集ループの多重起動・DOM 奪い合いを防ぐ） */
  let _busy = false;

  /**
   * 中断フラグ。オーバーレイの「ここまでで保存」で立てる。
   * 収集ループが次のチェックで break し、それまでに集めた分で finalize → 保存/コピーする。
   */
  let _cancelRequested = false;
  /**
   * 破棄フラグ。オーバーレイの「中止」やページ遷移（reset）で立てる。
   * 収集ループを止めたうえで、完了処理で保存もコピーもせずオーバーレイを閉じる。
   */
  let _discarded = false;

  /* ── 状態 ─────────────────────────────────────────── */

  let _availabilityCache = null;
  let _availabilityCacheUrl = '';

  /** 進捗オーバーレイ（収集中にページ右下へ出すパネル）の DOM 参照 */
  let _overlayEl = null;
  let _overlayProgressEl = null;
  let _overlayActionsEl = null;

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

  /**
   * メッセージの送信日時を取る。
   * @returns {{raw:string, ms:number, precise:boolean}}
   *   precise=true は `time[datetime]` 由来でパース成功＝送信時刻として信頼できることを示す。
   *   title フォールバックは添付ファイルの更新日や引用ブロックの日付など「送信時刻ではない
   *   日付」を拾う恐れがあるため precise=false とし、期間打ち切り/フィルタの判定には使わない
   *   （誤った古い日付で期間内メッセージを取りこぼすのを防ぐ。ソート用には引き続き使う）。
   */
  function _getTimestamp(el) {
    const t = el.querySelector('time[datetime]');
    if (t) {
      const dt = t.getAttribute('datetime') || '';
      const ms = Date.parse(dt);
      if (!Number.isNaN(ms)) return { raw: dt, ms, precise: true };
    }
    // title 属性に日時が入るケース。row スコープでは添付カードのファイル名等、非日時の title が
    // 先に来ることがあるため、最初の 1 件で諦めず、パース可能な title が見つかるまで走査する。
    const titled = el.querySelectorAll('[title]');
    for (const node of titled) {
      const raw = node.getAttribute('title') || '';
      const ms = Date.parse(raw);
      if (!Number.isNaN(ms)) return { raw, ms, precise: false };
    }
    return { raw: '', ms: NaN, precise: false };
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

  /** 安定 id。body-level 一致時は row 側の data-mid/id を拾う（_messageId の row フォールバック）。 */
  function _stableId(el) {
    return _messageId(el) || _messageId(_messageRow(el));
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
      const att = { kind: 'image', name: alt || 'image', url: src };
      list.push(att);
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

    // body-level セレクタ（messageBodyContainer / .message-body）がマッチした場合、
    // author / timestamp / reaction は body の外側（row）に兄弟として置かれることが多いため、
    // ファイルカードと同様に row らしき祖先まで広げてから取る。
    const rowEl = _messageRow(el);
    const author = _getAuthor(rowEl);
    const ts = _getTimestamp(rowEl);
    const reactions = _getReactions(rowEl);

    // 本文も添付もリアクションも空なら、システム行などとみなしスキップ
    if (!bodyMd && attachments.length === 0 && reactions.length === 0) {
      return null;
    }

    // body-level セレクタ一致時、安定 id（data-mid / id）は body ではなく row 側にあることが
    // 多い。row も見て拾うことで、合成キーへのフォールバックと numeric ID 順の喪失を防ぐ。
    const rawId = _messageId(el) || _messageId(rowEl);
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
    // 収集順から復元した時系列キー: _collectRecords は下端（最新）から上へ収集するため
    // round が大きいほど古い。-(round*STRIDE)+domIndex で「古い round ほど小さい値」かつ
    // 「同一 viewport 内は DOM 順（古→新）で増加」になり、昇順ソートで時系列に並ぶ。
    const seqKey = -(round * FALLBACK_ROUND_STRIDE) + domIndex;
    // 主キー: mid(numeric) → timestamp(ms) → seqKey の優先。
    const sortKey = !Number.isNaN(numeric)
      ? numeric
      : !Number.isNaN(ts.ms)
        ? ts.ms
        : seqKey;

    return {
      id,
      sortKey,
      seqKey, // sortKey 同値（粗いタイムスタンプで複数メッセージが同分など）のタイブレーカ
      tsMs: ts.ms, // ソート/期間判定用の epoch ms（取れなければ NaN）
      tsPrecise: ts.precise, // tsMs が time[datetime] 由来で信頼できるか（期間打ち切り判定に使う条件）
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

  /**
   * 現在の viewport の可視メッセージを map に回収する（1 回 = 1 ラウンド）。
   * @param {Map} map 収集 Map
   * @param {{value:number}} roundRef ラウンドカウンタ
   * @param {number|null} sinceMs 期間打ち切り基準（これより古い ts を見たら遡り終了）
   * @returns {boolean} このラウンドで sinceMs より古いメッセージを見たか（＝もう十分遡った）
   */
  function _captureInto(map, roundRef, sinceMs) {
    // 下端から上へ進むので round が大きいほど古い viewport。
    const round = roundRef.value++;
    const els = _findMessages();
    let reachedCutoff = false;
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      // 安定 id があり既に収集済みなら、重い _parseMessage（cloneNode + htmlToMarkdown）を省く。
      // 仮想スクロールで同一要素が複数反復の viewport に跨るため、再パースの無駄が大きい。
      // body-level 一致時は row 側の id を拾う（_parseMessage の rawId と整合させる）。
      const rawId = _stableId(el);
      if (rawId && map.has(rawId)) continue;
      // domIndex は viewport 内 DOM 順（古→新）。フォールバック sortKey の時系列復元に使う。
      const rec = _parseMessage(el, round, i);
      if (!rec) continue;
      if (!map.has(rec.id)) {
        map.set(rec.id, rec);
      }
      // 信頼できる送信時刻（time[datetime] 由来）が期間基準より古ければ、ここより上は全部
      // 期間外（時系列）→ 遡り終了。title 由来の粗い/疑わしい日付では打ち切らない（誤った
      // 古い日付で期間内メッセージを取りこぼすのを防ぐ）。既収集分（早期 continue した分）は
      // 前ラウンドで判定済みなので、新規分だけ見れば十分。
      if (sinceMs && rec.tsPrecise && !Number.isNaN(rec.tsMs) && rec.tsMs < sinceMs) {
        reachedCutoff = true;
      }
    }
    return reachedCutoff;
  }

  /**
   * 下端から上端まで段階的にスクロールしながらメッセージを収集する。
   * 中止（_cancelRequested / _discarded）・期間打ち切り（sinceMs）・進捗通知（onProgress）に対応。
   * @param {{sinceMs?:number|null, onProgress?:(info:{count:number, elapsedMs:number})=>void}} [options]
   * @returns {Promise<{records:Array, rawCount:number}>}
   *   records=期間フィルタ＋時系列ソート済み、rawCount=フィルタ前の生収集件数（0件判定の切り分け用）
   */
  async function _collectRecords(options = {}) {
    const { sinceMs = null, onProgress = null } = options;
    const scroller = _findScroller();
    const map = new Map();
    const roundRef = { value: 0 };
    const startHref = location.href; // 収集中にページ/会話が変わったら中断する基準
    const start = Date.now();

    const reportProgress = () => {
      if (!onProgress) return;
      try {
        onProgress({ count: map.size, elapsedMs: Date.now() - start });
      } catch {
        /* 進捗コールバックの失敗は収集本体に波及させない */
      }
    };

    if (!scroller) {
      // スクローラ不明: 現在表示分だけでも回収して返す
      _captureInto(map, roundRef, sinceMs);
      reportProgress();
      return _finalizeResult(map, sinceMs, scroller);
    }

    // まず下端（最新）に寄せて初回キャプチャ
    try {
      scroller.scrollTop = scroller.scrollHeight;
    } catch {
      /* スクロール不可は無視 */
    }
    await _delay(STEP_WAIT_MS);
    // wait 中に会話切替が起きたら初回 capture もスキップ（ループ内 wait の guard と同様。
    // スキップ後は直後の while 先頭 guard が startHref 不一致で即 break する）。
    if (location.href === startHref && !_discarded) {
      const hit = _captureInto(map, roundRef, sinceMs);
      reportProgress();
      if (hit) return _finalizeResult(map, sinceMs, scroller); // 最新分が既に期間外
    }

    let stagnant = 0;
    let iter = 0;

    while (iter < MAX_ITERATIONS) {
      iter++;
      if (Date.now() - start > MAX_DURATION_MS) break;
      if (map.size >= MAX_MESSAGES) break;
      // ユーザーが「ここまでで保存」/「中止」を押したら停止（それまでの分は呼び出し側で処理）
      if (_cancelRequested || _discarded) break;
      if (iter % 50 === 0) {
        console.debug(`[ReviewForMD][Teams] 収集中: ${map.size} 件 / iter=${iter} / elapsed=${Date.now() - start}ms`);
      }
      // ユーザーが別会話へ切替 / ページ遷移したら中断（誤会話の収集と DOM 奪い合いを防ぐ）
      if (location.href !== startHref) break;

      const prevHeight = scroller.scrollHeight;
      const prevTop = scroller.scrollTop;

      if (prevTop <= 0) {
        // 上端: 古いメッセージの読み込みを待つ
        scroller.scrollTop = 0;
        await _delay(LOAD_WAIT_MS);
        // wait 中に会話切替/中止が起きると新会話の DOM 混入や無駄処理になるため、capture 前に再チェック
        if (location.href !== startHref || _discarded) break;
        const hit = _captureInto(map, roundRef, sinceMs);
        reportProgress();
        if (hit) break; // 期間基準に到達 → 遡り終了
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
        // wait 中に会話切替/中止が起きると新会話の DOM 混入や無駄処理になるため、capture 前に再チェック
        if (location.href !== startHref || _discarded) break;
        const hit = _captureInto(map, roundRef, sinceMs);
        reportProgress();
        if (hit) break; // 期間基準に到達 → 遡り終了
        stagnant = 0;
      }
    }

    return _finalizeResult(map, sinceMs, scroller);
  }

  /**
   * Map → 時系列ソート → 送信者の前方補完 → 期間フィルタ。
   *
   * 補完を「フィルタより前・全レコード」で行うのが要点: Teams は同一送信者の連投で名前を
   * 先頭 1 件にしか出さない。先にフィルタすると「著者名を持つグループ先頭（期間外）」が落ち、
   * 期間内の継続分の補完シードが失われて著者『不明』になる。先に全件で補完してからフィルタ
   * すれば境界グループにも正しい著者が引き継がれる（tsMs は補完で変わらず期間整合も保てる）。
   *
   * @param {Map} map
   * @param {number|null} sinceMs これより古い「信頼できる ts（time[datetime] 由来）」を持つ
   *   レコードのみ除外。title 由来の粗い ts / ts 不明は残す（誤った古い日付での除外を防ぐ）。
   */
  function _finalize(map, sinceMs) {
    const records = Array.from(map.values());
    // 主キー sortKey、同値時は seqKey（収集順から復元した時系列）でタイブレーク。
    // 粗いタイムスタンプ（分単位）で複数メッセージが同じ ts.ms を持つとき、収集が下→上のため
    // 同分内が newest-before-oldest にならないよう、seqKey で chronological に整える。
    records.sort((a, b) => (a.sortKey - b.sortKey) || (a.seqKey - b.seqKey));
    // 空の送信者を直前の送信者で補完（フィルタ前の全件で行う＝上記コメント参照）。
    let lastAuthor = '';
    for (const r of records) {
      if (r.author) {
        lastAuthor = r.author;
      } else if (lastAuthor) {
        r.author = lastAuthor;
      }
    }
    // 期間フィルタ: 信頼できる ts が基準より古いものだけ落とす。
    if (sinceMs) {
      return records.filter((r) => !(r.tsPrecise && !Number.isNaN(r.tsMs) && r.tsMs < sinceMs));
    }
    return records;
  }

  /**
   * _finalize に加え、生収集 0 件のときは切り分け用に必ず警告ログを残す。
   * @returns {{records:Array, rawCount:number}}
   */
  function _finalizeResult(map, sinceMs, scroller) {
    const rawCount = map.size;
    const records = _finalize(map, sinceMs);
    if (rawCount === 0) {
      // 生 0 件は最も壊れやすい「Teams DOM 変更でセレクタ全滅」のサイン。無言にしない。
      // （期間フィルタで 0 件になったケースは rawCount>0 なので区別できる）
      console.warn(
        '[ReviewForMD][Teams] 収集メッセージ 0 件 / scroller=', !!scroller,
        'msgEls=', _findMessages().length
      );
    }
    return { records, rawCount };
  }

  /* ── Markdown 生成 ─────────────────────────────── */

  /** ファイル名/パスとして安全な文字列にする。 */
  function _safeName(name, fallback) {
    let s = (typeof name === 'string' ? name : '').normalize('NFKC');
    s = s
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/[‎‏‪-‮⁦-⁩]/g, '')
      .replace(/[﻿⁠]/g, '')
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
   */
  function _buildMarkdown(title, records) {
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
          const ref = att.url;
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

  /* ── 進捗オーバーレイ（収集中にページ右下へ出すパネル）──────────── */
  /*
   * 設計メモ: Teams 収集は長時間（数十秒〜数分）かかり、その間 popup は閉じられ得る。
   * そのため進捗表示・中止操作・保存/コピーまでを popup ではなくページ側オーバーレイで
   * 完結させる（popup は startCollection を呼ぶ「開始トリガー」のみ）。これで
   *   - popup を閉じても進捗が見え、いつでも中止できる
   *   - copy も収集完了後にオーバーレイのボタン（ユーザー操作）から実行でき、
   *     「popup を閉じると copy が失敗する」問題を回避できる
   * となる。innerHTML 不使用（CLAUDE.md 方針）で DOM 構築する。
   */

  /** 要素を作る小ヘルパ（tag / class / textContent）。 */
  function _el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  /** オーバーレイ用ボタンを作る。 */
  function _overlayButton(label, variant, onClick) {
    const cls =
      'rfmd-teams-overlay__btn ' +
      (variant === 'primary' ? 'rfmd-teams-overlay__btn--primary' : 'rfmd-teams-overlay__btn--ghost');
    const b = _el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  /** RfmdClipboard を安全に取得（未ロード時は null）。 */
  function _clip() {
    return typeof RfmdClipboard !== 'undefined' ? RfmdClipboard : null;
  }

  /** 「ここまでで保存」: 中止フラグを立てて、それまでの分で保存/コピーへ。 */
  function _onClickSave() {
    if (_discarded || _cancelRequested) return;
    _cancelRequested = true;
    if (_overlayActionsEl) {
      _overlayActionsEl.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    }
    if (_overlayProgressEl) _overlayProgressEl.textContent = '停止して書き出しています…';
  }

  /** 「中止」: 破棄フラグを立てて、保存せずオーバーレイを閉じる。 */
  function _onClickDiscard() {
    _discarded = true;
    _removeOverlay();
  }

  /** 収集中オーバーレイを作って表示する。 */
  function _buildOverlay({ title }) {
    _removeOverlay();
    const root = _el('div', 'rfmd-teams-overlay');

    const head = _el('div', 'rfmd-teams-overlay__head');
    const spinner = _el('span', 'rfmd-teams-overlay__spinner');
    spinner.setAttribute('aria-hidden', 'true');
    head.append(spinner, _el('span', 'rfmd-teams-overlay__title', 'Teams チャットを収集中'));

    const sub = _el('div', 'rfmd-teams-overlay__sub', title || '');
    // ライブリージョンは進捗テキストだけに限定する（操作ボタンをライブ領域に含めない）。
    const progress = _el('div', 'rfmd-teams-overlay__progress', '0 件 · 0 秒');
    progress.setAttribute('role', 'status');
    progress.setAttribute('aria-live', 'polite');

    const actions = _el('div', 'rfmd-teams-overlay__actions');
    actions.append(
      _overlayButton('ここまでで保存', 'primary', _onClickSave),
      _overlayButton('中止', 'ghost', _onClickDiscard)
    );

    root.append(head, sub, progress, actions);
    (document.body || document.documentElement).appendChild(root);
    _overlayEl = root;
    _overlayProgressEl = progress;
    _overlayActionsEl = actions;
  }

  /** 進捗テキストを更新する（停止中ラベルは上書きしない）。 */
  function _updateOverlayProgress(info) {
    if (!_overlayProgressEl || _cancelRequested) return;
    const sec = Math.floor((info.elapsedMs || 0) / 1000);
    _overlayProgressEl.textContent = `${info.count} 件 · ${sec} 秒`;
  }

  /** spinner を止めて完了/エラー見た目にする。 */
  function _markOverlayDone(isError) {
    if (!_overlayEl) return;
    _overlayEl.classList.add(isError ? 'rfmd-teams-overlay--error' : 'rfmd-teams-overlay--done');
  }

  /** 完了後、一定時間で自動的に閉じる。 */
  function _autoClose(ms = 6000) {
    const target = _overlayEl;
    setTimeout(() => {
      if (_overlayEl === target) _removeOverlay();
    }, ms);
  }

  /**
   * 収集完了時の表示。download はその場で保存、copy は操作ボタンを出す
   * （copy は user 操作起点が必要なため、オーバーレイのボタンクリックで実行する）。
   */
  function _overlayComplete({ markdown, count, mode, title }) {
    if (!_overlayEl || !_overlayActionsEl || !_overlayProgressEl) return;
    _markOverlayDone(false);
    _overlayProgressEl.textContent = `✓ ${count} 件を収集しました`;
    _overlayActionsEl.replaceChildren();

    const clip = _clip();
    const filename = _safeName(title, 'teams-chat') + '.md';

    if (mode === 'copy') {
      const copyBtn = _overlayButton('クリップボードにコピー', 'primary', async () => {
        // await 中にユーザーが「閉じる」/会話切替で _removeOverlay が走ると参照が null 化される。
        // 進捗要素はローカルに退避し、解決後に生存（isConnected）を確認してから触る。
        const progressEl = _overlayProgressEl;
        const ok = clip ? await clip.copy(markdown) : false;
        if (!progressEl || !progressEl.isConnected) return;
        progressEl.textContent = ok ? `✓ コピーしました（${count} 件）` : 'コピーに失敗しました';
        if (ok) { copyBtn.disabled = true; _autoClose(); }
      });
      _overlayActionsEl.append(copyBtn, _overlayButton('閉じる', 'ghost', _removeOverlay));
      return;
    }

    // download
    const ok = clip ? clip.download(markdown, filename) : false;
    if (ok) {
      _overlayProgressEl.textContent = `✓ ${count} 件をダウンロードしました`;
      _overlayActionsEl.append(_overlayButton('閉じる', 'ghost', _removeOverlay));
      _autoClose();
    } else {
      // 保存失敗時はコピーで救済できる手段を出す
      _overlayProgressEl.textContent = 'ダウンロードに失敗しました';
      const copyBtn = _overlayButton('コピーで保存', 'primary', async () => {
        const progressEl = _overlayProgressEl; // copy 分岐と同様、await 後の null 参照を防ぐ
        const c = clip ? await clip.copy(markdown) : false;
        if (!progressEl || !progressEl.isConnected) return;
        progressEl.textContent = c ? `✓ コピーしました（${count} 件）` : 'コピーにも失敗しました';
        if (c) copyBtn.disabled = true;
      });
      _overlayActionsEl.append(copyBtn, _overlayButton('閉じる', 'ghost', _removeOverlay));
    }
  }

  /** エラー表示（収集失敗・期間内 0 件など）。 */
  function _overlayError(msg) {
    if (!_overlayEl) return;
    _markOverlayDone(true);
    if (_overlayProgressEl) _overlayProgressEl.textContent = msg;
    if (_overlayActionsEl) {
      _overlayActionsEl.replaceChildren();
      _overlayActionsEl.append(_overlayButton('閉じる', 'ghost', _removeOverlay));
    }
  }

  /** 既に収集中に再度押されたとき、既存オーバーレイへ注意を引く。 */
  function _flashOverlay() {
    if (!_overlayEl) return;
    _overlayEl.classList.remove('rfmd-teams-overlay--flash');
    void _overlayEl.offsetWidth; // reflow でアニメーション再生
    _overlayEl.classList.add('rfmd-teams-overlay--flash');
  }

  /** オーバーレイを除去して参照を解放する（冪等）。 */
  function _removeOverlay() {
    if (_overlayEl) _overlayEl.remove();
    _overlayEl = null;
    _overlayProgressEl = null;
    _overlayActionsEl = null;
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
   * メッセージ収集を開始する（fire-and-forget）。
   *
   * 収集・進捗表示・中止・保存/コピーはすべてページ側オーバーレイで完結する。
   * popup には「開始した」ことだけを即返すので、popup を閉じても収集は継続でき、
   * いつでもオーバーレイから中止・保存できる。
   *
   * @param {{sinceDays?:number, mode?:('download'|'copy')}} [opts]
   *   sinceDays: この日数より古いメッセージは遡らない（未指定/0 以下なら無制限）
   *   mode: 完了時の既定動作（download=その場保存 / copy=コピー操作ボタンを提示）
   * @returns {{ok:boolean, started?:boolean, error?:string}}
   */
  function startCollection(opts = {}) {
    if (_busy) {
      _flashOverlay();
      return { ok: false, error: 'すでに収集中です。完了するか中止してからお試しください' };
    }
    _busy = true;
    _cancelRequested = false;
    _discarded = false;

    const days = Number(opts.sinceDays);
    const sinceMs = Number.isFinite(days) && days > 0 ? Date.now() - days * 86400000 : null;
    const mode = opts.mode === 'copy' ? 'copy' : 'download';
    const title = getTitle();
    const startHref = location.href; // 完了時に会話が切り替わっていないか確認する基準

    _buildOverlay({ title });

    // 非同期で収集を走らせ、完了/中止/エラーをオーバーレイに反映する。
    (async () => {
      try {
        const { records, rawCount } = await _collectRecords({
          sinceMs,
          onProgress: _updateOverlayProgress,
        });
        // 破棄指示、または収集中に別会話/ページへ切り替わったら部分データを保存しない
        // （ループは startHref 変化で中断済みだが、念のため完了処理でも弾く）。
        if (_discarded || location.href !== startHref) {
          _removeOverlay();
          return;
        }
        if (records.length === 0) {
          _overlayError(
            rawCount > 0
              ? '選択した期間内にメッセージがありませんでした。期間を広げてお試しください。'
              : 'メッセージを抽出できませんでした（Teams の画面構成が変わった可能性があります）。'
          );
          return;
        }
        const markdown = _buildMarkdown(title, records);
        _overlayComplete({ markdown, count: records.length, mode, title });
      } catch (e) {
        if (_discarded) {
          _removeOverlay();
          return;
        }
        _overlayError('収集中にエラーが発生しました: ' + (e?.message || e));
      } finally {
        _busy = false;
      }
    })();

    return { ok: true, started: true };
  }

  /** ページ遷移時にキャッシュをクリアする。進行中の収集があれば破棄してオーバーレイも閉じる。 */
  function reset() {
    _availabilityCache = null;
    _availabilityCacheUrl = '';
    // 会話切替/ページ離脱で進行中の収集を保存してしまわないよう破棄に倒す
    // （収集ループは startHref 変化でも break するが、完了処理の保存を確実に止める）。
    _discarded = true;
    _removeOverlay();
  }

  return { checkAvailability, hasChatDom, getTitle, startCollection, reset };
})();
