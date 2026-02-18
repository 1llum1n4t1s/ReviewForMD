/**
 * Main World スクリプト
 * ページ側の history.pushState / replaceState をフックし、
 * カスタムイベントとして content script に通知する。
 *
 * content_script.js がこのスクリプトを <script> タグで注入する。
 */
(() => {
  // 多重注入防止
  if (window.__rfmd_nav_hooked__) return;
  window.__rfmd_nav_hooked__ = true;

  function wrapHistoryMethod(original, eventName) {
    return function (...args) {
      original.apply(this, args);
      window.dispatchEvent(new CustomEvent(eventName));
    };
  }

  history.pushState = wrapHistoryMethod(history.pushState, 'rfmd:pushstate');
  history.replaceState = wrapHistoryMethod(history.replaceState, 'rfmd:replacestate');
})();
