// Twelve Data の日足終値をサーバー側で取得して返すCloudflare Pages Function。
//
// 設計方針（無駄な処理をしない・将来の変更に強くするため）:
// - 同一銘柄のリクエストはCloudflare KV(PRICE_CACHE)でキャッシュする。
//   キャッシュが古いかは「取得時刻が、直近のデータ更新時刻(提供元が日足を利用可能にする翌日の
//   現地0:00 ETの1時間後=1:00 ET)より前か」で判定し、古いときだけTwelve Dataから取り直す(下のisPriceDataStale)。
//   KVは全世界のCloudflare拠点で共有される保存領域なので、利用者の地域やアクセス拠点に
//   関係なく「同じ銘柄への実アクセスはTwelve Dataに対して概ね1日1回だけ」にできる
//   （書き込み後の反映に数秒〜最大1分程度のタイムラグがあるため、ごく稀にほぼ同時の
//   別拠点アクセスが重複することはあり得る）。
//   定期的に取りにいく処理はなく、その銘柄が検索されたときだけ取り直す。
//   取り直しに失敗したとき(無料枠の上限など)は、古いキャッシュがあればそれを返す。
// - PRICE_CACHE が未設定（KV未作成）でも動作は継続する（キャッシュなしで毎回取得するだけ）。
// - レスポンス契約 {symbol, dates, closes} / {error} を固定しておけば、
//   将来データ提供元をTwelve Data以外に差し替えてもフロント側は変更不要。
// - APIキーは環境変数 TWELVEDATA_API_KEY から読む（コードに直書きしない）。
//   ローカル確認: .dev.vars に設定。本番: Cloudflare Pages のダッシュボードで設定。

// KVの保存期間。古いかどうかの判定はisPriceDataStaleが行うため、ここは「検索されなくなった銘柄を
// いつまでも残さない」ための掃除用(7日)。
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
// ---- 米国株の日足の「更新時刻」判定 ----
// 【重要】site/js/marketTime.js と同じ内容。変更するときは両方を同じに保つこと。
const UPDATE_HOUR_ET = 1; // 翌日の現地1:00(ET)。提供元が「引け後、翌日の現地0:00(ET)以降」に日足を利用可能にする、その1時間後
const RETRY_INTERVAL_MS = 60 * 60 * 1000; // 更新が遅れている/休日のときの再取得は1時間に1回まで

const ET_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric", month: "numeric", day: "numeric",
  hour: "numeric", minute: "numeric", second: "numeric",
});

function etParts(ms) {
  const o = {};
  for (const p of ET_FORMAT.formatToParts(new Date(ms))) {
    if (p.type !== "literal") o[p.type] = Number(p.value);
  }
  return o;
}

function etOffsetMs(ms) {
  const p = etParts(ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - (ms - (ms % 1000));
}

function etWallToUtcMs(y, m, d, h) {
  const guess = Date.UTC(y, m - 1, d, h);
  return guess - etOffsetMs(guess);
}

function latestUpdateBoundary(nowMs = Date.now()) {
  const p = etParts(nowMs);
  let day = Date.UTC(p.year, p.month - 1, p.day);
  if (p.hour < UPDATE_HOUR_ET) day -= 86400000;
  // 更新時刻は「取引日(月〜金)の翌日」の1:00 ET = 火〜土。日・月の1:00は対象外(前日が土日で取引がない)
  while ([0, 1].includes(new Date(day).getUTCDay())) day -= 86400000;
  const d = new Date(day);
  return {
    ms: etWallToUtcMs(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), UPDATE_HOUR_ET),
    // この更新時刻の時点で、データに含まれているはずの最新の取引日(その前日)
    dateStr: new Date(day - 86400000).toISOString().slice(0, 10),
  };
}

function isPriceDataStale(fetchedAt, latestDate, nowMs = Date.now()) {
  if (!Number.isFinite(fetchedAt)) return true;
  const b = latestUpdateBoundary(nowMs);
  if (fetchedAt < b.ms) return true;
  if (latestDate && latestDate < b.dateStr && nowMs - fetchedAt >= RETRY_INTERVAL_MS) return true;
  return false;
}

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

  const cached = kv ? await kv.get(cacheKey, "json") : null;
  const cachedLatest = cached?.dates?.[cached.dates.length - 1];
  const now = Date.now();
  // キャッシュが新しければそのまま返す。古くても、直近1時間以内に取り直しを試して失敗している
  // 場合は(無料枠の上限などで失敗し続けないよう)再試行せず、古いキャッシュを返す。
  if (cached) {
    const stale = isPriceDataStale(cached.fetchedAt, cachedLatest, now);
    const triedRecently = Number.isFinite(cached.lastAttemptAt) && now - cached.lastAttemptAt < RETRY_INTERVAL_MS;
    if (!stale || triedRecently) return json(cached, 200);
  }

  // 取り直しに失敗したとき、古いキャッシュがあればそれを返す(エラーにしない)。
  const fail = async (errResponse) => {
    if (!cached) return errResponse;
    if (kv) {
      context.waitUntil(
        kv.put(cacheKey, JSON.stringify({ ...cached, lastAttemptAt: now }), { expirationTtl: CACHE_TTL_SECONDS })
      );
    }
    return json(cached, 200);
  };

  const apiKey = env.TWELVEDATA_API_KEY;
  if (!apiKey) return fail(json({ error: "server not configured (TWELVEDATA_API_KEY missing)" }, 500));

  const apiUrl = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=${OUTPUT_SIZE}&order=ASC&apikey=${apiKey}`;

  let res;
  try {
    res = await fetch(apiUrl);
  } catch (e) {
    return fail(json({ error: "fetch failed" }, 502));
  }

  // Twelve Dataはシンボル無効時もHTTP 404/400 + JSONボディでmessageを返すため、
  // ステータスコードで早期リターンせず、まずJSONとして読んでmessageを拾う。
  let data;
  try {
    data = await res.json();
  } catch (e) {
    return fail(json({ error: `upstream error ${res.status}` }, 502));
  }

  if (data.status === "error" || !Array.isArray(data.values)) {
    const msg = data.message || `symbol not found (HTTP ${res.status})`;
    return fail(json({ error: msg }, 404));
  }
  if (data.values.length < 30) {
    return fail(json({ error: "insufficient price history" }, 404));
  }

  const dates = [];
  const closes = [];
  for (const row of data.values) {
    const c = Number(row.close);
    if (!Number.isFinite(c)) continue;
    dates.push(row.datetime);
    closes.push(c);
  }

  // fetchedAt: Twelve Dataから取得した時刻。ブラウザ側もこの値で「古いか」を判定する。
  const result = { symbol, currency: data.meta?.currency || null, dates, closes, fetchedAt: now };

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
