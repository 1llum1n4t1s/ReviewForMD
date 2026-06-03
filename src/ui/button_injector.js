/**
 * UI ボタン注入 + popup アクション実行モジュール
 *
 * 設計（popup 集約）:
 *   - PR 詳細 / SharePoint / Teams の「ページ埋め込みボタン」は廃止。
 *     これらのアクションは popup から実行される（UI = popup、実行係 = runAction）。
 *   - PR 一覧ページの各行ダウンロードボタンのみページ側に残す
 *     （“どの行か”が文脈依存で popup に移せないため）。
 *   - popup への状態提供は getStatus()、アクション実行は runAction() が担う。
 *     content_script.js の rfmd:status / rfmd:extract ハンドラから呼ばれる。
 */
var ButtonInjector = ButtonInjector || (() => {
  const CHECK_ICON_SVG = `<svg class="rfmd-btn-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>`;
  const DOWNLOAD_ICON_SVG = `<svg class="rfmd-btn-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z"/><path d="M7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06Z"/></svg>`;

  const DOWNLOAD_LABEL = `${DOWNLOAD_ICON_SVG} MDでダウンロード`;

  /** フィードバックアニメーション表示時間 (ms)。 */
  const FEEDBACK_DURATION_MS = 1500;

  /**
   * 一覧行ボタンのコピー/ダウンロード完了フィードバック表示。
   * busy フラグは呼び出し側で既に '1' に立てられている前提。
   */
  function _showFeedback(btn, success) {
    if (btn._rfmdTimer) {
      clearTimeout(btn._rfmdTimer);
      btn._rfmdTimer = null;
    }

    const originalHtml = btn.dataset.rfmdOriginal;
    const isDownload = btn.dataset.rfmdAction === 'download';
    const cls = success ? 'rfmd-btn--success' : 'rfmd-btn--error';
    const label = success
      ? `${CHECK_ICON_SVG} ${isDownload ? 'ダウンロード完了' : 'コピー完了'}`
      : `${isDownload ? 'ダウンロード失敗' : 'コピー失敗'}`;

    btn.classList.add(cls);
    btn.innerHTML = label;

    btn._rfmdTimer = setTimeout(() => {
      if (!btn.isConnected) {
        btn._rfmdTimer = null;
        return;
      }
      btn.classList.remove(cls);
      btn.innerHTML = originalHtml;
      btn.dataset.rfmdBusy = '0';
      btn._rfmdTimer = null;
    }, FEEDBACK_DURATION_MS);
  }

  /**
   * ボタン生成ファクトリ（現状の利用箇所は一覧ページの行ボタンのみ）。
   * action='download' の extractFn は次のいずれかを返す:
   *   - { title, markdown }           → {title}.md として保存
   *   - { text, filename, mimeType? } → filename そのままで保存
   *   - { blob, filename }            → Blob をそのまま保存（ZIP 等）
   * @returns {HTMLButtonElement}
   */
  function _createButton({ className, dataRfmd, label, title, action = 'copy', extractFn }) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.setAttribute('data-rfmd', dataRfmd);
    btn.setAttribute('aria-label', title);
    btn.innerHTML = label;
    btn.dataset.rfmdOriginal = label;
    btn.dataset.rfmdBusy = '0';
    if (action === 'download') btn.dataset.rfmdAction = 'download';
    btn.title = title;

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.dataset.rfmdBusy === '1') return;
      // 即座に busy 状態にして並行クリックを防止 (single-flight)
      btn.dataset.rfmdBusy = '1';
      try {
        const result = await Promise.resolve(extractFn());
        let ok;
        if (action === 'download') {
          // 現状の唯一の利用箇所は PR 一覧の行ボタンで、extractFn は {title, markdown} を返す。
          // ZIP/VTT 等の binary・text 保存は popup の runAction 経路が担うため、ここは .md 保存のみ。
          const filename = _sanitizeFilename(result.title) + '.md';
          ok = RfmdClipboard.download(result.markdown, filename);
        } else {
          ok = await RfmdClipboard.copy(result);
        }
        _showFeedback(btn, ok);
      } catch (err) {
        console.error('[ReviewForMD]', err);
        _showFeedback(btn, false);
      }
    });

    return btn;
  }

  /**
   * サイトタイプに対応する Extractor を返す。
   * content_scripts はサイト別に分割されているため、現在のページで未ロードの
   * extractor は `typeof ... === 'undefined'` になる。typeof ガードで安全化する。
   */
  function _getExtractor(siteType) {
    if (siteType === SiteDetector.SiteType.GITHUB) {
      return typeof GitHubExtractor !== 'undefined' ? GitHubExtractor : null;
    }
    if (siteType === SiteDetector.SiteType.AZURE_DEVOPS) {
      return typeof DevOpsExtractor !== 'undefined' ? DevOpsExtractor : null;
    }
    if (siteType === SiteDetector.SiteType.AWS_CODECOMMIT) {
      return typeof CodeCommitExtractor !== 'undefined' ? CodeCommitExtractor : null;
    }
    if (siteType === SiteDetector.SiteType.SHAREPOINT_TEAMS) {
      return typeof SharePointExtractor !== 'undefined' ? SharePointExtractor : null;
    }
    if (siteType === SiteDetector.SiteType.TEAMS_CHAT) {
      return typeof TeamsExtractor !== 'undefined' ? TeamsExtractor : null;
    }
    return null;
  }

  /**
   * ファイル名として使えない文字を除去する。
   * 制御文字 / RTL override / FS 禁止文字 / 先頭末尾ドット / Windows 予約名 / 長大文字列を無害化。
   */
  function _sanitizeFilename(name) {
    if (typeof name !== 'string') return 'pullrequest';
    let s = name.normalize('NFKC');
    s = s
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/[‎‏‪-‮⁦-⁩]/g, '')
      .replace(/[﻿ ]/g, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+|\.+$/g, '')
      .trim();
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i.test(s)) {
      s = '_' + s;
    }
    if (s.length > 200) s = s.slice(0, 200).trim();
    return s || 'pullrequest';
  }

  /**
   * 外部サーバー由来のファイル名を安全化する（拡張子を分離して sanitize）。
   * @param {string} raw - サーバー由来の filename
   * @param {string} fallbackExt - raw が拡張子を持たないときに付与する拡張子（".vtt" 等）
   */
  function _sanitizeDownloadFilename(raw, fallbackExt = '') {
    const s = typeof raw === 'string' ? raw : '';
    const noPath = s.replace(/\\/g, '/').split('/').pop() || '';
    const dotIdx = noPath.lastIndexOf('.');
    const base = dotIdx > 0 ? noPath.slice(0, dotIdx) : noPath;
    let ext = dotIdx > 0 ? noPath.slice(dotIdx) : '';
    ext = ext.replace(/[\x00-\x1f\x7f\\/:*?"<>|‎‏‪-‮⁦-⁩]/g, '');
    if (!/^\.[A-Za-z0-9._-]{1,12}$/.test(ext)) ext = fallbackExt || '';
    return _sanitizeFilename(base) + ext;
  }

  /* ── PR 一覧ページ用ボタン注入（ページ側に残す唯一の埋め込み）─────── */

  function _injectGitHubList() {
    if (typeof GitHubExtractor === 'undefined') return;
    const prRows = document.querySelectorAll('.js-issue-row, [data-testid="list-view-item"]');

    prRows.forEach((row) => {
      if (row.querySelector('[data-rfmd="list-dl"]')) return;

      const link =
        row.querySelector('a[data-hovercard-type="pull_request"]') ||
        row.querySelector('a[id^="issue_"]') ||
        row.querySelector('a[href*="/pull/"]');
      if (!link) return;
      const prUrl = link.href;
      if (!prUrl || !/\/pull\/\d+/.test(prUrl)) return;

      const btn = _createButton({
        className: 'rfmd-btn rfmd-btn--sm',
        dataRfmd: 'list-dl',
        action: 'download',
        label: DOWNLOAD_LABEL,
        title: 'この PR を Markdown ファイルでダウンロード',
        extractFn: () => GitHubExtractor.extractByPrUrl(prUrl),
      });

      const wrap = document.createElement('span');
      wrap.className = 'rfmd-list-btn-wrap';
      wrap.appendChild(btn);

      const contentArea = row.querySelector('.flex-auto.min-width-0') ||
        row.querySelector('.d-flex.mt-1') || row;
      contentArea.appendChild(wrap);
    });
  }

  function _injectDevOpsList() {
    if (typeof DevOpsExtractor === 'undefined') return;
    const prRows = document.querySelectorAll('a.bolt-table-row, a.bolt-list-row');

    prRows.forEach((row) => {
      const prUrl = row.href;
      if (!prUrl || !/\/pullrequest\/\d+/i.test(prUrl)) return;
      if (row.querySelector('[data-rfmd="list-dl"]')) return;

      const btn = _createButton({
        className: 'rfmd-btn rfmd-btn--sm',
        dataRfmd: 'list-dl',
        action: 'download',
        label: DOWNLOAD_LABEL,
        title: 'この PR を Markdown ファイルでダウンロード',
        extractFn: () => DevOpsExtractor.extractByPrUrl(prUrl),
      });

      const wrap = document.createElement('span');
      wrap.className = 'rfmd-list-btn-wrap';
      wrap.appendChild(btn);

      const cellContent = row.querySelector('.bolt-table-cell-content.flex-column') ||
        row.querySelector('.bolt-table-two-line-cell .bolt-table-cell-content');
      if (cellContent) {
        cellContent.appendChild(wrap);
      } else {
        const titleCell = row.querySelector('.bolt-table-two-line-cell') ||
          row.querySelector('td:nth-child(3)');
        if (titleCell) {
          titleCell.appendChild(wrap);
        } else {
          row.appendChild(wrap);
        }
      }
    });
  }

  /* ── popup 向け: 現在ページの状態を返す ───────────────────────── */

  /**
   * 現在ページのサイト種別・ページ種別・利用可否・タイトルを返す。
   * popup が rfmd:status で取得し、サイトに合うボタンを描画するのに使う。
   * @returns {Promise<{siteType:string, pageType:('detail'|'list'|null), available:boolean, title:string}>}
   */
  async function getStatus() {
    let siteType = SiteDetector.detect();
    let pageType = 'detail';
    if (siteType === SiteDetector.SiteType.UNKNOWN) {
      siteType = SiteDetector.detectList();
      pageType = 'list';
    }
    if (siteType === SiteDetector.SiteType.UNKNOWN) {
      return { siteType: SiteDetector.SiteType.UNKNOWN, pageType: null, available: false, title: '' };
    }

    let available = true;
    let title = '';
    let reason = ''; // 利用不可の理由（401/network/no-transcript 等）を popup へ伝える

    if (pageType === 'detail') {
      const extractor = _getExtractor(siteType);
      if (!extractor) {
        available = false;
      } else {
        // SharePoint / Teams は実コンテンツの有無を確認（GitHub/DevOps は常に true）
        if (typeof extractor.checkAvailability === 'function') {
          try {
            const r = await extractor.checkAvailability();
            available = !!(r && r.available);
            if (!available && r && r.reason) reason = r.reason;
          } catch (e) {
            available = false;
            reason = `error: ${e?.message || e}`;
          }
        }
        if (available && typeof extractor.getTitle === 'function') {
          try {
            title = extractor.getTitle() || '';
          } catch {
            title = '';
          }
        }
      }
    }

    if (!title) {
      title = (document.title || '').trim();
    }

    return { siteType, pageType, available, title, reason };
  }

  /* ── popup 向け: アクション実行（抽出 + ダウンロード/コピー）──────── */

  /**
   * popup から依頼されたアクションを実行する。
   *   mode='download' → このページ側で保存し {ok} を返す
   *   mode='copy'     → 文字列を {ok, text} で返す（クリップボード書き込みは popup 側）
   * @param {{kind:('pr'|'vtt'|'teams-md'|'teams-zip'), mode:('download'|'copy')}} req
   * @returns {Promise<{ok:boolean, text?:string, error?:string}>}
   */
  async function runAction({ kind, mode }) {
    try {
      if (kind === 'pr') {
        // 現在の PR ページ（GitHub or Azure DevOps）を判定して抽出
        const siteType = SiteDetector.detect();
        const extractor = _getExtractor(siteType);
        if (!extractor) return { ok: false, error: 'PR ページの extractor が見つかりません' };
        const title = extractor.getTitle();
        const markdown = await extractor.extractAll();
        if (mode === 'copy') return { ok: true, text: markdown };
        const ok = RfmdClipboard.download(markdown, _sanitizeFilename(title) + '.md');
        return ok ? { ok: true } : { ok: false, error: 'ダウンロードに失敗しました' };
      }

      if (kind === 'vtt') {
        const extractor = _getExtractor(SiteDetector.SiteType.SHAREPOINT_TEAMS);
        if (!extractor) return { ok: false, error: 'SharePoint extractor が見つかりません' };
        const { text, filename } = await extractor.downloadTranscript();
        if (mode === 'copy') return { ok: true, text };
        const ok = RfmdClipboard.download(
          text,
          _sanitizeDownloadFilename(filename, '.vtt'),
          'text/vtt;charset=utf-8'
        );
        return ok ? { ok: true } : { ok: false, error: 'ダウンロードに失敗しました' };
      }

      if (kind === 'teams-md') {
        const extractor = _getExtractor(SiteDetector.SiteType.TEAMS_CHAT);
        if (!extractor) return { ok: false, error: 'Teams extractor が見つかりません' };
        const title = extractor.getTitle();
        const { markdown, count } = await extractor.extractAll();
        // 0 件成功偽装の防止: メッセージが取れなかったら成功扱いにしない
        if (!count) {
          return { ok: false, error: 'メッセージを抽出できませんでした（Teams の画面構成が変わった可能性があります）' };
        }
        if (mode === 'copy') return { ok: true, text: markdown };
        const ok = RfmdClipboard.download(markdown, _sanitizeFilename(title) + '.md');
        return ok ? { ok: true } : { ok: false, error: 'ダウンロードに失敗しました' };
      }

      if (kind === 'teams-zip') {
        const extractor = _getExtractor(SiteDetector.SiteType.TEAMS_CHAT);
        if (!extractor) return { ok: false, error: 'Teams extractor が見つかりません' };
        const { blob, filename, count } = await extractor.extractWithAttachments();
        if (!count) {
          return { ok: false, error: 'メッセージを抽出できませんでした（Teams の画面構成が変わった可能性があります）' };
        }
        const ok = RfmdClipboard.downloadBlob(blob, _sanitizeDownloadFilename(filename, '.zip'));
        return ok ? { ok: true } : { ok: false, error: 'ZIP の生成に失敗しました' };
      }

      return { ok: false, error: '未知のアクション: ' + kind };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  /* ── 公開 API ─────────────────────────────────── */

  /**
   * SPA 遷移でページを離脱したときのクリーンアップ。
   * 一覧行ボタンのフィードバックタイマーを解除する。
   */
  function cleanup() {
    document.querySelectorAll('[data-rfmd]').forEach((btn) => {
      if (btn._rfmdTimer) {
        clearTimeout(btn._rfmdTimer);
        btn._rfmdTimer = null;
      }
    });
  }

  /**
   * PR 一覧ページにダウンロードボタンを注入する。
   * @param {string} siteType
   */
  function injectList(siteType) {
    if (siteType === SiteDetector.SiteType.GITHUB) {
      _injectGitHubList();
    } else if (siteType === SiteDetector.SiteType.AZURE_DEVOPS) {
      _injectDevOpsList();
    }
  }

  return { injectList, cleanup, getStatus, runAction };
})();
