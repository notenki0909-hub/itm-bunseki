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

/**
 * @param {{date:string|null, itmDaysInWindow:number}[]} perEntry
 * @param {number} window 判定期間(営業日)
 * @param {'sell'|'buy'} group 色の基準を売り/買いで切り替えるために使う
 * @returns {string} HTML文字列
 */
export function renderEntryHeatmap(perEntry, window, group) {
  const cells = perEntry.map(({ date, itmDaysInWindow }) => {
    const dateLabel = date || "―";
    const title = `${dateLabel}: 判定期間${window}日中${itmDaysInWindow}日ITM`;
    return `<div class="hm-cell" style="background:${cellColor(itmDaysInWindow, group)}" title="${title}"></div>`;
  }).join("");

  return `<div class="hm-grid">${cells}</div>`;
}
