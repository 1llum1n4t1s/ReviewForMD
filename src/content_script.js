/**
 * ReviewForMD - Content Script エントリポイント
 *
 * GitHub / Azure DevOps のプルリクエストページを検出し、
 * Markdown コピーボタンを注入する。
 */
(() => {
  'use strict';

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
      }
      return;
    }

    _currentSiteType = siteType;
    _retries = 0;
    console.log(`[ReviewForMD] Detected: ${siteType}`);

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

    _observer = new MutationObserver(() => {
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
   * 3 つの方法で検出する:
   * 1. Service Worker からの chrome.runtime.onMessage
   * 2. main world に注入した navigation_hook.js からのカスタムイベント
   * 3. popstate イベント（ブラウザの戻る/進む）
   * 4. GitHub 固有の turbo:load イベント
   */
  function _watchNavigation() {
    const reinit = () => {
      _retries = 0;
      setTimeout(init, 300);
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
    } catch {
      // chrome.runtime が利用できない場合（動的注入時など）は無視
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
    } catch {
      // chrome.runtime が利用できない場合は無視
    }
  }

  // 起動
  _watchNavigation();
  init();
})();
