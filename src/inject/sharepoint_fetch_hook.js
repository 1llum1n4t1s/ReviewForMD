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
 *   そのため候補を location.href 単位で保持し、通知にも pageUrl を含める。
 *   transcripts を明示する URL は高信頼候補として通知し、それ以外の Drives item URL も
 *   フォールバック候補として残す。
 *
 * 参考: 既存拡張機能 "Teams Transcript Downloader" の content.js のロジック
 */
(() => {
  // 多重注入防止
  if (window.__rfmd_sp_hooked__) return;
  window.__rfmd_sp_hooked__ = true;

  const original = window.fetch ? window.fetch.bind(window) : null;
  if (!original) return;

  const MAX_SEEN_CANDIDATES = 40;
  let seenPageUrl = '';
  const seenCandidates = new Map();

  function _emit(driveId, fileId, pageUrl, transcriptRelated) {
    try {
      window.dispatchEvent(new CustomEvent('rfmd:sp-ids', {
        detail: { driveId, fileId, pageUrl, transcriptRelated },
      }));
    } catch {
      // CustomEvent 構築失敗時は黙殺
    }
  }

  // rfmd:sp-reset リスナーは置かない。ページ URL の変化で候補集合を入れ替えるため不要で、
  // リスナーを置くと攻撃者が CustomEvent を任意タイミングで dispatch して候補を消去できる。

  function _urlFromFetchInput(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    if (input && typeof input.href === 'string') return input.href;
    return String(input || '');
  }

  function _extractCandidate(rawUrl) {
    const url = new URL(rawUrl, location.href);
    const match = url.pathname.match(/\/_api\/v2\.1\/drives\/([^/]+)\/items\/([^/]+)/i);
    if (!match) return null;

    const transcriptValues = [
      url.searchParams.get('select'),
      url.searchParams.get('$select'),
      url.searchParams.get('expand'),
      url.searchParams.get('$expand'),
    ].filter(Boolean).join(' ').toLowerCase();
    const transcriptRelated = url.pathname.toLowerCase().includes('/media/transcripts') ||
      transcriptValues.includes('media/transcripts');
    return {
      driveId: decodeURIComponent(match[1]),
      fileId: decodeURIComponent(match[2]),
      transcriptRelated,
    };
  }

  window.fetch = function (...args) {
    try {
      const candidate = _extractCandidate(_urlFromFetchInput(args[0]));
      if (candidate) {
        const pageUrl = location.href;
        if (seenPageUrl !== pageUrl) {
          seenPageUrl = pageUrl;
          seenCandidates.clear();
        }
        const key = `${candidate.driveId}\u0000${candidate.fileId}`;
        const confidence = candidate.transcriptRelated ? 2 : 1;
        const previousConfidence = seenCandidates.get(key) || 0;
        // 同じ組でも、後から transcripts 明示 URL で確認できた場合は信頼度更新を通知する。
        if (confidence > previousConfidence) {
          if (seenCandidates.size >= MAX_SEEN_CANDIDATES && !seenCandidates.has(key)) {
            seenCandidates.delete(seenCandidates.keys().next().value);
          }
          seenCandidates.set(key, confidence);
          _emit(candidate.driveId, candidate.fileId, pageUrl, candidate.transcriptRelated);
        }
      }
    } catch {
      // URL 解析失敗時は通常の fetch にフォールスルー
    }
    return original.apply(this, args);
  };
})();
