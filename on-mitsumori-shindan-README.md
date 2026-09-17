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

## 管理者への通知メール（アップロードされた見積書の保存）

診断が行われるたびに、見積書の原本（画像/PDF）を添付したメールが管理者に届くようにできます。
[Resend](https://resend.com/)というメール送信サービスを使っています。

### 設定手順

1. https://resend.com/ でアカウントを作成（無料枠あり）。
2. ダッシュボードの「API Keys」から新しいキーを発行してコピーする。
3. Vercelのプロジェクト設定 → Settings → Environment Variables で、以下を追加する。
   - `RESEND_API_KEY` … 手順2で発行したキー
   - `ADMIN_NOTIFY_EMAIL` … 通知を受け取りたいメールアドレス（例: info@on-inc.example）
4. 再デプロイすれば、以降の診断ごとに通知メールが届く。

### 注意点

- `RESEND_API_KEY`と`ADMIN_NOTIFY_EMAIL`のどちらか一方でも未設定の場合、通知は送られませんが、
  診断機能そのものは通常どおり動きます（通知はあくまでおまけの機能です）。
- 初期状態では送信元アドレスが`onboarding@resend.dev`という共有ドメインになっており、Resend側の
  制限で送れる宛先が限られる場合があります。本格運用する場合は、Resendで自社ドメイン
  （例: on-inc.jp）を認証し、`NOTIFY_FROM_EMAIL`環境変数で送信元を自社ドメインのアドレスに
  変更することをおすすめします（例: `notify@on-inc.jp`）。
- 通知メールには見積書の原本が添付されるため、個人情報（黒塗りされていない氏名・住所）が
  写っている場合はメールにもそのまま残ります。取り扱いに注意してください。
