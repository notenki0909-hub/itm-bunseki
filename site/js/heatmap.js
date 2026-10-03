// エントリー日ごとのITM状況を一覧できるカレンダー風ヒートマップ（純粋関数）。
// 元Excelの「1日×150営業日後」の巨大な表とは異なり、1エントリー日=1マスに要約して
// 表示する（判定期間内にITMが何日あったかを色の濃淡で表す）ので軽量に描画できる。

// 色は判定期間内のITM日数(絶対値)を表す。売り/買いでしきい値・色が異なる
// (売りはITMが少ないほど良いので寒色系中心、買いはITMが多いほど良いので
// 暖色系中心、というように基準そのものを分けている)。
const LIGHT_GRAY = "color-mix(in srgb, var(--muted) 25%, var(--card))";
const LIGHT_YELLOW = "color-mix(in srgb, var(--gradYellow) 55%, var(--card))";
const PALE_LIGHT_BLUE = "color-mix(in srgb, var(--gradLightBlue) 45%, var(--card))";

export const ENTRY_HEATMAP_BANDS = {
  sell: [
    { max: 0, label: "0日", color: LIGHT_GRAY },
    { max: 3, label: "1〜3日", color: PALE_LIGHT_BLUE },
    { max: 5, label: "4〜5日", color: "var(--gradLightBlue)" },
    { max: 7, label: "6〜7日", color: "var(--gradBlue)" },
    { max: Infinity, label: "8日以上", color: "var(--gradPurple)" },
  ],
  buy: [
    { max: 0, label: "0日", color: "var(--gradLightBlue)" },
    { max: 1, label: "1日", color: PALE_LIGHT_BLUE },
    { max: 4, label: "2〜4日", color: LIGHT_GRAY },
    { max: 9, label: "5〜9日", color: LIGHT_YELLOW },
    { max: 14, label: "10〜14日", color: "var(--gradOrange)" },
    { max: Infinity, label: "15日以上", color: "var(--gradRed)" },
  ],
};

function cellColor(itmDaysInWindow, group) {
  const bands = ENTRY_HEATMAP_BANDS[group] || ENTRY_HEATMAP_BANDS.sell;
  const band = bands.find((b) => itmDaysInWindow <= b.max);
  return band ? band.color : bands[bands.length - 1].color;
}

function monthLabel(yearMonth) {
  const [y, m] = yearMonth.split("-");
  return `${y}年${Number(m)}月`;
}

// 日付(YYYY-MM-DD)の年月が変わるたびに新しいグループを開始する。
// perEntryは時系列順のため、同じ年月のエントリーは常に連続している。
function groupByMonth(perEntry) {
  const groups = [];
  let current = null;
  for (const entry of perEntry) {
    const yearMonth = entry.date ? entry.date.slice(0, 7) : null;
    if (!current || current.yearMonth !== yearMonth) {
      current = { yearMonth, entries: [] };
      groups.push(current);
    }
    current.entries.push(entry);
  }
  return groups;
}

/**
 * @param {{date:string|null, itmDaysInWindow:number}[]} perEntry
 * @param {number} window 判定期間(営業日)
 * @param {'sell'|'buy'} group 色の基準を売り/買いで切り替えるために使う
 * @returns {string} HTML文字列
 */
export function renderEntryHeatmap(perEntry, window, group, depthLabel = "") {
  const months = groupByMonth(perEntry);

  const blocks = months.map(({ yearMonth, entries }) => {
    const cells = entries.map(({ date, itmDaysInWindow }) => {
      const dateLabel = date || "―";
      const title = `${dateLabel}: 判定期間${window}日中${itmDaysInWindow}日ITM${depthLabel}`;
      return `<div class="hm-cell" style="background:${cellColor(itmDaysInWindow, group)}" title="${title}"></div>`;
    }).join("");
    const label = yearMonth ? monthLabel(yearMonth) : "―";
    // 1ヶ月の最大営業日数は23日程度なので、5×5(25マス)の正方形に収まる。
    return `<div class="hm-month"><div class="hm-month-label">${label}</div><div class="hm-grid hm-grid-5x5">${cells}</div></div>`;
  }).join("");

  return `<div class="hm-months">${blocks}</div>`;
}

// 最大ITM深さ・最大OTM深さのそれぞれについて、最大になった日と「エントリーから何営業日後か」を、
// マウスオーバー用の文章にする(どちらが先に起きたかを見るため。両方のヒートマップで同じ文章を出す)。
function extremesText(entry, todayStrike) {
  const dollar = (pct) => (pct * todayStrike).toFixed(2);
  const part = (label, pct, day, date) => (pct > 0 && day > 0
    ? `${label} ${(pct * 100).toFixed(1)}%（約${dollar(pct)}ドル。${date || "―"}、エントリーから${day}営業日後）`
    : `${label}なし`);
  return `${part("最大ITM深さ", entry.maxDepthPct, entry.maxDepthDay, entry.maxDepthDate)}／${part("最大OTM深さ", entry.maxOtmPct, entry.maxOtmDay, entry.maxOtmDate)}`;
}

// ---- エントリー日ごとの「最大ITM深さ」ヒートマップ ----
// 判定期間内の終値が、権利行使価格から最も深く入った割合(%)を色で表す。日数ではなく深さを見るので、
// 「一瞬だけ深く入った日」と「浅いまま長く続いた日」を区別できる。売りは深いほど不利(寒色→紫)、
// 買いは深いほど有利(寒色/灰→黄→橙→赤)。段階はユーザー指定: 0%, 〜3%, 3〜5%, 5〜8%, 8〜10%, 10〜15%, 15%超。
const DARK_PURPLE = "color-mix(in srgb, var(--gradPurple) 60%, #000)";
const DARK_RED = "color-mix(in srgb, var(--gradRed) 65%, #000)";
const MID_BLUE_PURPLE = "color-mix(in srgb, var(--gradBlue) 50%, var(--gradPurple))";

export const DEPTH_HEATMAP_BANDS = {
  sell: [
    { max: 0, label: "0%（ITMなし）", color: LIGHT_GRAY },
    { max: 0.03, label: "〜3%", color: PALE_LIGHT_BLUE },
    { max: 0.05, label: "3〜5%", color: "var(--gradLightBlue)" },
    { max: 0.08, label: "5〜8%", color: "var(--gradBlue)" },
    { max: 0.10, label: "8〜10%", color: MID_BLUE_PURPLE },
    { max: 0.15, label: "10〜15%", color: "var(--gradPurple)" },
    { max: Infinity, label: "15%超", color: DARK_PURPLE },
  ],
  buy: [
    { max: 0, label: "0%（ITMなし）", color: "var(--gradLightBlue)" },
    { max: 0.03, label: "〜3%", color: LIGHT_GRAY },
    { max: 0.05, label: "3〜5%", color: LIGHT_YELLOW },
    { max: 0.08, label: "5〜8%", color: "var(--gradYellow)" },
    { max: 0.10, label: "8〜10%", color: "var(--gradOrange)" },
    { max: 0.15, label: "10〜15%", color: "var(--gradRed)" },
    { max: Infinity, label: "15%超", color: DARK_RED },
  ],
};

function depthColor(depthPct, group) {
  const bands = DEPTH_HEATMAP_BANDS[group] || DEPTH_HEATMAP_BANDS.sell;
  const band = bands.find((b) => depthPct <= b.max);
  return band ? band.color : bands[bands.length - 1].color;
}

/**
 * @param {{date:string|null, maxDepthPct:number}[]} perEntry
 * @param {number} window 判定期間(営業日)
 * @param {'sell'|'buy'} group
 * @param {{depthPct:number, depthDollar:number, todayStrike:number}} opts
 *   depthPct/depthDollar: 「判定する深さ」(割合/ドル)。0なら印は付けない。
 *   todayStrike: 現在の権利行使価格(%をドルに換算して表示するため)
 */
export function renderDepthHeatmap(perEntry, window, group, opts) {
  const { depthPct = 0, depthDollar = 0, todayStrike = 0 } = opts || {};
  const months = groupByMonth(perEntry);
  const blocks = months.map(({ yearMonth, entries }) => {
    const cells = entries.map((entry) => {
      const { date, maxDepthPct } = entry;
      const dateLabel = date || "―";
      const marked = depthPct > 0 && maxDepthPct >= depthPct - 1e-12;
      let title = `${dateLabel}（判定期間${window}日中）: ${extremesText(entry, todayStrike)}`;
      if (marked) title += `／判定する深さ(${depthDollar}ドル)に届きました`;
      return `<div class="hm-cell${marked ? " hm-mark" : ""}" style="background:${depthColor(maxDepthPct, group)}" title="${title}"></div>`;
    }).join("");
    const label = yearMonth ? monthLabel(yearMonth) : "―";
    return `<div class="hm-month"><div class="hm-month-label">${label}</div><div class="hm-grid hm-grid-5x5">${cells}</div></div>`;
  }).join("");
  return `<div class="hm-months">${blocks}</div>`;
}

// ---- エントリー日ごとの「最大OTM深さ」ヒートマップ ----
// 最大ITM深さの逆で、判定期間内の終値が権利行使価格から最も深くOTM側に離れた割合(%)を色で表す。
// 段階は最大ITM深さと同じ(0%, 〜3%, 3〜5%, 5〜8%, 8〜10%, 10〜15%, 15%超)。
// 色の向きはユーザー指定: 売り(プット売・コール売)のOTMは暖色系、買い(コール買・プット買)のOTMは寒色系。
const ORANGE_YELLOW = "color-mix(in srgb, var(--gradYellow) 50%, var(--gradOrange))";

export const OTM_HEATMAP_BANDS = {
  sell: [
    { max: 0, label: "0%（OTMなし）", color: LIGHT_GRAY },
    { max: 0.03, label: "〜3%", color: LIGHT_YELLOW },
    { max: 0.05, label: "3〜5%", color: "var(--gradYellow)" },
    { max: 0.08, label: "5〜8%", color: ORANGE_YELLOW },
    { max: 0.10, label: "8〜10%", color: "var(--gradOrange)" },
    { max: 0.15, label: "10〜15%", color: "var(--gradRed)" },
    { max: Infinity, label: "15%超", color: DARK_RED },
  ],
  buy: [
    { max: 0, label: "0%（OTMなし）", color: LIGHT_GRAY },
    { max: 0.03, label: "〜3%", color: PALE_LIGHT_BLUE },
    { max: 0.05, label: "3〜5%", color: "var(--gradLightBlue)" },
    { max: 0.08, label: "5〜8%", color: "var(--gradBlue)" },
    { max: 0.10, label: "8〜10%", color: MID_BLUE_PURPLE },
    { max: 0.15, label: "10〜15%", color: "var(--gradPurple)" },
    { max: Infinity, label: "15%超", color: DARK_PURPLE },
  ],
};

function otmColor(otmPct, group) {
  const bands = OTM_HEATMAP_BANDS[group] || OTM_HEATMAP_BANDS.sell;
  const band = bands.find((b) => otmPct <= b.max);
  return band ? band.color : bands[bands.length - 1].color;
}

/**
 * @param {{date:string|null, maxOtmPct:number}[]} perEntry
 * @param {number} window 判定期間(営業日)
 * @param {'sell'|'buy'} group
 * @param {{todayStrike:number}} opts 現在の権利行使価格(%をドルに換算して表示するため)
 */
export function renderOtmHeatmap(perEntry, window, group, opts) {
  const { todayStrike = 0 } = opts || {};
  const months = groupByMonth(perEntry);
  const blocks = months.map(({ yearMonth, entries }) => {
    const cells = entries.map((entry) => {
      const { date, maxOtmPct } = entry;
      const dateLabel = date || "―";
      const title = `${dateLabel}（判定期間${window}日中）: ${extremesText(entry, todayStrike)}`;
      return `<div class="hm-cell" style="background:${otmColor(maxOtmPct, group)}" title="${title}"></div>`;
    }).join("");
    const label = yearMonth ? monthLabel(yearMonth) : "―";
    return `<div class="hm-month"><div class="hm-month-label">${label}</div><div class="hm-grid hm-grid-5x5">${cells}</div></div>`;
  }).join("");
  return `<div class="hm-months">${blocks}</div>`;
}
