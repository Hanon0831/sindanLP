// api/diagnose.js
// Vercel Serverless Function (Node.js runtime).
// Receives a base64-encoded quote (image or PDF), asks Claude to extract
// structured data from it, then applies a rule-based market-rate comparison.
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
// 相場の基準値（経済産業省 調達価格等算定委員会「令和8年度以降の調達価格等に
// 関する意見」令和8年2月5日 より）
// 出典: https://www.meti.go.jp/shingikai/santeii/pdf/20260205_1.pdf
// 数値は年度ごとに公表内容が更新されるため、年1回は見直してください。
// ---------------------------------------------------------------------------
const MARKET_RATE = {
  avgYenPerKw: 289000, // 2025年に新築で設置された案件の平均（中央値29.4万円/kW）
  top30YenPerKw: 256000, // 上位30%の水準
  projected2026YenPerKw: 255000, // 2026年度の想定値
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
    res.status(200).json({ extracted, verdict });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "diagnose_failed", message: String(err?.message || err) });
  }
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
  "maker": string|null,
  "solar_capacity_kw": number|null,
  "battery_capacity_kwh": number|null,
  "solar_related_subtotal_yen": number|null,
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

注意点:
- solar_related_subtotal_yen は、太陽光システム（パネル・パワコン・架台・設置工事等）に対応する金額の小計です。蓄電池やエコキュート等の他設備の金額を含めないでください。内訳から判別できない場合は null にしてください。
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
    // モデルが万一コードブロックを付けてしまった場合の保険
    const match = textBlock.text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Failed to parse model output as JSON.");
    parsed = JSON.parse(match[0]);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Step 2: ルールベースで判定する（相場比較＋契約前の確認項目）
// ---------------------------------------------------------------------------
function evaluateQuote(d) {
  const flags = [];
  let priceCheck = {
    tier: "unknown",
    label: "内訳の確認が必要",
    ratio: null,
    pricePerKw: null,
    benchmarkPerKw: MARKET_RATE.avgYenPerKw,
    reason: "",
  };

  const kw = d.solar_capacity_kw;
  const price = d.solar_related_subtotal_yen ?? (d.has_other_equipment ? null : d.total_price_yen);

  if (d.has_other_equipment) {
    flags.push({
      level: "info",
      message:
        "太陽光・蓄電池以外の設備が混ざっているため、総額での直接比較はしていません。" +
        (d.other_equipment_note ? `（${d.other_equipment_note}）` : ""),
    });
  }

  if (!kw || !price) {
    priceCheck.reason = !kw
      ? "太陽光の容量（kW）が見積書から読み取れませんでした。"
      : "金額の内訳が読み取れず、太陽光システム単体の金額を特定できませんでした。";
  } else {
    const pricePerKw = Math.round(price / kw);
    const ratio = pricePerKw / MARKET_RATE.avgYenPerKw;
    priceCheck.pricePerKw = pricePerKw;
    priceCheck.ratio = Math.round(ratio * 100) / 100;

    if (ratio <= THRESHOLDS.cheapRatio) {
      priceCheck.tier = "cheap";
      priceCheck.label = "相場より安い";
      priceCheck.reason = "kW単価が相場平均の0.7倍以下です。安さの理由（工事内容・保証・補助金対応）も確認してください。";
    } else if (ratio < THRESHOLDS.highRatio) {
      priceCheck.tier = "within_range";
      priceCheck.label = "相場の範囲内";
      priceCheck.reason = "kW単価は相場平均から大きく外れていません。";
    } else if (ratio < THRESHOLDS.needsCheckRatio) {
      priceCheck.tier = "high";
      priceCheck.label = "相場より高め";
      priceCheck.reason = "kW単価が相場平均を20%以上上回っています。";
    } else {
      priceCheck.tier = "needs_check";
      priceCheck.label = "要確認";
      priceCheck.reason = "kW単価が相場平均を50%以上上回っています。内訳を確認することを強くおすすめします。";
    }
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
  if (!kw) {
    flags.push({ level: "warn", message: "太陽光の容量（kW）が見積書に明記されていません。型番だけでは単価比較ができないため、販売店に確認してください。" });
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
    priceCheck,
    flags,
    disclaimer:
      "この診断は価格確認の目安であり、契約すべきか・解約すべきかを判断するものではありません。屋根の下地状況や分電盤の容量など、現地を見ないと分からない点は含まれていません。",
  };
}
