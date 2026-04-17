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
 * ---
 * 動画切替対応（singleton バグ対策）:
 *   このフックは `window.__rfmd_sp_hooked__` で多重注入を防いでいるが、
 *   動画切替（stream.aspx?id=A → ?id=B）でも同じフックが再利用される。
 *   そのため:
 *   1. 値が変わった時だけ更新する（「初回のみ代入」ロジックだと古い ID に固着する）
 *   2. content script から `rfmd:sp-reset` イベントを受け取ったら closure 変数をクリア
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

  // content script からのリセット要求を受信
  // URL 変化時（動画切替）に呼ばれて closure 変数をクリア
  window.addEventListener('rfmd:sp-reset', () => {
    driveId = '';
    fileId = '';
  });

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
        // 「初回のみ代入」ではなく「値が変わった時だけ更新」にする。
        // 動画切替後に新しい ID が fetch に来ても反映されるようにする。
        if (m && m[1] !== driveId) { driveId = m[1]; updated = true; }
        if (p && p[1] !== fileId) { fileId = p[1]; updated = true; }
        if (updated) _emit();
      }
    } catch {
      // URL 解析失敗時は通常の fetch にフォールスルー
    }
    return original.apply(this, args);
  };
})();
