/**
 * Fetch ユーティリティモジュール（全 Extractor 共有）
 *
 * _fetchWithTimeout と TIMEOUT_MS は github_extractor / devops_extractor /
 * sharepoint_extractor の 3 ファイルで同一実装されていた (DRY 違反) ため、
 * このモジュールに集約する。
 *
 * manifest.json の content_scripts では各 extractor より前にロードされる。
 * service_worker.js の動的注入リストにも追加済み。
 */
var RfmdFetch = RfmdFetch || (() => {
  /** 個別 fetch のタイムアウト (ms)。サーバー無応答時の UI フリーズ上限。 */
  const TIMEOUT_MS = 30000;

  /**
   * タイムアウト付き fetch ラッパ。
   * @param {string} url
   * @param {RequestInit} [options]
   * @returns {Promise<Response>}
   */
  async function withTimeout(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  return { withTimeout, TIMEOUT_MS };
})();
