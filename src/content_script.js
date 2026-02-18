/**
 * ReviewForMD - Content Script エントリポイント
 *
 * GitHub / Azure DevOps のプルリクエストページを検出し、
 * Markdown コピーボタンを注入する。
 */
(() => {
  'use strict';

  // 多重実行防止（動的注入で IIFE が再実行されるケース対策）
  if (window.__rfmd_initialized) return;
  window.__rfmd_initialized = true;

  /** 初期化試行間隔 (ms) */
  const RETRY_INTERVAL = 1500;
  /** 最大リトライ回数 */
  const MAX_RETRIES = 10;
  /** MutationObserver のデバウンス間隔 (ms) */
  const DEBOUNCE_MS = 800;

  let _retries = 0;
  let _currentSiteType = null;
  let _debounceTimer = null;
  /** @type {MutationObserver|null} */
  let _observer = null;

  /**
   * メイン初期化処理
   */
  function init() {
    const siteType = SiteDetector.detect();

    if (siteType === SiteDetector.SiteType.UNKNOWN) {
      if (_retries < MAX_RETRIES) {
        _retries++;
        setTimeout(init, RETRY_INTERVAL);
      } else {
        console.info('[ReviewForMD] Site detection failed after max retries.');
      }
      return;
    }

    _currentSiteType = siteType;
    _retries = 0;
    console.debug(`[ReviewForMD] Detected: ${siteType}`);

    // ボタンを注入
    ButtonInjector.inject(siteType);

    // DOM 変更を監視（多重登録を防止）
    _startObserver(siteType);
  }

  /**
   * DOM の変更を監視し、新しいコメントが追加されたら再注入する。
   * 既存の Observer がある場合は破棄してから作り直す。
   */
  function _startObserver(siteType) {
    // 既存の Observer を破棄
    if (_observer) {
      _observer.disconnect();
      _observer = null;
    }

    _observer = new MutationObserver((mutations) => {
      // 自身のボタン注入による DOM 変更は無視する
      const hasRelevantChange = mutations.some((m) =>
        [...m.addedNodes].some(
          (n) => n.nodeType === Node.ELEMENT_NODE &&
                 !/** @type {Element} */(n).hasAttribute('data-rfmd') &&
                 !/** @type {Element} */(n).classList?.contains('rfmd-comment-btn-wrap') &&
                 !/** @type {Element} */(n).classList?.contains('rfmd-all-copy-container')
        )
      );
      if (!hasRelevantChange) return;

      if (_debounceTimer) clearTimeout(_debounceTimer);
      _debounceTimer = setTimeout(() => {
        ButtonInjector.inject(siteType);
      }, DEBOUNCE_MS);
    });

    _observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  /**
   * SPA ナビゲーション対応
   *
   * 4 つの方法で検出する:
   * 1. Service Worker からの chrome.runtime.onMessage
   * 2. main world に注入した navigation_hook.js からのカスタムイベント
   * 3. popstate イベント（ブラウザの戻る/進む）
   * 4. GitHub 固有の turbo:load イベント
   */
  function _watchNavigation() {
    let _reinitTimer = null;
    const reinit = () => {
      if (_reinitTimer) clearTimeout(_reinitTimer);
      _reinitTimer = setTimeout(() => {
        _reinitTimer = null;
        _retries = 0;
        init();
      }, 300);
    };

    // 1. Service Worker / Popup からのメッセージ
    try {
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg?.type === 'rfmd:navigate') {
          reinit();
        }
        // Popup からの ping に応答（カスタムドメイン対応）
        if (msg?.type === 'rfmd:ping') {
          sendResponse({ siteType: _currentSiteType });
          return; // sendResponse を同期的に呼んでいるので true 不要
        }
      });
    } catch (e) {
      if (!e?.message?.includes('Extension context invalidated')) {
        console.warn('[ReviewForMD] onMessage listener error:', e);
      }
    }

    // 2. main world の navigation_hook.js からのカスタムイベント
    window.addEventListener('rfmd:pushstate', reinit);
    window.addEventListener('rfmd:replacestate', reinit);

    // 3. popstate（ブラウザの戻る/進む）
    window.addEventListener('popstate', reinit);

    // 4. GitHub turbo
    document.addEventListener('turbo:load', reinit);

    // main world スクリプトを注入（history.pushState/replaceState をフック）
    _injectNavigationHook();
  }

  /**
   * main world にナビゲーションフックスクリプトを注入する
   */
  function _injectNavigationHook() {
    try {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('src/inject/navigation_hook.js');
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
    } catch (e) {
      if (!e?.message?.includes('Extension context invalidated')) {
        console.warn('[ReviewForMD] Navigation hook injection error:', e);
      }
    }
  }

  // 起動
  _watchNavigation();
  init();
})();
