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
  /**
   * MutationObserver のデバウンス間隔 (ms)
   * 400ms: DOM 変更バッチ後すぐに反映しつつ、高頻度の無駄な再注入を抑止するバランス値。
   * GitHub/DevOps の SPA レンダリングは通常 200-300ms で完了するため十分に待てる。
   */
  const DEBOUNCE_MS = 400;

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

    // ボタンを注入（拡張コンテキスト無効化時のエラーを安全に無視）
    try {
      ButtonInjector.inject(siteType);
    } catch (e) {
      if (!e?.message?.includes('Extension context invalidated')) {
        console.warn('[ReviewForMD] ButtonInjector.inject error:', e);
      }
    }

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
      // NodeList を配列化せず直接ループすることで大量ノード追加時の GC 負荷を軽減
      let hasRelevantChange = false;
      for (let i = 0; i < mutations.length; i++) {
        const addedNodes = mutations[i].addedNodes;
        for (let j = 0; j < addedNodes.length; j++) {
          const n = addedNodes[j];
          if (
            n.nodeType === Node.ELEMENT_NODE &&
            !/** @type {Element} */(n).hasAttribute('data-rfmd') &&
            !/** @type {Element} */(n).classList?.contains('rfmd-comment-btn-wrap') &&
            !/** @type {Element} */(n).classList?.contains('rfmd-all-copy-container')
          ) {
            hasRelevantChange = true;
            break;
          }
        }
        if (hasRelevantChange) break;
      }
      if (!hasRelevantChange) return;

      if (_debounceTimer) clearTimeout(_debounceTimer);
      _debounceTimer = setTimeout(() => {
        // デバウンスコールバック内でも拡張コンテキスト無効化に備える
        try {
          ButtonInjector.inject(siteType);
        } catch (e) {
          if (!e?.message?.includes('Extension context invalidated')) {
            console.warn('[ReviewForMD] ButtonInjector.inject (observer) error:', e);
          }
        }
      }, DEBOUNCE_MS);
    });

    // document.body が未準備の場合は Observer を開始しない
    if (!document.body) {
      console.debug('[ReviewForMD] document.body not ready, skipping observer.');
      return;
    }
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
        // 拡張コンテキスト無効化後のコールバック呼び出し対策
        try {
          if (msg?.type === 'rfmd:navigate') {
            reinit();
          }
          // Popup からの ping に応答（カスタムドメイン対応）
          if (msg?.type === 'rfmd:ping') {
            sendResponse({ siteType: _currentSiteType });
            return; // sendResponse を同期的に呼んでいるので true 不要
          }
        } catch (innerErr) {
          if (!innerErr?.message?.includes('Extension context invalidated')) {
            console.warn('[ReviewForMD] onMessage handler error:', innerErr);
          }
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
