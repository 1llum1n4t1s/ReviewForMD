/**
 * Main World スクリプト (SharePoint Stream 用)
 *
 * window.fetch をフックして、動画再生に伴って発生する SharePoint API 呼び出しから
 * Drive ID (b!XXX) と File ID を抽出し、CustomEvent 'rfmd:sp-ids' で
 * content script に通知する。
 *
 * content script (isolated world) のページの fetch には介入できないため、
 * このスクリプトは <script src="..."> として main world に注入される。
 *
 * 参考: 既存拡張機能 "Teams Transcript Downloader" の content.js のロジック
 */
(() => {
  // 多重注入防止
  if (window.__rfmd_sp_hooked__) return;
  window.__rfmd_sp_hooked__ = true;

  const original = window.fetch ? window.fetch.bind(window) : null;
  if (!original) return;

  let driveId = '';
  let fileId = '';

  function _emit() {
    try {
      window.dispatchEvent(new CustomEvent('rfmd:sp-ids', {
        detail: { driveId, fileId },
      }));
    } catch {
      // CustomEvent 構築失敗時は黙殺
    }
  }

  window.fetch = function (...args) {
    try {
      const url = args[0]?.toString() || '';
      // SharePoint v2.1 Drives API のみを対象にする。
      // 単純に '/items/' を含むだけでは、ライブラリ一覧やドキュメント取得など
      // 無関係な SharePoint API が誤マッチして fileId を上書きする恐れがある。
      const isDrivesApi = url.includes('/_api/v2.1/drives/');
      const isTranscripts = url.includes('/media/transcripts');
      if (isDrivesApi || isTranscripts) {
        const m = url.match(/drives\/([^/]+)/);
        const p = url.match(/items\/([^/?]+)/);
        let updated = false;
        if (m && !driveId) { driveId = m[1]; updated = true; }
        if (p && !fileId) { fileId = p[1]; updated = true; }
        if (updated) _emit();
      }
    } catch {
      // URL 解析失敗時は通常の fetch にフォールスルー
    }
    return original.apply(this, args);
  };
})();
