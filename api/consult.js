// api/consult.js
// Vercel Serverless Function (Node.js runtime).
// 診断後の「無料相談」フォームの送信先。
// 入力された連絡先と、直前の診断結果をまとめて管理者にメール送信します。
//
// 必要な環境変数（api/diagnose.js と共通）:
//   RESEND_API_KEY      … Resend の API キー
//   ADMIN_NOTIFY_EMAIL  … 通知を受け取るメールアドレス
//   NOTIFY_FROM_EMAIL   … （任意）送信元アドレス。未設定なら onboarding@resend.dev

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "1mb",
    },
  },
};

const verdictLabels = {
  cheap: "相場より安い",
  within_range: "相場の範囲内",
  high: "相場より高め",
  needs_check: "要確認",
  unknown: "内訳の確認が必要",
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const resendKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.ADMIN_NOTIFY_EMAIL;
  if (!resendKey || !toEmail) {
    console.error("consult: RESEND_API_KEY または ADMIN_NOTIFY_EMAIL が未設定です。");
    res.status(500).json({ error: "server_not_configured", message: "送信設定が未完了です。お手数ですがお電話でご連絡ください。" });
    return;
  }

  const { name, tel, email, note, extracted, verdict } = req.body || {};

  if (!name || !tel) {
    res.status(400).json({ error: "bad_request", message: "お名前と電話番号を入力してください。" });
    return;
  }

  const fromEmail = process.env.NOTIFY_FROM_EMAIL || "onboarding@resend.dev";

  try {
    const html = buildHtml({ name, tel, email, note, extracted, verdict });

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        reply_to: email || undefined,
        subject: `【無料相談】${escapeHtml(name)} 様よりお問い合わせ`,
        html,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Resend API error (${resp.status}): ${text}`);
    }

    console.log("consult: 相談メールを送信しました →", toEmail);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("consult failed:", err);
    res.status(502).json({ error: "send_failed", message: String(err?.message || err) });
  }
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildHtml({ name, tel, email, note, extracted, verdict }) {
  const solarLine = verdict?.solarCheck?.applicable
    ? `太陽光: ${verdictLabels[verdict.solarCheck.tier] || "—"}${
        verdict.solarCheck.unitPrice ? `（${Math.round(verdict.solarCheck.unitPrice / 10000)}万円/kW）` : "（内訳不明）"
      }`
    : "太陽光: 対象外";
  const batteryLine = verdict?.batteryCheck?.applicable
    ? `蓄電池: ${verdictLabels[verdict.batteryCheck.tier] || "—"}${
        verdict.batteryCheck.unitPrice ? `（${Math.round(verdict.batteryCheck.unitPrice / 10000)}万円/kWh）` : "（内訳不明）"
      }`
    : "蓄電池: なし";

  const e = extracted || {};

  return `
    <h2 style="font-family:sans-serif;">無料相談のお申し込みがありました</h2>

    <h3 style="font-family:sans-serif;">お客様情報</h3>
    <table cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
      <tr><td style="background:#f2f2f2;">お名前</td><td><b>${escapeHtml(name)}</b></td></tr>
      <tr><td style="background:#f2f2f2;">電話番号</td><td><b>${escapeHtml(tel)}</b></td></tr>
      <tr><td style="background:#f2f2f2;">メール</td><td>${escapeHtml(email) || "—"}</td></tr>
      <tr><td style="background:#f2f2f2;">気になっている点</td><td>${escapeHtml(note) || "—"}</td></tr>
    </table>

    <h3 style="font-family:sans-serif;">このお客様の診断結果</h3>
    <p style="font-family:sans-serif;font-size:14px;"><b>${solarLine}</b><br><b>${batteryLine}</b></p>
    <table cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
      <tr><td style="background:#f2f2f2;">太陽光メーカー</td><td>${escapeHtml(e.solar_maker) || "—"}</td></tr>
      <tr><td style="background:#f2f2f2;">太陽光容量</td><td>${e.solar_capacity_kw ?? "—"} kW</td></tr>
      <tr><td style="background:#f2f2f2;">蓄電池メーカー</td><td>${escapeHtml(e.battery_maker) || "—"}</td></tr>
      <tr><td style="background:#f2f2f2;">蓄電池容量</td><td>${e.battery_capacity_kwh ?? "—"} kWh</td></tr>
      <tr><td style="background:#f2f2f2;">見積総額</td><td>${e.total_price_yen ? "¥" + Number(e.total_price_yen).toLocaleString() : "—"}</td></tr>
      <tr><td style="background:#f2f2f2;">金利</td><td>${e.interest_rate_percent ?? "—"} %</td></tr>
      <tr><td style="background:#f2f2f2;">保証年数</td><td>${e.warranty_years ?? "—"} 年</td></tr>
      <tr><td style="background:#f2f2f2;">記載補助金</td><td>${(e.subsidy_mentions || []).map(s => s.name + (s.amount_yen ? `（¥${Number(s.amount_yen).toLocaleString()}）` : "")).join("<br>") || "—"}</td></tr>
    </table>

    <p style="color:#888;font-size:12px;font-family:sans-serif;">
      送信日時: ${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}<br>
      ※見積書の原本は、同じお客様の「見積書AI診断」通知メールに添付されています。
    </p>
  `;
}
