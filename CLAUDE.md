# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Chrome extension (Manifest V3) — 複数サイトの情報を MD/VTT ファイルでダウンロード:
- **PR レビュー**: GitHub・Azure DevOps（カスタムドメイン含む）の PR タイトル/本文/レビューコメントを Markdown でダウンロード（またはコピー）
- **会議トランスクリプト**: SharePoint Stream の Teams 会議録画ページから VTT 字幕ファイルをダウンロード

Vanilla JS、ビルドステップなし。日本語 UI/コメント。

## Commands

**Package:** `npm run zip` (OS 自動判定なし＝Unix側)、または直接 `.\zip.ps1` (Windows) / `./zip.sh` (Linux/macOS) → `ReviewForMD.zip` 生成。Windows から npm 経由で実行したい場合は `npm run zip:win`。

**Release (自動公開):** `release/x.y.z` ブランチを push すると `.github/workflows/publish.yml` が起動し、Chrome Web Store API 経由で自動アップロード＆公開される。必要な GitHub Secrets: `CWS_EXTENSION_ID` / `CWS_CLIENT_ID` / `CWS_CLIENT_SECRET` / `CWS_REFRESH_TOKEN`。バージョンバンプは `/vava` スキルで一括実行可。

No tests, no linter. Install via `chrome://extensions` → Load unpacked → リポジトリルートを選択。

## Repo layout

- `src/lib/` — サイト非依存のユーティリティ (`site_detector`, `markdown_builder`, `clipboard`)
- `src/extractors/` — サイト別抽出ロジック (`github_extractor`, `devops_extractor`, `sharepoint_extractor`)
- `src/inject/` — main world に注入するフック (`navigation_hook`, `sharepoint_fetch_hook`) — `web_accessible_resources` に登録
- `src/ui/` — ボタン注入 (`button_injector.js`) と CSS (`styles.css`)
- `src/popup/` — ツールバーアイコンのポップアップ UI
- `src/content_script.js` / `src/service_worker.js` — エントリポイント
- `docs/` — Chrome Web Store 審査用のプライバシーポリシーなど
- `webstore/` — CWS 掲載用のアセット

## Architecture

### Data flow

```
content_script.js (entry, IIFE)
  → SiteDetector.detect()    → ButtonInjector.inject()
  → MutationObserver (400ms debounce)
  → SPA nav listeners (4 methods)

PR 詳細ページ:
  ボタンクリック → Extractor.getTitle() + Extractor.extractAll()
    → MarkdownBuilder → RfmdClipboard.download() / RfmdClipboard.copy()

PR 一覧ページ:
  ボタンクリック → Extractor.extractByPrUrl(url)  ※バックグラウンドで PR ページを fetch
    → { title, markdown } → RfmdClipboard.download()
```

### Content script load order matters

Defined in manifest.json `content_scripts.js` array. Each module is an IIFE that exposes a global (`SiteDetector`, `MarkdownBuilder`, etc.), so order determines dependency availability. manifest は3エントリに分割されており、各エントリは以下の順で共通ライブラリ → サイト固有 extractor → UI の順にロードする:

`site_detector` → `markdown_builder` → `clipboard` → `fetch_utils` → **[site-specific extractor]** → `button_injector` → `content_script`

`fetch_utils.js` (`RfmdFetch`) は `github_extractor` / `devops_extractor` / `sharepoint_extractor` が使う `_fetchWithTimeout` / `FETCH_TIMEOUT_MS` の共有モジュール。

**動的注入（カスタムドメイン DevOps 専用）**: `service_worker.js` は `chrome.scripting.executeScript` でカスタムドメインの DevOps ページのみ動的注入する。GitHub・SharePoint は静的注入のみ。動的注入のファイルリストにも `fetch_utils.js` を含める必要がある。

### Module pattern

IIFE returning public API object. Private functions prefixed with `_`. No ES modules — all scripts share the global scope within the content script context.

### SPA navigation detection (4 layers)

`content_script.js` listens for navigation via: (1) `chrome.runtime.onMessage` from service worker, (2) custom events from `navigation_hook.js` (injected into main world to hook `history.pushState/replaceState`), (3) `popstate` for browser back/forward, (4) GitHub's `turbo:load` event. All four trigger `reinit()` — a 300 ms-debounced wrapper (`NAV_REINIT_DEBOUNCE_MS`) that resets `_retries` before calling `init()`. `init()` self は即時実行で、MutationObserver 側は別の 400 ms (`DEBOUNCE_MS`) で絞る。

### Service worker (`service_worker.js`)

Monitors `webNavigation.onHistoryStateUpdated` and `onCompleted` for PR page URLs. For known domains (github.com, dev.azure.com, *.visualstudio.com), sends `rfmd:navigate` message to content script; falls back to dynamic injection if message fails (content script not yet loaded). For custom domains, always dynamically injects via `chrome.scripting.executeScript`.

### DevOps extraction strategy (3 tiers)

`devops_extractor.js` uses a tiered approach because DevOps is a SPA with lazy-loaded DOM:

1. **DOM extraction** — parses rendered comments from Activity/Discussion tabs and inline file comments
2. **REST API fallback** (`fetchViaApi`) — when DOM comments are missing or incomplete (e.g., unloaded tabs), fetches via `/_apis/git/repositories/.../pullRequests/.../threads` and iterations endpoints
3. **Items API enrichment** (`_enrichWithItemsApi`) — when threads lack diff context (source code lines), fetches file contents and FileDiffs API to reconstruct diff blocks. Batched with max 6 concurrent fetches.

`extractAll()` orchestrates: tries DOM first, falls back to API if comments are missing, then enriches any remaining threads lacking `diffLines` via Items API.

### GitHub extraction strategy (2 tiers)

`github_extractor.js` uses a dual-source approach to ensure complete comment extraction:

1. **DOM extraction** — parses live page comments after expanding hidden conversations (`_loadHiddenConversations`)
2. **HTML fetch fallback** (`_fetchAndExtractComments`) — fetches the same PR page via HTTP, parses with DOMParser, and loads hidden conversations (`_fetchHiddenConversations`). Captures review threads that are collapsed or not rendered in the live DOM due to GitHub's lazy-loading/fold state. Results are merged with DOM threads and deduplicated.

`extractAll()` orchestrates: expands hidden conversations in live DOM, extracts comments, then supplements with HTML fetch results.

Two extraction entry points exist:
- `extractAll()` — PR 詳細ページ用。ライブ DOM + HTML fetch の2ソースを統合
- `extractByPrUrl(url)` — PR 一覧ページ用。HTML fetch のみ（ライブ DOM なし）。`_fetchHiddenConversations` で pagination を処理

### GitHub hidden conversations loading

`_fetchHiddenConversations(doc, baseUrl)` は DOMParser 生成の doc 内の未読み込みコンテンツを fetch して挿入する。2種類のソースを処理:

1. **turbo-frame[src]** — GitHub がまだレンダリングしていない hidden items
2. **`.ajax-pagination-btn`** — "Load more" ボタン（form の action 属性から URL 取得）

**⚠️ 重要な設計制約**: pagination btn の `el` は `form` 自体を指す必要がある（`form.parentElement` ではない）。GitHub の PR ページでは、pagination form の親 DIV 内に既存のレビュースレッド（turbo-frame）が兄弟要素として共存しているため、親 DIV を `el.remove()` すると既存スレッドも巻き添えで削除される。

### Site detection

`site_detector.js`: GitHub by domain+path. DevOps known domains (dev.azure.com, *.visualstudio.com) by URL path (case-insensitive). Custom DevOps domains by URL path pattern + 2+ DOM signals (`.repos-pr-details-page`, `bolt-header`, PR tabbar, etc.). SharePoint Stream by `*.sharepoint.com` domain + `stream.aspx` path.

### SharePoint Stream extraction strategy

`sharepoint_extractor.js` は Teams 会議録画ページから VTT トランスクリプトを取得する。Drive ID と File ID の取得には2層構造を採用:

1. **`<script>` タグ抽出** (`_extractIdsFromScripts`) — 初期 HTML に埋め込まれた script の textContent から `drives/b!XXX` と `items/YYY` を正規表現抽出（同期）
2. **main world fetch フックフォールバック** (`sharepoint_fetch_hook.js`) — `<script>` から取れない場合に備え、main world に注入したフックが `window.fetch` を監視し、`/_api/v2.1/drives/` を含む URL から ID をキャプチャして CustomEvent `rfmd:sp-ids` で content script に通知

ID 取得後、`/_api/v2.1/drives/{driveId}/items/{fileId}?select=media/transcripts&$expand=media/transcripts` でメタデータ取得 → `temporaryDownloadUrl` を `/streamContent?is=1&applymediaedits=false` に正規化 → `credentials:'omit'`（temporaryDownloadUrl は SAS トークン埋め込み型のため cookie 不要）で VTT 取得 → `RfmdClipboard.download(text, filename, 'text/vtt;charset=utf-8')`。

`checkAvailability()` の結果は同一 URL でキャッシュするが、**`no-ids` の場合はキャッシュしない**（fetch フック由来の ID が後から到着したときに再評価できるようにするため）。stream.aspx?id=A → ?id=B のクエリ変更で別動画に遷移した際、`_capturedDriveId/_capturedFileId` も自動でクリアされる（古い動画の ID で API を叩かないため）。

### Button injection

`button_injector.js`: PR 詳細ページでは「MDでダウンロード」ボタン（全体）と「MDコピー」ボタン（個別コメント）を注入。PR 一覧ページでは各行にダウンロードボタンを追加（PR を開かずに取得可能）。`_createButton` factory でクリックハンドラを構成、フィードバックアニメーション（1.5s）と二重クリック防止（`data-rfmd-busy`）付き。

### Thread deduplication

`MarkdownBuilder.deduplicateThreads(threads)` はスレッド配列の先頭コメントから複合キーを生成して重複を除去する:

```
key = `${author}::${filePath}::${body}::${timestamp}::${lineRange}`
```

5要素すべてが必要な理由: bot（Codex, Gemini）が同一ファイルに同じテンプレート文のレビューを複数回投稿するため、`author::filePath::body` だけでは異なるレビューラウンドのコメントが誤って除去される。`timestamp` と `lineRange`（diffContext 由来）で区別する。

### HTML → Markdown conversion

`markdown_builder.js`: Recursive DOM walker (`_convertNode`) with 80-depth limit. Handles headings, inline formatting, code blocks (with language detection), links (with relative URL resolution), images (data-URI → placeholder), lists (nested with depth tracking), tables, checkboxes. Security: sanitizes dangerous URI schemes, escapes Markdown injection in link text/URLs. Filters out GitHub Code Review Agent badge images.

### Popup (`src/popup/`)

`popup.html` + `popup.js`: ツールバーアイコンクリック時のポップアップ UI。現在のタブが PR ページかどうかのステータスを表示。

### CSS / ダークモード

`styles.css`: GitHub テーマ（緑系）と DevOps テーマ（青系）の 2 系統。`@media (prefers-color-scheme: dark)` と GitHub 独自のダークモード属性 (`[data-color-mode="dark"]`, `[data-dark-theme]`) の両方に対応。

## Conventions

- `data-rfmd` attributes for DOM targeting and duplicate prevention
- `[ReviewForMD]` prefix on all console output
- Extension context invalidation errors (`Extension context invalidated`) silently caught throughout — this is expected when extension is updated while page is open
- `window.__rfmd_initialized` / `window.__rfmd_nav_hooked__` flags prevent double initialization from dynamic injection
- DevOps API URLs are constructed from URL parsing (`_parseDevOpsUrl`), not hardcoded — supports custom domains
- Markdown output uses Japanese labels: `本文`, `レビューコメント`, `コメント N`, `投稿者`, `日時`, `ファイル`, `対象行`, `↩ 返信`
- グローバル変数名は `Rfmd` プレフィックス（例: `RfmdClipboard`）でブラウザ組み込みオブジェクトとの名前衝突を回避
- PR タイトルの取得: DOM 要素 → `document.title` フォールバック（両プラットフォーム共通）
- GitHub REST API (`api.github.com`) は CORS 制約でCookie認証不可（`Access-Control-Allow-Origin: *` が `credentials: 'include'` をブロック）。代わりに同一オリジンの HTML fetch + DOMParser を使用
- `_fetchHiddenConversations` の DOM 操作では、挿入先要素 (`el`) のスコープに注意 — `el.remove()` は `el` 自体とその子孫のみ削除されるが、`el` が意図より広い範囲を指すと既存コンテンツが失われる
