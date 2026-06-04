# いろいろMDコピー (Review For MD)

複数サイトの情報を **Markdown / VTT / ZIP ファイルでダウンロード**できる Chrome 拡張機能です。

- **PR レビュー**: GitHub / Azure DevOps（カスタムドメイン含む）/ AWS CodeCommit の PR タイトル・本文・レビューコメントを Markdown でダウンロード
- **会議トランスクリプト**: SharePoint Stream の Teams 会議録画ページから字幕（VTT）をダウンロード
- **Teams チャット**: Microsoft Teams のチャット/チャネルの全履歴を自動スクロールで収集し、Markdown（添付込みは ZIP）でダウンロード

## 機能

操作はすべて **ツールバーアイコンのポップアップ** から行います。ポップアップは現在開いているサイトを判定し、そのサイトに合ったボタンを自動で出し分けます（PR 一覧ページの各行ダウンロードボタンのみ、利便性のためページ側にも残しています）。

### PR レビュー（GitHub / Azure DevOps / AWS CodeCommit）

PR の詳細ページを開いてツールバーアイコンをクリックすると、ポップアップに次のボタンが出ます。

- **「MDでダウンロード」** — タイトル・本文・全レビューコメント（投稿者・日時・対象ファイル・差分コード付き）を 1 つの `.md` ファイルとして保存。ファイル名には PR タイトルが自動で使われます。
- **「MDコピー」** — 同じ内容を Markdown テキストとしてクリップボードにコピー。

> **AWS CodeCommit について**: AWS マネジメントコンソールの PR 詳細ページに対応しています。CodeCommit は **詳細ページ専用**（PR 一覧ページの行ダウンロードボタンはありません）。コンソールがクライアントレンダリングの SPA のため、PR を開かずに取得する仕組みが使えないためです。

#### PR 一覧ページ対応（GitHub / Azure DevOps）

PR 一覧ページでは、各行にダウンロードボタンが表示されます（PR を開かずに直接取得可能）。ポップアップを開いた場合は「PR を開いてください」と案内されます。

### 会議トランスクリプト（SharePoint Stream / Teams 会議録画）

Teams 会議の録画動画ページ（`*.sharepoint.com/.../stream.aspx`）を開いてアイコンをクリックすると、**「VTTでダウンロード」** と **「VTTコピー」** が出ます。会議トランスクリプト（字幕）を `.vtt` で保存／コピーできます。トランスクリプトが存在しない録画ではボタンは出ません。

### Teams チャットのエクスポート

Microsoft Teams（`teams.microsoft.com` / `teams.live.com` / `teams.cloud.microsoft`）のチャット・チャネルを開いてアイコンをクリックすると、次のボタンが出ます。

- **「MDでダウンロード」** — チャットを自動スクロールして**全履歴**を収集し、送信者・日時・本文・リアクション・添付リンクを 1 つの `.md` ファイルとして保存。
- **「MDコピー」** — 同じ内容をクリップボードにコピー。
- **「添付ごとZIP」** — 添付ファイルや画像の実データもまとめて取得し、`transcript.md` と `attachments/` フォルダを 1 つの ZIP アーカイブで保存。

> 全履歴の収集は自動スクロールで行うため、会話が長いと数十秒かかることがあります。取得が終わるまでポップアップは開いたままにしてください。

### 出力例

```markdown
# 認証処理のリファクタリング #42

## 本文

認証フローを OAuth 2.0 に移行します。

## レビューコメント

### コメント 1

**投稿者:** tanaka  **日時:** 2026/02/17 10:30

エラーハンドリングを追加してください。

### コメント 2

**投稿者:** suzuki  **日時:** 2026/02/17 11:00  **ファイル:** `src/auth/login.ts`

この条件分岐は不要では？
```

## 対応プラットフォーム

| プラットフォーム | 対応状況 | 出力形式 |
|---|---|---|
| GitHub (`github.com`) | ✅ | Markdown |
| Azure DevOps (`dev.azure.com`) | ✅ | Markdown |
| Azure DevOps (`*.visualstudio.com`) | ✅ | Markdown |
| Azure DevOps（カスタムドメイン） | ✅ | Markdown |
| AWS CodeCommit (`*.console.aws.amazon.com`、詳細ページのみ) | ✅ | Markdown |
| SharePoint Stream (`*.sharepoint.com/.../stream.aspx`) | ✅ | VTT |
| Microsoft Teams チャット (`teams.microsoft.com` / `teams.live.com` / `teams.cloud.microsoft`) | ✅ | Markdown / ZIP |

### カスタムドメインの Azure DevOps 対応

企業独自ドメインで運用されている Azure DevOps も検出できます。URL パターン（`/_git/{repo}/pullrequest/{id}`）に加え、DOM 構造のマルチシグナル判定（`bolt-*` / `repos-*` CSS クラス等）を組み合わせることで、ドメインに依存しない判定を行います。

## インストール

### Chrome Web Store

[Chrome Web Store からインストール](https://chrome.google.com/webstore)（公開後にリンクを更新）

### 開発版（ローカル読み込み）

1. このリポジトリをクローンまたはダウンロード
2. Chrome で `chrome://extensions` を開く
3. 右上の **「デベロッパーモード」** を有効化
4. **「パッケージ化されていない拡張機能を読み込む」** をクリック
5. リポジトリのルートディレクトリを選択

### パッケージ作成

```powershell
# Windows (PowerShell)
.\zip.ps1
```

```bash
# macOS / Linux
./zip.sh
```

`ReviewForMD.zip` が生成されます。

## 技術仕様

### アーキテクチャ

```
src/
├── content_script.js          # エントリポイント（SPA ナビゲーション対応）
├── service_worker.js          # webNavigation 監視・動的注入
├── lib/
│   ├── site_detector.js       # GitHub / Azure DevOps / CodeCommit / SharePoint / Teams 判定
│   ├── markdown_builder.js    # HTML → Markdown 変換・テキスト組み立て
│   ├── clipboard.js           # クリップボードコピー・ファイル/Blob ダウンロード
│   ├── fetch_utils.js         # タイムアウト付き fetch（全 Extractor 共有）
│   └── zip_writer.js          # 純 JS ZIP ライタ（STORE 法・Teams 添付 ZIP 用）
├── extractors/
│   ├── github_extractor.js    # GitHub PR データ抽出
│   ├── devops_extractor.js    # Azure DevOps PR データ抽出（REST API フォールバック付き）
│   ├── codecommit_extractor.js # AWS CodeCommit PR データ抽出（DOM ベース・詳細ページ専用）
│   ├── sharepoint_extractor.js # SharePoint Stream トランスクリプト(VTT)取得
│   └── teams_extractor.js     # Teams チャット抽出（自動スクロール・添付収集）
├── inject/
│   ├── navigation_hook.js     # main world 注入（SPA 遷移検出用）
│   └── sharepoint_fetch_hook.js # main world 注入（fetch をフックして Drive/File ID を捕捉）
├── ui/
│   ├── button_injector.js     # ボタン注入ロジック（詳細ページ・一覧ページ・Teams）
│   └── styles.css             # ボタンスタイル（GitHub / DevOps / SharePoint / Teams テーマ・ダークモード対応）
└── popup/
    ├── popup.html             # ポップアップ UI
    └── popup.js               # PR ページ検出ステータス表示
```

### データフロー

操作の起点はツールバーアイコンのポップアップです。詳細ページのアクションは
ポップアップ↔コンテンツスクリプト間のメッセージで実行します。

```
詳細ページ（GitHub/DevOps/SharePoint/Teams）:
  ポップアップ起動 → rfmd:status でサイト状態を取得 → サイトに合うボタンを描画
  ボタンクリック → rfmd:extract { kind, mode }
    → コンテンツスクリプトが Extractor で抽出
        ダウンロード: その場でファイル保存
        コピー:      文字列を返し、ポップアップ側でクリップボードへ書き込み

PR 一覧ページ（ページ側に残す行ボタン）:
  行ボタンクリック → Extractor.extractByPrUrl(url)  ※バックグラウンドで PR ページを fetch
    → { title, markdown } → ファイル保存
```

### サイト検出ロジック

| 判定対象 | 方法 |
|---|---|
| GitHub | ドメイン (`github.com`) + URL パス (`/pull/\d+` or `/pulls`) |
| Azure DevOps（既知ドメイン） | ドメイン (`dev.azure.com`, `*.visualstudio.com`) + URL パス |
| Azure DevOps（カスタムドメイン） | URL パス + DOM シグナル 2 つ以上一致 |
| AWS CodeCommit | コンソールホスト (`*.console.aws.amazon.com`) + URL パス (`/codesuite/codecommit/.../pull-requests/{id}`) |
| SharePoint Stream | ドメイン (`*.sharepoint.com`) + URL パス (`stream.aspx`) |
| Microsoft Teams チャット | ドメイン (Teams 系) + メッセージリストの DOM シグナル |

### SPA ナビゲーション対応

GitHub（turbo）や Azure DevOps / Teams（SPA）のクライアントサイドルーティングに対応するため、以下の 5 つの方法でページ遷移を検出します（主に PR 一覧ページの行ボタン再注入に使用）。

1. **Service Worker** — `webNavigation.onHistoryStateUpdated` API
2. **Main World Script** — `history.pushState` / `replaceState` のフック → カスタムイベント
3. **popstate** イベント（ブラウザの戻る/進む）
4. **turbo:load** イベント（GitHub 固有）
5. **hashchange** イベント（Teams クラシックのハッシュルーティング）

### Azure DevOps データ取得戦略（3 階層）

1. **DOM 抽出** — レンダリング済みコメントを直接パース
2. **REST API フォールバック** — DOM にコメントがない場合、`/_apis/git/` エンドポイントから取得
3. **Items API 補完** — diff 情報がないスレッドに対し、FileDiffs API でソースコード行を復元

### 必要なパーミッション

| パーミッション | 用途 |
|---|---|
| `activeTab` | 現在のタブのコンテンツにアクセス |
| `scripting` | カスタムドメインの DevOps に動的スクリプト注入 |
| `webNavigation` | SPA ナビゲーション（`history.pushState`）の検出 |
| `clipboardWrite` | ポップアップの「コピー」で Markdown / VTT をクリップボードへ書き込み |

### HTML → Markdown 変換

PR 本文やコメントの HTML を Markdown に変換する際、以下の要素を正しく変換します。

- 見出し（`h1`〜`h6` → `#`〜`######`）
- 太字 / 斜体 / 取り消し線
- インラインコード / コードブロック（言語指定付き）
- リンク / 画像（data-URI → プレースホルダ）
- 順序付き・順序なしリスト（ネスト対応）
- テーブル
- 引用（`blockquote` → `>`）
- チェックボックス

## 動作要件

- Chrome 110 以降（Manifest V3 対応）
- Edge（Chromium ベース）でも動作します

## ライセンス

MIT License - 詳細は [LICENSE](LICENSE) を参照してください。
