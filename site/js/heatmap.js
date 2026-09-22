// エントリー日ごとのITM状況を一覧できるカレンダー風ヒートマップ（純粋関数）。
// 元Excelの「1日×150営業日後」の巨大な表とは異なり、1エントリー日=1マスに要約して
// 表示する（判定期間内にITMが何日あったかを色の濃淡で表す）ので軽量に描画できる。

const LEVELS = [
  { max: 0, cls: "h0" },   // ITM日数0
  { max: 0.10, cls: "h1" },
  { max: 0.30, cls: "h2" },
  { max: 0.60, cls: "h3" },
  { max: Infinity, cls: "h4" },
];

/**
 * @param {{date:string|null, itmDaysInWindow:number}[]} perEntry
 * @param {number} window 判定期間(営業日)
 * @returns {string} HTML文字列
 */
export function renderEntryHeatmap(perEntry, window) {
  const cells = perEntry.map(({ date, itmDaysInWindow }) => {
    const ratio = window > 0 ? itmDaysInWindow / window : 0;
    const level = LEVELS.find((l) => ratio <= l.max) || LEVELS[LEVELS.length - 1];
    const dateLabel = date || "―";
    const title = `${dateLabel}: 判定期間${window}日中${itmDaysInWindow}日ITM`;
    return `<div class="hm-cell ${level.cls}" title="${title}"></div>`;
  }).join("");

  return `<div class="hm-grid">${cells}</div>`;
}
