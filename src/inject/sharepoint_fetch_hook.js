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

  // rfmd:sp-reset リスナーは削除: content script 側で isolated world の変数を直接
  // クリアするようになったため不要。リスナーを残すと攻撃者が CustomEvent を
  // 任意タイミングで dispatch して driveId/fileId を消去する DoS 攻撃面になる。

  window.fetch = function (...args) {
    try {
      const url = args[0]?.toString() || '';
      // SharePoint v2.1 Drives API のみを対象にする。
      // 単純に '/media/transcripts' を含むだけでは、Drives API 以外の
      // 無関係なエンドポイントが誤マッチして fileId を上書きする恐れがある。
      // isTranscripts は isDrivesApi が true の文脈で /media/transcripts パスを
      // 持つ URL（例: drives/.../items/.../media/transcripts）を特定するためのもの。
      // 現在は isDrivesApi だけで ID を抽出できるため、追加条件は不要だが
      // 将来の拡張性のためコメントとして残す。
      const isDrivesApi = url.includes('/_api/v2.1/drives/');
      if (isDrivesApi) {
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
