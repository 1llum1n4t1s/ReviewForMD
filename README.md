# プルリクMDコピー (Review For MD)

GitHub / Azure DevOps のプルリクエスト（PR）から、タイトル・本文・レビューコメントを **Markdown ファイルでダウンロード**できる Chrome 拡張機能です。

## 機能

### MDでダウンロード

PR ページの **「MDでダウンロード」** ボタンをクリックすると、以下の情報を `.md` ファイルとして保存できます。

- PR タイトル（`# タイトル #番号`）
- PR 本文（`## 本文` セクション）
- 全レビューコメント（`## レビューコメント` セクション）
  - 投稿者・日時・対象ファイルパス・差分コード付き

ファイル名には PR タイトルが自動で使用されます。

### PR 一覧ページ対応

PR 一覧ページの各行にもダウンロードボタンが表示されます。PR を開かずに一覧から直接 Markdown ファイルを取得できます。

### 個別 MD コピー

各レビューコメントに **「MDコピー」** ボタンが追加され、特定のコメントだけを Markdown テキストとしてクリップボードにコピーできます。

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

| プラットフォーム | 対応状況 |
|---|---|
| GitHub (`github.com`) | ✅ |
| Azure DevOps (`dev.azure.com`) | ✅ |
| Azure DevOps (`*.visualstudio.com`) | ✅ |
| Azure DevOps（カスタムドメイン） | ✅ |

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
│   ├── site_detector.js       # GitHub / Azure DevOps 判定
│   ├── markdown_builder.js    # HTML → Markdown 変換・テキスト組み立て
│   └── clipboard.js           # クリップボードコピー・ファイルダウンロード
├── extractors/
│   ├── github_extractor.js    # GitHub PR データ抽出
│   └── devops_extractor.js    # Azure DevOps PR データ抽出（REST API フォールバック付き）
├── inject/
│   └── navigation_hook.js     # main world 注入（SPA 遷移検出用）
├── ui/
│   ├── button_injector.js     # ボタン注入ロジック（詳細ページ・一覧ページ）
│   └── styles.css             # ボタンスタイル（GitHub / DevOps テーマ・ダークモード対応）
└── popup/
    ├── popup.html             # ポップアップ UI
    └── popup.js               # PR ページ検出ステータス表示
```

### データフロー

```
PR 詳細ページ:
  ボタンクリック → Extractor.getTitle() + Extractor.extractAll()
    → MarkdownBuilder → Clipboard.download() / Clipboard.copy()

PR 一覧ページ:
  ボタンクリック → Extractor.extractByPrUrl(url)  ※バックグラウンドで PR ページを fetch
    → { title, markdown } → Clipboard.download()
```

### サイト検出ロジック

| 判定対象 | 方法 |
|---|---|
| GitHub | ドメイン (`github.com`) + URL パス (`/pull/\d+` or `/pulls`) |
| Azure DevOps（既知ドメイン） | ドメイン (`dev.azure.com`, `*.visualstudio.com`) + URL パス |
| Azure DevOps（カスタムドメイン） | URL パス + DOM シグナル 2 つ以上一致 |

### SPA ナビゲーション対応

GitHub（turbo）や Azure DevOps（React SPA）のクライアントサイドルーティングに対応するため、以下の 4 つの方法でページ遷移を検出します。

1. **Service Worker** — `webNavigation.onHistoryStateUpdated` API
2. **Main World Script** — `history.pushState` / `replaceState` のフック → カスタムイベント
3. **popstate** イベント（ブラウザの戻る/進む）
4. **turbo:load** イベント（GitHub 固有）

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
