/**
 * Popup スクリプト（アクション集約版）
 *
 * 役割:
 *   - 現在タブのコンテンツスクリプトに rfmd:status を問い合わせ、
 *     サイトに合うアクションボタンを popup 内に描画する。
 *   - ボタンクリックで rfmd:extract を送信。
 *       mode='download' → コンテンツスクリプト側で保存（DOM・セッション cookie がある側）
 *       mode='copy'     → 文字列を受け取り popup 側でクリップボードに書き込む
 *                         （navigator.clipboard はフォーカス必須＝popup 側で実行する必要がある）
 *   - カスタムドメイン Azure DevOps の許可フローは従来どおり popup が担う。
 */

/** PR パス判定用の正規表現（カスタムドメイン検出のフォールバックに使用） */
const RE_GITHUB_HOST = /^https?:\/\/(www\.)?github\.com\//;
const RE_GITHUB_PR = /\/pull\/\d+/;
const RE_GITHUB_PR_LIST = /\/pulls(\?|$|#)/;
const RE_DEVOPS_HOST = /^https?:\/\/(dev\.azure\.com|[^/]+\.visualstudio\.com)\//;
const RE_DEVOPS_PR = /\/_git\/[^/]+\/pullrequest\/\d+/i;
const RE_DEVOPS_PR_LIST = /\/_git\/[^/]+\/pullrequests/i;
const RE_CODECOMMIT_HOST = /^https?:\/\/([^/]+\.)?console\.aws\.amazon\.com\//;
const RE_CODECOMMIT_PR = /\/codesuite\/codecommit\/repositories\/[^/]+\/pull-requests\/\d+/i;
const RE_SHAREPOINT_HOST = /^https?:\/\/[^/]+\.sharepoint\.com\//;
const RE_SHAREPOINT_STREAM = /\/stream\.aspx/i;
const RE_TEAMS_HOST = /^https?:\/\/([^/]+\.)?(teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft)\//;

/** アクション完了フィードバックの表示時間 (ms) */
const FEEDBACK_MS = 1500;

/** SiteType → 表示名 */
const SITE_LABEL = {
  github: 'GitHub',
  devops: 'Azure DevOps',
  codecommit: 'AWS CodeCommit',
  sharepoint_teams: 'SharePoint 会議録画',
  teams_chat: 'Microsoft Teams',
};

/**
 * アクションアイコン（Lucide 風の stroke SVG マークアップ）。
 * stroke="currentColor" なので CSS の .pop-icon の color を継承する。
 * 値は自前定義の固定文字列で外部入力を含まない（_buildSvg で安全に DOM 化する）。
 */
const ICON = {
  download: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  copy: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  check: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
};

let _currentTabId = null;

/* ── DOM ヘルパ ─────────────────────────────────── */

function _setStatus(msg, kind) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status status--' + (kind || 'inactive');
}
const _setActive = (m) => _setStatus(m, 'active');
const _setInactive = (m) => _setStatus(m, 'inactive');
const _setNeedsPermission = (m) => _setStatus(m, 'needs-permission');

function _setNote(msg) {
  document.getElementById('note').textContent = msg || '';
}

function _clearActions() {
  document.getElementById('actions').replaceChildren();
}

/**
 * SVG マークアップ文字列を DOM ノード化する（innerHTML 不使用）。
 * DOMParser('image/svg+xml') + importNode は button_injector.js の _buildSvg と同型の
 * 確立パターン。innerHTML 代入を避けて Firefox AMO の UNSAFE_VAR_ASSIGNMENT lint を回避する。
 * @param {string} svgString 自前定義の固定 SVG マークアップ
 * @returns {SVGElement|null}
 */
function _buildSvg(svgString) {
  try {
    const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
    if (doc.querySelector('parsererror')) return null;
    return document.importNode(doc.documentElement, true);
  } catch {
    return null;
  }
}

/**
 * pop ボタンの内容を「アイコン span（SVG）+ ラベル span」で DOM 構築する（innerHTML 不使用）。
 * @param {HTMLButtonElement} btn
 * @param {string} iconSvg ICON マップの SVG マークアップ
 * @param {string} label
 */
function _setPopBtnContent(btn, iconSvg, label) {
  const iconSpan = document.createElement('span');
  iconSpan.className = 'pop-icon';
  const svg = iconSvg ? _buildSvg(iconSvg) : null;
  if (svg) iconSpan.appendChild(svg);
  const labelSpan = document.createElement('span');
  labelSpan.className = 'pop-label';
  labelSpan.textContent = label;
  btn.replaceChildren(iconSpan, labelSpan);
}

/**
 * アクションボタンを 1 つ追加する。
 * @param {{label:string, icon:string, kind:string, mode:string, primary?:boolean}} opt
 */
function _addActionButton({ label, icon, kind, mode, primary }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pop-btn' + (primary ? ' pop-btn--primary' : '');
  // フィードバック後の復元用に元のアイコン/ラベルを保持してから構築する
  btn._origIcon = icon;
  btn._origLabel = label;
  _setPopBtnContent(btn, icon, label);
  btn.addEventListener('click', () => _runAction(btn, kind, mode));
  document.getElementById('actions').appendChild(btn);
  return btn;
}

/* ── クリップボード（popup 側で実行）─────────────── */

async function _copyToClipboard(text) {
  if (typeof text !== 'string' || text === '') return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // フォールバックへ
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/* ── アクション実行 ─────────────────────────────── */

async function _runAction(btn, kind, mode) {
  if (btn.disabled || _currentTabId == null) return;
  const allBtns = document.querySelectorAll('#actions .pop-btn');
  allBtns.forEach((b) => { b.disabled = true; });
  _setNote('');

  const labelEl = btn.querySelector('.pop-label');
  if (labelEl) {
    labelEl.textContent = kind.startsWith('teams')
      ? '取得中…（時間がかかる場合があります）'
      : '取得中…';
  }

  let success = false;
  let errMsg = '';
  try {
    const res = await chrome.tabs.sendMessage(_currentTabId, { type: 'rfmd:extract', kind, mode });
    if (!res || !res.ok) {
      errMsg = res?.error || '実行に失敗しました';
    } else if (mode === 'copy') {
      success = await _copyToClipboard(res.text || '');
      if (!success) errMsg = 'クリップボードにコピーできませんでした';
    } else {
      success = true;
    }
  } catch (e) {
    errMsg = e?.message || String(e);
    // コンテンツスクリプトが応答しない / 拡張更新で context 無効化（ページ再読込が必要）
    if (/Receiving end does not exist|message port closed|context invalidated/i.test(errMsg)) {
      errMsg = '拡張機能が更新されたか、ページが古い可能性があります。ページを再読み込みしてからお試しください';
    }
  }

  _showFeedback(btn, success, errMsg, allBtns);
}

function _showFeedback(btn, success, errMsg, allBtns) {
  btn.classList.add(success ? 'pop-btn--success' : 'pop-btn--error');
  // 成功時はアイコンをチェックに化けさせる（達成感のマイクロインタラクション）。
  // 失敗時は元アイコンのまま色だけ警告色に。
  _setPopBtnContent(btn, success ? ICON.check : btn._origIcon, success ? '完了' : '失敗');
  if (!success && errMsg) _setNote('エラー: ' + errMsg);

  setTimeout(() => {
    btn.classList.remove('pop-btn--success', 'pop-btn--error');
    _setPopBtnContent(btn, btn._origIcon, btn._origLabel);
    allBtns.forEach((b) => { b.disabled = false; });
  }, FEEDBACK_MS);
}

/* ── サイト別レンダリング ───────────────────────── */

/**
 * 利用不可の理由に応じて案内文言を出し分ける。
 * 401/タイムアウト/ネットワーク等は「取得失敗（要再ログイン）」、それ以外は既定文言。
 */
function _unavailableMessage(status, defaultMsg) {
  const reason = status && status.reason ? String(status.reason) : '';
  if (/^error:|timeout|abort|\b401\b|\b403\b|network/i.test(reason)) {
    return '情報の取得に失敗しました。ログイン状態を確認し、ページを再読み込みしてからお試しください。';
  }
  return defaultMsg;
}

function _renderForStatus(status) {
  _clearActions();
  _setNote('');
  const { siteType, pageType, available, title } = status || {};

  if (!siteType || siteType === 'unknown') {
    _setInactive('対応ページを開いてください');
    return;
  }

  // PR 一覧ページ: “どの PR か” が定まらないので案内のみ（行ボタンはページ側に残してある）
  if (pageType === 'list') {
    _setActive(`${SITE_LABEL[siteType] || siteType} のPR一覧`);
    _setNote('PR を開くと、ここからダウンロード／コピーできます。一覧の各行のボタンからも直接ダウンロードできます。');
    return;
  }

  if (siteType === 'github' || siteType === 'devops' || siteType === 'codecommit') {
    _setActive(`${SITE_LABEL[siteType]} の PR${title ? '：' + title : ''}`);
    _addActionButton({ label: 'MDでダウンロード', icon: ICON.download, kind: 'pr', mode: 'download', primary: true });
    _addActionButton({ label: 'MDコピー', icon: ICON.copy, kind: 'pr', mode: 'copy' });
    return;
  }

  if (siteType === 'sharepoint_teams') {
    if (!available) {
      _setInactive(_unavailableMessage(status, 'この録画にはトランスクリプトがありません'));
      return;
    }
    _setActive('SharePoint 会議録画を検出しました');
    _addActionButton({ label: 'VTTでダウンロード', icon: ICON.download, kind: 'vtt', mode: 'download', primary: true });
    _addActionButton({ label: 'VTTコピー', icon: ICON.copy, kind: 'vtt', mode: 'copy' });
    return;
  }

  if (siteType === 'teams_chat') {
    if (!available) {
      _setInactive(_unavailableMessage(status, 'チャット／チャネルを開いてください'));
      return;
    }
    _setActive(`Teams${title ? '：' + title : ' チャット'}`);
    _setNote('全履歴を自動スクロールで収集します。会話が長いと数十秒かかることがあります。');
    _addActionButton({ label: 'MDでダウンロード', icon: ICON.download, kind: 'teams-md', mode: 'download', primary: true });
    _addActionButton({ label: 'MDコピー', icon: ICON.copy, kind: 'teams-md', mode: 'copy' });
    return;
  }

  _setInactive('対応ページを開いてください');
}

/* ── コンテンツスクリプト未到達時（URL ベースのフォールバック）──── */

/** DevOps PR ページ（詳細 or 一覧）を判定 */
function _isDevOpsPRPath(url) {
  return RE_DEVOPS_PR.test(url) || RE_DEVOPS_PR_LIST.test(url);
}

async function _hasOriginPermission(url) {
  try {
    const origin = new URL(url).origin + '/*';
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}

/**
 * active tab 内で Azure DevOps シグナルを検証する（permission 取得後に呼ぶ）。
 *
 * ⚠️ 同期必須: src/service_worker.js の verifyAzureDevOpsInTab と意図的な**コピー**。
 *    MV3 は Service Worker と popup 間でモジュール共有できないため並存している。
 *    判定ロジックを変更した際は必ず両方に反映すること。変更の起点: service_worker.js が正。
 */
async function _verifyAzureDevOpsInTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          if (typeof VSS !== 'undefined' || typeof TfsContext !== 'undefined') return true;
        } catch {}
        if (document.querySelector('.repos-pr-details-page')) return true;
        if (document.querySelector('[class*="bolt-header"]')) return true;
        if (document.querySelector('[class*="repos-pr-"]')) return true;
        const scripts = document.querySelectorAll('script[src]');
        for (const s of scripts) {
          const src = s.getAttribute('src') || '';
          if (/VSS\.SDK|ms\.vss-tfs-web|_static\/tfs/.test(src)) return true;
        }
        return false;
      },
    });
    return results?.[0]?.result === true;
  } catch (e) {
    console.debug('[ReviewForMD] DevOps verification failed:', e?.message || e);
    return false;
  }
}

/**
 * active tab にコンテンツスクリプト一式を注入する（service_worker に委譲）。
 * ファイルリストの権威は service_worker.js 一箇所に集約している。
 */
async function _injectContentScriptsInTab(tabId, url) {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'rfmd:request-injection', tabId, url });
    return !!(res && res.ok);
  } catch (e) {
    console.error('[ReviewForMD] Popup injection request failed:', e?.message || e);
    return false;
  }
}

/**
 * コンテンツスクリプトに届かなかった場合の処理。
 * カスタムドメイン DevOps の許可フロー or 案内表示。
 */
async function _handleNoContentScript(tab) {
  const url = tab.url;

  // カスタムドメイン Azure DevOps の可能性（URL パスベース）→ 許可フロー
  if (_isDevOpsPRPath(url) && !RE_DEVOPS_HOST.test(url)) {
    const granted = await _hasOriginPermission(url);
    if (granted) {
      _setInactive('Azure DevOps を検証中...');
      const isDevOps = await _verifyAzureDevOpsInTab(tab.id);
      if (!isDevOps) {
        _setInactive('Azure DevOps として検証できませんでした');
        return;
      }
      _setInactive('コンテンツスクリプトを注入中...');
      const ok = await _injectContentScriptsInTab(tab.id, url);
      if (ok) {
        // 注入後に状態を取り直してボタンを描画
        const status = await _queryStatus(tab.id);
        if (status) _renderForStatus(status);
        else _setInactive('注入しました。ページを再読み込みしてください');
      } else {
        _setInactive('注入に失敗しました。ページを再読み込みしてください');
      }
      return;
    }
    _showGrantFlow(tab, url);
    return;
  }

  // 既知の対応ドメインなのに届かない → コンテンツスクリプト未ロード（インストール直後など）
  const isKnownTarget =
    (RE_GITHUB_HOST.test(url) && (RE_GITHUB_PR.test(url) || RE_GITHUB_PR_LIST.test(url))) ||
    (RE_DEVOPS_HOST.test(url) && _isDevOpsPRPath(url)) ||
    (RE_CODECOMMIT_HOST.test(url) && RE_CODECOMMIT_PR.test(url)) ||
    (RE_SHAREPOINT_HOST.test(url) && RE_SHAREPOINT_STREAM.test(url)) ||
    RE_TEAMS_HOST.test(url);

  if (isKnownTarget) {
    _setInactive('ページを再読み込みしてからお試しください');
    return;
  }

  _setInactive('対応ページを開いてください');
}

/** カスタムドメイン許可ボタンの提示とハンドラ結線 */
function _showGrantFlow(tab, url) {
  const grantBtn = document.getElementById('grant-btn');
  const grantHint = document.getElementById('grant-hint');
  _setNeedsPermission('カスタムドメインを検出しました。下のボタンで権限を許可してください');
  grantBtn.classList.add('grant-btn--visible');
  grantHint.classList.add('grant-hint--visible');

  // onclick 代入で冪等化（_showGrantFlow が複数回呼ばれてもリスナー多重登録しない）
  grantBtn.onclick = async () => {
    grantBtn.disabled = true;
    grantBtn.textContent = '許可をリクエスト中...';
    const origin = new URL(url).origin + '/*';
    try {
      // chrome.permissions.request は user gesture (クリック) 内でのみ呼べる
      const permOk = await chrome.permissions.request({ origins: [origin] });
      if (!permOk) {
        grantBtn.disabled = false;
        grantBtn.textContent = 'このサイトでの動作を許可する';
        _setNeedsPermission('権限取得がキャンセルされました');
        return;
      }
      grantBtn.textContent = 'Azure DevOps を検証中...';
      const isDevOps = await _verifyAzureDevOpsInTab(tab.id);
      if (!isDevOps) {
        try { await chrome.permissions.remove({ origins: [origin] }); } catch {}
        grantBtn.disabled = false;
        grantBtn.textContent = 'このサイトでの動作を許可する';
        _setNeedsPermission('Azure DevOps として検証できませんでした。権限は返上しました');
        return;
      }
      // 検証OK → タブをリロードして service_worker 経由で正規ルートで注入
      await chrome.tabs.reload(tab.id);
      window.close();
    } catch (e) {
      grantBtn.disabled = false;
      grantBtn.textContent = 'このサイトでの動作を許可する';
      _setNeedsPermission('エラー: ' + (e?.message || e));
    }
  };
}

/* ── 起動 ─────────────────────────────────────── */

async function _queryStatus(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'rfmd:status' });
  } catch {
    return null; // コンテンツスクリプト未注入
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  _setStatus('確認中...', 'inactive');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) {
      _setInactive('タブ情報を取得できませんでした');
      return;
    }
    _currentTabId = tab.id;

    const status = await _queryStatus(tab.id);
    if (status) {
      _renderForStatus(status);
    } else {
      await _handleNoContentScript(tab);
    }
  } catch {
    _setInactive('タブ情報を取得できませんでした');
  }
});
