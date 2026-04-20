/**
 * SharePoint Stream (Teams 会議録画) 抽出モジュール
 *
 * 動画ページから会議トランスクリプト（VTT 字幕）を取得・ダウンロードする。
 *
 * 動作の流れ:
 *   1. <script> タグの textContent から Drive ID / File ID を抽出（同期）
 *   2. 取得できない場合は main world に注入した fetch フックからの
 *      CustomEvent ('rfmd:sp-ids') 経由で取得
 *   3. SharePoint REST API でトランスクリプトメタデータを取得
 *   4. temporaryDownloadUrl を /streamContent?is=1&applymediaedits=false に
 *      変換して VTT を取得し、ファイルとしてダウンロード
 *
 * 参考: 既存拡張機能 "Teams Transcript Downloader" (acaeimjaoagnkdbfmlplpcacjdghponp)
 */
var SharePointExtractor = SharePointExtractor || (() => {
  /** main world fetch フックから捕捉した ID を保持 */
  let _capturedDriveId = '';
  let _capturedFileId = '';

  /** main world fetch フックの注入済みフラグ */
  let _hookInjected = false;

  /** 利用可能性チェックの結果キャッシュ（ページ単位） */
  let _availabilityCache = null;
  let _availabilityCacheUrl = '';

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
    let driveId = '';
    let fileId = '';
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent || '';
      // まず /_api/v2.1/drives/.../items/... の完全一致を試す（最も信頼度が高い）
      // 単純な /items/ マッチはライブラリ一覧等の無関係 ID を拾う恐れがあるため、
      // 必ず SharePoint v2.1 Drives API の文脈に限定する。
      if (!driveId || !fileId) {
        const combined = text.match(/\/_api\/v2\.1\/drives\/(b![a-zA-Z0-9_-]+)\/items\/([A-Za-z0-9]{20,})/);
        if (combined) {
          if (!driveId) driveId = combined[1];
          if (!fileId) fileId = combined[2];
        }
      }
      // drive 単独は b! プレフィックスで誤マッチリスクが低いためフォールバック
      if (!driveId) {
        const m = text.match(/drives\/(b![a-zA-Z0-9_-]+)/);
        if (m) driveId = m[1];
      }
      if (driveId && fileId) break;
    }
    return { driveId, fileId };
  }

  /**
   * main world に fetch フックを一度だけ注入する。
   * フックは window.fetch をラップして transcripts/items を含む URL から
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
      // 「初回のみ代入」ガードは外す: 動画切替 (stream.aspx?id=A→B) でも最新値に追随する必要がある。
      if (typeof detail.driveId === 'string' && DRIVE_ID_RE.test(detail.driveId)) {
        _capturedDriveId = detail.driveId;
      }
      if (typeof detail.fileId === 'string' && FILE_ID_RE.test(detail.fileId)) {
        _capturedFileId = detail.fileId;
      }
    });
  }

  /**
   * Drive ID / File ID を取得する。
   * 1) <script> タグから即時取得 → 2) fetch フック経由のキャッシュ
   * @returns {{ driveId: string, fileId: string }}
   */
  function _getIds() {
    const fromScripts = _extractIdsFromScripts();
    return {
      driveId: fromScripts.driveId || _capturedDriveId,
      fileId: fromScripts.fileId || _capturedFileId,
    };
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
    const res = await RfmdFetch.withTimeout(url, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`metadata fetch failed: ${res.status}`);
    }
    const json = await res.json();
    return json.media?.transcripts || [];
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

    // URL が変わっていたら fetch フック由来の ID も古い動画のものなのでクリアする。
    // SharePoint Stream は stream.aspx?id=A → ?id=B の SPA 遷移で動画切替が起きるため、
    // captured ID を残すと別動画のメタデータを誤取得しうる。
    if (_availabilityCacheUrl !== location.href) {
      _capturedDriveId = '';
      _capturedFileId = '';
    }

    if (_availabilityCacheUrl === location.href && _availabilityCache !== null) {
      return _availabilityCache;
    }

    try {
      const { driveId, fileId } = _getIds();
      if (!driveId || !fileId) {
        // ID 未取得はキャッシュしない: fetch フック経由で後から ID が届いた場合に
        // MutationObserver の次回コールで再評価できるようにする。
        return { available: false, reason: 'no-ids' };
      }
      const transcripts = await _fetchTranscripts(driveId, fileId);
      const result = transcripts.length > 0
        ? { available: true }
        : { available: false, reason: 'no-transcript' };
      _availabilityCacheUrl = location.href;
      _availabilityCache = result;
      return result;
    } catch (e) {
      // メタデータ API エラーは非表示で扱う（権限・ネットワーク等）
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
    // URL が変わっていたら captured ID は古い動画のものなのでクリアして取り直す。
    // _injectSharePoint() の URL 検出と二重防御。動画切替後に古い ID で
    // 別動画の VTT が落ちてくる事故を防ぐ。
    if (_availabilityCacheUrl !== location.href) {
      _capturedDriveId = '';
      _capturedFileId = '';
      _availabilityCache = null;
      _availabilityCacheUrl = '';
      // 新しい URL のメタデータを取得（fetch フックも仕込まれる）
      await checkAvailability();
    }

    const { driveId, fileId } = _getIds();
    if (!driveId || !fileId) {
      throw new Error('Drive ID / File ID が見つかりません');
    }
    const transcripts = await _fetchTranscripts(driveId, fileId);
    if (transcripts.length === 0) {
      throw new Error('トランスクリプトが見つかりません');
    }
    const streamUrl = _normalizeStreamUrl(transcripts[0].temporaryDownloadUrl);
    // サーバー応答 (temporaryDownloadUrl) をそのまま credentials 付きで叩くと、
    // サーバー側で URL を差し替えられたときに cookie が外部オリジンへ流出しうる。
    // 必ず *.sharepoint.com ドメインに限定してから fetch する。
    if (!_isSharePointOrigin(streamUrl)) {
      throw new Error('VTT ダウンロード URL が SharePoint オリジンではありません');
    }
    const res = await RfmdFetch.withTimeout(streamUrl, {
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
      throw new Error(`VTT download failed: ${res.status}`);
    }
    const filename = _filenameFromContentDisposition(
      res.headers.get('Content-Disposition')
    ) || 'transcript.vtt';
    const text = await res.text();
    return { text, filename };
  }

  /**
   * ページ遷移時に呼び出してキャッシュ・捕捉済み ID をリセットする。
   * main world の fetch フックの closure 変数もクリアするため `rfmd:sp-reset` を発火。
   * （isolated world の reset だけでは main world の古い ID が残る singleton バグ対策）
   */
  function reset() {
    _capturedDriveId = '';
    _capturedFileId = '';
    _availabilityCache = null;
    _availabilityCacheUrl = '';
    try {
      window.dispatchEvent(new CustomEvent('rfmd:sp-reset'));
    } catch {
      // イベント発火失敗時は黙殺（拡張コンテキスト無効化時など）
    }
  }

  return { checkAvailability, downloadTranscript, reset };
})();
