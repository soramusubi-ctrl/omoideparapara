# おもひでパラパラだ

表紙と写真に、日付とひとことを添えて一冊にするブラウザアプリです。HTML・CSS・JavaScriptの静的ファイルだけで動き、アプリ用の依存パッケージ、ビルド、外部API、専用サーバーは不要です。

## できること

- 表紙に画像・タイトル・サブタイトルを設定
- 写真ページのまとめ追加、日付・ひとこと、並べ替え、削除と取り消し
- 「日付なし」で日付の印字を省略
- 明朝・ゴシック・丸ゴシックから全ページ共通のフォントを選択（PDF・PNG・編集データにも反映）
- 画像全体を残す表示と、枠いっぱいに切り抜く表示
- 表紙・写真ページごとに「枠なし・白ふち・ポラロイド風・写真コーナー」を選択（PDF・PNG・編集データにも反映）
- きなり・空色・さくらの3色と、印刷用の「背景なし（白）」
- 好きな背景画像を全ページに設定し、濃さを調整。「背景なし（白）」では背景設定を保持して非表示にし、別の色で復元
- このブラウザへの自動保存（IndexedDB）
- 表紙込みのA5縦PDF、表示中ページのPNG、続きを編集できる `.album.json` の保存・読み込み
- 見本のアルバム、スマートフォンの編集／プレビュー切り替え

写真ページは100ページまで、編集データは200MiB以内です。写真・背景画像は読み込み時に長辺2400px以内のJPEGへ変換します。画像の追加・差し替え前に容量を確認し、後から文章を入力する余裕も確保します。PDFは端末のCanvasで描いた各ページを画像として埋め込むため、文字検索・文字編集には対応しません。

写真をサーバーへアップロードする処理はありません。見本画像も `dist/demo/` 内の静的ファイルです。

## 写真の枠

編集欄の「写真の枠」で、表紙と各ページの写真を個別に飾れます。「全体を入れる」では画像の端を残し、枠を写真のまわりに描きます。白い台紙でも選んだ枠は表示します。画像がないときは枠を描きません。以前の編集データは「枠なし」で開きます。

## フォント

編集欄の「文字のフォント」で、表紙・日付・ひとこと・ページ番号の書体をまとめて選べます。プレビューとPDF・PNGは同じ書体で描画し、編集データにも選択を保存します。以前の編集データは明朝で開きます。

明朝・ゴシックは端末に搭載された日本語書体を使用します。丸ゴシックには M PLUS Rounded 1c Regular を同梱しているため、端末の搭載書体にかかわらず利用できます。外部フォントサービスへの接続は不要です。

同梱書体: Copyright 2016 The Rounded M+ Project Authors. / SIL Open Font License 1.1。フォントとライセンスは [`dist/fonts/`](dist/fonts/) にあります。[Google Fontsの原本](https://github.com/google/fonts/blob/main/ofl/mplusrounded1c/MPLUSRounded1c-Regular.ttf)（Git blob `a66978b6a6f55de71105a37f8de702ab3f31d27d`）を、字形・収録文字・名称を保ったままFontTools 4.61.1でWOFF2へ変換しています。[ライセンス原文](https://github.com/fontsource/font-files/blob/main/fonts/google/m-plus-rounded-1c/LICENSE)。

## Vercelに公開する

VercelでGitHubリポジトリ `soramusubi-ctrl/omoideparapara` をImportし、次の設定でDeployします。

| 項目 | 設定 |
| --- | --- |
| Root Directory | リポジトリのルート（`./`） |
| Framework Preset | Other |
| Install Command | 空欄（実行しない） |
| Build Command | 空欄（実行しない） |
| Output Directory | `dist` |
| Environment Variables | 不要 |

同梱の `vercel.json` がFramework・Install・Build・Outputの設定を指定します。`dist` 以外のテストやREADMEを公開対象に含める必要はありません。独自API、外部CDN、環境変数の追加も不要です。

設定の根拠: Vercel公式の[プロジェクト設定](https://vercel.com/docs/project-configuration/vercel-json)と[ビルド設定](https://vercel.com/docs/builds/configure-a-build)。

## いまのアルバムを新しいURLへ移す

自動保存はブラウザのオリジン（プロトコル・ホスト名・ポート）ごとに分かれます。同じ端末でも、以前のURL、Vercelの公開URL、プレビューURLの間で自動保存は共有されません。

1. 以前のURLを開き、「保存する」→「編集データを保存」で `.album.json` をダウンロードします。
2. 新しいURLを開き、「データを開く」でそのファイルを選びます。
3. 写真・文章・背景設定を確認します。以後の編集は新しいURLのブラウザ保存先へ自動保存されます。

別の端末へ移す場合も、同じ編集データを使います。PDFやPNGは閲覧・印刷用なので、編集の引き継ぎには `.album.json` を保存してください。

## ローカル表示と確認

ローカル表示は `dist/` を静的HTTPサーバーで配信します。Pythonがある場合の例:

```sh
python3 -m http.server 8000 --directory dist
```

`http://localhost:8000` を開きます。Node.js 20以上があれば、追加インストールなしで次の確認を実行できます。

```sh
npm test
node --check dist/app.js
```

テストはNode.js標準機能で保存・読み込み、画像検証、容量制限、PDF構造などを確認します。任意の `@napi-rs/canvas` が利用できる環境では実画像・文字配置・PNG/PDF描画のテストも実行し、未導入なら描画テストはskipとして表示されます。アプリの実行・公開にこのパッケージは不要です。

実機ブラウザのUI操作・保存ダイアログは未確認です。
