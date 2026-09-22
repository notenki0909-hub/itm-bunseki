// ITM分析の計算ロジック（純粋関数のみ。DOM・fetchに依存しない）
// 将来オプションタイプや判定基準を追加・変更する場合はこのファイルだけを触ればよい設計。

// オプションタイプごとの初期値。
// ratio: 権利行使価格 = 終値 × ratio
// itmWhen: 'below'(終値がストライクを下回るとITM=プット系) / 'above'(上回るとITM=コール系)
export const OPTION_TYPES = {
  put_sell:  { label: "プット売", ratio: 0.90, itmWhen: "below" },
  call_sell: { label: "コール売", ratio: 1.20, itmWhen: "above" },
  call_buy:  { label: "コール買", ratio: 1.05, itmWhen: "above" },
  put_buy:   { label: "プット買", ratio: 0.95, itmWhen: "below" },
};

export const WINDOW_OPTIONS = [10, 20, 30, 60, 90];
export const DEFAULT_WINDOW = 30;

// 集計期間（「過去」とみなす営業日数）の選択肢。1営業日=1本のデータ。
export const PERIOD_OPTIONS = [
  { label: "6ヶ月", days: 130 },
  { label: "1年", days: 253 },
  { label: "1.6年", days: 400 },
  { label: "2年", days: 500 },
  { label: "3年", days: 750 },
];
export const DEFAULT_PERIOD_DAYS = 253;

export const MOMENTUM_LOOKBACK_OPTIONS = [1, 2, 3, 4, 5, 6, 7];
export const DEFAULT_MOMENTUM_LOOKBACK = 7;

// 判定バッジの7段階しきい値。表示中の「期間内ITM確率」と矛盾しないよう、
// バッジも同じ overallItmProb（有利方向への確率に変換した値）から直接算出する。
const BADGE_PROB_THRESHOLDS = [0.85, 0.65, 0.45, 0.25, 0.10, 0.03];
const BADGE_LABELS = {
  sell: ["激熱", "熱", "好機", "可もなく不可もなく", "ひやひや", "ITM", "ピンチ"],
  buy:  ["激熱", "熱", "好機", "ITM", "OTM", "ピンチ", "大ピンチ"],
};

/**
 * @param {number[]} closes 古い順の終値配列
 * @param {{ratio:number, itmWhen:'below'|'above', window:number, group:'sell'|'buy'}} params
 * @param {string[]} [dates] closesと同じ並びの日付文字列(YYYY-MM-DD)。渡すとperEntryに日付が入る
 * @returns {{
 *   entryCount:number,
 *   itmEntryCount:number,
 *   overallItmProb:number|null,
 *   dayProb:(number|null)[],
 *   badge:string,
 *   badgeLevel:number|null,
 *   perEntry:{date:string|null, itmDaysInWindow:number}[]
 * }}
 */
export function computeItmAnalysis(closes, params, dates) {
  const { ratio, itmWhen, window, group } = params;
  const n = closes.length;
  const isBelow = itmWhen === "below";

  const dayItmCounts = new Array(window + 1).fill(0);
  const dayTotalCounts = new Array(window + 1).fill(0);
  let entryCount = 0;
  let entriesItmWithinWindow = 0;
  const perEntry = [];

  for (let i = 0; i + window < n; i++) {
    const strike = closes[i] * ratio;
    if (!(strike > 0)) continue;
    entryCount++;
    let itmDaysInWindow = 0;
    for (let d = 1; d <= window; d++) {
      const fwd = closes[i + d] / strike - 1;
      const itm = isBelow ? fwd < 0 : fwd > 0;
      dayTotalCounts[d]++;
      if (itm) {
        dayItmCounts[d]++;
        itmDaysInWindow++;
      }
    }
    if (itmDaysInWindow > 0) entriesItmWithinWindow++;
    perEntry.push({ date: dates ? dates[i] : null, itmDaysInWindow });
  }

  const dayProb = [];
  for (let d = 1; d <= window; d++) {
    dayProb.push(dayTotalCounts[d] ? dayItmCounts[d] / dayTotalCounts[d] : null);
  }

  const overallItmProb = entryCount ? entriesItmWithinWindow / entryCount : null;
  const { label: badge, level: badgeLevel } = classifyBadge(overallItmProb, group);

  return {
    entryCount,
    itmEntryCount: entriesItmWithinWindow,
    overallItmProb,
    dayProb,
    badge,
    badgeLevel,
    perEntry,
  };
}

// level: 0(最も有利=激熱)〜6(最も不利=ピンチ/大ピンチ)。色の濃淡付けに使う。
function classifyBadge(overallItmProb, group) {
  const labels = BADGE_LABELS[group] || BADGE_LABELS.sell;
  if (overallItmProb === null || Number.isNaN(overallItmProb)) return { label: "―", level: null };
  // 買い(buy)はITM確率が高いほど有利、売り(sell)はITM確率が低いほど有利なので
  // 「有利方向への確率」に揃えてからしきい値判定する。
  const favorableProb = group === "sell" ? 1 - overallItmProb : overallItmProb;
  for (let i = 0; i < BADGE_PROB_THRESHOLDS.length; i++) {
    if (favorableProb >= BADGE_PROB_THRESHOLDS[i]) return { label: labels[i], level: i };
  }
  return { label: labels[labels.length - 1], level: labels.length - 1 };
}

export function typeGroup(typeKey) {
  return typeKey === "put_sell" || typeKey === "call_sell" ? "sell" : "buy";
}

/**
 * indexの終値が、そのlookbackDays営業日前と比べて何%変動したか。
 * 元Excelの「N営業日前比較」列と同じ定義。
 * @returns {number|null} データが足りない場合はnull
 */
export function computeMomentum(closes, index, lookbackDays) {
  const base = index - lookbackDays;
  if (base < 0 || index < 0 || index >= closes.length) return null;
  return closes[index] / closes[base] - 1;
}

/**
 * 最新日について、1〜maxLookback営業日前との比較を並べたもの（「本日の状況」表示用）。
 */
export function computeRecentMomentumStrip(closes, maxLookback = 7) {
  const latest = closes.length - 1;
  const strip = [];
  for (let n = 1; n <= maxLookback; n++) {
    strip.push({ daysAgo: n, change: computeMomentum(closes, latest, n) });
  }
  return strip;
}

/**
 * 「過去、直近の値動きが今日と似ていた日」に絞り込んだ場合のITM確率を計算する。
 * computeItmAnalysisと同じ判定基準を使うが、対象エントリーを momentum条件でフィルタする点が異なる。
 *
 * @param {number[]} closes
 * @param {{ratio:number, itmWhen:'below'|'above', window:number,
 *           momentumLookback:number, momentumDirection:'down'|'up', momentumThresholdPct:number}} params
 * @returns {{matchedCount:number, matchedItmProb:number|null}}
 */
export function computeConditionalItmAnalysis(closes, params) {
  const { ratio, itmWhen, window, momentumLookback, momentumDirection, momentumThresholdPct } = params;
  const n = closes.length;
  const isBelow = itmWhen === "below";
  const thresholdFrac = momentumThresholdPct / 100;

  let matchedCount = 0;
  let matchedItmCount = 0;

  for (let i = momentumLookback; i + window < n; i++) {
    const momentum = computeMomentum(closes, i, momentumLookback);
    if (momentum === null) continue;
    const matches = momentumDirection === "down" ? momentum <= -thresholdFrac : momentum >= thresholdFrac;
    if (!matches) continue;

    const strike = closes[i] * ratio;
    if (!(strike > 0)) continue;
    matchedCount++;

    let itmAny = false;
    for (let d = 1; d <= window; d++) {
      const fwd = closes[i + d] / strike - 1;
      const itm = isBelow ? fwd < 0 : fwd > 0;
      if (itm) { itmAny = true; break; }
    }
    if (itmAny) matchedItmCount++;
  }

  return {
    matchedCount,
    matchedItmProb: matchedCount ? matchedItmCount / matchedCount : null,
  };
}
