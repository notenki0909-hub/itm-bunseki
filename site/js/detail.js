import {
  OPTION_TYPES, WINDOW_OPTIONS, DEFAULT_WINDOW,
  PERIOD_OPTIONS, DEFAULT_PERIOD_DAYS,
  DETAIL_BEFORE_DAYS, DETAIL_ITM_REF_DAYS, computeDetailMatrix,
} from "./calc.js";
import { initThemeBar } from "./theme.js";
import { addTickerToHistory, setupTickerHistoryDropdown } from "./tickerHistory.js";

const HANDOFF_KEY = "itm-detail-handoff";
// 31日後以降を初期状態で折りたたむ境界。元Excelに列数の上限はないが、判定期間を
// 最大150営業日まで許容すると列が非常に多くなるため、UI上の見やすさのために設ける。
const COLLAPSE_AFTER_DAY = 30;

// このページ単独でも銘柄を切り替えられるよう、分析ページ(app.js)と同じ
// フェッチ・キャッシュの仕組みを持つ(ページを跨いだメモリキャッシュではないが、
// サーバー側KVキャッシュのおかげで同一銘柄の再取得は軽い)。
const priceCache = new Map();

const state = {
  symbol: null,
  closesFull: null,
  datesFull: null,
  typeKey: "put_sell",
  ratio: OPTION_TYPES.put_sell.ratio,
  windowDays: DEFAULT_WINDOW,
  periodDays: DEFAULT_PERIOD_DAYS,
  expanded: false,
};

const els = {
  ticker: document.getElementById("ticker"),
  tickerHistoryDropdown: document.getElementById("tickerHistoryDropdown"),
  typeSelect: document.getElementById("typeSelect"),
  ratioInput: document.getElementById("ratioInput"),
  windowSelect: document.getElementById("windowSelect"),
  periodSelect: document.getElementById("periodSelect"),
  analyzeBtn: document.getElementById("analyzeBtn"),
  status: document.getElementById("status"),

  emptyState: document.getElementById("emptyState"),
  detailWrap: document.getElementById("detailWrap"),
  detailSymbol: document.getElementById("detailSymbol"),
  detailType: document.getElementById("detailType"),
  detailRatio: document.getElementById("detailRatio"),
  detailWindow: document.getElementById("detailWindow"),
  detailRows: document.getElementById("detailRows"),
  dmTable: document.getElementById("dmTable"),
  afterLegend: document.getElementById("afterLegend"),
  expandRow: document.getElementById("expandRow"),
  expandBtn: document.getElementById("expandBtn"),
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
  if (rawFwd === null) return "dm-nodata"; // データなし(集計期間の末尾で先の日付が無い)
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
  if (v === null) return "dm-nodata";
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
  const fixedHeads = ["日付", "終値", "権利行使価格", `ITM日数(${DETAIL_ITM_REF_DAYS}日以内)`];
  const beforeHeads = [];
  for (let k = DETAIL_BEFORE_DAYS; k >= 1; k--) beforeHeads.push({ text: `${k}日前`, extra: false });
  const afterHeads = [];
  for (let d = 1; d <= windowDays; d++) afterHeads.push({ text: `${d}日後`, extra: d > COLLAPSE_AFTER_DAY });

  const head =
    fixedHeads.map((h, idx) => `<th class="${idx === 0 ? "dm-sticky" : ""}">${h}</th>`).join("") +
    [...beforeHeads, ...afterHeads].map((h) => `<th class="${h.extra ? "dm-extra" : ""}">${h.text}</th>`).join("");

  const bodyRows = rows.map((row) => {
    const beforeOrdered = [...row.before].reverse(); // 7日前→1日前の順で表示
    const fixedCells =
      `<td class="dm-sticky dm-date">${row.date}</td>` +
      `<td class="dm-num">${row.close.toFixed(2)}</td>` +
      `<td class="dm-num">${row.strike.toFixed(2)}</td>` +
      `<td class="dm-num${row.itmDaysRef === null ? " dm-nodata" : ""}">${row.itmDaysRef === null ? "―" : row.itmDaysRef}</td>`;
    const beforeCells = beforeOrdered.map((v) => {
      const cls = classifyBefore(v);
      return `<td class="dc ${cls}" title="${row.date}: ${pct(v)}"></td>`;
    }).join("");
    const afterCells = row.after.map((rawFwd, idx) => {
      const cls = classifyAfter(rawFwd, typeKey);
      const extraCls = idx + 1 > COLLAPSE_AFTER_DAY ? " dm-extra" : "";
      return `<td class="dc ${cls}${extraCls}" title="${row.date} ${idx + 1}日後: 権利行使価格比 ${pct(rawFwd)}"></td>`;
    }).join("");
    return `<tr>${fixedCells}${beforeCells}${afterCells}</tr>`;
  }).join("");

  return `<thead><tr>${head}</tr></thead><tbody>${bodyRows}</tbody>`;
}

function updateExpandUI(windowDays) {
  if (windowDays <= COLLAPSE_AFTER_DAY) {
    els.expandRow.hidden = true;
    return;
  }
  els.expandRow.hidden = false;
  const hiddenCount = windowDays - COLLAPSE_AFTER_DAY;
  els.expandBtn.textContent = state.expanded
    ? `▲ ${COLLAPSE_AFTER_DAY + 1}日後以降を隠す`
    : `▼ ${COLLAPSE_AFTER_DAY + 1}日後以降を表示（${hiddenCount}列）`;
  els.dmTable.classList.toggle("dm-show-extra", state.expanded);
}

function setStatus(msg, isError) {
  els.status.textContent = msg || "";
  els.status.classList.toggle("err", !!isError);
}

async function fetchHistory(symbol) {
  if (priceCache.has(symbol)) return priceCache.get(symbol);
  const res = await fetch(`/api/history?symbol=${encodeURIComponent(symbol)}`);
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  priceCache.set(symbol, data);
  return data;
}

function periodClosesOf() {
  return state.closesFull.slice(-state.periodDays);
}
function periodDatesOf() {
  return state.datesFull.slice(-state.periodDays);
}

function render() {
  const type = OPTION_TYPES[state.typeKey];
  const closes = periodClosesOf();
  const dates = periodDatesOf();
  const rows = computeDetailMatrix(closes, dates, {
    ratio: state.ratio,
    window: state.windowDays,
    itmWhen: type.itmWhen,
  });

  els.pageTitle.textContent = `${state.symbol} の詳細マトリクス`;
  els.pageSub.textContent = `${type.label}・権利行使価格の比率${state.ratio}・判定期間${state.windowDays}営業日での、エントリー日ごとの値動き一覧です。`;
  els.detailSymbol.textContent = state.symbol;
  els.detailType.textContent = type.label;
  els.detailRatio.textContent = state.ratio;
  els.detailWindow.textContent = `${state.windowDays}営業日`;
  els.detailRows.textContent = rows.length.toLocaleString("ja-JP");

  els.dmTable.innerHTML = renderTable(rows, state.windowDays, state.typeKey);
  els.afterLegend.innerHTML = renderAfterLegend(state.typeKey);
  updateExpandUI(state.windowDays);

  els.emptyState.hidden = true;
  els.detailWrap.hidden = false;
  alignBackLink();
}

async function onAnalyze() {
  const symbol = els.ticker.value.trim().toUpperCase();
  if (!symbol) {
    setStatus("ティッカーを入力してください", true);
    return;
  }
  readForm();
  els.analyzeBtn.disabled = true;
  setStatus("取得中…");
  try {
    const data = await fetchHistory(symbol);
    state.symbol = data.symbol;
    state.closesFull = data.closes;
    state.datesFull = data.dates;
    setStatus(`${data.symbol} の${data.closes.length}日分の終値を取得しました`);
    addTickerToHistory(data.symbol);
    render();
  } catch (e) {
    setStatus(`取得に失敗しました: ${e.message}`, true);
  } finally {
    els.analyzeBtn.disabled = false;
  }
}

function readForm() {
  state.typeKey = els.typeSelect.value;
  state.ratio = Number(els.ratioInput.value) || OPTION_TYPES[state.typeKey].ratio;
  state.windowDays = Number(els.windowSelect.value) || DEFAULT_WINDOW;
  state.periodDays = Number(els.periodSelect.value) || DEFAULT_PERIOD_DAYS;
}

function onFormChange() {
  readForm();
  if (state.closesFull) {
    state.expanded = false;
    render();
  }
}

function initTypeOptions() {
  els.typeSelect.innerHTML = Object.entries(OPTION_TYPES)
    .map(([key, t]) => `<option value="${key}">${t.label}</option>`)
    .join("");
}
function initWindowOptions() {
  els.windowSelect.innerHTML = WINDOW_OPTIONS
    .map((d) => `<option value="${d}">${d}営業日</option>`)
    .join("");
}
function initPeriodOptions() {
  els.periodSelect.innerHTML = PERIOD_OPTIONS
    .map((p) => `<option value="${p.days}">${p.label}</option>`)
    .join("");
}

function applyStateToForm() {
  els.ticker.value = state.symbol || "";
  els.typeSelect.value = state.typeKey;
  els.ratioInput.value = state.ratio;
  els.windowSelect.value = String(state.windowDays);
  els.periodSelect.value = String(state.periodDays);
}

// 「← 分析ページへ戻る」の右端を、1段下にある「標準に戻す」の右端に揃える
// (見た目上、戻るリンクが標準に戻すの真上に来るように)。どちらの位置も
// 配色プリセットの数やラベル幅で変わり得るため、実際の描画結果を測って合わせる。
function alignBackLink() {
  const pagenav = document.querySelector(".pagenav");
  const topbar = document.querySelector(".dm-topbar");
  const resetBtn = document.querySelector("#theme-bar .tb-reset");
  if (!pagenav || !topbar || !resetBtn) return;
  pagenav.style.marginRight = "0px";
  const offset = topbar.getBoundingClientRect().right - resetBtn.getBoundingClientRect().right;
  pagenav.style.marginRight = offset > 0 ? `${offset}px` : "0px";
}

async function init() {
  initThemeBar("theme-bar");
  initTypeOptions();
  initWindowOptions();
  initPeriodOptions();
  setupTickerHistoryDropdown(els.ticker, els.tickerHistoryDropdown);

  let handoff = null;
  try {
    handoff = JSON.parse(sessionStorage.getItem(HANDOFF_KEY) || "null");
  } catch (e) {
    handoff = null;
  }
  // 分析ページからの引き継ぎは「設定(レシピ)」だけで、価格データは含まない。
  // ここで改めて取得することで、詳細マトリクス側で銘柄や集計期間を変えても
  // 常に整合したデータで再計算できるようにしている(KVキャッシュがあるので軽い)。
  sessionStorage.removeItem(HANDOFF_KEY);

  if (handoff && handoff.symbol) {
    Object.assign(state, {
      symbol: handoff.symbol,
      typeKey: handoff.typeKey || state.typeKey,
      ratio: handoff.ratio ?? state.ratio,
      windowDays: handoff.windowDays ?? state.windowDays,
      periodDays: handoff.periodDays ?? state.periodDays,
    });
    applyStateToForm();
    await onAnalyze();
  } else {
    applyStateToForm();
    els.emptyState.hidden = false;
  }
  alignBackLink();
  window.addEventListener("resize", debounce(alignBackLink, 150));
  // 配色切替でラベル("ライトに切替"/"ダークに切替")の幅が変わり、標準に戻すの
  // 位置がわずかにずれる可能性があるため、テーマバー操作後にも再計算する。
  document.getElementById("theme-bar").addEventListener("click", () => {
    setTimeout(alignBackLink, 0);
  });

  els.analyzeBtn.addEventListener("click", onAnalyze);
  els.ticker.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onAnalyze();
  });
  els.typeSelect.addEventListener("change", () => {
    els.ratioInput.value = OPTION_TYPES[els.typeSelect.value].ratio;
    onFormChange();
  });
  els.ratioInput.addEventListener("input", debounce(onFormChange, 250));
  els.windowSelect.addEventListener("change", onFormChange);
  els.periodSelect.addEventListener("change", onFormChange);
  els.expandBtn.addEventListener("click", () => {
    state.expanded = !state.expanded;
    updateExpandUI(state.windowDays);
  });
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

init();
