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
  afterLegend: document.getElementById("afterLegend"),
  pageTitle: document.getElementById("pageTitle"),
  pageSub: document.getElementById("pageSub"),
};

// 先読み(after)の7段階しきい値。元Excelの条件付き書式をタイプ(プット売/コール売/
// コール買/プット買)ごとにそのまま再現している(しきい値・色ともに元シートの
// 条件付き書式ルールを解析して抽出したもの。4タイプで数値が異なる非対称な設計)。
// rawFwd = 株価/権利行使価格-1 (正=株価が権利行使価格より上)。
// L0=最も有利(赤)…L6=最も不利(紫)の7段階。L3は塗りなし(可もなく不可もなく/ITM境界)。
const AFTER_BANDS = {
  // 有利な方向=株価上昇。しきい値が大きい方から順にL0〜L5、それ未満はL6。
  put_sell: { mode: "gte", steps: [[0.40, "L0"], [0.30, "L1"], [0.20, "L2"], [0.05, "L3"], [0, "L4"], [-0.05, "L5"]] },
  call_buy: { mode: "gte", steps: [[0.30, "L0"], [0.20, "L1"], [0.10, "L2"], [0, "L3"], [-0.10, "L4"], [-0.20, "L5"]] },
  // 有利な方向=株価下落。しきい値が小さい(マイナスに大きい)方から順にL0〜L5、それ超はL6。
  call_sell: { mode: "lte", steps: [[-0.30, "L0"], [-0.20, "L1"], [-0.10, "L2"], [-0.05, "L3"], [0, "L4"], [0.05, "L5"]] },
  put_buy: { mode: "lte", steps: [[-0.30, "L0"], [-0.20, "L1"], [-0.10, "L2"], [0, "L3"], [0.10, "L4"], [0.20, "L5"]] },
};

function classifyAfter(rawFwd, typeKey) {
  const band = AFTER_BANDS[typeKey] || AFTER_BANDS.put_sell;
  for (const [t, cls] of band.steps) {
    if (band.mode === "gte" ? rawFwd >= t : rawFwd <= t) return cls;
  }
  return "L6";
}

// L0〜L6に対応する凡例表示用の名称・しきい値レンジ(権利行使価格比)。
// 名称・レンジともに元Excelの表記に合わせている。
const AFTER_LABELS = {
  sell: ["激熱", "熱", "好機", "可もなく不可もなく", "ひやひや", "ITM", "ピンチ"],
  buy: ["大勝ち", "かなり勝ち", "勝ち", "ITM", "OTM", "ピンチ", "大ピンチ"],
};
const AFTER_RANGES = {
  put_sell: ["+40%以上", "+30〜40%", "+20〜30%", "+5〜20%", "0〜5%", "-5〜0%", "-5%未満"],
  call_buy: ["+30%以上", "+20〜30%", "+10〜20%", "0〜10%", "-10〜0%", "-20〜-10%", "-20%未満"],
  call_sell: ["-30%以下", "-30〜-20%", "-20〜-10%", "-10〜-5%", "-5〜0%", "0〜5%", "+5%超"],
  put_buy: ["-30%以下", "-30〜-20%", "-20〜-10%", "-10〜0%", "0〜10%", "10〜20%", "+20%超"],
};
const AFTER_GROUP = {
  put_sell: "sell", call_sell: "sell", call_buy: "buy", put_buy: "buy",
};

function renderAfterLegend(typeKey) {
  const labels = AFTER_LABELS[AFTER_GROUP[typeKey]] || AFTER_LABELS.sell;
  const ranges = AFTER_RANGES[typeKey] || AFTER_RANGES.put_sell;
  const items = labels.map((label, i) => {
    return `<span class="dm-litem"><span class="dc L${i}"></span>${label}（${ranges[i]}）</span>`;
  }).join("");
  return `<span class="dm-lgroup-title">先読み（権利行使価格比・左が有利／右が不利）</span>${items}`;
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

function renderTable(rows, windowDays, typeKey) {
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
      const cls = classifyAfter(rawFwd, typeKey);
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

  const typeKey = OPTION_TYPES[handoff.typeKey] ? handoff.typeKey : "put_sell";
  const type = OPTION_TYPES[typeKey];
  const windowDays = handoff.windowDays;
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

  els.dmTable.innerHTML = renderTable(rows, windowDays, typeKey);
  els.afterLegend.innerHTML = renderAfterLegend(typeKey);
  els.detailWrap.hidden = false;
}

init();
