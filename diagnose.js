// api/diagnose.js
// Vercel Serverless Function (Node.js runtime).
// Receives a base64-encoded quote (image or PDF), asks Claude to extract
// structured data from it, then applies a rule-based market-rate comparison
// for BOTH the solar system and the storage battery (if present).
//
// Required environment variable: ANTHROPIC_API_KEY
// (Set this in the Vercel project's Settings > Environment Variables.
//  Never expose it to the frontend — this file only runs server-side.)

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "8mb",
    },
  },
};

// ---------------------------------------------------------------------------
// 太陽光の相場基準値（経済産業省 調達価格等算定委員会「令和8年度以降の調達価格等に
// 関する意見」令和8年2月5日 より）
// 出典: https://www.meti.go.jp/shingikai/santeii/pdf/20260205_1.pdf
// 数値は年度ごとに公表内容が更新されるため、年1回は見直してください。
// ---------------------------------------------------------------------------
const SOLAR_MARKET_RATE = {
  avgYenPerKw: 289000, // 2025年に新築で設置された案件の平均（中央値29.4万円/kW）
  source: "経済産業省 調達価格等算定委員会（令和8年2月5日公表）",
  isOfficial: true,
};

// ---------------------------------------------------------------------------
// 蓄電池の相場基準値
// 太陽光と違い、蓄電池には調達価格等算定委員会のような公的統計がありません。
// 複数の業界調査（施工店の見積もり実績集計）で平均容量12.25kWh・工事費込み
// 210.1万円＝約17.2万円/kWhという水準がほぼ一致して報告されており、これを
// 初期値にしています。容量帯によって単価は変動します（小容量ほど割高、
// 大容量ほど割安の傾向）。
// この基準値は「公的データではなく市場調査に基づく参考値」であることを
// 診断結果にも明記してください（消さないこと）。
// ---------------------------------------------------------------------------
const BATTERY_MARKET_RATE = {
  avgYenPerKwh: 172000, // 平均12.25kWh・工事費込み210.1万円の実績平均
  source: "業界調査データの平均値（施工店の見積もり実績集計。公的統計ではありません）",
  isOfficial: false,
};

const THRESHOLDS = {
  cheapRatio: 0.7, // これ以下は「相場より安い」
  highRatio: 1.2, // これ以上は「相場より高め」
  needsCheckRatio: 1.5, // これ以上は「要確認」
  highInterestRatePercent: 4.0, // これ以上の金利は注意
  highDiscountRatioOfTotal: 0.25, // 総額の25%以上の値引きは注意
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "server_not_configured", message: "ANTHROPIC_API_KEY is not set." });
    return;
  }

  const { mediaType, data } = req.body || {};
  if (!mediaType || !data) {
    res.status(400).json({ error: "bad_request", message: "mediaType and data (base64) are required." });
    return;
  }
  if (data.length > 6_000_000) {
    res.status(400).json({ error: "file_too_large", message: "4MB程度までのファイルにしてください。" });
    return;
  }

  try {
    const extracted = await extractQuoteData({ apiKey, mediaType, data });
    const verdict = evaluateQuote(extracted);

    // 管理者への通知（未設定の場合は何もせずスキップ。失敗しても診断結果は返す）
    await notifyAdmin({ extracted, verdict, mediaType, data }).catch((e) => {
      console.error("notifyAdmin failed:", e);
    });

    res.status(200).json({ extracted, verdict });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "diagnose_failed", message: String(err?.message || err) });
  }
}

// ---------------------------------------------------------------------------
// 管理者通知メール（Resend使用）
// RESEND_API_KEY と ADMIN_NOTIFY_EMAIL が設定されていない場合は何もしない。
// ---------------------------------------------------------------------------
async function notifyAdmin({ extracted, verdict, mediaType, data }) {
  const resendKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.ADMIN_NOTIFY_EMAIL;

  console.log("notifyAdmin: RESEND_API_KEY =", resendKey ? "設定あり" : "未設定",
              "/ ADMIN_NOTIFY_EMAIL =", toEmail ? `設定あり(${toEmail})` : "未設定");

  if (!resendKey || !toEmail) {
    console.log("notifyAdmin: 環境変数が不足しているため通知をスキップしました。");
    return;
  }

  const fromEmail = process.env.NOTIFY_FROM_EMAIL || "onboarding@resend.dev";

  const verdictLabels = {
    cheap: "相場より安い", within_range: "相場の範囲内", high: "相場より高め",
    needs_check: "要確認", unknown: "内訳の確認が必要",
  };

  const solarLine = verdict.solarCheck?.applicable
    ? `太陽光: ${verdictLabels[verdict.solarCheck.tier]}（${verdict.solarCheck.unitPrice ? Math.round(verdict.solarCheck.unitPrice/10000) + "万円/kW" : "内訳不明"}）`
    : "太陽光: 対象外";
  const batteryLine = verdict.batteryCheck?.applicable
    ? `蓄電池: ${verdictLabels[verdict.batteryCheck.tier]}（${verdict.batteryCheck.unitPrice ? Math.round(verdict.batteryCheck.unitPrice/10000) + "万円/kWh" : "内訳不明"}）`
    : "蓄電池: なし";

  const html = `
    <h2>見積書AI診断：新しい診断がありました</h2>
    <p><b>${solarLine}</b><br><b>${batteryLine}</b></p>
    <table cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
      <tr><td>メーカー（太陽光）</td><td>${extracted.maker ?? "—"}</td></tr>
      <tr><td>太陽光容量</td><td>${extracted.solar_capacity_kw ?? "—"} kW</td></tr>
      <tr><td>蓄電池メーカー</td><td>${extracted.battery_maker ?? "—"}</td></tr>
      <tr><td>蓄電池容量</td><td>${extracted.battery_capacity_kwh ?? "—"} kWh</td></tr>
      <tr><td>見積総額</td><td>${extracted.total_price_yen ? "¥" + extracted.total_price_yen.toLocaleString() : "—"}</td></tr>
      <tr><td>金利</td><td>${extracted.interest_rate_percent ?? "—"} %</td></tr>
      <tr><td>値引き額</td><td>${extracted.discount_amount_yen ? "¥" + extracted.discount_amount_yen.toLocaleString() : "—"}</td></tr>
    </table>
    <p style="color:#888;font-size:12px;">送信日時: ${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}</p>
    <p style="color:#888;font-size:12px;">見積書の原本（画像/PDF）を添付しています。</p>
  `;

  const extMap = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };
  const filename = `mitsumori.${extMap[mediaType] || "bin"}`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${resendKey}`,
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [toEmail],
      subject: `【見積書AI診断】新規アップロード（${verdictLabels[verdict.solarCheck?.tier] || ""}）`,
      html,
      attachments: [{ filename, content: data }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend API error (${res.status}): ${text}`);
  }
  console.log("notifyAdmin: 通知メールを送信しました →", toEmail);
}

// ---------------------------------------------------------------------------
// Step 1: Claude に見積書を読み取らせて構造化データにする
// ---------------------------------------------------------------------------
async function extractQuoteData({ apiKey, mediaType, data }) {
  const isPdf = mediaType === "application/pdf";

  const contentBlock = isPdf
    ? { type: "document", source: { type: "base64", media_type: mediaType, data } }
    : { type: "image", source: { type: "base64", media_type: mediaType, data } };

  const systemPrompt = `あなたは太陽光発電・蓄電池の見積書を読み取る専門アシスタントです。
渡された見積書の画像またはPDFから、以下のJSONスキーマに厳密に従ってデータを抽出してください。
読み取れない項目は null にしてください。数値はすべて円単位の整数（kW/kWhは小数可）。
説明文やコードブロックの記号（\`\`\`）は一切つけず、JSONオブジェクトのみを出力してください。

スキーマ:
{
  "solar_maker": string|null,
  "solar_capacity_kw": number|null,
  "solar_related_subtotal_yen": number|null,
  "battery_maker": string|null,
  "battery_capacity_kwh": number|null,
  "battery_related_subtotal_yen": number|null,
  "total_price_yen": number|null,
  "has_battery": boolean,
  "has_other_equipment": boolean,
  "other_equipment_note": string|null,
  "interest_rate_percent": number|null,
  "discount_amount_yen": number|null,
  "mentions_scaffolding_fee": boolean,
  "mentions_warranty": boolean,
  "warranty_years": number|null,
  "mentions_grid_connection_fee": boolean,
  "mentions_application_fee": boolean,
  "line_items": [{"name": string, "amount_yen": number|null}],
  "extraction_confidence": "high"|"medium"|"low",
  "notes": string
}

注意点（金額の切り分けが最も重要です）:
- solar_maker は太陽光パネルのメーカー名のみ、battery_maker は蓄電池のメーカー名のみを入れてください。見積書に太陽光が含まれていない場合、solar_maker は必ず null にしてください（蓄電池のメーカー名を solar_maker に入れないでください）。逆も同様です。
- solar_related_subtotal_yen は、太陽光システム（パネル・パワコン・架台・太陽光の設置工事等）に対応する金額の小計です。蓄電池や他設備の金額を含めないでください。
- battery_related_subtotal_yen は、蓄電池本体・蓄電池用の設置工事に対応する金額の小計です。太陽光や他設備の金額を含めないでください。見積書が蓄電池単体（太陽光を含まない）の場合は、total_price_yen と同じ金額を設定してください。
- 内訳から太陽光・蓄電池それぞれの金額を分離できない場合（「太陽光・蓄電池セット一式」のような1行のみの場合など）は、両方とも null にしてください。無理に按分しないでください。
- 足場費・電気配線工事費など太陽光・蓄電池のどちらに属するか判別できない共通費用は、どちらの小計にも含めず、line_items にのみ記載してください。
- has_other_equipment は、太陽光・蓄電池以外の設備（エコキュート、V2H、カーポート等）が見積もりに混在している場合に true にしてください。
- 個人情報（氏名・住所）は抽出しないでください。`;

  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: 1500,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: [
          contentBlock,
          { type: "text", text: "この見積書を読み取って、指定されたJSONスキーマで出力してください。" },
        ],
      },
    ],
  };

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${text}`);
  }

  const json = await response.json();
  const textBlock = (json.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text response from model.");

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (e) {
    const match = textBlock.text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Failed to parse model output as JSON.");
    parsed = JSON.parse(match[0]);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Step 2: ルールベースで判定する（太陽光・蓄電池それぞれの相場比較＋確認項目）
// ---------------------------------------------------------------------------
function tierFromRatio(ratio) {
  if (ratio <= THRESHOLDS.cheapRatio) return { tier: "cheap", label: "相場より安い" };
  if (ratio < THRESHOLDS.highRatio) return { tier: "within_range", label: "相場の範囲内" };
  if (ratio < THRESHOLDS.needsCheckRatio) return { tier: "high", label: "相場より高め" };
  return { tier: "needs_check", label: "要確認" };
}

function evaluateSolar(d) {
  // 太陽光がまったく含まれない見積書（蓄電池単体など）では太陽光の判定自体を行わない
  if (!d.solar_capacity_kw && !d.solar_related_subtotal_yen && d.has_battery) {
    return { applicable: false };
  }

  const kw = d.solar_capacity_kw;
  const price = d.solar_related_subtotal_yen ?? (!d.has_battery && !d.has_other_equipment ? d.total_price_yen : null);

  const check = {
    applicable: true,
    tier: "unknown",
    label: "内訳の確認が必要",
    ratio: null,
    unitPrice: null,
    benchmark: SOLAR_MARKET_RATE.avgYenPerKw,
    benchmarkUnit: "円/kW",
    source: SOLAR_MARKET_RATE.source,
    isOfficial: SOLAR_MARKET_RATE.isOfficial,
    reason: "",
  };

  if (!kw) {
    check.reason = "太陽光の容量（kW）が見積書から読み取れませんでした。";
    return check;
  }
  if (!price) {
    check.reason = "金額の内訳が読み取れず、太陽光システム単体の金額を特定できませんでした。";
    return check;
  }

  const unitPrice = Math.round(price / kw);
  const ratio = Math.round((unitPrice / SOLAR_MARKET_RATE.avgYenPerKw) * 100) / 100;
  const { tier, label } = tierFromRatio(ratio);

  check.unitPrice = unitPrice;
  check.ratio = ratio;
  check.tier = tier;
  check.label = label;
  check.reason = {
    cheap: "kW単価が相場平均の0.7倍以下です。安さの理由（工事内容・保証・補助金対応）も確認してください。",
    within_range: "kW単価は相場平均から大きく外れていません。",
    high: "kW単価が相場平均を20%以上上回っています。",
    needs_check: "kW単価が相場平均を50%以上上回っています。内訳を確認することを強くおすすめします。",
  }[tier];

  return check;
}

function evaluateBattery(d) {
  if (!d.has_battery) {
    return { applicable: false };
  }

  const kwh = d.battery_capacity_kwh;
  const price = d.battery_related_subtotal_yen ?? (!d.solar_capacity_kw && !d.has_other_equipment ? d.total_price_yen : null);

  const check = {
    applicable: true,
    tier: "unknown",
    label: "内訳の確認が必要",
    ratio: null,
    unitPrice: null,
    benchmark: BATTERY_MARKET_RATE.avgYenPerKwh,
    benchmarkUnit: "円/kWh",
    source: BATTERY_MARKET_RATE.source,
    isOfficial: BATTERY_MARKET_RATE.isOfficial,
    reason: "",
  };

  if (!kwh) {
    check.reason = "蓄電池の容量（kWh）が見積書から読み取れませんでした。";
    return check;
  }
  if (!price) {
    check.reason = "金額の内訳が太陽光と分離できず、蓄電池単体の金額を特定できませんでした。「太陽光・蓄電池セット一式」のような書き方の見積書によくあります。販売店に内訳を確認してください。";
    return check;
  }

  const unitPrice = Math.round(price / kwh);
  const ratio = Math.round((unitPrice / BATTERY_MARKET_RATE.avgYenPerKwh) * 100) / 100;
  const { tier, label } = tierFromRatio(ratio);

  check.unitPrice = unitPrice;
  check.ratio = ratio;
  check.tier = tier;
  check.label = label;
  check.reason = {
    cheap: "kWh単価が市場相場平均の0.7倍以下です。安さの理由（機種・保証年数）も確認してください。",
    within_range: "kWh単価は市場相場平均から大きく外れていません。ただし容量帯によって適正な単価幅は変わります（小容量ほど割高、大容量ほど割安が一般的）。",
    high: "kWh単価が市場相場平均を20%以上上回っています。",
    needs_check: "kWh単価が市場相場平均を50%以上上回っています。内訳を確認することを強くおすすめします。",
  }[tier];

  return check;
}

function evaluateQuote(d) {
  const flags = [];

  const solarCheck = evaluateSolar(d);
  const batteryCheck = evaluateBattery(d);

  if (d.has_other_equipment) {
    flags.push({
      level: "info",
      message:
        "太陽光・蓄電池以外の設備が混ざっているため、その分の金額は今回の相場比較に含めていません。" +
        (d.other_equipment_note ? `（${d.other_equipment_note}）` : ""),
    });
  }

  if (d.solar_capacity_kw && d.has_battery && (!d.solar_related_subtotal_yen || !d.battery_related_subtotal_yen) && d.total_price_yen) {
    flags.push({
      level: "info",
      message: "太陽光と蓄電池の金額が内訳として分かれていなかったため、それぞれ単体では判定できませんでした。販売店に内訳（太陽光分／蓄電池分）を確認すると、より正確に比較できます。",
    });
  }

  // 契約前の確認項目チェック
  if (d.interest_rate_percent != null && d.interest_rate_percent >= THRESHOLDS.highInterestRatePercent) {
    flags.push({
      level: "warn",
      message: `金利が年${d.interest_rate_percent}%と高めです（目安：年4.0%以上は要注意）。0円ソーラーやローン提案でよく見られる水準です。`,
    });
  }
  if (d.discount_amount_yen != null && d.total_price_yen) {
    const discountRatio = d.discount_amount_yen / d.total_price_yen;
    if (discountRatio >= THRESHOLDS.highDiscountRatioOfTotal) {
      flags.push({
        level: "warn",
        message: `値引き額が総額の${Math.round(discountRatio * 100)}%です。値引き率ではなく、値引き後の最終総額を相場と比べて判断してください。`,
      });
    }
  }
  if (!d.solar_capacity_kw && !d.has_battery) {
    flags.push({ level: "warn", message: "太陽光の容量（kW）が見積書に明記されていません。型番だけでは単価比較ができないため、販売店に確認してください。" });
  }
  if (d.has_battery && !d.battery_capacity_kwh) {
    flags.push({ level: "warn", message: "蓄電池の容量（kWh）が見積書に明記されていません。販売店に確認してください。" });
  }
  if (!d.mentions_warranty) {
    flags.push({ level: "info", message: "保証年数の記載が見当たりません。機器保証・工事保証の年数と範囲を確認してください。" });
  }
  if (!d.mentions_scaffolding_fee) {
    flags.push({ level: "info", message: "足場設置費の記載が見当たりません。別途請求になっていないか確認してください。" });
  }
  if (!d.mentions_grid_connection_fee) {
    flags.push({ level: "info", message: "電力会社への申請・工事負担金についての記載が見当たりません。後から追加費用が発生しないか確認してください。" });
  }

  return {
    solarCheck,
    batteryCheck,
    flags,
    disclaimer:
      "この診断は価格確認の目安であり、契約すべきか・解約すべきかを判断するものではありません。屋根の下地状況や分電盤の容量など、現地を見ないと分からない点は含まれていません。蓄電池の相場基準値は公的統計ではなく、施工店の見積もり実績を集計した市場調査データの平均値です。",
  };
}
