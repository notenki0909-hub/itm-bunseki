// Twelve Data の日足終値をサーバー側で取得して返すCloudflare Pages Function。
//
// 設計方針（無駄な処理をしない・将来の変更に強くするため）:
// - 同一銘柄のリクエストはCloudflare KV(PRICE_CACHE)で1日キャッシュする。
//   KVは全世界のCloudflare拠点で共有される保存領域なので、利用者の地域やアクセス拠点に
//   関係なく「同じ銘柄への実アクセスはTwelve Dataに対して概ね1日1回だけ」にできる
//   （書き込み後の反映に数秒〜最大1分程度のタイムラグがあるため、ごく稀にほぼ同時の
//   別拠点アクセスが重複することはあり得る）。
// - PRICE_CACHE が未設定（KV未作成）でも動作は継続する（キャッシュなしで毎回取得するだけ）。
// - レスポンス契約 {symbol, dates, closes} / {error} を固定しておけば、
//   将来データ提供元をTwelve Data以外に差し替えてもフロント側は変更不要。
// - APIキーは環境変数 TWELVEDATA_API_KEY から読む（コードに直書きしない）。
//   ローカル確認: .dev.vars に設定。本番: Cloudflare Pages のダッシュボードで設定。

const CACHE_TTL_SECONDS = 20 * 60 * 60; // 20時間。日次バッチと同じ「1日1回」の考え方に合わせる
const OUTPUT_SIZE = 800; // 集計期間セレクター(最大3年)をローカルスライスだけで賄うための最大取得数

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const symbolRaw = (url.searchParams.get("symbol") || "").trim();

  if (!symbolRaw) return json({ error: "symbol is required" }, 400);
  if (!/^[A-Za-z0-9.\-]{1,15}$/.test(symbolRaw)) {
    return json({ error: "invalid symbol" }, 400);
  }
  const symbol = symbolRaw.toUpperCase();
  const kv = env.PRICE_CACHE; // KV未バインドの環境でも動くようoptionalに扱う
  const cacheKey = `itm-history:${symbol}`;

  if (kv) {
    const cached = await kv.get(cacheKey, "json");
    if (cached) return json(cached, 200);
  }

  const apiKey = env.TWELVEDATA_API_KEY;
  if (!apiKey) return json({ error: "server not configured (TWELVEDATA_API_KEY missing)" }, 500);

  const apiUrl = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=${OUTPUT_SIZE}&order=ASC&apikey=${apiKey}`;

  let res;
  try {
    res = await fetch(apiUrl);
  } catch (e) {
    return json({ error: "fetch failed" }, 502);
  }

  // Twelve Dataはシンボル無効時もHTTP 404/400 + JSONボディでmessageを返すため、
  // ステータスコードで早期リターンせず、まずJSONとして読んでmessageを拾う。
  let data;
  try {
    data = await res.json();
  } catch (e) {
    return json({ error: `upstream error ${res.status}` }, 502);
  }

  if (data.status === "error" || !Array.isArray(data.values)) {
    const msg = data.message || `symbol not found (HTTP ${res.status})`;
    return json({ error: msg }, 404);
  }
  if (data.values.length < 30) {
    return json({ error: "insufficient price history" }, 404);
  }

  const dates = [];
  const closes = [];
  for (const row of data.values) {
    const c = Number(row.close);
    if (!Number.isFinite(c)) continue;
    dates.push(row.datetime);
    closes.push(c);
  }

  const result = { symbol, currency: data.meta?.currency || null, dates, closes };

  if (kv) {
    context.waitUntil(
      kv.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS })
    );
  }

  return json(result, 200);
}

function json(body, status) {
  // 実際のキャッシュ制御はKV側(1日1回)で行うため、ブラウザの標準HTTPキャッシュには
  // 一切キャッシュさせない。付けないとブラウザが独自判断で古いレスポンスを使い回し、
  // 「本日の状況」が何日も更新されなくなる不具合が起きるため明示が必須。
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
