# AGENTS.md

このリポジトリの作業規約、必須コマンド、検証手順、変更時の制約を扱う。利用方法は [README.md](README.md)、構造・責務・データフロー・設計判断は [DESIGN.md](DESIGN.md) を正本とする。構造や責務を変更するときは、実装と同じ変更内で設計書も更新する。

「いろいろMDコピー」はVanilla JSのChrome / Firefox Manifest V3拡張。UI・コメント・Markdownのラベルは日本語を使う。

## Commands

**Dependencies / shared support UI:** `bun run deps` で依存を復元する。`src/shared/` は `@kagayoi/support-extension` から配布物へ同梱する追跡済みコピーなので、同パッケージの更新後とパッケージ作成前に `bun --bun run sync:support` を実行し、JSとCSSを一式で同期する。共通部品の実装変更はパッケージ側を正本とし、このリポジトリのコピーへ直接加えない。

**Package:** `bun --bun run zip` (OS 自動判定なし＝Unix側)、または直接 `.\zip.ps1` (Windows) / `./zip.sh` (Linux/macOS) → Chrome用`ReviewForMD.zip`とFirefox用`ReviewForMD-firefox.zip`を生成。Windowsからnpm経由で実行したい場合は`bun --bun run zip:win`。

**Release (自動公開):** `release/x.y.z`ブランチをpushすると`.github/workflows/publish.yml`が起動し、Chrome用ZIPをCWS、Firefox用ZIPをAMOへ渡す**2つの独立ジョブ**で公開する。両提出ジョブは共通の`package`ジョブだけに依存し、互いには依存しないので、片方のストアが失敗してももう片方は止まらない。必要なGitHub Secrets: CWSは`CWS_EXTENSION_ID` / `CWS_CLIENT_ID` / `CWS_CLIENT_SECRET` / `CWS_REFRESH_TOKEN`、AMOは`AMO_JWT_ISSUER` / `AMO_JWT_SECRET`。**AMOは初回のみDeveloper Hubでのadd-on登録が必要**。バージョンバンプ＋ストアlisting同期は`/vava`スキルを使う。

CWSはAPI V2を使うため、上記に加えてGitHub Actions variable `CWS_PUBLISHER_ID`（secretでも可）が必要。Developer Dashboardのアカウントページで確認する。提出状態の判定は [DESIGN.md](DESIGN.md#配布設計) を参照する。AMO jobはPowerShellで実行する。

ローカルに自動テスト・専用リンタはない。配信CIは `.github/workflows/publish.yml` にある。実機読み込みは [README.md](README.md#インストール) を参照する。

**構文サニティチェック（テスト代替）:** 自動テスト・専用リンタが無いため、JS を変更したら `bun build --no-bundle <file> --outdir <temporary-directory>` で構文確認するのが慣習（壊れた構文は実機まで気づけない）。例: `bun build --no-bundle src/extractors/teams_extractor.js --outdir <temporary-directory>`。manifest は `Get-Content manifest.json -Raw | ConvertFrom-Json` で JSON 妥当性を確認できる。

Firefox manifest生成だけを確認する場合は `bun --bun run manifest:firefox` を使う（出力: `build-firefox/manifest.json`）。梱包スクリプトは固定依存の復元とSupport一致検査を実行する。共通部品更新後の同期は事前に行う。Windows梱包は `temp-build/package` だけを作成・清掃し、`temp-build` 配下の他の成果物には触れない。

変更した機能は実機で保存・コピーまで確認する。抽出・非同期処理の変更では、抽出中のSPA遷移、通信失敗と再試行、一覧ボタンの連打、Teamsの部分保存・中止・0件を該当経路で確認し、再現手順と出力を検証結果として残す。

## ストア画像生成

`webstore/` の画像生成依存はルートから隔離し、ローカルの `webstore/package.json`・`bun.lock`・`bunfig.toml` と `node_modules/` は Git 管理しない。既存のローカル設定は `packageManager: bun@1.4.4`、`trustedDependencies: ["puppeteer"]`、`[install] minimumReleaseAge = 86400` を保つ。`cd webstore` 後に `bun run deps` と `bun --bun run generate-screenshots` を実行する。既存 lock の初回移行は `bun install --lockfile-only` を使い、依存版を維持する。必要な環境では `PUPPETEER_EXECUTABLE_PATH` へ Chrome/Edge の絶対パスを渡す。

## 変更時の制約

### 読み込み・サイト判定

- IIFEで公開APIをグローバルへ公開し、非公開関数は `_` を接頭辞にする。新しい共有グローバルには `Rfmd` を付け、ブラウザ組み込み名との衝突を避ける。
- 静的・動的注入とも、`site_detector` → `markdown_builder` → `clipboard` → `fetch_utils` → サイト固有Extractor → `button_injector` → `content_script` の依存順を維持する。
- Chrome用 `manifest.json` は `background.service_worker` のみを宣言する。Firefox用は `scripts/create-firefox-manifest.mjs` で生成し、正本へ `background.scripts` を併記しない。既存のgecko ID、最低対応版128.0、データ収集権限宣言を維持する。background処理はFirefoxのscriptsでも動作するよう、背景コンテキストでwindow/documentやSW専用APIへ依存させない（executeScriptでページへ渡す関数は除く）。
- service workerの動的注入はカスタムドメインDevOpsとCodeCommitのフォールバックに限定する。`extractorFileForUrl` でExtractorを1本だけ選び、GitHub・SharePoint・Teamsは静的注入に委ねる。
- `verifyAzureDevOpsInTab` は `src/service_worker.js` を正として変更し、`src/popup/popup.js` へ同じ変更を転記する。シグナル1つで許可する判定を厳しくする前に、オンプレDevOpsへの影響を確認する。検出との閾値の違いは [DESIGN.md](DESIGN.md#サイト判定とspa遷移) を参照する。
- TeamsとCodeCommitのサイト固有セレクタは各Extractorの `SELECTORS` で保守する。Teams検出は `TeamsExtractor.hasChatDom()` へ委譲し、別のセレクタ体系を増やさない。CodeCommit本文・コメントは実PRのDOMに基づいて調整する。

### 抽出・出力

- PR詳細とVTTの非同期処理では開始URLを照合し、保存・コピー直前にはアクション世代も照合する。SharePointのID・キャッシュ更新もURLと世代が一致する処理だけに許可する。
- GitHubのHTML取得は `_normalizePrConversationUrl` を通す。`_fetchHiddenConversations` のpagination削除対象はform自体に限定し、既存スレッドが同居する親DIVを削除しない。
- DevOps API URLは `_parseDevOpsUrl` から組み立て、クエリ値には `encodeURIComponent` を使う（`encodeURI` は `&`、`?`、`#`、`+` を保護しない）。差分照合の一意性・メモリ境界は [DESIGN.md](DESIGN.md#差分とmarkdownの整合性) を維持する。
- レスポンス本文を読む共有fetchは `RfmdFetch.withText` / `withJson` を使い、本文消費まで30秒の中止制御を維持する。
- SharePointのDrive ID / File IDは同じURL由来の完全な組だけを使う。ページに結び付けた候補を維持し、SPA切替後に旧ページ候補や初期scriptを再利用しない。現在ページのfetchイベントがnavigation通知より先に来ても、その候補を捨てない。
- VTT取得は `_isSharePointOrigin` のHTTPS・SharePointガードと `credentials: 'include'` を維持する。`omit` への変更前には [DESIGN.md](DESIGN.md#sharepointトランスクリプト) の認証上の理由を確認する。ID未取得・通信・権限エラーを利用可否キャッシュへ固定しない。
- レビュースレッドの重複除去では投稿者・ファイル・本文・日時・対象行の複合キーを維持し、同じ親の別ソースにある返信を統合する。リスト・表の変換は専用走査だけで行い、DOM深度上限を引き継ぐ。
- Teamsは再入ガード、中止・破棄、会話切替時のreset、時間・件数・反復上限を維持する。月判定と遡り停止には `time[datetime]` 由来の信頼できる時刻だけを使い、送信者・時刻の補完を期間フィルタより先に行う。
- Teams収集開始の `{ok, started}` と収集完了を区別する。完了時0件は成功・空ファイル扱いにせず、生0件と期間フィルタ後0件を `rawCount` で区別する。部分履歴の理由を画面とMarkdownに残す。
- Markdownのラベルは `本文`、`レビューコメント`、`コメント N`、`投稿者`、`日時`、`ファイル`、`対象行`、`↩ 返信` を使う。

### DOM・ログ・共通UI

- 動的内容は `createElement` / `textContent` / `replaceChildren` で構築し、`innerHTML` 代入を使わない（AMOの静的検査で警告になる）。SVGはDOMParserとimportNodeを使う。リモートJavaScriptやFirefox非対応のoffscreen APIを導入しない。
- DOM識別と二重注入防止には `data-rfmd` 属性と既存の `__rfmd_initialized` / `__rfmd_nav_hooked__` を使う。
- 一覧ボタンの成否は可視テキスト・アクセシブル名・ `role="status"` 領域に反映する。テーマ対応は一覧ボタンの `src/ui/styles.css` とpopupの `popup.html` で行う。
- ログには `[ReviewForMD]` を付け、content script起動時のバージョン・hostログを維持する。SAS付きURL等は `_redactUrl` でorigin+pathnameへ縮約する。拡張更新で発生する `Extension context invalidated` は黙って処理する。
- `src/shared/` は配布時コピーへ直接実装変更せず、Supportパッケージ側を変更してJS/CSSを一式同期する。問い合わせ経路へPR・VTT・チャットの抽出データを渡さない。

### 配信

- `release/x.y.z` はmanifestのversionと一致させる。公開構成と重複提出判定は [DESIGN.md](DESIGN.md#配布設計) を参照する。
- CWSはSecretsを持たない梱包ジョブのartifactだけを受け取り、提出ジョブでcheckoutやnpm lifecycleを実行しない。OAuth応答を出力せず、単一行のaccess tokenだけをマスクし、`set -x` を有効にしない。
- GitHub ActionsはSHAを固定し、更新時はタグコメントも合わせる。checkoutは `persist-credentials: false` を維持する。AMOのweb-extはパッチ版を固定する。

### ストア掲載情報

CWS ID は `CWS_EXTENSION_ID` 環境変数で指定できる（ローカルに `.cws-id` があれば利用可）。リポジトリルートで実行する。AMO 更新は公開依頼時のみ実行し、事前に同じコマンドへ `--dry-run` を付けて入力を確認する。

```powershell
bun "$HOME/.agents/skills/vava/scripts/update-amo-listing.mjs" --slug 'iroiro-md-copy' --listing 'ja=webstore/store-listing.firefox.ja.txt' --listing 'en-US=webstore/store-listing.firefox.en.txt' --privacy 'ja=docs/privacy-policy.md' --privacy 'en-US=docs/privacy-policy-en.md' --name 'ja=いろいろMDコピー' --name 'en-US=Iroiro MD Copy' --homepage 'https://github.com/1llum1n4t1s/ReviewForMD' --support-url 'https://github.com/1llum1n4t1s/ReviewForMD/issues' --category 'web-development'
bun "$HOME/.agents/skills/vava/scripts/check-store-listing.mjs" --cws --amo --slug 'iroiro-md-copy' --cws-id-file '.cws-id' --keyword 'cws.description.ja=CodeCommit' --keyword 'cws.description.ja=SharePoint' --keyword 'cws.description.ja=Teams' --keyword 'cws.description.en=CodeCommit' --keyword 'cws.description.en=SharePoint' --keyword 'cws.description.en=Teams' --keyword 'amo.summary.ja=CodeCommit' --keyword 'amo.description.ja=CodeCommit' --keyword 'amo.summary.ja=SharePoint' --keyword 'amo.description.ja=SharePoint' --keyword 'amo.summary.ja=Teams' --keyword 'amo.description.ja=Teams' --keyword 'amo.summary.en-US=CodeCommit' --keyword 'amo.description.en-US=CodeCommit' --keyword 'amo.summary.en-US=SharePoint' --keyword 'amo.description.en-US=SharePoint' --keyword 'amo.summary.en-US=Teams' --keyword 'amo.description.en-US=Teams'
```

### AMO 公開のHTTP境界

公開workflowはネイティブarchive builderが生成した最終XPIとそのsnapshotのSHA-256 receiptを使い、GUID・versionとともに `scripts/Publish-Amo.ps1`（PowerShell 7.2 以上）へ渡す。旧web-ext sign/承認タイムアウトを成功化する手順に代えて、JWT認証・全ページの非公開listed版検査・upload検証・GUIDに対するPUT提出の受付応答まで確認する。XPIの同一snapshotをhash検証と送信に使い、保存UUIDの再利用・重複・不明な受付結果は停止する。CI成功は審査完了・ストア公開を意味しない。

### CI中間成果物

job間の検証済み成果物はprivate R2へSigV4で保存し、repository・commit・run・producer attemptのidentityと各ファイルのSHA-256/サイズを検証して復元する。設定は `vars.CLOUDFLARE_ACCOUNT_ID` / `vars.R2_ARTIFACT_BUCKET` と `secrets.R2_ARTIFACT_ACCESS_KEY_ID` / `secrets.R2_ARTIFACT_SECRET_ACCESS_KEY`。キーは当該bucket限定。`ci-artifacts/` は30日保持後にlifecycleで削除され、恒久配布とは区別する。

CWSは `scripts/Publish-Cws.ps1`（PowerShell 7、API v2）を使う。既存OAuth secretsとpublisher/item IDを維持し、同期upload成功・応答ID・manifest版の一致を確認してpublishする。非同期uploadは版を確定できないため自動publishせず停止する。公開workflowはrepository単位の `queue: max` で最大100件まで直列化し、Dashboardや他の手動公開と並行しない。

### CWS v2の再実行

`Publish-Cws.ps1` は認証付きfetchStatusのitem identity・revision state・distributionChannelsのversionを検証する。PUBLISHED / PUBLISHED_TO_TESTERS / PENDING_REVIEW / STAGED の正常な登録版が今回versionと一致するときだけ、従来の再実行契約として「既に提出/公開済み・今回ZIPの新規送信なし」と明示して終了する。ストア配布bytesと今回ZIPの同一性を確認したとは扱わない。未提出draft・不明状態・非同期uploadは成功として扱わず停止する。新規送信はverifier receiptに一致するsnapshotを使い、同期uploadのID・版とpublish受付応答を確認する。公開はrepository単位で直列化し、外部Dashboard操作と並行しない。


新規cloneでは隔離用設定は付属しない。"webstore/package.json" を private なBun 1.4.4パッケージとして作成し、puppeteer 25.14.0 を固定、trustedDependenciesはpuppeteerだけ、scripts.depsは "bun ../scripts/Install-Dependencies.mjs"、scripts["deps:resolve"]は "bun install" とする。scripts.generate-screenshotsも "bun generate-screenshots.js" にする。bunfig.tomlは最低24時間待機と [run] bun=true を指定する。初回だけ "bun run --cwd webstore deps:resolve" でlockを生成し、その後は "bun run --cwd webstore deps" で固定復元する。これらはローカル専用で強制Git追加しない。

## Bun依存の脆弱性検出

依存の固定復元は `bun run deps` を使う。lock欠落・破損を拒否し、`[run] bun=true` 経由で依存のpostinstallまでBunで実行する。Node.jsがあるPCでも通常の `bun install` を直接使う経路へ戻さない。

日次と手動実行では `bun audit` でlock全体を監査する。ローカルでも同じコマンドで確認できる。BunはDependabotの通常の更新PRには対応するが、脆弱性起点の自動修正PRは `dependency-security.yml` が補完する。日次・手動で全件監査し、隔離領域で `bun audit fix` による候補を作成し、同じrunから既存の Dependency validation を呼ぶ。未対策アドバイザリが減少し、依存以外のmanifest・パッチ・24時間待機を保ち、全検証が成功した場合だけ、検証したマージコミットを競合検知付きの通常pushで取り込む。保護されたブランチには自動pushせず、修正版未公開・互換性・検証失敗は単一のIssueに通知して次回再試行する。生の監査は警告を除外せず、対策済みパッチの認定も監査成功とは区別してsummaryへ残す。既知のdeepmerge対策はアドバイザリ・版・パッチSHAが完全一致した場合だけ修正対象から外し、生監査には残す。通常のDependabot更新と他ecosystemの設定は維持する。
