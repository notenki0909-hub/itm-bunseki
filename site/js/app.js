import {
  OPTION_TYPES, WINDOW_OPTIONS, DEFAULT_WINDOW,
  PERIOD_OPTIONS, DEFAULT_PERIOD_DAYS,
  MOMENTUM_LOOKBACK_OPTIONS, DEFAULT_MOMENTUM_LOOKBACK,
  computeItmAnalysis, computeConditionalItmAnalysis,
  computeRecentMomentumStrip, computeMomentum, typeGroup,
} from "./calc.js";
import { renderDayProbChart } from "./chart.js";
import { renderEntryHeatmap } from "./heatmap.js";

// 複数銘柄・複数タイプを切り替えながら見比べられるよう「タブ」単位で状態を持つ。
// タブの切り替えは常にメモリ上のデータを出し直すだけで、APIへの再アクセスは発生しない。
// 実アクセスが起きるのは「分析する」ボタンを押した瞬間だけ、という原則はタブ導入後も変わらない。

let nextTabId = 1;
const tabs = [];
let activeTabId = null;

// 同一ブラウザ内でのタブ間重複フェッチを防ぐための銘柄→データのメモリキャッシュ。
// (サーバー側のKVキャッシュとは別レイヤー。こちらは「同じ人が複数タブで同じ銘柄を見る」場合、
//  自サーバーへのリクエストすら発生させないためのもの。ページ再読み込みで消える一時キャッシュ)
const priceCache = new Map();

const els = {
  tabBar: document.getElementById("tabBar"),
  ticker: document.getElementById("ticker"),
  analyzeBtn: document.getElementById("analyzeBtn"),
  typeSelect: document.getElementById("typeSelect"),
  ratioInput: document.getElementById("ratioInput"),
  windowSelect: document.getElementById("windowSelect"),
  periodSelect: document.getElementById("periodSelect"),
  status: document.getElementById("status"),

  todayCard: document.getElementById("todayCard"),
  todayDate: document.getElementById("todayDate"),
  todayClose: document.getElementById("todayClose"),
  todayStrike: document.getElementById("todayStrike"),
  momentumStrip: document.getElementById("momentumStrip"),

  result: document.getElementById("result"),
  badge: document.getElementById("badge"),
  entryCount: document.getElementById("entryCount"),
  itmCount: document.getElementById("itmCount"),
  overallProb: document.getElementById("overallProb"),
  chartWrap: document.getElementById("chartWrap"),
  heatmapWrap: document.getElementById("heatmapWrap"),
  symbolLabel: document.getElementById("symbolLabel"),

  conditionCard: document.getElementById("conditionCard"),
  momentumLookbackSelect: document.getElementById("momentumLookbackSelect"),
  momentumDirectionSelect: document.getElementById("momentumDirectionSelect"),
  momentumThresholdInput: document.getElementById("momentumThresholdInput"),
  matchedCount: document.getElementById("matchedCount"),
  matchedProb: document.getElementById("matchedProb"),
  baselineProb: document.getElementById("baselineProb"),
  todayMatchBadge: document.getElementById("todayMatchBadge"),
};

function activeTab() {
  return tabs.find((t) => t.id === activeTabId) || null;
}

function newTabState() {
  return {
    id: nextTabId++,
    symbol: null,
    closesFull: null, // フェッチした生データ(最大件数)。期間セレクターはこれをローカルでスライスするだけ
    datesFull: null,  // closesFullと同じ並びの日付文字列
    typeKey: "put_sell",
    ratio: OPTION_TYPES.put_sell.ratio,
    windowDays: DEFAULT_WINDOW,
    periodDays: DEFAULT_PERIOD_DAYS,
    momentumLookback: DEFAULT_MOMENTUM_LOOKBACK,
    momentumDirection: "down",
    momentumThresholdPct: 5,
  };
}

function createTab() {
  const t = newTabState();
  tabs.push(t);
  switchTab(t.id);
}

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  tabs.splice(idx, 1);
  if (tabs.length === 0) {
    createTab();
    return;
  }
  if (activeTabId === id) {
    const next = tabs[Math.max(0, idx - 1)];
    switchTab(next.id);
  } else {
    renderTabBar();
  }
}

function switchTab(id) {
  activeTabId = id;
  const t = activeTab();
  if (!t) return;

  els.ticker.value = t.symbol || "";
  els.typeSelect.value = t.typeKey;
  els.ratioInput.value = t.ratio;
  els.windowSelect.value = String(t.windowDays);
  els.periodSelect.value = String(t.periodDays);
  els.momentumLookbackSelect.value = String(t.momentumLookback);
  els.momentumDirectionSelect.value = t.momentumDirection;
  els.momentumThresholdInput.value = t.momentumThresholdPct;
  setStatus("");

  if (t.closesFull) {
    renderAll(t);
  } else {
    els.todayCard.hidden = true;
    els.result.hidden = true;
    els.conditionCard.hidden = true;
  }
  renderTabBar();
}

function tabLabel(t) {
  if (!t.symbol) return "新規タブ";
  return `${t.symbol}・${OPTION_TYPES[t.typeKey].label}`;
}

function renderTabBar() {
  els.tabBar.innerHTML = "";
  for (const t of tabs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tab" + (t.id === activeTabId ? " active" : "");
    btn.textContent = tabLabel(t);
    btn.addEventListener("click", () => switchTab(t.id));

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "tab-close";
    closeBtn.textContent = "×";
    closeBtn.title = "タブを閉じる";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(t.id);
    });
    btn.appendChild(closeBtn);

    els.tabBar.appendChild(btn);
  }

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "tab-add";
  addBtn.textContent = "＋ 新規タブ";
  addBtn.addEventListener("click", createTab);
  els.tabBar.appendChild(addBtn);
}

function initTypeOptions() {
  els.typeSelect.innerHTML = Object.entries(OPTION_TYPES)
    .map(([key, t]) => `<option value="${key}">${t.label}</option>`)
    .join("");
}

function initWindowOptions() {
  els.windowSelect.innerHTML = WINDOW_OPTIONS
    .map((d) => `<option value="${d}" ${d === DEFAULT_WINDOW ? "selected" : ""}>${d}営業日</option>`)
    .join("");
}

function initPeriodOptions() {
  els.periodSelect.innerHTML = PERIOD_OPTIONS
    .map((p) => `<option value="${p.days}" ${p.days === DEFAULT_PERIOD_DAYS ? "selected" : ""}>${p.label}</option>`)
    .join("");
}

function initMomentumLookbackOptions() {
  els.momentumLookbackSelect.innerHTML = MOMENTUM_LOOKBACK_OPTIONS
    .map((d) => `<option value="${d}" ${d === DEFAULT_MOMENTUM_LOOKBACK ? "selected" : ""}>${d}営業日前と比較</option>`)
    .join("");
}

function setStatus(msg, isError) {
  els.status.textContent = msg || "";
  els.status.classList.toggle("err", !!isError);
}

async function fetchHistory(symbol) {
  // 同一ブラウザ内で既に取得済みならAPIを叩かず使い回す(タブをまたいでも共有)
  if (priceCache.has(symbol)) return priceCache.get(symbol);
  const res = await fetch(`/api/history?symbol=${encodeURIComponent(symbol)}`);
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  priceCache.set(symbol, data);
  return data;
}

async function onAnalyze() {
  const t = activeTab();
  if (!t) return;
  const symbol = els.ticker.value.trim().toUpperCase();
  if (!symbol) {
    setStatus("ティッカーを入力してください", true);
    return;
  }
  els.analyzeBtn.disabled = true;
  setStatus("取得中…");
  els.todayCard.hidden = true;
  els.result.hidden = true;
  els.conditionCard.hidden = true;
  try {
    const data = await fetchHistory(symbol);
    t.symbol = data.symbol;
    t.closesFull = data.closes;
    t.datesFull = data.dates;
    setStatus(`${data.symbol} の${data.closes.length}日分の終値を取得しました`);
    renderAll(t);
    renderTabBar();
  } catch (e) {
    setStatus(`取得に失敗しました: ${e.message}`, true);
  } finally {
    els.analyzeBtn.disabled = false;
  }
}

function onFormChange() {
  const t = activeTab();
  if (!t) return;
  t.typeKey = els.typeSelect.value;
  t.ratio = Number(els.ratioInput.value) || OPTION_TYPES[t.typeKey].ratio;
  t.windowDays = Number(els.windowSelect.value) || DEFAULT_WINDOW;
  t.periodDays = Number(els.periodSelect.value) || DEFAULT_PERIOD_DAYS;
  t.momentumLookback = Number(els.momentumLookbackSelect.value) || DEFAULT_MOMENTUM_LOOKBACK;
  t.momentumDirection = els.momentumDirectionSelect.value;
  t.momentumThresholdPct = Number(els.momentumThresholdInput.value) || 0;
  if (t.closesFull) renderAll(t);
  renderTabBar();
}

// 集計期間で末尾N件にスライスした配列を返す(ローカル計算のみ。APIは叩かない)
function periodClosesOf(t) {
  return t.closesFull.slice(-t.periodDays);
}
function periodDatesOf(t) {
  return t.datesFull.slice(-t.periodDays);
}

function renderAll(t) {
  renderTodayCard(t);
  renderMainAnalysis(t);
  renderConditionCard(t);
}

function renderTodayCard(t) {
  const closes = periodClosesOf(t);
  const latestIdx = closes.length - 1;
  const latestClose = closes[latestIdx];
  const strike = latestClose * t.ratio;

  els.todayDate.textContent = `最新${closes.length}日分中`;
  els.todayClose.textContent = latestClose.toFixed(2);
  els.todayStrike.textContent = strike.toFixed(2);

  const strip = computeRecentMomentumStrip(closes, 7);
  els.momentumStrip.innerHTML = strip.map(({ daysAgo, change }) => {
    const cls = change === null ? "" : change >= 0 ? "up" : "down";
    const text = change === null ? "―" : (change >= 0 ? "+" : "") + (change * 100).toFixed(1) + "%";
    return `<div class="momentum-cell"><span class="m-label">${daysAgo}営業日前比</span><span class="m-value ${cls}">${text}</span></div>`;
  }).join("");

  els.todayCard.hidden = false;
}

function renderMainAnalysis(t) {
  const closes = periodClosesOf(t);
  const dates = periodDatesOf(t);
  const type = OPTION_TYPES[t.typeKey];
  const analysis = computeItmAnalysis(closes, {
    ratio: t.ratio,
    itmWhen: type.itmWhen,
    window: t.windowDays,
    group: typeGroup(t.typeKey),
  }, dates);

  els.symbolLabel.textContent = t.symbol;
  els.badge.textContent = analysis.badge;
  els.badge.className = "badge " + badgeLevelClass(analysis.badgeLevel);
  els.entryCount.textContent = analysis.entryCount.toLocaleString("ja-JP");
  els.itmCount.textContent = analysis.itmEntryCount.toLocaleString("ja-JP");
  els.overallProb.textContent = analysis.overallItmProb === null
    ? "―"
    : (analysis.overallItmProb * 100).toFixed(1) + "%";
  els.chartWrap.innerHTML = renderDayProbChart(analysis.dayProb);
  els.heatmapWrap.innerHTML = renderEntryHeatmap(analysis.perEntry, t.windowDays);
  els.result.hidden = false;
}

function renderConditionCard(t) {
  const closes = periodClosesOf(t);
  const type = OPTION_TYPES[t.typeKey];

  const baseline = computeItmAnalysis(closes, {
    ratio: t.ratio,
    itmWhen: type.itmWhen,
    window: t.windowDays,
    group: typeGroup(t.typeKey),
  });
  const conditional = computeConditionalItmAnalysis(closes, {
    ratio: t.ratio,
    itmWhen: type.itmWhen,
    window: t.windowDays,
    momentumLookback: t.momentumLookback,
    momentumDirection: t.momentumDirection,
    momentumThresholdPct: t.momentumThresholdPct,
  });

  els.matchedCount.textContent = conditional.matchedCount.toLocaleString("ja-JP");
  els.matchedProb.textContent = conditional.matchedItmProb === null
    ? "―"
    : (conditional.matchedItmProb * 100).toFixed(1) + "%";
  els.baselineProb.textContent = baseline.overallItmProb === null
    ? "―"
    : (baseline.overallItmProb * 100).toFixed(1) + "%";

  const todayMomentum = computeMomentum(closes, closes.length - 1, t.momentumLookback);
  const thresholdFrac = t.momentumThresholdPct / 100;
  const todayMatches = todayMomentum === null ? null
    : t.momentumDirection === "down" ? todayMomentum <= -thresholdFrac : todayMomentum >= thresholdFrac;

  els.todayMatchBadge.textContent = todayMatches === null ? "データ不足" : todayMatches ? "該当する" : "該当しない";
  els.todayMatchBadge.className = "badge " + (todayMatches ? "b-good" : "b-neutral");

  els.conditionCard.hidden = false;
}

// badgeLevel(0=最も有利〜6=最も不利)をヒートマップ同様の色クラスに変換する
function badgeLevelClass(level) {
  return level === null || level === undefined ? "b-neutral" : `b${level}`;
}

// 各.stat項目をクリックすると、対応するセクションの直前(data-target先)に説明を表示する。
// 同じ項目をもう一度クリックすると閉じる(トグル)。
function setupStatExplain() {
  document.querySelectorAll(".stat[data-target]").forEach((statEl) => {
    statEl.addEventListener("click", () => {
      const targetId = statEl.dataset.target;
      const box = document.getElementById(targetId);
      if (!box) return;
      const alreadyActive = statEl.classList.contains("active");
      // 同じセクション(同じdata-target)内の他の項目のactive状態だけを解除する
      document.querySelectorAll(`.stat[data-target="${targetId}"].active`)
        .forEach((el) => el.classList.remove("active"));
      if (alreadyActive) {
        box.hidden = true;
        box.textContent = "";
      } else {
        box.textContent = statEl.dataset.note;
        box.hidden = false;
        statEl.classList.add("active");
      }
    });
  });
}

function init() {
  initTypeOptions();
  initWindowOptions();
  initPeriodOptions();
  initMomentumLookbackOptions();
  setupStatExplain();
  createTab();

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
  els.momentumLookbackSelect.addEventListener("change", onFormChange);
  els.momentumDirectionSelect.addEventListener("change", onFormChange);
  els.momentumThresholdInput.addEventListener("input", debounce(onFormChange, 250));
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

init();
