# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Chrome extension (Manifest V3) — 複数サイトの情報を MD/VTT ファイルでダウンロード:
- **PR レビュー**: GitHub・Azure DevOps（カスタムドメイン含む）・AWS CodeCommit の PR タイトル/本文/レビューコメントを Markdown でダウンロード（またはコピー）
- **会議トランスクリプト**: SharePoint Stream の Teams 会議録画ページから VTT 字幕ファイルをダウンロード
- **Teams チャット**: Microsoft Teams（teams.microsoft.com / teams.live.com / teams.cloud.microsoft）のチャット/チャネルを自動スクロールで全履歴収集し、Markdown でダウンロード

アプリ表示名は「いろいろMDコピー」。Vanilla JS、ビルドステップなし。日本語 UI/コメント。**Chrome / Firefox(MV3) 両対応** — 単一の `manifest.json` を共有。Chrome は `browser_specific_settings` を無視、Firefox は `gecko.id` + `strict_min_version: 128.0`（`optional_host_permissions` 対応）+ `data_collection_permissions: {required:["none"]}`（データ非収集宣言）を読む。`background` は **dual-key**（`service_worker` を Chrome、`scripts: ["src/service_worker.js"]` を Firefox が使う MDN 推奨のクロスブラウザパターン）— `service_worker.js` は `window`/`document` も SW 専用 API も使わないので両コンテキストで動く。⚠️ **Chrome 110-120 は MV3 で `background.scripts` を無視せず拒否する**（121+ で無視に変わった）ため、`minimum_chrome_version: "121"` で 121 未満を弾く（旧 Chrome に壊れたパッケージを配らない）。`web-ext lint` は errors 0（残る warnings は dual-key の informational と data_collection の forward-compat のみ）。CWS/AMO とも同一 zip（manifest + src + icons）で公開する。

## Commands

**Package:** `npm run zip` (OS 自動判定なし＝Unix側)、または直接 `.\zip.ps1` (Windows) / `./zip.sh` (Linux/macOS) → `ReviewForMD.zip` 生成。Windows から npm 経由で実行したい場合は `npm run zip:win`。

**Release (自動公開):** `release/x.y.z` ブランチを push すると `.github/workflows/publish.yml` が起動し、**2 つの独立ジョブ**で公開する: (1) Chrome Web Store（`chrome-webstore-upload-cli` で auto-publish）、(2) Firefox AMO（`web-ext sign --channel listed` で listed 提出）。ジョブは互いに `needs` を持たず独立なので、片方のストアが失敗してももう片方は止まらない。必要な GitHub Secrets: CWS は `CWS_EXTENSION_ID` / `CWS_CLIENT_ID` / `CWS_CLIENT_SECRET` / `CWS_REFRESH_TOKEN`、AMO は `AMO_JWT_ISSUER` / `AMO_JWT_SECRET`。**AMO は初回のみ Developer Hub での add-on 登録が必要**（listing 情報の事前登録。登録後は CI が新バージョンを listed channel に自動提出）。バージョンバンプ＋ストア listing 同期は `/vava` スキル（AMO listing は `vava.config.json` + `webstore/store-listing.firefox.{ja,en}.txt` を参照）。

No tests, no linter. Install via `chrome://extensions` → Load unpacked → リポジトリルートを選択。

**構文サニティチェック（テスト代替）:** テスト/リンタ/CI が無いため、JS を変更したら `node --check <file>` で構文確認するのが慣習（壊れた構文は実機まで気づけない）。例: `node --check src/extractors/teams_extractor.js`。manifest は `Get-Content manifest.json -Raw | ConvertFrom-Json` で JSON 妥当性を確認できる。

## Repo layout

- `src/lib/` — サイト非依存のユーティリティ (`site_detector`, `markdown_builder`, `clipboard`, `fetch_utils`)
- `src/extractors/` — サイト別抽出ロジック (`github_extractor`, `devops_extractor`, `codecommit_extractor`, `sharepoint_extractor`, `teams_extractor`)
- `src/inject/` — main world に注入するフック (`navigation_hook`, `sharepoint_fetch_hook`) — `web_accessible_resources` に登録
- `src/ui/` — ボタン注入 (`button_injector.js`) と CSS (`styles.css`)
- `src/popup/` — ツールバーアイコンのポップアップ UI
- `src/content_script.js` / `src/service_worker.js` — エントリポイント
- `docs/` — Chrome Web Store 審査用のプライバシーポリシーなど
- `webstore/` — CWS 掲載用のアセット

## Architecture

### Data flow

UI は **popup に集約**されている。詳細ページ（GitHub/DevOps PR・SharePoint・Teams）のアクションは
すべて popup から実行する。ページ側に残る埋め込みボタンは **PR 一覧の各行ダウンロードのみ**。

```
content_script.js (entry, IIFE)
  → SiteDetector.detect() / detectList()
  → PR 一覧ページのみ ButtonInjector.injectList()（行ボタン）+ MutationObserver
  → SPA nav listeners (5 methods)
  → chrome.runtime.onMessage: rfmd:status / rfmd:extract / rfmd:navigate

詳細ページ（popup 主導）:
  popup 起動 → tabs.sendMessage('rfmd:status')
    → ButtonInjector.getStatus() が { siteType, pageType, available, title } を返す
    → popup がサイトに合うボタンを描画
  ボタンクリック → tabs.sendMessage('rfmd:extract', { kind, mode })
    → ButtonInjector.runAction() が Extractor で抽出
        mode='download' → content script 側で RfmdClipboard.download/downloadBlob（{ok} を返す）
        mode='copy'     → 文字列を { ok, text } で返し popup 側が navigator.clipboard で書き込み
                          （clipboard はフォーカス必須なので popup 側で実行）

PR 一覧ページ（ページ側に残す）:
  行ボタンクリック → Extractor.extractByPrUrl(url)  ※バックグラウンドで PR ページを fetch
    → { title, markdown } → RfmdClipboard.download()
```

**kind**: `pr`（GitHub/DevOps/CodeCommit 詳細）/ `vtt`（SharePoint）/ `teams-md`。Teams 経路は抽出 0 件のとき `runAction` が `{ ok:false }` を返す（空ファイルの成功偽装防止）。**CodeCommit は詳細ページ専用**（PR 一覧の行ボタンは無し。コンソールがクライアントレンダリング SPA で `extractByPrUrl` の背景 fetch が不可能なため）。

### Content script load order matters

Defined in manifest.json `content_scripts.js` array. Each module is an IIFE that exposes a global (`SiteDetector`, `MarkdownBuilder`, etc.), so order determines dependency availability. manifest は5エントリに分割されており（GitHub / DevOps / CodeCommit / SharePoint / Teams）、各エントリは以下の順で共通ライブラリ → サイト固有 extractor → UI の順にロードする:

`site_detector` → `markdown_builder` → `clipboard` → `fetch_utils` → **[site-specific extractor]** → `button_injector` → `content_script`

CodeCommit エントリは `*.console.aws.amazon.com/codesuite/codecommit/*` にマッチし、`codecommit_extractor.js` をロードする。

`fetch_utils.js` (`RfmdFetch`) は `github_extractor` / `devops_extractor` / `sharepoint_extractor` が使う `withTimeout` / `withRetry`（429/503/一時障害を指数バックオフで再試行）/ `TIMEOUT_MS` の共有モジュール（CodeCommit は DOM 専用、Teams は MD 専用化で fetch しない）。

**動的注入（カスタムドメイン DevOps 専用）**: `service_worker.js` は `chrome.scripting.executeScript` でカスタムドメインの DevOps ページのみ動的注入する。GitHub・SharePoint は静的注入のみ。動的注入のファイルリストにも `fetch_utils.js` を含める必要がある。

### Module pattern

IIFE returning public API object. Private functions prefixed with `_`. No ES modules — all scripts share the global scope within the content script context.

### SPA navigation detection (5 layers)

`content_script.js` listens for navigation via: (1) `chrome.runtime.onMessage` from service worker, (2) custom events from `navigation_hook.js` (injected into main world to hook `history.pushState/replaceState`), (3) `popstate` for browser back/forward, (4) GitHub's `turbo:load` event, (5) `hashchange` (Teams クラシックのハッシュルーティング会話切替). All five trigger `reinit()` — a 300 ms-debounced wrapper (`NAV_REINIT_DEBOUNCE_MS`) that resets `_retries` before calling `init()`. `init()` self は即時実行で、MutationObserver（一覧ページのみ起動）側は別の 400 ms (`DEBOUNCE_MS`) で絞る。

### Service worker (`service_worker.js`)

Monitors `webNavigation.onHistoryStateUpdated` / `onCompleted`. For known domains (github.com / *.github.com / dev.azure.com / *.visualstudio.com / console.aws.amazon.com / *.console.aws.amazon.com / *.sharepoint.com), sends `rfmd:navigate` to the content script. **`injectContentScripts` のファイルリストは DevOps 用 extractor のみ**なので、メッセージ未達時のフォールバック動的注入は **DevOps 既知ドメイン (`isDevOpsKnownDomain`) に限定**する（GitHub/SharePoint は静的注入に委ね、誤った extractor セットを注入して `__rfmd_initialized` で正規注入を阻害しないため）。カスタムドメインは `verifyAzureDevOpsInTab` で DevOps シグナル検証後に `chrome.scripting.executeScript` で動的注入。Teams は SW 非関与（content script が自前で SPA 遷移を処理）。

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

### AWS CodeCommit extraction strategy

`codecommit_extractor.js` は AWS マネジメントコンソール（CodeSuite）の CodeCommit PR 詳細ページから DOM ベースで抽出する。**DOM 一択の理由**: 公開 CodeCommit API は SigV4 署名（IAM 秘密鍵）必須でブラウザから呼べず、コンソール内部 API は CSRF + セッション依存で未公開・脆い。

- 公開 API: `getTitle` / `getPRNumber`（URL ベース・最も堅牢）/ `getBody` / `getComments` / `extractAll`（Markdown 文字列を返す）。GitHub/DevOps と違い `extractByPrUrl` は**持たない**（コンソールはクライアントレンダリング SPA で生 HTML に PR データが無く、背景 fetch では取得不能）→ PR 一覧の行ボタンは提供せず、**詳細ページ専用**。
- **⚠️ セレクタの揮発性**: コンソールは Cloudscape の React SPA で CSS クラスがハッシュ化（`awsui_xxx_yyyy`）され頻繁に変わる。**サイト固有セレクタの単一の真実の源は `codecommit_extractor.js` の `SELECTORS`**。タイトル / PR 番号 / 検出は URL・見出しベースで堅牢だが、**本文・コメントのセレクタは best-effort のプレースホルダ**で、実 PR ページの DOM を採取して `SELECTORS` を調整する前提（Teams と同方針）。本文・コメントが両方空のとき `extractAll` は `console.warn` で調整シグナルを出す（タイトル見出しは必ず出すので空ファイルにはしない）。

### Site detection

`site_detector.js`: GitHub by domain+path. DevOps known domains (dev.azure.com, *.visualstudio.com) by URL path (case-insensitive). Custom DevOps domains by URL path pattern + 2+ DOM signals (`.repos-pr-details-page`, `bolt-header`, PR tabbar, etc.). AWS CodeCommit by console host (`*.console.aws.amazon.com`) + URL path (`/codesuite/codecommit/repositories/{repo}/pull-requests/{id}`)。コンソールは Cloudscape の React SPA で DOM クラスがハッシュ化され揮発性が高いため、検出は安定した URL ベース（DOM 非依存）。SharePoint Stream by `*.sharepoint.com` domain + `stream.aspx` path. Microsoft Teams chat by Teams domain (teams.microsoft.com / teams.live.com / teams.cloud.microsoft) + message-list DOM signals（Teams はハッシュ/SPA ルーティングで URL から会話判定しづらいため DOM ベース）。

### SharePoint Stream extraction strategy

`sharepoint_extractor.js` は Teams 会議録画ページから VTT トランスクリプトを取得する。Drive ID と File ID の取得には2層構造を採用:

1. **`<script>` タグ抽出** (`_extractIdsFromScripts`) — 初期 HTML に埋め込まれた script の textContent から `drives/b!XXX` と `items/YYY` を正規表現抽出（同期）
2. **main world fetch フックフォールバック** (`sharepoint_fetch_hook.js`) — `<script>` から取れない場合に備え、main world に注入したフックが `window.fetch` を監視し、`/_api/v2.1/drives/` を含む URL から ID をキャプチャして CustomEvent `rfmd:sp-ids` で content script に通知

ID 取得後、`/_api/v2.1/drives/{driveId}/items/{fileId}?select=media/transcripts&$expand=media/transcripts` でメタデータ取得 → `temporaryDownloadUrl` を `/streamContent?is=1&applymediaedits=false` に正規化 → `credentials:'omit'`（temporaryDownloadUrl は SAS トークン埋め込み型のため cookie 不要）で VTT 取得 → `RfmdClipboard.download(text, filename, 'text/vtt;charset=utf-8')`。

`checkAvailability()` の結果は同一 URL でキャッシュするが、**`no-ids` の場合はキャッシュしない**（fetch フック由来の ID が後から到着したときに再評価できるようにするため）。stream.aspx?id=A → ?id=B のクエリ変更で別動画に遷移した際、`_capturedDriveId/_capturedFileId` も自動でクリアされる（古い動画の ID で API を叩かないため）。

### Teams chat extraction strategy

`teams_extractor.js` は Teams チャット/チャネルの全履歴を **DOM 自動スクロール方式** で収集する（公開機能仕様からのクリーンルーム実装。内部 chatsvc API は未使用）。Teams Web は仮想スクロールで画面外メッセージが DOM から外れるため、スクロールしながら逐次回収する必要がある。

1. **スクローラ特定** — `SELECTORS.scroller` 候補 → 外れたら最初のメッセージ要素から `_findScrollableAncestor` でスクロール可能祖先を探索
2. **段階スクロール収集** (`_collectRecords`) — 下端（最新）から上へ `clientHeight * 0.8` ずつ移動し、各 viewport の可視メッセージを id キーの Map に確保（**全メッセージを viewport に通す**ためジャンプではなく段階移動）。上端では `LOAD_WAIT_MS` 待って古い分の prepend を待ち、`scrollHeight` が増えなくなる状態が `STABLE_ROUNDS` 連続したら終了。**毎ラウンド中止フラグ（`_cancelRequested` / `_discarded`）と期間 cutoff（`sinceMs`）を確認して途中終了でき、`onProgress` でオーバーレイへ進捗を通知する**。`MAX_ITERATIONS` / `MAX_DURATION_MS` / `MAX_MESSAGES` はセーフティネットとして維持
3. **時系列整列 + 送信者補完 + 期間フィルタ** (`_finalize`) — mid（≒epoch ms の単調増加値）→ timestamp → 収集順 の優先で sort。Teams は同一送信者連投で名前を 1 度しか出さないため、整列後に空 author を直前 author で前方補完する。**補完はフィルタより前・全レコードで行う**（期間フィルタで著者名を持つグループ先頭が落ちても継続分の著者を失わないため）。期間フィルタは **`time[datetime]` 由来の信頼できる ts（`tsPrecise`）が `sinceMs` より古いものだけ除外**し、title 由来の粗い ts / ts 不明は残す
4. **Markdown 生成** (`_buildMarkdown`) — 本文は `MarkdownBuilder.htmlToMarkdown`、日時は `formatTimestamp` を再利用。本文クローンから添付（画像・ファイルカード）を抜いてから変換し、二重化を防ぐ

**起動 / 出力**（長時間処理のため popup ではなくページ側オーバーレイで完結させる）:
- `startCollection({ sinceDays, mode })` — fire-and-forget で収集を開始し `{ ok, started }` を即返す。収集・進捗表示・中止・保存/コピーは content script 側の **進捗オーバーレイ**（ページ右下のパネル）で完結する。これにより popup を閉じても収集を継続でき、いつでも「ここまでで保存」/「中止」できる（`mode='download'` は完了時にその場保存、`mode='copy'` は完了オーバーレイの操作ボタンから user 操作起点でコピー＝「popup を閉じると copy が失敗する」問題を回避）
- 期間は popup の期間ドロップダウン（過去 1/2/3 か月＝`sinceDays` 30/60/90）で事前制限する。`count`＝収集件数で 0 件は成功扱いにしない（空ファイルの偽装防止。生 0 件＝セレクタ全滅と、期間フィルタ後 0 件＝期間内に無し、を `rawCount` で区別して文言を出し分ける）

**堅牢化（暴走・OOM・取りこぼし・無言失敗の防止）**:
- 再入ガード `_busy`（収集中の多重起動を弾く）＋ 中止フラグ `_cancelRequested`（ここまでで保存）/ `_discarded`（破棄）でいつでも安全に停止できる
- `_collectRecords` は開始時の `location.href` が変わったら中断、`startCollection` も完了時に href を再確認して会話切替時は保存しない。`reset()`（会話切替/離脱で content_script が呼ぶ）は進行中収集を破棄しオーバーレイを閉じる（誤会話の収集・DOM 奪い合い・部分データの誤保存を防ぐ）
- 期間 cutoff は **信頼できる `time[datetime]` 由来 ts のみで打ち切る**（title 由来の誤日付＝添付の更新日等で期間内メッセージを取りこぼさない）
- 生収集 0 件は `console.warn`（セレクタ全滅の切り分け用ログ）

**⚠️ セレクタの揮発性**: Teams の DOM クラス/属性は頻繁に変わる。**サイト固有セレクタの単一の真実の源は `teams_extractor.js` の `SELECTORS`**。`site_detector.js` の `_isTeamsChatByDom` は `TeamsExtractor.hasChatDom()` に委譲しているので、UI 変更で動かなくなったら `SELECTORS` だけを実機 DOM に合わせて調整すればよい（detect 側と extract 側でセレクタが分裂するのを防ぐ設計）。

### Button injection / popup actions

`button_injector.js` は UI 注入とアクション実行の両方を担う:
- **ページ埋め込み（残存）**: PR 一覧ページの各行ダウンロードボタン（`injectList` → `_injectGitHubList` / `_injectDevOpsList`）のみ。`_createButton` factory でクリックハンドラ・フィードバック（1.5s）・二重クリック防止（`data-rfmd-busy`）を構成。一覧行の `extractFn` は `{title, markdown}` を返し `.md` 保存する（VTT 等の binary・text 保存は popup の `runAction` 経路が担う。`RfmdClipboard` には `download` / `downloadBlob` の両方がある）。
- **popup 向け（詳細ページのアクションはこちら）**:
  - `getStatus()` — `SiteDetector.detect/detectList` ＋ SharePoint/Teams の `checkAvailability` で `{ siteType, pageType, available, title }` を返す
  - `runAction({ kind, mode })` — kind ごとに extractor を呼び、`mode='download'` はその場で保存して `{ok}`、`mode='copy'` は `{ok, text}` を返す（popup 側でクリップボードへ）
- 詳細ページにボタンを埋め込まなくなったため、`_injectGitHub`/`_injectDevOps`/`_injectSharePoint`/`_injectTeams` と個別コメント/詳細用ファクトリは廃止。`_getExtractor`・サニタイズ・一覧注入は維持。

content_script の `chrome.runtime.onMessage` が `rfmd:status` → `getStatus()`、`rfmd:extract` → `runAction()` を仲介する。

### Thread deduplication

`MarkdownBuilder.deduplicateThreads(threads)` はスレッド配列の先頭コメントから複合キーを生成して重複を除去する:

```
key = `${author}::${filePath}::${body}::${timestamp}::${lineRange}`
```

5要素すべてが必要な理由: bot（Codex, Gemini）が同一ファイルに同じテンプレート文のレビューを複数回投稿するため、`author::filePath::body` だけでは異なるレビューラウンドのコメントが誤って除去される。`timestamp` と `lineRange`（diffContext 由来）で区別する。

### HTML → Markdown conversion

`markdown_builder.js`: Recursive DOM walker (`_convertNode`) with 80-depth limit. Handles headings, inline formatting, code blocks (with language detection), links (with relative URL resolution), images (data-URI → placeholder), lists (nested with depth tracking), tables, checkboxes. Security: sanitizes dangerous URI schemes, escapes Markdown injection in link text/URLs. Filters out GitHub Code Review Agent badge images.

### Popup (`src/popup/`)

`popup.html` + `popup.js`: ツールバーアイコンのポップアップ UI。**全アクションの実行起点**。起動時に `rfmd:status` で現在ページの状態を取得し、サイトに合うボタン（GitHub/DevOps/CodeCommit=MD DL+コピー、SharePoint=VTT DL+コピー、Teams=MD DL+コピー、一覧=案内）を動的描画する。ボタンクリックで `rfmd:extract` を送信。**コピーは popup 側で `navigator.clipboard`（フォーカス必須のため）**、ダウンロードは content script 側で実行。content script に届かない場合（カスタムドメイン DevOps 未許可など）は URL ベースの許可フロー（`chrome.permissions.request` → DevOps シグナル検証 → service_worker 経由注入）にフォールバック。

### CSS / ダークモード

`styles.css`: 詳細ページのボタン埋め込みを廃止したため、**PR 一覧の行ボタン（`.rfmd-btn--sm` / `.rfmd-list-btn-wrap`）向けに絞った**。GitHub ダークモード属性（`[data-color-mode="dark"]` / `html.dark`）と DevOps ダークテーマ、`@media (prefers-color-scheme: dark)` に対応。popup 内のボタン CSS は `popup.html` の `<style>` に定義（`.pop-btn` 系、ダークモード対応）。

## Conventions

- `data-rfmd` attributes for DOM targeting and duplicate prevention
- `[ReviewForMD]` prefix on all console output。content_script 起動時に `[ReviewForMD] v{version} loaded on {host}` を 1 行出す（ユーザー報告からバージョン/サイトを特定するため）
- 機微 URL（SAS トークン付き SharePoint/OneDrive URL 等）をログに出すときは `_redactUrl` 等で `origin+pathname` に落としてから出力する
- Extension context invalidation errors (`Extension context invalidated`) silently caught throughout — this is expected when extension is updated while page is open
- `window.__rfmd_initialized` / `window.__rfmd_nav_hooked__` flags prevent double initialization from dynamic injection
- DevOps API URLs are constructed from URL parsing (`_parseDevOpsUrl`), not hardcoded — supports custom domains
- Markdown output uses Japanese labels: `本文`, `レビューコメント`, `コメント N`, `投稿者`, `日時`, `ファイル`, `対象行`, `↩ 返信`
- グローバル変数名は `Rfmd` プレフィックス（例: `RfmdClipboard`）でブラウザ組み込みオブジェクトとの名前衝突を回避
- PR タイトルの取得: DOM 要素 → `document.title` フォールバック（両プラットフォーム共通）
- GitHub REST API (`api.github.com`) は CORS 制約でCookie認証不可（`Access-Control-Allow-Origin: *` が `credentials: 'include'` をブロック）。代わりに同一オリジンの HTML fetch + DOMParser を使用
- `_fetchHiddenConversations` の DOM 操作では、挿入先要素 (`el`) のスコープに注意 — `el.remove()` は `el` 自体とその子孫のみ削除されるが、`el` が意図より広い範囲を指すと既存コンテンツが失われる
- **`innerHTML` 代入は使わない**（Firefox AMO の `web-ext lint` が `UNSAFE_VAR_ASSIGNMENT` 警告を static analysis で出すため。runtime で安全でも警告は消えない）。ボタン等の動的内容は DOM 構築で組む: `button_injector` の `_setButtonContent`（SVG アイコンは `_buildSvg` = `DOMParser('image/svg+xml')` + `importNode`）、`popup.js` の `_setPopBtnContent`（`createElement` + `textContent` + `replaceChildren`）。クリアは `el.replaceChildren()`。Firefox 固有 API（`offscreen` 等）は不使用なので strip マーカーは不要
