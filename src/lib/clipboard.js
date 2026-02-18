/**
 * クリップボードコピーモジュール
 */
const Clipboard = (() => {
  /**
   * テキストをクリップボードにコピーする
   * @param {string} text
   * @returns {Promise<boolean>}
   */
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // フォールバック: execCommand
      return _fallbackCopy(text);
    }
  }

  function _fallbackCopy(text) {
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
      document.body.removeChild(textarea);
    }
  }

  return { copy };
})();
