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
export function renderEntryHeatmap(perEntry, window, group) {
  const months = groupByMonth(perEntry);

  const blocks = months.map(({ yearMonth, entries }) => {
    const cells = entries.map(({ date, itmDaysInWindow }) => {
      const dateLabel = date || "―";
      const title = `${dateLabel}: 判定期間${window}日中${itmDaysInWindow}日ITM`;
      return `<div class="hm-cell" style="background:${cellColor(itmDaysInWindow, group)}" title="${title}"></div>`;
    }).join("");
    const label = yearMonth ? monthLabel(yearMonth) : "―";
    // 1ヶ月の最大営業日数は23日程度なので、5×5(25マス)の正方形に収まる。
    return `<div class="hm-month"><div class="hm-month-label">${label}</div><div class="hm-grid hm-grid-5x5">${cells}</div></div>`;
  }).join("");

  return `<div class="hm-months">${blocks}</div>`;
}
