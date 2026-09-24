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

export const WINDOW_OPTIONS = [10, 20, 30, 60, 90, 120, 150];
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
// オプション売りは「利益は限定的・損失は相対的に大きい」非対称な構造のため、
// 損益分岐点となる勝率は50%よりかなり高くなるのが一般的。有利確率50%を
// 「ほぼ最悪」の位置に置き、50%未満(=ITM方向の方が優勢)を最悪(最終段階)とする。
// 売り系は「勝率は最低85%は欲しい」というユーザー基準に合わせ、買い系より
// 厳しめのしきい値を使う(85%未満はもう「熱」ではなく「可もなく不可もなく」)。
const BADGE_PROB_THRESHOLDS = {
  sell: [0.95, 0.85, 0.80, 0.70, 0.60, 0.50],
  buy:  [0.95, 0.85, 0.75, 0.65, 0.55, 0.50],
};
export const BADGE_LABELS = {
  sell: ["激熱", "熱", "可もなく不可もなく", "ひやひや", "ITM", "ピンチ", "大ピンチ"],
  buy:  ["激熱", "熱", "好機", "ITM", "OTM", "ピンチ", "大ピンチ"],
};

// 「有利方向への確率」を0(最も有利)〜6(最も不利)の7段階に変換する。総合判定
// バッジが使う(営業日ごとのITM確率チャート・エントリー日ごとのヒートマップは、
// 別のしきい値(絶対値ベース)を使っており、この関数とは独立している)。
// 売り/買いでしきい値が異なるため、groupを指定する(省略時はsell扱い)。
export function favorableProbToLevel(favorableProb, group) {
  if (favorableProb === null || favorableProb === undefined || Number.isNaN(favorableProb)) return null;
  const thresholds = BADGE_PROB_THRESHOLDS[group] || BADGE_PROB_THRESHOLDS.sell;
  for (let i = 0; i < thresholds.length; i++) {
    if (favorableProb >= thresholds[i]) return i;
  }
  return thresholds.length; // 6 = 最下段(ピンチ/大ピンチ)
}

/**
 * @param {number[]} closes 古い順の終値配列
 * @param {{ratio:number, itmWhen:'below'|'above', window:number, group:'sell'|'buy'}} params
 * @param {string[]} [dates] closesと同じ並びの日付文字列(YYYY-MM-DD)。渡すとperEntryに日付が入る
 * @returns {{
 *   entryCount:number,
 *   itmEntryCount:number,
 *   totalItmDays:number,
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
  let totalItmDays = 0;
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
    totalItmDays += itmDaysInWindow;
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
    totalItmDays,
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
  const level = favorableProbToLevel(favorableProb, group);
  return { label: labels[level], level };
}

export function typeGroup(typeKey) {
  return typeKey === "put_sell" || typeKey === "call_sell" ? "sell" : "buy";
}

// 生のITM確率(比率)を、そのタイプにとっての「有利方向への確率」に変換する。
// 営業日ごとのITM確率チャート・エントリー日ごとのヒートマップでも共通で使う。
export function toFavorableProb(rawItmProb, group) {
  if (rawItmProb === null || rawItmProb === undefined || Number.isNaN(rawItmProb)) return null;
  return group === "sell" ? 1 - rawItmProb : rawItmProb;
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

// エントリー条件で絞り込みの、値動き条件の判定方法。
// "lookback": N営業日前と比較して、指定した変化率条件を満たすか(単一日の比較)。
// "countWithin7": 直近7営業日それぞれ(1〜7営業日前比較)について条件を満たす日を数え、
//   その日数が指定した日数以上あるか(何日も同じ方向に動き続けたか、を見る)。
export const CONDITION_MODES = ["lookback", "countWithin7"];
const CONDITION_WITHIN_DAYS = 7;

/**
 * 「過去、直近の値動きが今日と似ていた日」に絞り込んだ場合のITM確率を計算する。
 * computeItmAnalysisと同じ判定基準を使うが、対象エントリーを値動き条件でフィルタする点が異なる。
 *
 * @param {number[]} closes
 * @param {{ratio:number, itmWhen:'below'|'above', window:number,
 *           conditionMode:'lookback'|'countWithin7', momentumLookback:number,
 *           momentumDirection:'down'|'up', momentumThresholdPct:number, minMatchDays:number}} params
 * @returns {{matchedCount:number, matchedItmCount:number, matchedItmProb:number|null,
 *            matchedTotalItmDays:number, itmDaysList:number[]}}
 */
export function computeConditionalItmAnalysis(closes, params) {
  const {
    ratio, itmWhen, window, momentumDirection, momentumThresholdPct,
    conditionMode = "lookback", momentumLookback, minMatchDays,
  } = params;
  const n = closes.length;
  const isBelow = itmWhen === "below";
  const thresholdFrac = momentumThresholdPct / 100;
  const startIndex = conditionMode === "countWithin7" ? CONDITION_WITHIN_DAYS : momentumLookback;

  let matchedCount = 0;
  let matchedItmCount = 0;
  let matchedTotalItmDays = 0;
  // 該当日ごとのITM日数の一覧。リスクリワード分析で「ITM日数がしきい値以上の
  // 該当日」を数え直すために使う(母数は該当日数=matchedCountに固定するため)。
  const itmDaysList = [];

  for (let i = startIndex; i + window < n; i++) {
    let matches;
    if (conditionMode === "countWithin7") {
      let hitDays = 0;
      for (let k = 1; k <= CONDITION_WITHIN_DAYS; k++) {
        const m = computeMomentum(closes, i, k);
        if (m === null) continue;
        const hit = momentumDirection === "down" ? m <= -thresholdFrac : m >= thresholdFrac;
        if (hit) hitDays++;
      }
      matches = hitDays >= minMatchDays;
    } else {
      const momentum = computeMomentum(closes, i, momentumLookback);
      if (momentum === null) continue;
      matches = momentumDirection === "down" ? momentum <= -thresholdFrac : momentum >= thresholdFrac;
    }
    if (!matches) continue;

    const strike = closes[i] * ratio;
    if (!(strike > 0)) continue;
    matchedCount++;

    let itmAny = false;
    let itmDaysInWindow = 0;
    for (let d = 1; d <= window; d++) {
      const fwd = closes[i + d] / strike - 1;
      const itm = isBelow ? fwd < 0 : fwd > 0;
      if (itm) { itmAny = true; itmDaysInWindow++; }
    }
    if (itmAny) matchedItmCount++;
    matchedTotalItmDays += itmDaysInWindow;
    itmDaysList.push(itmDaysInWindow);
  }

  return {
    matchedCount,
    matchedItmCount,
    matchedItmProb: matchedCount ? matchedItmCount / matchedCount : null,
    matchedTotalItmDays,
    itmDaysList,
  };
}

// ============================================================
// リスクリワード分析
// ============================================================
// 「ITM発生エントリー数の割合」とは別に、ITM日数(判定期間内で判定基準価格に
// 達していた日数)が指定したしきい値以上かどうかで勝敗を決め、受取/支払い
// プレミアムと損失額(または獲得すべき利益額)を比較する機能。

// 取引の種類。上部の取引タイプ(OPTION_TYPESのキー)ごとに「単体(naked)」と
// 「スプレッド(spread)」の2種類を選べる。ラベルは元のオプション用語に合わせた。
export const RISK_VARIANT_LABELS = {
  put_sell: { naked: "プット売り", spread: "ブルプット" },
  call_sell: { naked: "コール売り", spread: "ベアコール" },
  put_buy: { naked: "プット買い", spread: "ベアプット" },
  call_buy: { naked: "コール買い", spread: "ブルコール" },
};

// 「コール売り(単体)」だけは理論上、損失が無限大になり得る特殊ケース。
export function isInfiniteLossVariant(typeKey, variant) {
  return typeKey === "call_sell" && variant === "naked";
}

/**
 * 判定期間内のITM日数の一覧から、指定したしきい値で勝敗を数え、勝率を返す。
 * 売り(group="sell")はITM日数がしきい値以上を「負け」、
 * 買い(group="buy")はITM日数がしきい値以上を「勝ち」として扱う
 * (ITMが有利か不利かは売り/買いで逆になるため)。
 *
 * @param {number[]} itmDaysList
 * @param {number} threshold ITM日数のしきい値(◯日以上)
 * @param {'sell'|'buy'} group
 * @returns {{total:number, hitCount:number, winRate:number|null}}
 */
export function computeWinRateByItmDays(itmDaysList, threshold, group) {
  const total = itmDaysList.length;
  if (total === 0) return { total: 0, hitCount: 0, winRate: null };
  const hitCount = itmDaysList.filter((d) => d >= threshold).length;
  const winRate = group === "sell" ? 1 - hitCount / total : hitCount / total;
  return { total, hitCount, winRate };
}

// 売り系: 受取プレミアムと勝率から、損益分岐となる「許容できる最大損失額」を算出する。
// p×プレミアム = (1-p)×損失額 が損益分岐点なので、損失額 = プレミアム×p/(1-p)。
// 売り系: 反対売買(買い戻し)で決済する場合、受取プレミアムの一部を買い戻しコストとして
// 支払うため、実際に確定する利益は受取プレミアムの一部(利確割合)にとどまる。
// 利確割合が未入力(null/undefined)の場合は100%(満額)とみなす。
export function expectedProfitOnClose(premium, profitRatioPercent) {
  if (premium === null || !(premium >= 0)) return null;
  const ratio = (profitRatioPercent === null || profitRatioPercent === undefined) ? 1 : profitRatioPercent / 100;
  if (!(ratio >= 0)) return null;
  return premium * ratio;
}

export function breakEvenMaxLoss(premium, winRate) {
  if (premium === null || winRate === null || !(premium >= 0)) return null;
  if (winRate >= 1) return Infinity;
  if (winRate <= 0) return 0;
  return premium * (winRate / (1 - winRate));
}

// breakEvenMaxLossの逆算: 自分で決めた損切額と利益額(予想利益/見越し最大利益額)
// から、損益分岐点となる勝率を算出する。p×利益 = (1-p)×損切額 を p について
// 解いたもの(p = 損切額 ÷ (利益+損切額))。実際の勝率(実績)は一切使わないため、
// 「絞り込みなし/あり」どちらの母集団にも依存しない。
export function breakEvenWinRateFromLoss(gain, loss) {
  if (gain === null || loss === null || !(gain >= 0) || !(loss >= 0)) return null;
  if (gain + loss <= 0) return null;
  return loss / (gain + loss);
}

// 買い系: 支払いプレミアムと勝率から、損益分岐に必要な「最低利益額」を算出する。
// (1-p)×プレミアム = p×利益額 が損益分岐点なので、利益額 = プレミアム×(1-p)/p。
export function breakEvenMinGain(premium, winRate) {
  if (premium === null || winRate === null || !(premium >= 0)) return null;
  if (winRate <= 0) return Infinity;
  if (winRate >= 1) return 0;
  return premium * ((1 - winRate) / winRate);
}

// サンプル数(母数)に応じた警告レベル。B+E方式: 〜9件=強い警告、10〜29件=軽い警告、
// 30件〜=警告なし。呼び出し側で「集計期間を延ばす/判定期間を短くする/条件を緩める」
// といった改善策の文言を添えることを想定している。
export function sampleWarningLevel(count) {
  if (count < 10) return "strong";
  if (count < 30) return "mild";
  return null;
}

export const DETAIL_BEFORE_DAYS = 7;
// 「30営業日以内のITM日数」参考列の固定日数。判定期間(window)の選択値とは独立。元Excelの
// 「30営業日以内のP売ITM日数」列に合わせている。
export const DETAIL_ITM_REF_DAYS = 30;

/**
 * 元Excelに近い、エントリー日ごとの詳細マトリクスを計算する。
 * 各行=1エントリー日について、終値・権利行使価格・30営業日以内のITM日数(参考)・
 * 前7営業日比較(before)・判定期間分の先読み(after)を持つ。
 * afterは権利行使価格に対する生の乖離率（株価/権利行使価格-1）。正=株価が権利行使価格より上、負=下。
 * 集計期間の全エントリー日を対象とする(判定期間分を差し引かない)。先読みの日数分の
 * データが無いセルはnull(未確定)になる。
 *
 * @param {number[]} closes
 * @param {string[]} dates
 * @param {{ratio:number, window:number, itmWhen:'below'|'above'}} params
 * @returns {{date:string, close:number, strike:number, itmDaysRef:number|null,
 *            before:(number|null)[], after:(number|null)[]}[]}
 */
export function computeDetailMatrix(closes, dates, params) {
  const { ratio, window, itmWhen } = params;
  const n = closes.length;
  const isBelow = itmWhen === "below";
  const rows = [];

  for (let i = 0; i < n; i++) {
    const close = closes[i];
    const strike = close * ratio;
    const before = [];
    for (let k = 1; k <= DETAIL_BEFORE_DAYS; k++) {
      before.push(computeMomentum(closes, i, k));
    }
    const after = [];
    for (let d = 1; d <= window; d++) {
      after.push(i + d < n ? closes[i + d] / strike - 1 : null);
    }
    const refDays = Math.min(DETAIL_ITM_REF_DAYS, n - 1 - i);
    let itmDaysRef = null;
    if (refDays > 0) {
      itmDaysRef = 0;
      for (let d = 1; d <= refDays; d++) {
        const fwd = closes[i + d] / strike - 1;
        if (isBelow ? fwd < 0 : fwd > 0) itmDaysRef++;
      }
    }
    rows.push({ date: dates[i], close, strike, itmDaysRef, before, after });
  }
  return rows;
}
