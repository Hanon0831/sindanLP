# 合同会社on — LP + 見積書AI診断

太陽光・蓄電池の見積もりセカンドオピニオンLPに、その場で動くAI診断機能を組み込んだものです。

## 構成

```
on-mitsumori-shindan/
├── on-mitsumori-shindan-lp.html   ← LP本体（ヒーロー〜フォームまで、AI診断UIを内蔵）
├── storefront.jpg                  ← 会社紹介セクションの店舗写真
├── api/
│   └── diagnose.js                ← 診断API（Vercel Serverless Function）
└── package.json
```

※ ファイル名は他のLPプロジェクトと保存時に重複しないよう、`index.html`ではなく
`on-mitsumori-shindan-lp.html`という名前にしています。**Vercelにデプロイする前に、
このファイルを`index.html`にリネームしてください。** リネームしないと、サイトの
トップURL（`/`）でLPが表示されません（`/on-mitsumori-shindan-lp.html`という
URLでは表示されますが、通常はそれだと不便です）。

`on-mitsumori-shindan-lp.html`（デプロイ時は`index.html`）の「見積書を送るだけ。
その場でAIが診断します」セクションが、アップロードされた見積書を`/api/diagnose`に
送り、結果をその場で表示します。診断結果を見たあと「この内容について無料相談する」を
押すと、連絡先入力フォームが開きます（このフォームの送信先はまだ未接続のプレースホルダーです。下記参照）。

## デプロイ手順（Vercel）

1. このフォルダの`on-mitsumori-shindan-lp.html`を`index.html`にリネームします。
2. フォルダを丸ごとGitHubリポジトリにするか、Vercel CLIで直接デプロイします。
   ```
   npm i -g vercel
   cd on-mitsumori-shindan
   vercel
   ```
3. Vercelのプロジェクト設定 → **Settings → Environment Variables** で、以下を追加してください。
   - `ANTHROPIC_API_KEY` … Anthropic Consoleで発行したAPIキー（https://console.anthropic.com/）
4. 再デプロイすれば、`https://（プロジェクト名）.vercel.app/` でLPごと公開されます。
5. 独自ドメインを使う場合は、VercelのDomainsから設定してください。

## まだ接続していないもの

- **「この内容について無料相談する」フォームの送信先**：現状はフロントエンドで
  「お問い合わせありがとうございます」の画面に切り替わるだけで、実際にはどこにも
  送信されていません。メール通知やスプレッドシート連携などを別途つなぐ必要があります。
- **診断結果の保存**：相場データの精度向上のために結果を蓄積したい場合は、別途DBを
  用意し、プライバシーポリシーへの明記が必要です（ソラカルテも同様の対応をしています）。

## 相場の基準値・判定ロジック

`api/diagnose.js` 冒頭の `MARKET_RATE`／`THRESHOLDS` を参照してください。
経済産業省 調達価格等算定委員会の公表データ（2025年設置平均28.9万円/kWなど）を
初期値にしています。**この数値は毎年更新されるため、年1回は最新の公表資料を確認して
更新してください。** 出典: https://www.meti.go.jp/shingikai/santeii/pdf/20260205_1.pdf

## 費用の目安

Anthropic APIは従量課金です。1回の診断でClaudeへの1回のリクエストが発生します。
想定件数が多い場合は、事前にAnthropicの料金ページ（https://www.anthropic.com/pricing）
で試算しておくと安心です。
