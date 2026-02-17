/**
 * Main World スクリプト
 * ページ側の history.pushState / replaceState をフックし、
 * カスタムイベントとして content script に通知する。
 *
 * content_script.js がこのスクリプトを <script> タグで注入する。
 */
(() => {
  const origPush = history.pushState;
  const origReplace = history.replaceState;

  history.pushState = function (...args) {
    origPush.apply(this, args);
    window.dispatchEvent(new CustomEvent('rfmd:pushstate', { detail: args }));
  };

  history.replaceState = function (...args) {
    origReplace.apply(this, args);
    window.dispatchEvent(new CustomEvent('rfmd:replacestate', { detail: args }));
  };
})();
