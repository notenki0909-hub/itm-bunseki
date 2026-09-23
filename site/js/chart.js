// 日数別ITM確率の棒グラフをSVG文字列として生成する（純粋関数）。
// 既存の「銘柄診断ツール」サイトと同じくインラインSVG方式（外部チャートライブラリ不使用）。

// 色はその日のITM率(絶対値)を表す。売り/買いでしきい値・色が異なる
// (売りはITMが少ないほど良いので寒色系中心、買いはITMが多いほど良いので
// 暖色系中心、というように基準そのものを分けている)。
const LIGHT_GRAY = "color-mix(in srgb, var(--muted) 25%, var(--card))";
const LIGHT_YELLOW = "color-mix(in srgb, var(--gradYellow) 55%, var(--card))";

export const DAY_PROB_BANDS = {
  sell: [
    { max: 0.05, label: "5%以下", color: "var(--gradLightBlue)" },
    { max: 0.10, label: "5〜10%", color: "var(--gradBlue)" },
    { max: Infinity, label: "10%超", color: "var(--gradPurple)" },
  ],
  buy: [
    { max: 0.10, label: "10%未満", color: LIGHT_GRAY },
    { max: 0.20, label: "10〜20%", color: LIGHT_YELLOW },
    { max: 0.30, label: "20〜30%", color: "var(--gradOrange)" },
    { max: Infinity, label: "30%以上", color: "var(--gradRed)" },
  ],
};

function barColor(v, group) {
  const bands = DAY_PROB_BANDS[group] || DAY_PROB_BANDS.sell;
  const band = bands.find((b) => v <= b.max);
  return band ? band.color : bands[bands.length - 1].color;
}

/**
 * @param {(number|null)[]} dayProb dayProb[d-1] = d営業日後のITM確率(0-1)
 * @param {'sell'|'buy'} group 色の基準を売り/買いで切り替えるために使う
 * @returns {string} SVG文字列
 */
export function renderDayProbChart(dayProb, group) {
  const w = 640;
  const barGap = 2;
  const leftPad = 34;
  const rightPad = 8;
  const topPad = 10;
  const bottomPad = 22;
  const chartH = 160;
  const h = topPad + chartH + bottomPad;
  const n = dayProb.length;
  const barW = n > 0 ? (w - leftPad - rightPad) / n - barGap : 0;

  let bars = "";
  let labels = "";
  const labelStep = Math.max(1, Math.ceil(n / 15));

  for (let i = 0; i < n; i++) {
    const v = dayProb[i];
    const x = leftPad + i * (barW + barGap);
    const barH = v === null ? 0 : Math.max(0, v) * chartH;
    const y = topPad + (chartH - barH);
    const color = v === null ? "var(--line)" : barColor(v, group);
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" fill="${color}"><title>${i + 1}営業日後: ${v === null ? "データ不足" : (v * 100).toFixed(1) + "%"}</title></rect>`;
    if ((i + 1) % labelStep === 0 || i === 0 || i === n - 1) {
      labels += `<text x="${(x + barW / 2).toFixed(1)}" y="${h - 6}" font-size="9" text-anchor="middle" fill="var(--muted)">${i + 1}</text>`;
    }
  }

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const y = topPad + chartH * (1 - f);
    return `<line x1="${leftPad}" y1="${y.toFixed(1)}" x2="${w - rightPad}" y2="${y.toFixed(1)}" stroke="var(--line)" stroke-width="1"/>` +
      `<text x="${leftPad - 6}" y="${(y + 3).toFixed(1)}" font-size="9" text-anchor="end" fill="var(--muted)">${Math.round(f * 100)}%</text>`;
  }).join("");

  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="過去の営業日ごとのITM確率">` +
    gridLines + bars + labels +
    `</svg>`;
}
