/**
 * SharePoint Stream (Teams 会議録画) 抽出モジュール
 *
 * 動画ページから会議トランスクリプト（VTT 字幕）を取得・ダウンロードする。
 *
 * 動作の流れ:
 *   1. 初期文書では <script> タグの textContent から Drive ID / File ID を抽出（同期）
 *   2. main world に注入した fetch フックから、現在のページ URL に結び付いた候補を
 *      CustomEvent ('rfmd:sp-ids') 経由で取得
 *   3. 候補を SharePoint API で検証し、トランスクリプトがある ID 組を確定
 *   4. temporaryDownloadUrl を /streamContent?is=1&applymediaedits=false に
 *      変換して VTT を取得し、ファイルとしてダウンロード
 *
 * 参考: 既存拡張機能 "Teams Transcript Downloader" (acaeimjaoagnkdbfmlplpcacjdghponp)
 */
var SharePointExtractor = SharePointExtractor || (() => {
  /** この content script が読み込まれた文書の URL。SPA 遷移後は初期 script を再利用しない。 */
  const _documentUrl = location.href;

  /** main world fetch フックから捕捉した、ページ URL 単位の ID 候補 */
  let _capturedCandidates = [];
  let _candidateSequence = 0;
  const MAX_ID_CANDIDATES = 20;

  /** checkAvailability で実際にトランスクリプトを確認できた ID 組 */
  let _selectedIds = null;

  /** main world fetch フックの注入済みフラグ */
  let _hookInjected = false;

  /** 利用可能性チェックの結果キャッシュ（ページ単位） */
  let _availabilityCache = null;
  let _availabilityCacheUrl = '';

  /**
   * 直近に checkAvailability を評価した URL。captured ID の「実ナビゲーション時クリア」判定に使う。
   * no-ids 時は _availabilityCacheUrl を更新しないため、それを基準にすると毎回 URL 変化と誤判定して
   * フック由来の captured ID を使う前に消してしまう。専用変数で実 URL 変化のみ検出する。
   */
  let _lastSeenUrl = '';

  // RfmdFetch.withTimeout と FETCH_TIMEOUT_MS は src/lib/fetch_utils.js の
  // RfmdFetch.withTimeout / RfmdFetch.TIMEOUT_MS に集約済み。

  /** SharePoint Graph 形式の Drive ID フォーマット（b! で始まる url-safe base64-ish） */
  const DRIVE_ID_RE = /^b![a-zA-Z0-9_-]+$/;
  /** SharePoint の File ID フォーマット（大文字英数 20 文字以上） */
  const FILE_ID_RE = /^[A-Za-z0-9]{20,}$/;

  /* ── ID 抽出 ────────────────────────────────── */

  /**
   * <script> タグの中から Drive ID (b!XXX) と File ID を抽出する。
   * SharePoint Stream のページは初期 HTML 内のスクリプトに ID が
   * 埋め込まれていることが多い。
   * @returns {{ driveId: string, fileId: string }}
   */
  function _extractIdsFromScripts() {
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent || '';
      // まず /_api/v2.1/drives/.../items/... の完全一致を試す（最も信頼度が高い）
      // 単純な /items/ マッチはライブラリ一覧等の無関係 ID を拾う恐れがあるため、
      // 必ず SharePoint v2.1 Drives API の文脈に限定する。
      const combined = text.match(/\/_api\/v2\.1\/drives\/(b![a-zA-Z0-9_-]+)\/items\/([A-Za-z0-9]{20,})/);
      if (combined) {
        return { driveId: combined[1], fileId: combined[2] };
      }
    }
    return { driveId: '', fileId: '' };
  }

  /**
   * URL 変化に追随して、前ページの候補・選択結果・availability キャッシュを破棄する。
   * fetch フックのイベントが navigation 検出より先に届く場合があるため、現在 URL 用として
   * すでに捕捉した候補だけは残す。
   */
  function _syncPageContext() {
    const currentUrl = location.href;
    if (_lastSeenUrl && _lastSeenUrl !== currentUrl) {
      _capturedCandidates = _capturedCandidates.filter((candidate) => candidate.pageUrl === currentUrl);
      _selectedIds = null;
      _availabilityCache = null;
      _availabilityCacheUrl = '';
    }
    _lastSeenUrl = currentUrl;
  }

  /**
   * main world に fetch フックを一度だけ注入する。
   * フックは window.fetch をラップして Drives item URL から
   * Drive ID / File ID を抽出し、CustomEvent 'rfmd:sp-ids' で通知する。
   */
  function _ensureFetchHookInjected() {
    if (_hookInjected) return;
    _hookInjected = true;
    try {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('src/inject/sharepoint_fetch_hook.js');
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
    } catch (e) {
      // 拡張コンテキスト無効化時など
      console.debug('[ReviewForMD][SP] Hook injection failed:', e?.message || e);
    }

    window.addEventListener('rfmd:sp-ids', (e) => {
      const detail = /** @type {CustomEvent} */(e).detail || {};
      // main world は untrusted (SharePoint ページ上の任意スクリプトや他拡張が
      // CustomEvent を spoof できる) ため、Graph ID のフォーマットで検証してから受理する。
      // URL を同時に照合し、遅れて完了した前動画の fetch や別ページ用イベントを混ぜない。
      if (
        typeof detail.driveId === 'string' && DRIVE_ID_RE.test(detail.driveId) &&
        typeof detail.fileId === 'string' && FILE_ID_RE.test(detail.fileId) &&
        typeof detail.pageUrl === 'string' && detail.pageUrl === location.href
      ) {
        _syncPageContext();
        const existingIndex = _capturedCandidates.findIndex((candidate) =>
          candidate.pageUrl === detail.pageUrl &&
          candidate.driveId === detail.driveId &&
          candidate.fileId === detail.fileId
        );
        const candidate = {
          driveId: detail.driveId,
          fileId: detail.fileId,
          pageUrl: detail.pageUrl,
          transcriptRelated: detail.transcriptRelated === true,
          sequence: existingIndex >= 0
            ? _capturedCandidates[existingIndex].sequence
            : ++_candidateSequence,
        };
        if (existingIndex >= 0) {
          candidate.transcriptRelated = candidate.transcriptRelated ||
            _capturedCandidates[existingIndex].transcriptRelated;
          _capturedCandidates.splice(existingIndex, 1);
        }
        _capturedCandidates.push(candidate);
        if (_capturedCandidates.length > MAX_ID_CANDIDATES) {
          _capturedCandidates.splice(0, _capturedCandidates.length - MAX_ID_CANDIDATES);
        }

        // 新しい候補が来たら、no-transcript/error を含む古い判定を再評価する。
        _selectedIds = null;
        _availabilityCache = null;
        _availabilityCacheUrl = '';
      }
    });
  }

  /**
   * 現在ページ用の Drive ID / File ID 候補を信頼度順に返す。
   * 1) transcripts を明示する fetch、2) 初期文書の script、3) その他の Drives item fetch。
   * 初期 script は SPA 遷移後も DOM に残るため、読み込み時と同じ URL でしか使わない。
   * @returns {Array<{ driveId: string, fileId: string }>}
   */
  function _getIdCandidates() {
    const currentUrl = location.href;
    const result = [];
    const add = (candidate) => {
      if (!candidate?.driveId || !candidate?.fileId) return;
      if (result.some((item) => item.driveId === candidate.driveId && item.fileId === candidate.fileId)) return;
      result.push({ driveId: candidate.driveId, fileId: candidate.fileId });
    };
    const captured = _capturedCandidates.filter((candidate) => candidate.pageUrl === currentUrl);

    captured
      .filter((candidate) => candidate.transcriptRelated)
      .sort((a, b) => b.sequence - a.sequence)
      .forEach(add);

    if (currentUrl === _documentUrl) {
      add(_extractIdsFromScripts());
    }

    captured
      .filter((candidate) => !candidate.transcriptRelated)
      .sort((a, b) => a.sequence - b.sequence)
      .forEach(add);

    return result;
  }

  /* ── REST API ──────────────────────────────── */

  /** ページのオリジン (例: https://contoso.sharepoint.com) */
  function _origin() {
    return `${location.protocol}//${location.host}`;
  }

  /**
   * SharePoint 系オリジンかどうかを判定する。
   * `temporaryDownloadUrl` は SharePoint CDN の別サブドメイン（*-my.sharepoint.com 等）
   * に向くことがあるので、同一オリジンに限定すると VTT 取得が失敗する。
   * そのため「*.sharepoint.com + HTTPS」をホワイトリストとして許容する。
   * @param {string} url
   */
  function _isSharePointOrigin(url) {
    try {
      const u = new URL(url, location.href);
      return u.protocol === 'https:' && u.hostname.endsWith('.sharepoint.com');
    } catch {
      return false;
    }
  }

  /**
   * 指定 Drive/File のトランスクリプトメタデータを取得する
   * @returns {Promise<Array<{ temporaryDownloadUrl: string }>>}
   */
  async function _fetchTranscripts(driveId, fileId) {
    const url = `${_origin()}/_api/v2.1/drives/${driveId}/items/${fileId}` +
      `?select=media/transcripts&$expand=media/transcripts`;
    // _origin() はページホストなので同一オリジン確定。念のためホワイトリストを経由。
    if (!_isSharePointOrigin(url)) {
      throw new Error('SharePoint 以外のオリジンへのリクエストは許可されていません');
    }
    const { response: res, json } = await RfmdFetch.withJson(url, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      try { await res.body?.cancel(); } catch { /* 接続解放 */ }
      throw new Error(`metadata fetch failed: ${res.status}`);
    }
    return json.media?.transcripts || [];
  }

  /**
   * 現在ページの候補を順に検証し、実際にトランスクリプトがある ID 組を確定する。
   * @returns {Promise<{ ids?: {driveId:string, fileId:string}, transcripts?: Array<{temporaryDownloadUrl:string}>, reason?: string }>}
   */
  async function _resolveTranscript() {
    const candidates = _getIdCandidates();
    if (candidates.length === 0) return { reason: 'no-ids' };

    let lastError = null;
    let successfulRequest = false;
    for (const ids of candidates) {
      try {
        const transcripts = await _fetchTranscripts(ids.driveId, ids.fileId);
        successfulRequest = true;
        if (transcripts.length > 0) return { ids, transcripts };
      } catch (e) {
        lastError = e;
      }
    }

    if (!successfulRequest && lastError) throw lastError;
    return { reason: 'no-transcript' };
  }

  /**
   * temporaryDownloadUrl を VTT 取得用の streamContent URL に正規化する
   */
  function _normalizeStreamUrl(rawUrl) {
    if (rawUrl.includes('/content')) {
      return rawUrl.replace(/\/content(\?.*)?$/, '/streamContent?is=1&applymediaedits=false');
    }
    if (rawUrl.includes('/streamContent?')) {
      return rawUrl.replace(/\/streamContent\?.*$/, '/streamContent?is=1&applymediaedits=false');
    }
    return rawUrl;
  }

  /**
   * Content-Disposition ヘッダーからファイル名を取り出す。
   * 取得できない場合は null を返す。
   */
  function _filenameFromContentDisposition(header) {
    if (!header) return null;
    // RFC 5987 形式: filename*=utf-8''xxx
    const m1 = header.match(/filename\*=utf-8''([^;]+)/i);
    if (m1 && m1[1]) {
      try {
        return decodeURIComponent(m1[1]);
      } catch {
        // フォールスルー
      }
    }
    // 通常形式: filename="xxx" または filename=xxx
    const m2 = header.match(/filename=["']?([^"';]+)["']?/i);
    if (m2 && m2[1]) return m2[1];
    return null;
  }

  /* ── 公開 API ─────────────────────────────── */

  /**
   * トランスクリプトが利用可能かどうかを判定する。
   * 同一 URL に対しては結果をキャッシュして REST API の連打を防ぐ。
   * @returns {Promise<{ available: boolean, reason?: string }>}
   */
  async function checkAvailability() {
    // fetch フックは早めに仕込んでおく（動画再生で fetch される ID を捕捉する）
    _ensureFetchHookInjected();

    _syncPageContext();

    if (_availabilityCacheUrl === location.href && _availabilityCache !== null) {
      return _availabilityCache;
    }

    try {
      const resolved = await _resolveTranscript();
      if (resolved.reason === 'no-ids') {
        // ID 未取得はキャッシュしない: fetch フック経由で後から ID が届いた場合に
        // MutationObserver の次回コールで再評価できるようにする。
        return { available: false, reason: 'no-ids' };
      }
      _selectedIds = resolved.ids
        ? { ...resolved.ids, pageUrl: location.href }
        : null;
      const result = resolved.ids
        ? { available: true }
        : { available: false, reason: 'no-transcript' };
      _availabilityCacheUrl = location.href;
      _availabilityCache = result;
      return result;
    } catch (e) {
      // 権限切れ(401)/ネットワーク等。reason を残し、切り分け用にログも出す
      // （popup 側は reason を見て「トランスクリプト無し」か「取得失敗」かを出し分ける）。
      console.warn('[ReviewForMD][SP] availability チェック失敗:', e?.message || e);
      const result = { available: false, reason: `error: ${e?.message || e}` };
      _availabilityCacheUrl = location.href;
      _availabilityCache = result;
      return result;
    }
  }

  /**
   * トランスクリプト (VTT) を取得してダウンロードする
   * @returns {Promise<{ text: string, filename: string }>}
   *   ダウンロードに使う VTT 本文と推奨ファイル名を返す
   */
  async function downloadTranscript() {
    _ensureFetchHookInjected();
    _syncPageContext();

    let ids = _selectedIds?.pageUrl === location.href ? _selectedIds : null;
    let transcripts;
    if (ids) {
      transcripts = await _fetchTranscripts(ids.driveId, ids.fileId);
    } else {
      const resolved = await _resolveTranscript();
      if (resolved.reason === 'no-ids') {
        throw new Error('Drive ID / File ID が見つかりません');
      }
      if (!resolved.ids) {
        throw new Error('トランスクリプトが見つかりません');
      }
      ids = { ...resolved.ids, pageUrl: location.href };
      _selectedIds = ids;
      transcripts = resolved.transcripts;
    }
    if (!ids) {
      throw new Error('Drive ID / File ID が見つかりません');
    }
    if (transcripts.length === 0) {
      throw new Error('トランスクリプトが見つかりません');
    }
    // temporaryDownloadUrl が欠落しているケース（権限不足でメタデータだけ返る等）で
    // _normalizeStreamUrl が TypeError になると、ユーザーに切り分け不能な例外が出る。
    const rawUrl = transcripts[0].temporaryDownloadUrl;
    if (typeof rawUrl !== 'string' || rawUrl === '') {
      throw new Error('トランスクリプトのダウンロード URL が取得できませんでした');
    }
    const streamUrl = _normalizeStreamUrl(rawUrl);
    // サーバー応答 (temporaryDownloadUrl) をそのまま credentials 付きで叩くと、
    // サーバー側で URL を差し替えられたときに cookie が外部オリジンへ流出しうる。
    // 必ず *.sharepoint.com ドメインに限定してから fetch する。
    if (!_isSharePointOrigin(streamUrl)) {
      throw new Error('VTT ダウンロード URL が SharePoint オリジンではありません');
    }
    const { response: res, text } = await RfmdFetch.withText(streamUrl, {
      // _normalizeStreamUrl が元 URL のクエリ文字列を ?is=1&applymediaedits=false で
      // 上書きするため、temporaryDownloadUrl に SAS トークンが含まれていても剥がれる。
      // よって認証は SharePoint のセッション cookie に依存する必要がある。
      // URL は _isSharePointOrigin ガードで *.sharepoint.com HTTPS に限定済み。
      // Cookie はドメインスコープなので、別テナントのサブドメインに自テナント cookie は
      // 送信されず、cookie 漏洩は発生しない。
      credentials: 'include',
      cache: 'no-store',
    });
    if (!res.ok) {
      try { await res.body?.cancel(); } catch { /* 接続解放 */ }
      const hint = (res.status === 401 || res.status === 403)
        ? 'ログインし直してからページを再読み込みしてください'
        : '';
      throw new Error(`VTT の取得に失敗しました (HTTP ${res.status})${hint ? '。' + hint : ''}`);
    }
    const filename = _filenameFromContentDisposition(
      res.headers.get('Content-Disposition')
    ) || 'transcript.vtt';
    return { text, filename };
  }

  /**
   * ページ遷移時に呼び出してキャッシュ・捕捉済み ID をリセットする。
   * 注: main world フック側の候補集合はここからはクリアしない。フック自身が location.href の
   * 変化を検出して候補を入れ替え、content script 側も pageUrl が一致するイベントだけを受理する。
   * （`rfmd:sp-reset` のリスナーは DoS 攻撃面になるため hook 側で意図的に削除済み。
   *   ここから発火しても受け手はいないので dispatch しない。）
   */
  function reset() {
    _capturedCandidates = [];
    _selectedIds = null;
    _availabilityCache = null;
    _availabilityCacheUrl = '';
    _lastSeenUrl = '';
  }

  return { checkAvailability, downloadTranscript, reset };
})();
