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

  // 起動ログ: ユーザー報告から「どのバージョン・どのサイトか」を特定できるようにする。
  try {
    console.info(`[ReviewForMD] v${chrome.runtime.getManifest().version} loaded on ${location.hostname}`);
  } catch { /* 拡張コンテキスト無効化時は黙殺 */ }

  /** Extension が更新されてコンテキストが無効化されたエラーかどうか */
  function _isExtCtxError(e) {
    return e?.message?.includes('Extension context invalidated');
  }

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
  /**
   * SPA ナビゲーション検出後の再初期化デバウンス間隔 (ms)。
   * pushState/popstate/turbo:load から連続で発火するのを 1 回の init() にまとめる。
   */
  const NAV_REINIT_DEBOUNCE_MS = 300;

  let _retries = 0;
  let _currentSiteType = null;
  /** @type {'detail'|'list'|null} */
  let _currentPageType = null;
  let _debounceTimer = null;
  /** @type {MutationObserver|null} */
  let _observer = null;

  /**
   * SPA 遷移で PR ページから離れた際のクリーンアップ。
   * 古い MutationObserver が非 PR ページでボタンを再注入するのを防ぐ。
   */
  function _cleanup() {
    if (_observer) {
      _observer.disconnect();
      _observer = null;
    }
    if (_debounceTimer) {
      clearTimeout(_debounceTimer);
      _debounceTimer = null;
    }
    // ButtonInjector.cleanup() を先に呼ぶ。
    // cleanup() 内部で querySelectorAll('[data-rfmd]') を使ってタイマー参照を回収するため、
    // DOM 要素を削除する前に実行する必要がある（逆順にすると 0 件ヒットになる）。
    try {
      if (typeof ButtonInjector !== 'undefined' && ButtonInjector.cleanup) {
        ButtonInjector.cleanup();
      }
    } catch { /* 拡張コンテキスト無効化時は黙殺 */ }
    // 前のページから残った一覧行ボタンを除去
    // （詳細/SP/Teams のページ埋め込みは廃止したので一覧行ボタンのみ）
    document
      .querySelectorAll('.rfmd-list-btn-wrap')
      .forEach((el) => el.remove());
    // SharePoint の captured ID / availability キャッシュをリセット。
    // ButtonInjector は UI 層なので extractor 層の reset() は content_script から直接呼ぶ。
    try {
      if (typeof SharePointExtractor !== 'undefined' && SharePointExtractor.reset) {
        SharePointExtractor.reset();
      }
    } catch { /* 拡張コンテキスト無効化時は黙殺 */ }
    // Teams チャットの availability キャッシュもリセット（会話切替対応）。
    try {
      if (typeof TeamsExtractor !== 'undefined' && TeamsExtractor.reset) {
        TeamsExtractor.reset();
      }
    } catch { /* 拡張コンテキスト無効化時は黙殺 */ }
    _currentSiteType = null;
    _currentPageType = null;
  }

  /**
   * メイン初期化処理
   */
  function init() {
    // PR 詳細ページを検出
    let siteType = SiteDetector.detect();
    let pageType = 'detail';

    // PR 詳細が見つからない場合、一覧ページを検出
    if (siteType === SiteDetector.SiteType.UNKNOWN) {
      siteType = SiteDetector.detectList();
      pageType = 'list';
    }

    if (siteType === SiteDetector.SiteType.UNKNOWN) {
      // 以前 PR ページとして検出されていた場合、クリーンアップ
      // （SPA 遷移で PR ページから離れたケース）
      if (_currentSiteType !== null) {
        _cleanup();
      }
      if (_retries < MAX_RETRIES) {
        _retries++;
        setTimeout(init, RETRY_INTERVAL);
      } else {
        console.info('[ReviewForMD] Site detection failed after max retries.');
      }
      return;
    }

    _currentSiteType = siteType;
    _currentPageType = pageType;
    _retries = 0;
    console.debug(`[ReviewForMD] Detected: ${siteType} (${pageType})`);

    // 設計（popup 集約）: 詳細ページのボタンはページに埋め込まず popup から操作する。
    // ページ側に残すのは PR 一覧の各行ダウンロードボタンのみ。
    if (pageType === 'list') {
      try {
        ButtonInjector.injectList(siteType);
      } catch (e) {
        if (!_isExtCtxError(e)) {
          console.warn('[ReviewForMD] ButtonInjector.injectList error:', e);
        }
      }
      // 一覧は SPA で行が遅延描画されるため DOM 変更を監視して再注入する
      _startObserver(siteType);
    } else if (siteType === SiteDetector.SiteType.SHAREPOINT_TEAMS) {
      // SharePoint は再生中に発生する fetch から ID を捕捉する main world フックを
      // 早めに仕込んでおく必要があるため、ボタンは出さないが checkAvailability を
      // 一度だけ走らせてフックを注入する（popup を開く前から ID 捕捉を有効化）。
      try {
        if (typeof SharePointExtractor !== 'undefined') {
          SharePointExtractor.checkAvailability();
        }
      } catch { /* 拡張コンテキスト無効化時は黙殺 */ }
    }
    // 詳細ページ（GitHub/DevOps/SharePoint/Teams）は popup 主導のため Observer 不要。
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
        if (addedNodes.length === 0) continue;
        for (let j = 0; j < addedNodes.length; j++) {
          const n = addedNodes[j];
          if (
            n.nodeType === Node.ELEMENT_NODE &&
            !/** @type {Element} */(n).hasAttribute('data-rfmd') &&
            !/** @type {Element} */(n).classList?.contains('rfmd-list-btn-wrap')
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
        // クロージャに捕捉された古い siteType を使わず、最新の _currentSiteType を参照する。
        // SPA 遷移 (GitHub → DevOps 等) と MutationObserver デバウンスが
        // race したときに、観測時点のサイトタイプでボタン注入してしまう事故を防ぐ。
        const site = _currentSiteType;
        if (!site) return; // cleanup 済み
        // Observer は一覧ページでのみ起動するため、再注入も injectList のみ。
        if (_currentPageType !== 'list') return;
        try {
          ButtonInjector.injectList(site);
        } catch (e) {
          if (!_isExtCtxError(e)) {
            console.warn('[ReviewForMD] ButtonInjector.injectList (observer) error:', e);
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
   * 5 つの方法で検出する:
   * 1. Service Worker からの chrome.runtime.onMessage
   * 2. main world に注入した navigation_hook.js からのカスタムイベント
   * 3. popstate イベント（ブラウザの戻る/進む）
   * 4. GitHub 固有の turbo:load イベント
   * 5. hashchange（Teams クラシックのハッシュルーティング会話切替）
   */
  function _watchNavigation() {
    let _reinitTimer = null;
    const reinit = () => {
      if (_reinitTimer) clearTimeout(_reinitTimer);
      _reinitTimer = setTimeout(() => {
        _reinitTimer = null;
        _retries = 0;
        init();
      }, NAV_REINIT_DEBOUNCE_MS);
    };

    // 1. Service Worker / Popup からのメッセージ
    try {
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        // 拡張コンテキスト無効化後のコールバック呼び出し対策
        try {
          if (msg?.type === 'rfmd:navigate') {
            reinit();
            sendResponse(); // port closed エラー防止
            return; // 同期
          }
          // Popup へ現在ページの状態（サイト種別/ページ種別/利用可否/タイトル）を返す
          if (msg?.type === 'rfmd:status') {
            Promise.resolve(ButtonInjector.getStatus())
              .then((s) => sendResponse(s))
              .catch((e) => sendResponse({
                siteType: SiteDetector.SiteType.UNKNOWN,
                pageType: null,
                available: false,
                title: '',
                error: e?.message || String(e),
              }));
            return true; // 非同期 sendResponse
          }
          // Popup からのアクション実行依頼（抽出 + ダウンロード/コピー）
          if (msg?.type === 'rfmd:extract') {
            Promise.resolve(ButtonInjector.runAction({ kind: msg.kind, mode: msg.mode }))
              .then((r) => sendResponse(r))
              .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
            return true; // 非同期 sendResponse
          }
        } catch (innerErr) {
          if (!_isExtCtxError(innerErr)) {
            console.warn('[ReviewForMD] onMessage handler error:', innerErr);
          }
        }
      });
    } catch (e) {
      if (!_isExtCtxError(e)) {
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

    // 5. hashchange（Teams クラシックのハッシュルーティング会話切替に対応）
    window.addEventListener('hashchange', reinit);

    // main world スクリプトを注入（history.pushState/replaceState をフック）
    _injectNavigationHook();
  }

  /**
   * main world にナビゲーションフックスクリプトを注入する。
   * SharePoint Stream は通常 SPA push/replace を行わずクエリパラメータでも
   * フルロードに近い挙動になるため、navigation_hook は不要。
   * かつ navigation_hook.js は web_accessible_resources で SharePoint ホストを
   * 許可していないため、注入すると ERR_BLOCKED_BY_CLIENT が発生してしまう。
   *
   * このメソッドは _watchNavigation() の段階（_currentSiteType 未設定）で
   * 呼ばれるため、ホスト名から直接 SharePoint かどうか判定する。
   */
  function _injectNavigationHook() {
    if (location.hostname.endsWith('.sharepoint.com')) {
      return;
    }
    try {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('src/inject/navigation_hook.js');
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
    } catch (e) {
      if (!_isExtCtxError(e)) {
        console.warn('[ReviewForMD] Navigation hook injection error:', e);
      }
    }
  }

  // 起動
  _watchNavigation();
  init();
})();
