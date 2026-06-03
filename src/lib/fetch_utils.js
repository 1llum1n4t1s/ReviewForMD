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

  /**
   * 429 / 503 / ネットワークエラーに限り、指数バックオフで最大 retries 回まで再試行する。
   * 401/403/404 等は再試行しても無駄なのでそのまま返す。
   * @param {string} url
   * @param {RequestInit} [options]
   * @param {number} [retries=1] 追加試行回数（0 で withTimeout と同等）
   * @returns {Promise<Response>}
   */
  async function withRetry(url, options = {}, retries = 1) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await withTimeout(url, options);
        if ((res.status === 429 || res.status === 503) && attempt < retries) {
          await new Promise((r) => setTimeout(r, 400 * (2 ** attempt)));
          continue;
        }
        return res;
      } catch (e) {
        lastErr = e;
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 400 * (2 ** attempt)));
          continue;
        }
      }
    }
    throw lastErr || new Error('fetch failed');
  }

  return { withTimeout, withRetry, TIMEOUT_MS };
})();
