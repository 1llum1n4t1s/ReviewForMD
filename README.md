# Review For MD

プルリクエストのタイトル・本文・全レビューコメントを **Markdown 形式** でクリップボードにコピーする Chrome 拡張機能です。

## 機能

### 全てMDコピー

PR ページのヘッダー付近に表示される緑色の **「全てMDコピー」** ボタンをクリックすると、以下の情報を一括で Markdown テキストとしてコピーします。

- PR タイトル（`# タイトル #番号`）
- PR 本文（`## 本文` セクション）
- 全レビューコメント（`## レビューコメント` セクション）
  - 投稿者・日時・対象ファイルパス付き

### 個別MDコピー

各レビューコメントのヘッダーに **「MDコピー」** ボタンが追加され、1 件単位で Markdown コピーできます。

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
| GitHub (`github.com`) | 対応 |
| Azure DevOps (`dev.azure.com`) | 対応 |
| Azure DevOps (`*.visualstudio.com`) | 対応 |
| Azure DevOps（カスタムドメイン） | 対応 |

### カスタムドメインの Azure DevOps 対応

企業独自ドメインで運用されている Azure DevOps も検出できます。URL パターン（`/_git/{repo}/pullrequest/{id}`）に加え、DOM 構造のマルチシグナル判定（`bolt-*` / `repos-*` CSSクラス等）を組み合わせることで、ドメインに依存しない判定を行います。

## インストール

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
│   └── clipboard.js           # クリップボードコピー
├── extractors/
│   ├── github_extractor.js    # GitHub PR データ抽出
│   └── devops_extractor.js    # Azure DevOps PR データ抽出（REST API フォールバック付き）
├── inject/
│   └── navigation_hook.js     # main world 注入（SPA 遷移検出用）
├── ui/
│   ├── button_injector.js     # ボタン注入ロジック
│   └── styles.css             # ボタンスタイル（GitHub / DevOps テーマ対応）
└── popup/
    ├── popup.html             # ポップアップ UI
    └── popup.js               # PR ページ検出ステータス表示
```

### サイト検出ロジック

| 判定対象 | 方法 |
|---|---|
| GitHub | ドメイン (`github.com`) + URL パス (`/pull/\d+`) |
| Azure DevOps（既知ドメイン） | ドメイン (`dev.azure.com`, `*.visualstudio.com`) + URL パス (`/_git/*/pullrequest/*`) |
| Azure DevOps（カスタムドメイン） | URL パス + DOM シグナル 2 つ以上一致（`.repos-pr-details-page`, `bolt-*` クラス, タブバー等） |

### SPA ナビゲーション対応

GitHub（turbo）や Azure DevOps（React SPA）のクライアントサイドルーティングに対応するため、以下の 4 つの方法でページ遷移を検出します。

1. **Service Worker** -- `webNavigation.onHistoryStateUpdated` API
2. **Main World Script** -- `history.pushState` / `replaceState` のフック → カスタムイベント
3. **popstate** イベント（ブラウザの戻る/進む）
4. **turbo:load** イベント（GitHub 固有）

### Azure DevOps REST API フォールバック

DOM からレビューコメントが取得できない場合、Azure DevOps REST API を使用してデータを取得します。

```
GET {baseUrl}/_apis/git/repositories/{repo}/pullRequests/{prId}?api-version=7.1
GET {baseUrl}/_apis/git/repositories/{repo}/pullRequests/{prId}/threads?api-version=7.1
```

ユーザーの既存セッション Cookie を利用するため、追加の認証設定は不要です。

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
- リンク / 画像
- 順序付き・順序なしリスト（ネスト対応）
- テーブル
- 引用（`blockquote` → `>`）
- チェックボックス

## 動作要件

- Chrome 110 以降（Manifest V3 対応）
- Edge（Chromium ベース）でも動作します

## ライセンス

MIT License - 詳細は [LICENSE](LICENSE) を参照してください。
