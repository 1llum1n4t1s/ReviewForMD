/**
 * クリップボードコピーモジュール
 */
var RfmdClipboard = RfmdClipboard || (() => {
  /**
   * テキストをクリップボードにコピーする
   * @param {string} text
   * @returns {Promise<boolean>}
   */
  async function copy(text) {
    // 空文字列・非文字列の場合は何もしない
    if (typeof text !== 'string' || text === '') {
      return false;
    }

    // navigator.clipboard は HTTPS 環境でのみ利用可能
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Clipboard API 失敗時はフォールバックへ
      }
    }

    // フォールバック: execCommand
    return _fallbackCopy(text);
  }

  function _fallbackCopy(text) {
    // document.body が未準備の場合はコピー不可
    if (!document.body) {
      return false;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      // 例外発生時も textarea を確実に除去する
      textarea.parentNode?.removeChild(textarea);
    }
  }

  /**
   * テキストを MD ファイルとしてダウンロードする
   * @param {string} text - ダウンロードする Markdown テキスト
   * @param {string} filename - ファイル名（.md 拡張子付き）
   * @returns {boolean}
   */
  function download(text, filename) {
    if (typeof text !== 'string' || text === '') return false;
    try {
      const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || 'pullrequest.md';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      // クリーンアップ
      setTimeout(() => {
        URL.revokeObjectURL(url);
        a.parentNode?.removeChild(a);
      }, 100);
      return true;
    } catch {
      return false;
    }
  }

  return { copy, download };
})();
