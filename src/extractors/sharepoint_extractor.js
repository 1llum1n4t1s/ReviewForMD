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
      if (!driveId) {
        const m = text.match(/drives\/b!([a-zA-Z0-9_-]+)/);
        if (m) driveId = 'b!' + m[1];
      }
      if (!fileId) {
        const m = text.match(/items\/([A-Z0-9]{20,})/);
        if (m) fileId = m[1];
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
      if (detail.driveId && !_capturedDriveId) _capturedDriveId = detail.driveId;
      if (detail.fileId && !_capturedFileId) _capturedFileId = detail.fileId;
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
   * 指定 Drive/File のトランスクリプトメタデータを取得する
   * @returns {Promise<Array<{ temporaryDownloadUrl: string }>>}
   */
  async function _fetchTranscripts(driveId, fileId) {
    const url = `${_origin()}/_api/v2.1/drives/${driveId}/items/${fileId}` +
      `?select=media/transcripts&$expand=media/transcripts`;
    const res = await fetch(url, {
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
    const { driveId, fileId } = _getIds();
    if (!driveId || !fileId) {
      throw new Error('Drive ID / File ID が見つかりません');
    }
    const transcripts = await _fetchTranscripts(driveId, fileId);
    if (transcripts.length === 0) {
      throw new Error('トランスクリプトが見つかりません');
    }
    const streamUrl = _normalizeStreamUrl(transcripts[0].temporaryDownloadUrl);
    const res = await fetch(streamUrl, {
      credentials: 'include',
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
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
   * ページ遷移時に呼び出してキャッシュ・捕捉済み ID をリセットする
   */
  function reset() {
    _capturedDriveId = '';
    _capturedFileId = '';
    _availabilityCache = null;
    _availabilityCacheUrl = '';
  }

  return { checkAvailability, downloadTranscript, reset };
})();
