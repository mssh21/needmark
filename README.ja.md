# NeedMark

[English](README.md) | **日本語**

UIを指してコメントを書き、いつものコーディングAIへ渡す。NeedMarkはコメント、対象・ソース情報、任意のスクリーンショットをローカルファイルに保存します。AIが根拠を確認して修正し、最後にあなたが結果を確かめられます。

MITライセンス。アカウント、MCPサーバー、特定のAIプロバイダーは必須ではありません。操作UIはReactに依存せず、Vite開発用プラグイン、またはNext.jsなどの既存HTTP開発サーバー向けレビュー用プロキシで使えます。ホスト型サービスNeedBackから独立したパッケージです。

[Webサイト](https://mssh21.github.io/needmark/ja/) · [ドキュメント](docs/README.md) · [npm](https://www.npmjs.com/package/needmark)

## 自分のプロジェクトに導入する

Node.js 22.12以降が必要です。アプリケーションのプロジェクトで実行します。

```sh
pnpm add -D needmark   # npm install -D needmark / yarn add -D needmark
pnpm exec needmark init
pnpm dev               # いつもの開発コマンド
```

いつもどおりアプリを開くと、ページ下部にNeedMarkのツールバーが表示されます。例はpnpmで記載しています。npmでは`npx needmark`、Yarnでは`yarn needmark`でCLIを実行します。

`init`は推奨設定を示し、同意するとNeedMarkを開発サーバーにつなぎます。アプリのソースと本番ビルドには触れません。

| プロジェクト | `init`が変更するもの |
| --- | --- |
| Vite（React、Vueなど） | `vite.config.*`の`plugins`に`needmark()`を追加 |
| Astro | `astro.config.*`に`vite: { plugins: [needmark()] }`を追加 |
| Next.js | `dev`スクリプトを`needmark dev --`経由にする。いつものポートのままNext.jsをその裏で動かします |

あわせて`needmark.config.ts`と用途に応じたGitの除外ルールを作ります。`NEEDMARK=off pnpm dev`で自分だけNeedMarkなしで起動でき、`needmark.config.ts`の`enabled: false`で全員分を止められます。`pnpm exec needmark remove`で接続を元に戻せます。`init`が読めない設定やほかの開発サーバーは、[はじめに](docs/getting-started.ja.md#開発サーバーにつなぐ)の手順で手動で設定します。[非対話実行の全フラグ](docs/getting-started.ja.md#インストールと初期設定)も記載しています。

## コメントして、AIに渡して、確認する

1. [ポインターを重ねて対象のタグ・名前・取得できるコンポーネントを確認](docs/getting-started.ja.md#対象を選んで保存する)し、要素、テキスト、範囲、複数要素を選びます。Shift+クリック・ドラッグで複数対象を追加し、Alt/Option＋ドラッグで文字の一部を選び、Ctrl/Cmd+クリックで重なりの下の対象を選べます。Enterで選択を完了します。
2. コメントを書き、DOM撮影、現在のタブの撮影、または画像なしで保存します。各コメントに`comment.md`、`context.json`、任意の`screenshot.png`が作られます。**修正**・**相談**・**質問** のカテゴリで、AIにコードを変えてほしいのか回答してほしいのかを伝えます。
3. 絞り込み中の未対応のコメントをAIへの指示としてコピーします。AIには同じプロジェクトのファイルと、利用する画像へのアクセスが必要です。
4. AIにコード修正と、検証結果の返信での報告を依頼します。解決済みにする前に、自分で結果を確認します。

MCP対応のAI（Claude Code、Codexなど）なら`needmark mcp`を登録すると、画像つきでコメントを直接読み、返信や解決済みへの変更、新しいコメントの待ち受けまで行えます。[AIエージェントと連携する](docs/getting-started.ja.md#aiエージェントと連携する)を参照してください。

```sh
pnpm exec needmark export --detail compact
pnpm exec needmark watch
pnpm exec needmark reply <id> '余白を調整し、チェックが通りました。' --author Codex
# ユーザーが結果を確認した後:
pnpm exec needmark resolve <id>
```

ピンと一覧から編集、返信、解決済みへの変更と未対応への戻しができます。

DOM撮影は共有許可なしで使えますが、再現できる描画に制限があります。タブ撮影は現在のタブの共有許可を求めます。保存画像ではパスワード欄と指定領域をマスクします。[撮影とプライバシー](docs/getting-started.ja.md#撮影とプライバシー)に制約と画像なしで保存する方法をまとめています。

## 言語とドキュメント

`needmark.config.ts`の`language`を`'ja'`または`'en'`にします。互換性のためUIの初期値は日本語です。ブラウザに保存した設定が優先されます。言語を切り替えても、コメント、返信、取得したページのテキスト、カスタム部品の入力内容は翻訳しません。UIからコピーする指示は選択中の言語、CLI出力は明示した設定言語を使い、未指定のCLI出力は英語の説明文を維持します。

- [はじめに](docs/getting-started.ja.md): 設定、選択、AIへの受け渡し、共有、移行。
- [Getting started](docs/getting-started.md): 同じ内容の英語ガイド。
- [アーキテクチャと動作上の制約（英語）](docs/architecture.md): 実装の詳細なリファレンス。
- [Agentationとの比較とプロダクト評価](docs/agentation-comparison.ja.md)
- [ドキュメント一覧](docs/README.md) · [コントリビューション（英語）](CONTRIBUTING.md) · [MITライセンス](LICENSE)
