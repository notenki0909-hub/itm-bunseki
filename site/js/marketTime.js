// 米国株の日足データの「更新時刻」まわりの判定(純粋関数のみ)。
//
// データ提供元(Twelve Data)は、履歴・日足データを「各取引日の引け後、翌日の現地0:00(ET)以降」に
// 利用可能にする(公式: support.twelvedata.com の「US equities market data」)。その1時間後
// (翌日の現地1:00 ET)を「更新時刻」とみなし、直近のその時刻より前に取得したデータは
// 「古い」と判定して取り直す。タブを開いたとき(ブラウザ側)と、リクエストを受けたとき(サーバー側)
// の両方で同じ判定を使う。
// 【重要】functions/api/history.js にも同じ関数がある。変更するときは両方を同じに保つこと。

export const UPDATE_HOUR_ET = 1; // 翌日の現地1:00(ET)。提供元が「引け後、翌日の現地0:00(ET)以降」に日足を利用可能にする、その1時間後
export const RETRY_INTERVAL_MS = 60 * 60 * 1000; // 更新が遅れている/休日のときの再取得は1時間に1回まで

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

// その瞬間の「米国東部時間 − UTC」(ミリ秒。夏時間は−4時間、冬時間は−5時間)
function etOffsetMs(ms) {
  const p = etParts(ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - (ms - (ms % 1000));
}

// 米国東部時間の「年月日 時:00」に当たるUTCのミリ秒
function etWallToUtcMs(y, m, d, h) {
  const guess = Date.UTC(y, m - 1, d, h);
  return guess - etOffsetMs(guess);
}

/**
 * 直近の「更新時刻」(取引日の翌日=火〜土の現地1:00 ET)を返す。
 * @returns {{ms:number, dateStr:string}} ms=その時刻(UTCミリ秒)、dateStr=その時点でデータに含まれているはずの最新の取引日(YYYY-MM-DD)
 */
export function latestUpdateBoundary(nowMs = Date.now()) {
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

/**
 * 取得済みの株価データが古いか(取り直すべきか)を判定する。
 *  - 取得時刻が、直近の更新時刻より前なら古い。
 *  - 取得時刻が更新時刻以降でも、最新の日付が想定(dateStr)より古く、かつ取得から
 *    1時間以上たっていれば古いとみなす(提供元の更新が遅れている場合の保険。休日は当日分が
 *    ないため、この場合の取り直しも1時間に1回までに抑える)。
 * @param {number|null|undefined} fetchedAt データを取得した時刻(UTCミリ秒)
 * @param {string|undefined} latestDate データの最新の日付(YYYY-MM-DD)
 */
export function isPriceDataStale(fetchedAt, latestDate, nowMs = Date.now()) {
  if (!Number.isFinite(fetchedAt)) return true;
  const b = latestUpdateBoundary(nowMs);
  if (fetchedAt < b.ms) return true;
  if (latestDate && latestDate < b.dateStr && nowMs - fetchedAt >= RETRY_INTERVAL_MS) return true;
  return false;
}
