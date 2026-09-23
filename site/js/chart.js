// 日数別ITM確率の棒グラフをSVG文字列として生成する（純粋関数）。
// 既存の「銘柄診断ツール」サイトと同じくインラインSVG方式（外部チャートライブラリ不使用）。

// 色はその日のITM率(絶対値)をそのまま6段階で表す(タイプの有利/不利には連動しない)。
// しきい値・色は下の凡例(index.html)と一致させること。
export const DAY_PROB_BANDS = [
  { max: 0.05, label: "5%以下", cls: "水色", color: "var(--gradLightBlue)" },
  { max: 0.10, label: "5〜10%", cls: "青", color: "var(--gradBlue)" },
  { max: 0.15, label: "10〜15%", cls: "紫", color: "var(--gradPurple)" },
  { max: 0.35, label: "15〜35%", cls: "黄", color: "var(--gradYellow)" },
  { max: 0.60, label: "35〜60%", cls: "オレンジ", color: "var(--gradOrange)" },
  { max: Infinity, label: "60%超", cls: "赤", color: "var(--gradRed)" },
];

function barColor(v) {
  const band = DAY_PROB_BANDS.find((b) => v <= b.max);
  return band ? band.color : "var(--gradRed)";
}

/**
 * @param {(number|null)[]} dayProb dayProb[d-1] = d営業日後のITM確率(0-1)
 * @returns {string} SVG文字列
 */
export function renderDayProbChart(dayProb) {
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
    const color = v === null ? "var(--line)" : barColor(v);
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
