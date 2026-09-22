import { OPTION_TYPES, DETAIL_BEFORE_DAYS, computeDetailMatrix } from "./calc.js";
import { initThemeBar } from "./theme.js";

const HANDOFF_KEY = "itm-detail-handoff";

const els = {
  emptyState: document.getElementById("emptyState"),
  detailWrap: document.getElementById("detailWrap"),
  detailSymbol: document.getElementById("detailSymbol"),
  detailType: document.getElementById("detailType"),
  detailRatio: document.getElementById("detailRatio"),
  detailWindow: document.getElementById("detailWindow"),
  detailRows: document.getElementById("detailRows"),
  dmTable: document.getElementById("dmTable"),
  pageTitle: document.getElementById("pageTitle"),
  pageSub: document.getElementById("pageSub"),
};

// 先読み(after)の7段階しきい値。元Excelの条件付き書式(激熱〜ピンチ)に合わせている。
// v=権利行使価格から見てOTM方向への乖離率(正=OTM/青、負=ITM/赤)。
// 0%が境界: 0%以上(OTM側)=青(L0〜L4)、0%未満(ITM側)=赤(L5〜L6)。
function classifyAfter(v) {
  if (v >= 0.40) return "L0"; // 激熱
  if (v >= 0.30) return "L1"; // 熱
  if (v >= 0.20) return "L2"; // 好機
  if (v >= 0.05) return "L3"; // 可もなく不可もなく
  if (v >= 0) return "L4";    // ひやひや
  if (v >= -0.05) return "L5"; // ITM
  return "L6";                 // ピンチ
}

// rawFwd(株価/権利行使価格-1、正=株価が権利行使価格より上)から、
// itmWhenに応じてOTM方向への乖離率(classifyAfter用)を導く。
// call(itmWhen=above): ITM=株価が上=rawFwd正 → OTM方向は負なので符号反転。
// put(itmWhen=below): ITM=株価が下=rawFwd負 → OTM方向は正のrawFwdそのまま。
function toOtmDirection(rawFwd, isBelow) {
  return isBelow ? rawFwd : -rawFwd;
}

// 前営業日比較(before)の5段階しきい値。元Excelの条件付き書式(10/0/-5/-10%)に合わせている。
function classifyBefore(v) {
  if (v === null) return "";
  if (v > 0.10) return "U1"; // 上昇 10%超
  if (v >= 0) return "Z";    // 0〜10%: ほぼ変動なし〜小幅上昇
  if (v >= -0.05) return "D0"; // 下落 -5〜0%
  if (v >= -0.10) return "D1"; // 下落 -10〜-5%
  return "D2";                 // 下落 10%超
}

function pct(v) {
  return v === null ? "―" : (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";
}

function renderTable(rows, windowDays, isBelow) {
  const headCells = ["日付"];
  for (let k = DETAIL_BEFORE_DAYS; k >= 1; k--) headCells.push(`${k}日前`);
  for (let d = 1; d <= windowDays; d++) headCells.push(`${d}日後`);
  const head = `<tr><th class="dm-sticky">${headCells[0]}</th>` +
    headCells.slice(1).map((h) => `<th>${h}</th>`).join("") + "</tr>";

  const bodyRows = rows.map((row) => {
    const beforeOrdered = [...row.before].reverse(); // 7日前→1日前の順で表示
    const beforeCells = beforeOrdered.map((v) => {
      const cls = classifyBefore(v);
      return `<td class="dc ${cls}" title="${row.date}: ${pct(v)}"></td>`;
    }).join("");
    const afterCells = row.after.map((rawFwd, idx) => {
      const cls = classifyAfter(toOtmDirection(rawFwd, isBelow));
      return `<td class="dc ${cls}" title="${row.date} ${idx + 1}日後: 権利行使価格比 ${pct(rawFwd)}"></td>`;
    }).join("");
    return `<tr><td class="dm-sticky dm-date">${row.date}</td>${beforeCells}${afterCells}</tr>`;
  }).join("");

  return `<thead>${head}</thead><tbody>${bodyRows}</tbody>`;
}

function init() {
  initThemeBar("theme-bar");

  let handoff;
  try {
    handoff = JSON.parse(sessionStorage.getItem(HANDOFF_KEY) || "null");
  } catch (e) {
    handoff = null;
  }

  if (!handoff || !Array.isArray(handoff.closes) || !Array.isArray(handoff.dates)) {
    els.emptyState.hidden = false;
    return;
  }

  const type = OPTION_TYPES[handoff.typeKey] || OPTION_TYPES.put_sell;
  const windowDays = handoff.windowDays;
  const isBelow = type.itmWhen === "below";
  const rows = computeDetailMatrix(handoff.closes, handoff.dates, {
    ratio: handoff.ratio,
    window: windowDays,
  });

  els.pageTitle.textContent = `${handoff.symbol} の詳細マトリクス`;
  els.pageSub.textContent = `${type.label}・権利行使価格の比率${handoff.ratio}・判定期間${windowDays}営業日での、エントリー日ごとの値動き一覧です。`;
  els.detailSymbol.textContent = handoff.symbol;
  els.detailType.textContent = type.label;
  els.detailRatio.textContent = handoff.ratio;
  els.detailWindow.textContent = `${windowDays}営業日`;
  els.detailRows.textContent = rows.length.toLocaleString("ja-JP");

  els.dmTable.innerHTML = renderTable(rows, windowDays, isBelow);
  els.detailWrap.hidden = false;
}

init();
