// エントリー日ごとのITM状況を一覧できるカレンダー風ヒートマップ（純粋関数）。
// 元Excelの「1日×150営業日後」の巨大な表とは異なり、1エントリー日=1マスに要約して
// 表示する（判定期間内にITMが何日あったかを色の濃淡で表す）ので軽量に描画できる。

// 色は判定期間内のITM日数(絶対値)をそのまま7段階で表す(タイプの有利/不利には連動しない)。
// しきい値・色は下の凡例(index.html)と一致させること。
export const ENTRY_HEATMAP_BANDS = [
  { max: 0, label: "0日", cls: "赤", color: "var(--gradRed)" },
  { max: 1, label: "1日", cls: "オレンジ", color: "var(--gradOrange)" },
  { max: 2, label: "2日", cls: "薄い黄色", color: "color-mix(in srgb, var(--gradYellow) 55%, var(--card))" },
  { max: 3, label: "3日", cls: "薄いグレー", color: "color-mix(in srgb, var(--muted) 25%, var(--card))" },
  { max: 5, label: "4〜5日", cls: "水色", color: "var(--gradLightBlue)" },
  { max: 7, label: "6〜7日", cls: "青", color: "var(--gradBlue)" },
  { max: Infinity, label: "8日以上", cls: "紫", color: "var(--gradPurple)" },
];

function cellColor(itmDaysInWindow) {
  const band = ENTRY_HEATMAP_BANDS.find((b) => itmDaysInWindow <= b.max);
  return band ? band.color : "var(--gradPurple)";
}

/**
 * @param {{date:string|null, itmDaysInWindow:number}[]} perEntry
 * @param {number} window 判定期間(営業日)
 * @returns {string} HTML文字列
 */
export function renderEntryHeatmap(perEntry, window) {
  const cells = perEntry.map(({ date, itmDaysInWindow }) => {
    const dateLabel = date || "―";
    const title = `${dateLabel}: 判定期間${window}日中${itmDaysInWindow}日ITM`;
    return `<div class="hm-cell" style="background:${cellColor(itmDaysInWindow)}" title="${title}"></div>`;
  }).join("");

  return `<div class="hm-grid">${cells}</div>`;
}
