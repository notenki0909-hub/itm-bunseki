// エントリー日ごとのITM状況を一覧できるカレンダー風ヒートマップ（純粋関数）。
// 元Excelの「1日×150営業日後」の巨大な表とは異なり、1エントリー日=1マスに要約して
// 表示する（判定期間内にITMが何日あったかを色の濃淡で表す）ので軽量に描画できる。

import { toFavorableProb, favorableProbToLevel } from "./calc.js";

/**
 * @param {{date:string|null, itmDaysInWindow:number}[]} perEntry
 * @param {number} window 判定期間(営業日)
 * @param {'sell'|'buy'} group 色をそのタイプにとって有利な方向(赤)に揃えるために使う
 * @returns {string} HTML文字列
 */
export function renderEntryHeatmap(perEntry, window, group) {
  const cells = perEntry.map(({ date, itmDaysInWindow }) => {
    const ratio = window > 0 ? itmDaysInWindow / window : 0;
    const level = favorableProbToLevel(toFavorableProb(ratio, group));
    const dateLabel = date || "―";
    const title = `${dateLabel}: 判定期間${window}日中${itmDaysInWindow}日ITM`;
    return `<div class="hm-cell L${level}" title="${title}"></div>`;
  }).join("");

  return `<div class="hm-grid">${cells}</div>`;
}
