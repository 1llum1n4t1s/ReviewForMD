# いろいろMDコピー 設計

この文書は、現在のコードと設定に基づくシステム設計の正本です。利用方法は [README.md](README.md)、作業規約と検証手順は [AGENTS.md](AGENTS.md) を参照してください。

## 目的とシステム境界

「いろいろMDコピー」は、利用者が開いているWebページから次の情報を抽出し、MarkdownまたはVTTとしてローカルへ保存・コピーするChrome / Firefox Manifest V3拡張です。

- GitHub、Azure DevOps、AWS CodeCommitのPR本文とレビューコメント
- SharePoint Stream上のTeams会議トランスクリプト
- Microsoft Teamsのチャット・チャネル履歴

抽出結果はファイルまたはクリップボードへ出力し、外部の保存基盤は持ちません。Kagayoi Supportへの問い合わせだけは独立した利用者操作であり、フォームへ入力された情報だけを `support.kagayoi.com` へ送信します。PR、トランスクリプト、チャット本文は問い合わせ経路へ渡しません。

## 主要コンポーネント

| コンポーネント | 責務と境界 |
| --- | --- |
| `manifest.json` | 対応サイト、権限、静的content script、Chrome / Firefoxのbackground実行方式を宣言する。 |
| `src/popup/` | 全詳細ページ操作の起点。サイト状態と利用可能な操作を表示し、フォーカスが必要なクリップボード書き込みを行う。 |
| `src/content_script.js` | ページ側の調停役。SPA遷移を検知し、`rfmd:status` / `rfmd:extract` / `rfmd:navigate` を処理する。 |
| `src/ui/button_injector.js` | popup向け状態取得・抽出実行と、GitHub / DevOpsのPR一覧行ボタンを提供する。 |
| `src/lib/` | サイト判定、HTML→Markdown変換、ダウンロード、タイムアウト・再試行付きfetchを共有する。 |
| `src/extractors/` | サイト固有のDOM・HTML・API差異を吸収し、MarkdownまたはVTTへ正規化する。 |
| `src/service_worker.js` | 対象タブのナビゲーションを監視し、カスタムドメインDevOpsとCodeCommitの必要時だけ動的注入する。 |
| `src/inject/` | main worldでHistory APIとSharePointのfetchを観測し、isolated worldへ最小限のイベントを渡す。 |
| `src/shared/` | popup内のKagayoi Support問い合わせフォームとフッターを提供する。抽出機能とはデータを共有しない。 |
| `zip.ps1` / `zip.sh` | `manifest.json`、`src/`、`icons/`だけを同一配布ZIPへまとめる。 |
| `.github/workflows/publish.yml` | `release/x.y.z`を検証・梱包し、CWSとAMOを独立ジョブで提出する。 |

## 実行モデルとデータフロー

### 詳細ページ

1. popupがcontent scriptへ `rfmd:status` を送り、`SiteDetector` と各Extractorの利用可否判定を取得する。
2. 利用者操作で `rfmd:extract { kind, mode, monthsAgo }` を送る。
3. `ButtonInjector.runAction()` がサイト固有Extractorを呼ぶ。
4. ダウンロードはcontent script側で実行し、コピーは文字列をpopupへ返して `navigator.clipboard` へ書く。

### PR一覧ページ

content scriptがGitHub / DevOpsの各行へ小型ボタンを注入し、対象PRのHTMLまたはAPIを背景取得してMarkdownを直接保存します。CodeCommitはクライアントレンダリングSPAのため、一覧取得を行わず詳細ページだけを対象にします。

### SharePointトランスクリプト

初期scriptからDrive ID / File IDを抽出し、取得できない場合はmain worldのfetchフックで補います。SharePoint APIからトランスクリプトURLを得てVTTを取得します。認証Cookieが必要なため `credentials: 'include'` を使いますが、送信先はHTTPSの `*.sharepoint.com` に限定します。

### Teamsチャット

仮想スクロールで画面外要素が破棄されるため、最新位置から上方向へ段階スクロールし、各viewportのメッセージをID単位で蓄積します。時系列整列後に送信者と信頼できる時刻を補完し、選択月の `[sinceMs, untilMs)` へ絞ります。進捗、部分保存、中止、会話切替時の破棄はページ内オーバーレイで完結します。

### お問い合わせ

popupの共通Web Componentが、メール確認コードによる認証後に問い合わせをKagayoi Supportへ送信します。認証済みセッションのアクセストークン、メールアドレス、有効期限は、フォームを利用した場合だけ拡張機能の `localStorage` に保存します。

## サイト別の取得戦略

| 対象 | 採用方式 | 理由とトレードオフ |
| --- | --- | --- |
| GitHub | ライブDOMと同一オリジンHTML fetchを統合 | 折りたたみ・遅延表示コメントを補える一方、GitHub DOM構造への追随が必要。 |
| Azure DevOps | DOM → REST API → Items / FileDiffs補完 | 遅延DOMでも完全性を高められる一方、URL解析と複数API呼び出しが必要。 |
| AWS CodeCommit | 詳細ページのDOMのみ | SigV4秘密鍵を拡張へ持ち込まない代わりに、Cloudscape DOMセレクタの保守が必要。 |
| SharePoint | 埋め込みID → fetchフック → SharePoint API | 初期HTML差異に耐える一方、認証済み同一オリジン通信が必要。 |
| Teams | DOM自動スクロール | 非公開内部APIへ依存しない代わりに、仮想スクロールとDOM変更への追随が必要。 |

## 重要な不変条件

- content scriptは `site_detector` → 共通lib → サイト固有Extractor → `button_injector` → `content_script` の順で読み込む。
- 詳細ページのUIはpopupへ集約し、ページ埋め込みUIはPR一覧行ボタンとTeams進捗オーバーレイに限定する。
- `background.service_worker` と `background.scripts` を同じファイルへ向け、ChromeとFirefoxへ同一ZIPを配布する。Chrome 121未満は対象外とする。
- 動的注入は、静的注入で扱えないカスタムドメインDevOpsとCodeCommitのフォールバックだけに限定する。
- `verifyAzureDevOpsInTab` はservice workerとpopupで意図的に同一定義を持つため、変更時は両方を同期する。
- TeamsとCodeCommitのサイト固有セレクタは各Extractorの `SELECTORS` を唯一の正本とする。
- SharePointの認証付きfetchは `_isSharePointOrigin` を通し、機微URLをログへ出す場合はoriginとpathだけへ縮約する。
- レビュースレッドの重複除去は投稿者、ファイル、本文、日時、対象行の複合キーを維持する。
- HTML由来の動的内容はDOM APIで構築し、`innerHTML` 代入やリモートJavaScript実行を行わない。
- Teamsの対象月判定と遡り停止には `time[datetime]` 由来の信頼できる時刻だけを使う。
- 抽出0件を成功扱いにせず、空ファイルによる成功偽装を防ぐ。

## 配布設計

ChromeとFirefoxは単一manifest・単一ZIPを共有します。Chromeはservice worker、Firefoxはbackground scriptsを選択します。この方式はブラウザ別成果物の分岐を避ける代わりに、各ブラウザのlintで未使用キーに関する情報警告が残ります。

公開時は最初にSecretsを持たないジョブでZIPを生成し、artifactをCWS / AMOジョブへ渡します。CWSは公式APIへ直接アップロードして審査提出し、AMOは `web-ext sign --channel listed` で提出します。両ジョブを独立させ、一方のストア障害が他方の提出を止めない構成です。
