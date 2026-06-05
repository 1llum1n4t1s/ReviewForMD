# Privacy Policy — いろいろMDコピー (Review For MD)

**Last Updated: 2026-06-03**

## Overview

いろいろMDコピー（Review For MD、以下「本拡張機能」）は、以下の操作を支援する Chrome 拡張機能です。

- GitHub、Azure DevOps（カスタムドメインを含む）、および AWS CodeCommit のプルリクエストページから、タイトル・本文・レビューコメントを Markdown 形式で取得し、ファイルとしてダウンロードまたはクリップボードへコピーする
- SharePoint Stream（Teams 会議録画）ページから、会議トランスクリプト（VTT 字幕ファイル）をダウンロードする
- Microsoft Teams（teams.microsoft.com / teams.live.com / teams.cloud.microsoft）のチャット/チャネルから、メッセージ履歴（送信者・日時・本文・リアクション・添付）を取得し、Markdown ファイルとしてダウンロードする

本拡張機能は、ユーザーのプライバシーを最大限尊重して設計されています。

## 収集する情報

**本拡張機能は、個人情報を一切収集・送信・保存しません。**

具体的には以下の通りです。

- ユーザーの個人情報（氏名、メールアドレス等）は収集しません
- Cookie、トラッキング技術は一切使用しません
- 外部サーバーへのデータ送信は行いません
- アナリティクスツールや広告 SDK は組み込まれていません
- ブラウザの閲覧履歴へのアクセスは行いません

## 使用する権限

本拡張機能は以下のブラウザ権限を使用します。

### activeTab

ユーザーが拡張機能のボタンをクリックした際に、現在アクティブなタブのページ内容（PR タイトル・本文・レビューコメント）を読み取るために使用します。ユーザーの操作なしにタブの内容にアクセスすることはありません。

### scripting

主にカスタムドメインの Azure DevOps や、別サービスから遷移した AWS CodeCommit など、あらかじめ静的に登録していないページで、ユーザーが明示的に許可した場合にコンテンツスクリプトを動的に注入するために使用します。各操作の起点はツールバーアイコンのポップアップです。

### webNavigation

SPA（Single Page Application）のページ遷移を検知し、PR 一覧ページの行ダウンロードボタンの再表示や、適切なタイミングでのコンテンツスクリプトの再初期化を行うために使用します。

### clipboardWrite

ポップアップの「コピー」操作で、整形した Markdown / VTT テキストをユーザーのクリップボードに書き込むために使用します。クリップボードへの書き込みはユーザーがボタンを押したときのみ行い、読み取りは一切行いません。

### host_permissions

以下のドメインに対してのみコンテンツスクリプトが動作します。

- `https://github.com/*`
- `https://*.github.com/*`（GitHub Enterprise 対応）
- `https://dev.azure.com/*`
- `https://*.visualstudio.com/*`
- `https://console.aws.amazon.com/*` / `https://*.console.aws.amazon.com/*`（AWS マネジメントコンソールの CodeCommit PR ページからレビュー内容を取得するため）
- `https://*.sharepoint.com/*`（Teams 会議録画ページから VTT トランスクリプトを取得するため）
- `https://teams.microsoft.com/*` / `https://*.teams.microsoft.com/*`
- `https://teams.live.com/*`
- `https://teams.cloud.microsoft/*`（Microsoft Teams のチャット履歴・添付を取得するため）

上記以外のカスタムドメイン（社内ホストされた Azure DevOps 等）については、`optional_host_permissions` によりユーザーが個別に「このサイトで動作を許可する」操作を行ったオリジンのみで動作します。ユーザーが明示的に許可していないドメインでは動作しません。

## データの処理

本拡張機能がアクセスするデータ（PR タイトル・本文・レビューコメント、SharePoint Stream の VTT トランスクリプト、および Microsoft Teams のチャットメッセージ）は以下の方法でのみ処理されます。

- ブラウザ内のメモリ上で Markdown / VTT 形式に変換（整形）されます
- ユーザーの明示的な操作（ボタンクリック）に応じて、次のいずれかが行われます
  - クリップボードへのコピー（「MDコピー」ボタン）
  - `.md` / `.vtt` ファイルとしてのダウンロード（「MDでダウンロード」「VTTダウンロード」ボタン）
- 処理後、メモリ上のデータは破棄されます
- 本拡張機能から第三者サーバーへのデータ送信は行いません

## データの保存

本拡張機能自身は、ユーザーデータを永続的に保存しません。

- ローカルストレージ（localStorage）への保存なし
- IndexedDB / chrome.storage への保存なし
- 外部サーバーへの保存なし

ただし、ユーザーが「MDでダウンロード」「VTTダウンロード」ボタンをクリックした場合のみ、ブラウザの標準ダウンロード機能を通じて、ユーザー自身の端末のダウンロードフォルダに `.md` / `.vtt` ファイルが保存されます。これはユーザーの明示的な意思に基づく保存であり、拡張機能側は保存後のファイルにアクセスしません。

## 第三者への提供

本拡張機能はデータを収集しないため、第三者へのデータ提供は発生しません。

## 子どものプライバシー

本拡張機能は年齢を問わず利用可能であり、いかなるユーザーからも個人情報を収集しません。

## オープンソース

本拡張機能のソースコードは公開されており、プライバシーに関する動作を誰でも確認できます。

リポジトリ: [https://github.com/1llum1n4t1s/ReviewForMD](https://github.com/1llum1n4t1s/ReviewForMD)

## ポリシーの変更

本プライバシーポリシーを変更する場合は、本ページの「Last Updated」の日付を更新します。重要な変更がある場合は、拡張機能のアップデートノートでお知らせします。

## お問い合わせ

本プライバシーポリシーに関するご質問は、以下までお問い合わせください。

- GitHub: [https://github.com/1llum1n4t1s](https://github.com/1llum1n4t1s)
- Issues: [https://github.com/1llum1n4t1s/ReviewForMD/issues](https://github.com/1llum1n4t1s/ReviewForMD/issues)
