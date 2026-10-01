# いろいろMDコピー 設計

この文書は、現在のコードと設定に基づくシステム設計の正本です。利用方法は [README.md](README.md)、作業規約と検証手順は [AGENTS.md](AGENTS.md) を参照してください。

## 目的とシステム境界

「いろいろMDコピー」は、利用者が開いているWebページから次の情報を抽出し、MarkdownまたはVTTとしてローカルへ保存・コピーするChrome / Firefox Manifest V3拡張です。

- GitHub、Azure DevOps、AWS CodeCommitのPR本文とレビューコメント
- SharePoint Stream上のTeams会議トランスクリプト
- Microsoft Teamsのチャット・チャネル履歴

抽出結果はファイルまたはクリップボードへ出力し、外部の保存基盤は持ちません。Kagayoi Supportへの問い合わせだけは独立した利用者操作であり、フォームの入力内容、製品ID・アプリ版・ブラウザ言語などの付随情報を `support.kagayoi.com` へ送信します。PR、トランスクリプト、チャット本文は問い合わせ経路へ渡しません。

## 主要コンポーネント

| コンポーネント | 責務と境界 |
| --- | --- |
| `manifest.json` | 対応サイト、権限、静的content script、Chromeのservice workerを宣言する正本。 |
| `src/popup/` | 全詳細ページ操作の起点。サイト状態と利用可能な操作を表示し、フォーカスが必要なクリップボード書き込みを行う。 |
| `src/content_script.js` | ページ側の調停役。SPA遷移を検知し、`rfmd:status` / `rfmd:extract` / `rfmd:navigate` を処理する。 |
| `src/ui/button_injector.js` | popup向け状態取得・抽出実行と、GitHub / DevOpsのPR一覧行ボタンを提供する。 |
| `src/lib/` | サイト判定、HTML→Markdown変換、ダウンロード、タイムアウト・再試行付きfetchを共有する。 |
| `src/extractors/` | サイト固有のDOM・HTML・API差異を吸収し、MarkdownまたはVTTへ正規化する。 |
| `src/service_worker.js` | 対象タブのナビゲーションを監視し、カスタムドメインDevOpsとCodeCommitの必要時だけ動的注入する。 |
| `src/inject/` | main worldでHistory APIとSharePointのfetchを観測し、isolated worldへ最小限のイベントを渡す。 |
| `src/shared/` | `@kagayoi/support-extension` から同期したJS/CSSの配布時コピーとして、popup内の問い合わせフォームとフッターを提供する。抽出機能とはデータを共有しない。 |
| `scripts/create-firefox-manifest.mjs` | Chrome正本からFirefoxの`background.scripts`形式へmanifestを決定的に変換する。 |
| `zip.ps1` / `zip.sh` | Chrome用`ReviewForMD.zip`とFirefox用`ReviewForMD-firefox.zip`を生成する。 |
| `.github/workflows/publish.yml` | `release/x.y.z`を検証・梱包し、CWSとAMOを独立ジョブで提出する。 |

## 実行モデルとデータフロー

### 詳細ページ

1. popupがcontent scriptへ `rfmd:status` を送り、`SiteDetector` と各Extractorの利用可否判定を取得する。
2. 利用者操作で `rfmd:extract { kind, mode, monthsAgo }` を送る。
3. `ButtonInjector.runAction()` がサイト固有Extractorを呼ぶ。
4. PR・VTTのダウンロードはcontent script側で実行し、コピーは文字列をpopupへ返して `navigator.clipboard` へ書く。Teamsは開始結果 `{ok, started}` だけを即返し、収集完了と出力はページ内オーバーレイが担う。

`kind` は `pr`（GitHub / DevOps / CodeCommit）、`vtt`（SharePoint）、`teams-md`（Teams）です。状態応答は `{siteType, pageType, available, title, reason}`、PR・VTTの操作応答は保存時 `{ok}`、コピー時 `{ok, text}`、失敗時 `{ok:false, error}` を返します。

PR詳細の各Extractorは開始時のURLを保持し、通信・会話展開・タブ切替の待機後に照合して、別PRのDOMを混ぜません。アクション実行側も開始URLとcleanupで進める世代を保存し、完了時に一致する場合だけ保存またはコピー用文字列を返します。

### PR一覧ページ

content scriptがGitHub / DevOpsの各行へ小型ボタンを注入し、対象PRのHTMLまたはAPIを背景取得してMarkdownを直接保存します。GitHubのHTML取得は、現在ページや一覧リンクが `/files`、`/commits`、`/checks` 等のサブタブでも本文と会話を欠落させないよう、常に `/{owner}/{repo}/pull/{id}` のConversation URLへ正規化します。CodeCommitはクライアントレンダリングSPAのため、一覧取得を行わず詳細ページだけを対象にします。

一覧ボタンの成否は可視テキスト・アクセシブル名へ反映し、独立した `role="status"` 領域でも通知します。

### SharePointトランスクリプト

初期文書ではscriptから同じAPI URLに含まれるDrive ID / File IDの組を抽出します。main worldのfetchフックは文字列・URL・Request入力から完全なID組と発生時のページURLを通知し、content scriptは現在ページの候補だけを信頼度順にAPIで検証します。SPA切替後は残存する初期scriptを使いません。確定したIDからトランスクリプトURLを得てVTTを取得します。取得URLは `temporaryDownloadUrl` の末尾を `/streamContent?is=1&applymediaedits=false` へ正規化し、クエリを上書きするため、元のSAS認証情報は残りません。認証Cookieが必要なため `credentials: 'include'` を使い、送信先はHTTPSの `*.sharepoint.com` に限定します。`omit` では401になった実績があり、Cookieはドメインスコープで送信されます。

利用可否判定とVTT取得は開始URLと世代を通信後に照合してからID・キャッシュを更新し、結果を返します。URL変更とresetで世代を進め、同じURLのreset前の処理も破棄します。ID未取得と通信・権限エラーはキャッシュせず、次の操作で再評価します。

### Teamsチャット

仮想スクロールで画面外要素が破棄されるため、最新位置から上方向へ段階スクロールし、各viewportのメッセージをID単位で蓄積します。移動幅は `max(200, clientHeight * 0.8)` とし、上端で古いメッセージの追加を待ちます。高さが増えない状態が3回続けば取得可能な履歴の先頭と判断します。mid（数値ID）、timestamp、収集順の優先で時系列整列した後、欠けた送信者と `time[datetime]` 由来の信頼できる時刻を直前の値から前方補完し、選択した開始月の月初 `sinceMs` から現在までへ絞ります。title由来の粗い日時は月判定・遡り停止に使わず、判定時刻が補完できないメッセージは残します。過去月の翌月初による上限は設けません。履歴が指定期間より短い場合は、取得可能な履歴の先頭で収集を正常終了し、取得できた分を保存します。進捗、部分保存、中止、会話切替時の破棄はページ内オーバーレイで完結します。

収集結果は終了理由を保持します。時間・件数・反復上限、スクロール領域未検出、「ここまでで保存」は、取得済みデータを保存しつつ画面とMarkdownに部分履歴と理由を明記し、利用者が確認できるよう完了パネルを自動で閉じません。期間下限または取得可能な履歴の先頭への到達は通常完了です。ファイル名はチャット名と保存日のローカル日付から `チャット名_yyyyMMdd.md` とします。コピーは完了パネルのボタンを利用者が押して実行するため、popupのフォーカスや寿命に依存しません。0件の場合は保存せず、生収集0件と期間フィルタ後0件を区別したエラーを表示します。

### お問い合わせ

popupの共通Web Componentが、メール確認コードによる認証後に問い合わせをKagayoi Supportへ送信します。認証済みセッションのアクセストークン、メールアドレス、有効期限は、フォームで認証した場合だけ拡張機能の `sessionStorage` に保存します。共通部品にはlocal保存の選択肢もありますが、この拡張のフッターはstorage属性を指定せず、既定のsession保存を使います。

問い合わせUIの実装正本は `@kagayoi/support-extension` パッケージです。拡張機能のMV3配布物がリモートJavaScriptへ依存しないよう、JSとCSSを同じパッケージ版の配布時コピーとして `src/shared/` へ同期し、ZIPへ同梱します。同期コマンドは [AGENTS.md](AGENTS.md#commands) を参照してください。

## サイト別の取得戦略

| 対象 | 採用方式 | 理由とトレードオフ |
| --- | --- | --- |
| GitHub | ライブDOMと同一オリジンHTML fetchを統合 | 折りたたみ・遅延表示コメントを補える一方、GitHub DOM構造への追随が必要。 |
| Azure DevOps | DOM → REST API → Items / FileDiffs補完 | 遅延DOMでも完全性を高められる一方、URL解析と複数API呼び出しが必要。 |
| AWS CodeCommit | 詳細ページのDOMのみ | SigV4秘密鍵を拡張へ持ち込まない代わりに、Cloudscape DOMセレクタの保守が必要。 |
| SharePoint | 埋め込みID → fetchフック → SharePoint API | 初期HTML差異に耐える一方、認証済み同一オリジン通信が必要。 |
| Teams | DOM自動スクロール | 非公開内部APIへ依存しない代わりに、仮想スクロールとDOM変更への追随が必要。 |

## サイト判定とSPA遷移

各サイトはmanifestの5つのcontent scriptエントリで独立して読み込まれます。スクリプトはES modulesではなく、IIFEの公開グローバルを読み込み順で共有します。共有fetchはGitHub・DevOps・SharePointが使用し、CodeCommitとTeamsはDOMだけを取得元にします。`RfmdFetch` は本文消費まで30秒のタイムアウトを保ち、429・503・ネットワークエラーに指数バックオフで再試行します。

GitHubはホストとPRパス、DevOpsの既知ホストは大文字小文字を区別しないPRパスで判定します。カスタムドメインDevOpsの詳細判定はURLパスを含むシグナルが2つ以上、一覧は一覧パスとDOMシグナル1つです。注入許可の `verifyAzureDevOpsInTab` はオンプレ環境の検出漏れを避けるためシグナル1つを採用します。service workerとpopupは別コンテキストであるため同一定義を持ち、同期方法は [AGENTS.md](AGENTS.md#読み込みサイト判定) に記載します。

CodeCommitはAWSコンソールホストとPR詳細パス、SharePointはSharePointホストと `stream.aspx`、TeamsはTeamsホストとメッセージDOMで判定します。CodeCommitのCloudscapeとTeamsのDOMは変化しやすいため、セレクタは各Extractorの `SELECTORS` に集約します。CodeCommit本文・コメントはbest-effortで、両方空の場合は警告を出しつつタイトルを出力します。

ナビゲーション検出はservice worker通知、History APIフック、popstate、GitHubのturbo:load、hashchangeの5経路です。再初期化は300msでまとめ、一覧だけのMutationObserverは400msでまとめます。Teamsはservice workerの対象ではなく、content scriptで遷移を処理します。cleanupは一覧ボタンのタイマー・DOM、SharePoint候補・キャッシュ、Teams収集・オーバーレイを片付けます。

静的注入に失敗した場合のフォールバックは既知DevOpsとCodeCommitだけです。カスタムドメインはpopupで対象originへの任意権限を要求し、DevOpsシグナルを検証してからservice workerへ注入を依頼します。GitHub・SharePoint・Teamsへ別Extractorを動的注入しないのは、初期化済みフラグが正規の静的注入を妨げるのを防ぐためです。

## 差分とMarkdownの整合性

GitHub詳細はライブDOMの隠れた会話を展開してから、同一オリジンのHTMLをDOMParserで解析して不足を補います。一覧取得はHTMLだけを使います。両経路とも `turbo-frame[src]` とpagination formのactionから隠れた会話を追加取得します。pagination formの親DIVには既存スレッドが同居するため、置換はform自体だけに限定します。Cookie付きGitHub REST APIはCORS制約があるため、取得元を同一オリジンHTMLにしています。

DevOpsはDOMコメントがない・不十分な場合にthreadsとiterationsのREST APIへフォールバックし、残る差分不足をItems / FileDiffsで補います。DOM差分はファイルと非空の対象行が完全一致する場合だけ採用します。DOM側スレッドをAPIで再補完する際は、投稿者・パス・既知の行範囲で一意に対応する候補だけを採用し、使用済み候補も曖昧さ判定に含めます。曖昧なら別スレッドのコードを付けるより差分欠落を選びます。取得は6タスクずつで、各タスク内でsnippetを生成してファイル全文を後続batchへ保持しないため、長いレビューでもメモリ蓄積を抑えます。

重複除去のキーは投稿者・ファイル・本文・日時・対象行です。日時と対象行も含めることで、botが同じファイルへ同じテンプレート文を別のレビューラウンドで投稿しても残せます。同じ親コメントの複数ソースは返信を統合し、返信も同じキーで重複除去します。入力スレッドは変更しません。

HTML→Markdownは深度上限80の再帰DOM走査で、見出し、文字装飾、言語付きコード、相対URL解決、画像、ネストしたリスト、表、引用、チェックボックスを変換します。リスト・表は専用変換へ深度を引き継ぎ、一度だけ走査します。危険なURIスキームを除き、リンク文字列とURLをエスケープし、data URI画像はプレースホルダへ置き換え、GitHub Code Review Agentのバッジ画像を除きます。Teams本文は変換前に添付画像・ファイルカードをクローンから除き、添付の二重出力を防ぎます。

## 配布設計

ChromeとFirefoxはソースとバージョンを共有し、background宣言を成果物生成時に分け、Firefox用では `minimum_chrome_version` も取り除きます。Chrome用ZIPは正本`manifest.json`の`service_worker`を保持し、Firefox用ZIPは生成スクリプトが同じファイルを`scripts`配列へ変換します。これによりChrome MV3へ `background.scripts` を渡さず、手編集するmanifestの重複も持ちません。

公開時は最初にSecretsを持たないジョブで2つのZIPを生成し、同じartifact内でCWS / AMOジョブへ渡します。両提出ジョブは共通のpackageジョブだけに依存し、互いには依存しません。CWSはChrome用ZIPを公式APIへ直接アップロードし、AMOはFirefox用ZIPを展開して`web-ext sign --channel listed`で提出します。この依存関係により、一方のストア障害が他方の提出を止めません。

CWSはAPI V2を使用します。認証・publisher IDの設定手順は [AGENTS.md](AGENTS.md#commands) に記載します。`fetchStatus` の公開済み・提出済みrevisionとversionで重複を判定し、アップロードが非同期なら完了を確認してから `DEFAULT_PUBLISH` で審査へ提出します。失敗・不明状態・待機上限では提出せずjobを失敗させます。listingは引き続きDashboardで管理します。AMOのmetadata生成とweb-ext実行にはNode 24を使います。

AMOの掲載メタデータは `webstore/*.txt`、`vava.config.json`、`package.json` から `update-amo-listing.mjs` が生成します。初回登録手順は [AGENTS.md](AGENTS.md#commands) を参照してください。公開version一覧で重複を確認しますが、審査待ちは一覧に現れないため、提出時のversion conflictも検知します。listed提出は承認を待たず、version conflictと承認待ちtimeoutだけを警告へ降格し、その他の失敗はjob失敗にします。
