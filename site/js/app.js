import {
  OPTION_TYPES, WINDOW_OPTIONS, DEFAULT_WINDOW,
  PERIOD_OPTIONS, DEFAULT_PERIOD_DAYS,
  MOMENTUM_LOOKBACK_OPTIONS, DEFAULT_MOMENTUM_LOOKBACK,
  computeItmAnalysis, computeConditionalItmAnalysis,
  computeRecentMomentumStrip, computeMomentum, typeGroup, BADGE_LABELS,
  RISK_VARIANT_LABELS, isInfiniteLossVariant,
  baseEntryIndices, computeDepthEntryResults, summarizeDepthResults,
  breakEvenMaxLoss, breakEvenMinGain, sampleWarningLevel, expectedProfitOnClose,
  breakEvenWinRateFromLoss,
  VOLATILITY_PERIODS, computeVolatilityStats, computeRecentVolatilityAmount,
} from "./calc.js";
import { renderDayProbChart, DAY_PROB_BANDS } from "./chart.js";
import { renderEntryHeatmap, ENTRY_HEATMAP_BANDS } from "./heatmap.js";
import { initThemeBar } from "./theme.js";
import { addTickerToHistory, setupTickerHistoryDropdown, loadTickerHistory, mergeTickerHistory } from "./tickerHistory.js";

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

// 同一端末での永続化(localStorage)。ページ遷移・リロード・ブラウザ再起動をまたいで
// タブの状態(取得済みデータ込み)を復元できるようにする。
const STORAGE_KEY = "itm-tool-state-v1";

// 端末をまたいだ共有用。タブの「設定」だけ(取得済みデータは含めない)をURLに載せる。
// URLが長くなりすぎるのを避けるため、価格データは含めず、開いた側で再取得させる設計。
function tabRecipe(t) {
  return {
    symbol: t.symbol,
    typeKey: t.typeKey,
    ratio: t.ratio,
    windowDays: t.windowDays,
    periodDays: t.periodDays,
    conditionMode: t.conditionMode,
    momentumLookback: t.momentumLookback,
    minMatchDays: t.minMatchDays,
    momentumDirection: t.momentumDirection,
    momentumThresholdPct: t.momentumThresholdPct,
    rrVariant: t.rrVariant,
    rrDepth: t.rrDepth,
    rrPremium: t.rrPremium,
    rrPayPremium: t.rrPayPremium,
    rrProfitRatio: t.rrProfitRatio,
    rrCutLoss: t.rrCutLoss,
    rrExpectedGain: t.rrExpectedGain,
    rrSpreadWidth: t.rrSpreadWidth,
  };
}

function applyRecipe(t, rec) {
  Object.assign(t, {
    symbol: rec.symbol ?? t.symbol,
    typeKey: rec.typeKey || t.typeKey,
    ratio: rec.ratio ?? t.ratio,
    windowDays: rec.windowDays ?? t.windowDays,
    periodDays: rec.periodDays ?? t.periodDays,
    conditionMode: rec.conditionMode || t.conditionMode,
    momentumLookback: rec.momentumLookback ?? t.momentumLookback,
    minMatchDays: rec.minMatchDays ?? t.minMatchDays,
    momentumDirection: rec.momentumDirection || t.momentumDirection,
    momentumThresholdPct: rec.momentumThresholdPct ?? t.momentumThresholdPct,
    rrVariant: rec.rrVariant || t.rrVariant,
    rrDepth: rec.rrDepth ?? t.rrDepth,
    rrPremium: rec.rrPremium ?? t.rrPremium,
    rrPayPremium: rec.rrPayPremium ?? t.rrPayPremium,
    rrProfitRatio: rec.rrProfitRatio ?? t.rrProfitRatio,
    rrCutLoss: rec.rrCutLoss ?? t.rrCutLoss,
    rrExpectedGain: rec.rrExpectedGain ?? t.rrExpectedGain,
    rrSpreadWidth: rec.rrSpreadWidth ?? t.rrSpreadWidth,
  });
  // 古い保存状態・共有リンクの引き継ぎ。
  //  - 買い系の支払いプレミアム額は、以前はrrLossBasis(さらに前はrrPremium)に保存していた。
  //    今は専用のrrPayPremiumに保存する(受取プレミアムと意味が違うため、別々に持つ)。
  //  - 売り系スプレッドのスプレッド幅は、以前はrrLossBasisに保存していた。今はrrSpreadWidthに統一。
  if (rec.rrPayPremium === null || rec.rrPayPremium === undefined) {
    if (typeGroup(t.typeKey) === "buy") {
      const legacy = rec.rrPremium ?? rec.rrLossBasis;
      if (legacy !== null && legacy !== undefined) {
        t.rrPayPremium = legacy;
        t.rrPremium = null;
      }
    }
  }
  if ((rec.rrSpreadWidth === null || rec.rrSpreadWidth === undefined)
      && typeGroup(t.typeKey) === "sell" && t.rrVariant === "spread"
      && rec.rrLossBasis !== null && rec.rrLossBasis !== undefined) {
    t.rrSpreadWidth = rec.rrLossBasis;
  }
}

function persistState() {
  try {
    const activeIndex = Math.max(0, tabs.findIndex((t) => t.id === activeTabId));
    const payload = {
      activeIndex,
      tabs: tabs.map((t) => ({
        ...tabRecipe(t),
        closesFull: t.closesFull,
        datesFull: t.datesFull,
      })),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    // 保存できなくても致命的ではない(プライベートブラウジング等で失敗することがある)ので無視する
  }
}

function loadFromSavedState() {
  let payload;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    payload = JSON.parse(raw);
  } catch (e) {
    return false;
  }
  if (!payload || !Array.isArray(payload.tabs) || payload.tabs.length === 0) return false;

  for (const rec of payload.tabs) {
    const t = newTabState();
    applyRecipe(t, rec);
    t.closesFull = rec.closesFull || null;
    t.datesFull = rec.datesFull || null;
    tabs.push(t);
  }
  const idx = Math.min(Math.max(payload.activeIndex || 0, 0), tabs.length - 1);
  switchTab(tabs[idx].id);
  return true;
}

// 新形式は {tabs, tickerHistory} のオブジェクト。配列そのものだった旧形式の
// 共有リンク(このセクション追加前に発行されたもの)も後方互換で読み込める。
function parseShareParam() {
  try {
    const raw = new URLSearchParams(location.search).get("share");
    if (!raw) return null;
    // URLSearchParams.get() は自動でデコード済みなので、ここでさらに decodeURIComponent はしない
    const parsed = JSON.parse(raw);
    const recipes = Array.isArray(parsed) ? parsed : parsed.tabs;
    const tickerHistory = Array.isArray(parsed) ? [] : parsed.tickerHistory;
    if (!Array.isArray(recipes) || recipes.length === 0) return null;
    return { recipes, tickerHistory: Array.isArray(tickerHistory) ? tickerHistory : [] };
  } catch (e) {
    return null;
  }
}

async function loadFromShareRecipes(recipes) {
  for (const rec of recipes) {
    const t = newTabState();
    applyRecipe(t, rec);
    tabs.push(t);
  }
  renderTabBar();
  switchTab(tabs[0].id);
  setStatus("共有された設定を読み込み中…");

  for (const t of tabs) {
    if (!t.symbol) continue;
    try {
      const data = await fetchHistory(t.symbol);
      t.closesFull = data.closes;
      t.datesFull = data.dates;
    } catch (e) {
      // このタブだけ取得失敗。「分析する」ボタンで再試行できる
    }
  }
  renderTabBar();
  const active = activeTab();
  if (active?.closesFull) renderAll(active);
  setStatus("共有された設定を読み込みました");
  persistState();
  // URLの共有パラメータは読み込み後に消し、通常のURLに戻す
  history.replaceState(null, "", location.pathname);
}

function buildShareUrl() {
  const recipes = tabs.filter((t) => t.symbol).map(tabRecipe);
  const payload = { tabs: recipes, tickerHistory: loadTickerHistory() };
  const url = new URL(location.href);
  url.search = "";
  // URLSearchParams.set() が自動でエンコードするので、ここで encodeURIComponent はしない
  url.searchParams.set("share", JSON.stringify(payload));
  return url.toString();
}

async function onShareLink() {
  const url = buildShareUrl();
  try {
    await navigator.clipboard.writeText(url);
    setStatus("共有リンクをコピーしました");
  } catch (e) {
    window.prompt("このリンクをコピーしてください", url);
  }
}

const DETAIL_HANDOFF_KEY = "itm-detail-handoff";

// 詳細マトリクスページへは、今のタブの設定(レシピ)だけを渡す。詳細マトリクス側でも
// 銘柄・タイプ・比率・判定期間・集計期間を変更できるようにしたため、価格データそのものは
// 渡さず、詳細マトリクス側で(KVキャッシュ経由の軽い)再取得をさせる設計にした。
function onOpenDetail() {
  const t = activeTab();
  if (!t || !t.closesFull) {
    setStatus("先に「分析する」でデータを取得してください", true);
    return;
  }
  try {
    sessionStorage.setItem(DETAIL_HANDOFF_KEY, JSON.stringify(tabRecipe(t)));
  } catch (e) {
    // 保存できなくても致命的ではない(詳細マトリクス側は空の状態から入力すればよい)
  }
  window.location.href = "detail.html";
}

const els = {
  tabBar: document.getElementById("tabBar"),
  shareBtn: document.getElementById("shareBtn"),
  openDetailBtn: document.getElementById("openDetailBtn"),
  ticker: document.getElementById("ticker"),
  tickerHistoryDropdown: document.getElementById("tickerHistoryDropdown"),
  analyzeBtn: document.getElementById("analyzeBtn"),
  typeSelect: document.getElementById("typeSelect"),
  ratioInput: document.getElementById("ratioInput"),
  windowSelect: document.getElementById("windowSelect"),
  periodSelect: document.getElementById("periodSelect"),
  status: document.getElementById("status"),

  volatilityCard: document.getElementById("volatilityCard"),
  volatilityTableBody: document.getElementById("volatilityTableBody"),

  todayCard: document.getElementById("todayCard"),
  todayDate: document.getElementById("todayDate"),
  todayRange: document.getElementById("todayRange"),
  todayClose: document.getElementById("todayClose"),
  todayCloseDate: document.getElementById("todayCloseDate"),
  todayStrike: document.getElementById("todayStrike"),
  momentumStrip: document.getElementById("momentumStrip"),

  result: document.getElementById("result"),
  badge: document.getElementById("badge"),
  entryCount: document.getElementById("entryCount"),
  itmCount: document.getElementById("itmCount"),
  totalItmDays: document.getElementById("totalItmDays"),
  overallProb: document.getElementById("overallProb"),
  chartWrap: document.getElementById("chartWrap"),
  heatmapWrap: document.getElementById("heatmapWrap"),
  symbolLabel: document.getElementById("symbolLabel"),
  dayProbDepth: document.getElementById("dayProbDepth"),
  heatmapDepth: document.getElementById("heatmapDepth"),
  resultTypeLabel: document.getElementById("resultTypeLabel"),
  badgeLegend: document.getElementById("badgeLegend"),
  dayProbLegend: document.getElementById("dayProbLegend"),
  entryHeatmapLegend: document.getElementById("entryHeatmapLegend"),

  conditionCard: document.getElementById("conditionCard"),
  conditionModeSelect: document.getElementById("conditionModeSelect"),
  conditionModeNote: document.getElementById("conditionModeNote"),
  momentumLookbackSelect: document.getElementById("momentumLookbackSelect"),
  minMatchDaysInput: document.getElementById("minMatchDaysInput"),
  momentumDirectionSelect: document.getElementById("momentumDirectionSelect"),
  momentumThresholdInput: document.getElementById("momentumThresholdInput"),
  matchedCount: document.getElementById("matchedCount"),
  matchedItmCount: document.getElementById("matchedItmCount"),
  matchedTotalItmDays: document.getElementById("matchedTotalItmDays"),
  matchedProb: document.getElementById("matchedProb"),
  todayMatchBadge: document.getElementById("todayMatchBadge"),

  riskRewardCard: document.getElementById("riskRewardCard"),
  orderCard: document.getElementById("orderCard"),
  orderTicker: document.getElementById("orderTicker"),
  orderClose: document.getElementById("orderClose"),
  orderLine: document.getElementById("orderLine"),
  orderTypeLabel: document.getElementById("orderTypeLabel"),
  orderMaxLossField: document.getElementById("orderMaxLossField"),
  orderMaxLoss: document.getElementById("orderMaxLoss"),
  orderMaxLossHint: document.getElementById("orderMaxLossHint"),
  orderDepthPct: document.getElementById("orderDepthPct"),
  spBtn: document.getElementById("spBtn"),
  rrPayPremiumInput: document.getElementById("rrPayPremiumInput"),
  rrDepthInput: document.getElementById("rrDepthInput"),
  rrDepthPct: document.getElementById("rrDepthPct"),
  rrBreakEvenSummary: document.getElementById("rrBreakEvenSummary"),
  rrPremiumInput: document.getElementById("rrPremiumInput"),
  rrProfitRatioInput: document.getElementById("rrProfitRatioInput"),
  rrInfiniteNote: document.getElementById("rrInfiniteNote"),
  rrBaseSummary: document.getElementById("rrBaseSummary"),
  rrBaseWarning: document.getElementById("rrBaseWarning"),
  rrCondSummary: document.getElementById("rrCondSummary"),
  rrCondWarning: document.getElementById("rrCondWarning"),
  rrSpreadWidthInput: document.getElementById("rrSpreadWidthInput"),
  rrExpectedGainInput: document.getElementById("rrExpectedGainInput"),
  rrCutLossInput: document.getElementById("rrCutLossInput"),
  rrCutLossSummary: document.getElementById("rrCutLossSummary"),
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
    conditionMode: "lookback",
    momentumLookback: DEFAULT_MOMENTUM_LOOKBACK,
    minMatchDays: 3,
    momentumDirection: "down",
    momentumThresholdPct: 5,
    rrVariant: "naked",
    rrDepth: null,
    rrPremium: null,
    rrPayPremium: null,
    rrProfitRatio: null,
    rrCutLoss: null,
    rrExpectedGain: null,
    rrSpreadWidth: null,
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
    persistState();
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
  els.conditionModeSelect.value = t.conditionMode;
  els.momentumLookbackSelect.value = String(t.momentumLookback);
  els.minMatchDaysInput.value = t.minMatchDays;
  els.momentumDirectionSelect.value = t.momentumDirection;
  els.momentumThresholdInput.value = t.momentumThresholdPct;
  updateConditionModeUI(t.conditionMode);

  els.rrDepthInput.value = t.rrDepth ?? "";
  els.rrPremiumInput.value = t.rrPremium ?? "";
  els.rrPayPremiumInput.value = t.rrPayPremium ?? "";
  els.rrProfitRatioInput.value = t.rrProfitRatio ?? "";
  els.rrCutLossInput.value = t.rrCutLoss ?? "";
  delete els.rrExpectedGainInput.dataset.auto;
  els.rrExpectedGainInput.value = t.rrExpectedGain ?? "";
  els.rrSpreadWidthInput.value = t.rrSpreadWidth ?? "";
  setWarn("rrCutLoss", null);
  setWarn("rrExpectedGain", null);
  updateRiskRewardInputUI(t.typeKey, t.rrVariant);
  syncMirrors();
  setStatus("");

  if (t.closesFull) {
    renderAll(t);
  } else {
    els.volatilityCard.hidden = true;
    els.todayCard.hidden = true;
    els.result.hidden = true;
    els.orderCard.hidden = true;
    els.conditionCard.hidden = true;
    els.riskRewardCard.hidden = true;
  }
  renderTabBar();
  persistState();
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
  els.volatilityCard.hidden = true;
  els.todayCard.hidden = true;
  els.result.hidden = true;
  els.orderCard.hidden = true;
  els.conditionCard.hidden = true;
  try {
    const data = await fetchHistory(symbol);
    t.symbol = data.symbol;
    t.closesFull = data.closes;
    t.datesFull = data.dates;
    setStatus(`${data.symbol} の${data.closes.length}日分の終値を取得しました`);
    addTickerToHistory(data.symbol);
    renderAll(t);
    renderTabBar();
    persistState();
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
  t.conditionMode = els.conditionModeSelect.value;
  t.momentumLookback = Number(els.momentumLookbackSelect.value) || DEFAULT_MOMENTUM_LOOKBACK;
  t.minMatchDays = Number(els.minMatchDaysInput.value) || 1;
  t.momentumDirection = els.momentumDirectionSelect.value;
  t.momentumThresholdPct = Number(els.momentumThresholdInput.value) || 0;
  updateConditionModeUI(t.conditionMode);

  t.rrDepth = els.rrDepthInput.value === "" ? null : Math.max(0, Number(els.rrDepthInput.value));
  t.rrPremium = els.rrPremiumInput.value === "" ? null : Number(els.rrPremiumInput.value);
  t.rrPayPremium = els.rrPayPremiumInput.value === "" ? null : Number(els.rrPayPremiumInput.value);
  t.rrProfitRatio = els.rrProfitRatioInput.value === "" ? null : Number(els.rrProfitRatioInput.value);
  t.rrCutLoss = els.rrCutLossInput.value === "" ? null : Number(els.rrCutLossInput.value);
  if (!els.rrExpectedGainInput.dataset.auto) {
    t.rrExpectedGain = els.rrExpectedGainInput.value === "" ? null : Number(els.rrExpectedGainInput.value);
  }
  t.rrSpreadWidth = els.rrSpreadWidthInput.value === "" ? null : Number(els.rrSpreadWidthInput.value);
  // プレミアム額・差額などの変更で理論上の最大利益額が下がった場合も、手入力値を上限に丸める
  {
    const { gainCap } = computeCutLossCaps(t);
    if (t.rrExpectedGain !== null && gainCap !== null && t.rrExpectedGain > gainCap) {
      t.rrExpectedGain = gainCap;
      els.rrExpectedGainInput.value = gainCap.toFixed(2);
      setWarn("rrExpectedGain", `理論上の最大利益額(${gainCap.toFixed(2)})を超えていたため、${gainCap.toFixed(2)}に調整しました`);
    }
  }
  updateRiskRewardInputUI(t.typeKey, t.rrVariant);

  if (t.closesFull) renderAll(t);
  syncMirrors();
  renderTabBar();
  persistState();
}

// 条件タイプに応じて、使わない入力欄を無効化し、簡単な説明を出す。
function updateConditionModeUI(mode) {
  const isCount = mode === "countWithin7";
  els.momentumLookbackSelect.disabled = isCount;
  els.minMatchDaysInput.disabled = !isCount;
  els.conditionModeNote.textContent = isCount
    ? "直近7営業日それぞれ(1〜7営業日前比較)について、指定した変化率条件を満たす日を数え、その日数が指定した日数以上あった日をエントリー日とします。「比較営業日数」は使いません。"
    : "指定した比較営業日数の1点だけで、変化率条件を満たすかを判定します。";
}

// 集計期間で末尾N件にスライスした配列を返す(ローカル計算のみ。APIは叩かない)
function periodClosesOf(t) {
  return t.closesFull.slice(-t.periodDays);
}
function periodDatesOf(t) {
  return t.datesFull.slice(-t.periodDays);
}

function renderAll(t) {
  renderVolatilityCard(t);
  renderTodayCard(t);
  renderMainAnalysis(t);
  renderOrderCard(t);
  renderConditionCard(t);
  renderRiskReward(t);
}

// 「変動幅の統計」カードを描画する。集計期間セレクターの影響を受けず、
// 常に取得済みの全データ(closesFull、最大800営業日)を使う。
function renderVolatilityCard(t) {
  const closes = t.closesFull;
  if (!closes || closes.length < 2) {
    els.volatilityCard.hidden = true;
    return;
  }
  els.volatilityTableBody.innerHTML = VOLATILITY_PERIODS.map(({ label, days }) => {
    const stats = computeVolatilityStats(closes, days);
    const recent = computeRecentVolatilityAmount(closes, days);
    const pctText = stats ? (stats.avgAbsPct * 100).toFixed(2) + "%" : "―";
    const riseText = stats ? "+" + (stats.maxRisePct * 100).toFixed(2) + "%" : "―";
    const fallText = stats ? (stats.maxFallPct * 100).toFixed(2) + "%" : "―";
    const runUpText = stats ? "+" + (stats.maxRunUpPct * 100).toFixed(2) + "%" : "―";
    const drawdownText = stats ? (stats.maxDrawdownPct * 100).toFixed(2) + "%" : "―";
    const amountText = recent ? recent.avgAbsAmount.toFixed(2) : "―";
    return `<tr><td>${label}</td><td>${pctText}</td><td>${riseText}</td><td>${fallText}</td><td>${runUpText}</td><td>${drawdownText}</td><td>${amountText}</td></tr>`;
  }).join("");
  els.volatilityCard.hidden = false;
}

function renderTodayCard(t) {
  const closes = periodClosesOf(t);
  const dates = periodDatesOf(t);
  const latestIdx = closes.length - 1;
  const latestClose = closes[latestIdx];
  const strike = latestClose * t.ratio;

  els.todayDate.textContent = closes.length.toLocaleString("ja-JP");
  els.todayRange.textContent = `${dates[0]} 〜 ${dates[latestIdx]}`;
  els.todayClose.textContent = latestClose.toFixed(2);
  els.todayCloseDate.textContent = dates[latestIdx];
  els.todayStrike.textContent = strike.toFixed(2);

  const strip = computeRecentMomentumStrip(closes, 7);
  els.momentumStrip.innerHTML = strip.map(({ daysAgo, change }) => {
    const cls = change === null ? "" : change >= 0 ? "up" : "down";
    const text = change === null ? "―" : (change >= 0 ? "+" : "") + (change * 100).toFixed(1) + "%";
    return `<div class="momentum-cell"><span class="m-label">${daysAgo}営業日前比</span><span class="m-value ${cls}">${text}</span></div>`;
  }).join("");

  els.todayCard.hidden = false;
}

// 判定する深さ(ドル)を、現在の権利行使価格(本日の終値×比率)に対する割合に換算する。
// 過去の各エントリーにも同じ割合を当てはめる(過去の株価水準が今と違っても公平に比べられるように
// するため)。分析結果・リスクリワード分析で共通に使う。
function depthInfo(t, closes) {
  const depthDollar = t.rrDepth ?? 0;
  const todayStrike = closes[closes.length - 1] * t.ratio;
  const depthPct = todayStrike > 0 ? depthDollar / todayStrike : 0;
  return { depthDollar, todayStrike, depthPct };
}

// 判定する深さを入力しているとき、ラベルに付ける「（◯ドル）」。空欄(0ドル)なら空文字。
function depthSuffixOf(t) {
  const d = t.rrDepth ?? 0;
  return d > 0 ? `（${d}ドル）` : "";
}

function renderMainAnalysis(t) {
  const closes = periodClosesOf(t);
  const dates = periodDatesOf(t);
  const type = OPTION_TYPES[t.typeKey];
  const { depthDollar, todayStrike, depthPct } = depthInfo(t, closes);
  const analysis = computeItmAnalysis(closes, {
    ratio: t.ratio,
    itmWhen: type.itmWhen,
    window: t.windowDays,
    group: typeGroup(t.typeKey),
    depthPct,
  }, dates);

  els.rrDepthPct.textContent = depthDollar > 0
    ? `＝ 権利行使価格の約${(depthPct * 100).toFixed(2)}%（現在の権利行使価格${todayStrike.toFixed(2)}に対して）`
    : "＝ 0%（一度でもITMになれば該当）";
  const depthTitle = depthSuffixOf(t);
  document.querySelectorAll(".dep-sfx").forEach((el) => { el.textContent = depthTitle; });
  els.dayProbDepth.textContent = depthTitle;
  els.heatmapDepth.textContent = depthTitle;

  els.symbolLabel.textContent = t.symbol;
  els.resultTypeLabel.textContent = `：${type.label}、×${t.ratio}`;
  els.badge.textContent = analysis.badge;
  els.badge.className = "badge " + badgeLevelClass(analysis.badgeLevel);
  els.entryCount.textContent = analysis.entryCount.toLocaleString("ja-JP");
  els.itmCount.textContent = analysis.itmEntryCount.toLocaleString("ja-JP");
  els.totalItmDays.textContent = analysis.totalItmDays.toLocaleString("ja-JP");
  els.overallProb.textContent = analysis.overallItmProb === null
    ? "―"
    : (analysis.overallItmProb * 100).toFixed(1) + "%";
  const group = typeGroup(t.typeKey);
  els.chartWrap.innerHTML = renderDayProbChart(analysis.dayProb, group);
  els.heatmapWrap.innerHTML = renderEntryHeatmap(analysis.perEntry, t.windowDays, group,
    depthDollar > 0 ? `(${depthDollar}ドル以上)` : "");
  els.badgeLegend.innerHTML = renderBadgeLegend(group);
  els.dayProbLegend.innerHTML = renderColorLegend(DAY_PROB_BANDS[group]);
  els.entryHeatmapLegend.innerHTML = renderColorLegend(ENTRY_HEATMAP_BANDS[group]);
  els.result.hidden = false;
}

// 総合判定バッジの7段階配色の凡例(選択中のタイプのラベルで表示)
function renderBadgeLegend(group) {
  const labels = BADGE_LABELS[group] || BADGE_LABELS.sell;
  const items = labels.map((label, i) => {
    return `<span class="badge b${i}" style="padding:2px 8px;font-size:11px">${label}</span>`;
  }).join("");
  return `<span>総合判定の凡例（左が有利／右が不利）：</span>${items}`;
}

// 色つき帯グラフ(営業日ごとのITM確率・エントリー日ごとのITM状況)共通の凡例
function renderColorLegend(bands) {
  const items = bands.map((b) => {
    return `<span class="hm-cell" style="background:${b.color}"></span><span>${b.label}</span>`;
  }).join("");
  return items;
}

function renderConditionCard(t) {
  const closes = periodClosesOf(t);
  const type = OPTION_TYPES[t.typeKey];
  const { depthPct } = depthInfo(t, closes);

  const conditional = computeConditionalItmAnalysis(closes, {
    depthPct,
    ratio: t.ratio,
    itmWhen: type.itmWhen,
    window: t.windowDays,
    conditionMode: t.conditionMode,
    momentumLookback: t.momentumLookback,
    minMatchDays: t.minMatchDays,
    momentumDirection: t.momentumDirection,
    momentumThresholdPct: t.momentumThresholdPct,
  });

  els.matchedCount.textContent = conditional.matchedCount.toLocaleString("ja-JP");
  els.matchedItmCount.textContent = conditional.matchedItmCount.toLocaleString("ja-JP");
  els.matchedTotalItmDays.textContent = conditional.matchedTotalItmDays.toLocaleString("ja-JP");
  els.matchedProb.textContent = conditional.matchedItmProb === null
    ? "―"
    : (conditional.matchedItmProb * 100).toFixed(1) + "%";

  const thresholdFrac = t.momentumThresholdPct / 100;
  const latestIdx = closes.length - 1;
  let todayMatches;
  if (t.conditionMode === "countWithin7") {
    let hitDays = 0;
    let anyData = false;
    for (let k = 1; k <= 7; k++) {
      const m = computeMomentum(closes, latestIdx, k);
      if (m === null) continue;
      anyData = true;
      const hit = t.momentumDirection === "down" ? m <= -thresholdFrac : m >= thresholdFrac;
      if (hit) hitDays++;
    }
    todayMatches = !anyData ? null : hitDays >= t.minMatchDays;
  } else {
    const todayMomentum = computeMomentum(closes, latestIdx, t.momentumLookback);
    todayMatches = todayMomentum === null ? null
      : t.momentumDirection === "down" ? todayMomentum <= -thresholdFrac : todayMomentum >= thresholdFrac;
  }

  els.todayMatchBadge.textContent = todayMatches === null ? "データ不足" : todayMatches ? "該当する" : "該当しない";
  els.todayMatchBadge.className = "badge " + (todayMatches === null ? "b-neutral" : todayMatches ? "b-match" : "b-nomatch");

  els.conditionCard.hidden = false;
}

// プット売り(単体)の株購入価格は、権利行使される価格＝現在の権利行使価格(本日の終値×比率)
// そのものなので、入力させず自動で使う。
function isAutoStockPrice(typeKey, variant) {
  return typeKey === "put_sell" && variant === "naked";
}

// リスクリワード分析で使う「満期まで保有した場合の損失の基準額」。
//   プット売り(単体): 株購入価格＝現在の権利行使価格(自動)
//   売り系スプレッド(ブルプット/ベアコール): 権利行使価格の差額(スプレッド幅)
//   コール売り(単体): 損失無限大のため使わない(null)
function lossBasisOf(t) {
  if (isAutoStockPrice(t.typeKey, t.rrVariant)) {
    const c = t.closesFull;
    return c && c.length ? c[c.length - 1] * t.ratio : null;
  }
  if (t.rrVariant === "spread") return t.rrSpreadWidth;
  return null;
}

// 注文時のプレミアム額。売り系は受取プレミアム額、買い系は支払いプレミアム額。
function premiumOf(t) {
  return typeGroup(t.typeKey) === "sell" ? t.rrPremium : t.rrPayPremium;
}

// 売り/買い・単体/SPで使う入力欄が違うため、body属性に現在の状態を書き込み、
// CSS(data-only属性)で表示する欄を切り替える(使わない欄は非表示にし、値は保持する)。
function updateRiskRewardInputUI(typeKey, variant) {
  const group = typeGroup(typeKey);
  const infinite = isInfiniteLossVariant(typeKey, variant);
  document.body.dataset.group = group;
  document.body.dataset.mode = variant === "spread" ? "sp" : "naked";
  els.rrInfiniteNote.hidden = !infinite;

  const labels = RISK_VARIANT_LABELS[typeKey] || RISK_VARIANT_LABELS.put_sell;
  els.spBtn.textContent = variant === "spread" ? `${labels.naked}へ切替` : `${labels.spread}へ切替`;
  els.spBtn.setAttribute("aria-pressed", variant === "spread" ? "true" : "false");
  els.spBtn.classList.toggle("active", variant === "spread");
}

// 現在の権利行使価格(本日の終値×比率)。データ未取得ならnull。
function todayStrikeOf(t) {
  const c = t.closesFull;
  return c && c.length ? c[c.length - 1] * t.ratio : null;
}

// 損切額・見越し最大利益額の理論上の上限を求める。
//   売り(無限大でない): 実際の最大損失額(株購入価格またはスプレッド幅−受取プレミアム額)
//   売り(コール売り単体=無限大): 上限なし(null)
//   買いの損切額: 支払いプレミアム額(常に有限)
//   買いの見越し最大利益額(理論上の最大利益額):
//     スプレッド買い: スプレッド幅−支払いプレミアム額
//     プット買い(単体): 現在の権利行使価格−支払いプレミアム額(株価は0未満にならないため)
//     コール買い(単体): 上限なし(null)
function computeCutLossCaps(t) {
  const group = typeGroup(t.typeKey);
  const infinite = isInfiniteLossVariant(t.typeKey, t.rrVariant);
  let cutLossCap = null;
  let gainCap = null;
  if (group === "sell") {
    const basis = lossBasisOf(t);
    if (!infinite && basis !== null && t.rrPremium !== null) {
      cutLossCap = basis - t.rrPremium;
    }
  } else {
    if (t.rrPayPremium !== null) cutLossCap = t.rrPayPremium;
    if (t.rrPayPremium !== null) {
      let cap = null;
      if (t.rrVariant === "spread") {
        if (t.rrSpreadWidth !== null) cap = t.rrSpreadWidth - t.rrPayPremium;
      } else if (t.typeKey === "put_buy") {
        const strike = todayStrikeOf(t);
        if (strike !== null) cap = strike - t.rrPayPremium;
      }
      gainCap = cap !== null && cap >= 0 ? cap : null;
    }
  }
  return { cutLossCap, gainCap };
}

// 見越し最大利益額として計算に使う値。手入力があればそれ、空欄(自動)なら理論上の最大利益額。
// コール買い(単体)のように上限がなく自動値も出せない場合はnull。
function expectedGainOf(t) {
  if (t.rrExpectedGain !== null) return t.rrExpectedGain;
  return computeCutLossCaps(t).gainCap;
}

// 見越し最大利益額の入力欄を、理論上の最大利益額で自動入力する(手入力がない場合)。
// 入力中(フォーカスあり)は上書きしない。入力欄には上限(max)とヒントも設定する。
function refreshExpectedGainField(t) {
  const { gainCap } = computeCutLossCaps(t);
  const el = els.rrExpectedGainInput;
  const mirrors = [...document.querySelectorAll('[data-mirror="rrExpectedGainInput"]')];
  const focused = [el, ...mirrors].includes(document.activeElement);
  el.max = gainCap === null ? "" : gainCap.toFixed(2);
  mirrors.forEach((m) => { m.max = el.max; });
  if (t.rrExpectedGain === null) {
    if (!focused) {
      if (gainCap !== null) {
        el.value = gainCap.toFixed(2);
        el.dataset.auto = "1";
      } else {
        el.value = "";
        delete el.dataset.auto;
      }
    }
  } else {
    delete el.dataset.auto;
    if (!focused) el.value = t.rrExpectedGain;
  }
  const isCallSingle = t.rrVariant !== "spread" && t.typeKey === "call_buy";
  // 欄の幅を広げないよう表示は短くし、詳しい説明はtitle(マウスを乗せると表示)とラベルの説明に置く。
  let hint = "";
  let hintTitle = "";
  if (isCallSingle) {
    hint = "上限なし";
    hintTitle = "コール買いは理論上の最大利益額がないため、自動入力はありません。ご自身の見込みを入力してください。";
  } else if (gainCap === null) {
    hint = "自動入力待ち";
    hintTitle = "プレミアム額(・権利行使価格の差額)を入力すると、理論上の最大利益額が自動入力されます。";
  } else if (el.dataset.auto) {
    hint = "自動入力（理論上の最大）";
    hintTitle = `理論上の最大利益額 ${gainCap.toFixed(2)} が自動入力されています。これを超える額は入力できません。`;
  } else {
    hint = `上限 ${gainCap.toFixed(2)}（空欄で自動）`;
    hintTitle = `理論上の最大利益額 ${gainCap.toFixed(2)} まで入力できます。空欄にすると自動入力に戻ります。`;
  }
  document.querySelectorAll('[data-hint="rrExpectedGain"]').forEach((h) => {
    h.textContent = hint;
    h.title = hintTitle;
  });
  syncMirrors();
}

// data-warn属性を持つ全ての要素(同じ入力欄を複数の場所に置いているため複数ある)に、
// 警告文を表示/非表示する。
function setWarn(key, text) {
  document.querySelectorAll(`[data-warn="${key}"]`).forEach((el) => {
    el.hidden = !text;
    el.textContent = text || "";
  });
}

// 損切額入力欄からフォーカスが外れたときに、上限を超えていれば上限値に丸め、
// 理由を添えた警告を表示する(入力中は丸めない)。
function onCutLossBlur() {
  const t = activeTab();
  if (!t) return;
  t.rrCutLoss = els.rrCutLossInput.value === "" ? null : Number(els.rrCutLossInput.value);
  const { cutLossCap } = computeCutLossCaps(t);
  if (cutLossCap !== null && t.rrCutLoss !== null && t.rrCutLoss > cutLossCap) {
    t.rrCutLoss = cutLossCap;
    els.rrCutLossInput.value = cutLossCap.toFixed(2);
    setWarn("rrCutLoss", `上限(${cutLossCap.toFixed(2)})を超えていたため、${cutLossCap.toFixed(2)}に調整しました`);
  } else {
    setWarn("rrCutLoss", null);
  }
  if (t.closesFull) renderAll(t);
  syncMirrors();
  persistState();
}

// 見越し最大利益額は、理論上の最大利益額を超える額を入力できない。入力した瞬間に上限へ丸め、
// 理由を添えた警告を表示する。空欄にすると自動入力(理論上の最大利益額)に戻る。
function onExpectedGainInput() {
  const t = activeTab();
  if (!t) return;
  const el = els.rrExpectedGainInput;
  delete el.dataset.auto;
  let v = el.value === "" ? null : Number(el.value);
  const { gainCap } = computeCutLossCaps(t);
  if (v !== null && gainCap !== null && v > gainCap) {
    v = gainCap;
    el.value = gainCap.toFixed(2);
    setWarn("rrExpectedGain", `理論上の最大利益額(${gainCap.toFixed(2)})を超えていたため、${gainCap.toFixed(2)}に調整しました`);
  } else {
    setWarn("rrExpectedGain", null);
  }
  t.rrExpectedGain = v;
  syncMirrors();
}

// フォーカスが外れたとき、空欄なら自動入力(理論上の最大利益額)に戻す。
function onExpectedGainBlur() {
  const t = activeTab();
  if (!t) return;
  if (t.closesFull) renderAll(t);
  syncMirrors();
  persistState();
}

// 勝率を「10回換算で何勝何敗」の表現に変換する(使い方ページ・他の説明文と同じ表現)。
function tenTrialText(winRate) {
  const wins = (winRate * 10).toFixed(1);
  const losses = ((1 - winRate) * 10).toFixed(1);
  return `10回換算で${wins}勝${losses}敗`;
}

// 「損切額から損益分岐を確認」セクションを描画する。実績の勝率(絞り込みなし/あり)
// には依存しない単一の損益分岐勝率を算出し、両方の実績勝率と比較する。
function renderCutLossSection(t, { group, infinite, premiumForBreakEven, baseWin, condWin }) {
  const gain = group === "sell" ? premiumForBreakEven : expectedGainOf(t);
  const loss = t.rrCutLoss;
  const neededWinRate = breakEvenWinRateFromLoss(gain, loss);

  // 主表示は実績と同じ向きの「損益分岐ITM発生率」(売りは1−損益分岐勝率、買いは損益分岐勝率と同値)。
  // 損益分岐勝率は判定に使う値なので、サブ表示で併記する。
  const neededWinText = neededWinRate === null ? "―" : (neededWinRate * 100).toFixed(1) + "%";
  const neededItmRate = neededWinRate === null ? null : (group === "sell" ? 1 - neededWinRate : neededWinRate);
  const neededText = neededItmRate === null ? "―" : (neededItmRate * 100).toFixed(1) + "%";
  const neededSub = neededWinRate === null ? null
    : `ITM${depthSuffixOf(t)}発生率が${neededText}${group === "sell" ? "以下" : "以上"}なら有利<br>損益分岐勝率 ${neededWinText}（${tenTrialText(neededWinRate)}）`;

  function verdictItem(label, winInfo) {
    const actual = winInfo.winRate;
    if (neededWinRate === null || actual === null) {
      return { label, value: "入力待ち", badge: "b-neutral" };
    }
    const favorable = actual >= neededWinRate;
    return { label, value: favorable ? "統計的に有利" : "統計的に不利", badge: favorable ? "b0" : "b6" };
  }

  const baseVerdict = verdictItem("絞り込みなしとの比較", baseWin);
  const condVerdict = verdictItem("絞り込みありとの比較", condWin);

  const T = "riskRewardExplain";
  const items = [
    {
      label: `損益分岐ITM${depthSuffixOf(t)}発生率`, value: neededText, sub: neededSub,
      note: (group === "sell"
        ? "損切額と予想利益(利確時)から、期待値がちょうどゼロになる勝率(損益分岐勝率)を算出し、実績と同じ向きのITM発生率に換算したものです。\n(損益分岐勝率p=損切額÷(予想利益+損切額)、ITM発生率=1−p)\n実際のITM発生率がこの値以下なら有利、上回れば不利です。"
        : "損切額と見越し最大利益額から、期待値がちょうどゼロになる勝率(損益分岐勝率)を算出し、実績と同じ向きのITM発生率に換算したものです。\n(損益分岐勝率p=損切額÷(見越し最大利益額+損切額)、買いはITM発生率=p)\n実際のITM発生率がこの値以上なら有利、下回れば不利です。")
        + "\n実績の割合(絞り込みなし/あり)は一切使っていません。",
    },
    {
      label: baseVerdict.label, value: `<span class="badge ${baseVerdict.badge}">${baseVerdict.value}</span>`, isBadge: true,
      note: "上の「絞り込みなし」の実績が有利な側(売りはITM発生率が損益分岐ITM発生率以下、買いは以上)であれば「統計的に有利」です。\n(勝率で比べても同じ結果になります)",
    },
    {
      label: condVerdict.label, value: `<span class="badge ${condVerdict.badge}">${condVerdict.value}</span>`, isBadge: true,
      note: "上の「エントリー条件で絞り込みあり」の実績が有利な側(売りはITM発生率が損益分岐ITM発生率以下、買いは以上)であれば「統計的に有利」です。\n(勝率で比べても同じ結果になります)",
    },
  ];

  els.rrCutLossSummary.innerHTML = items.map((it) =>
    `<div class="stat" data-target="${T}" data-note="${it.note}">`
    + (it.isBadge ? `${it.value}<br>` : `<b>${it.value}</b>`)
    + `<span>${it.label}</span>`
    + (it.sub ? `<span class="stat-sub">${it.sub}</span>` : "")
    + `</div>`
  ).join("");
}

function renderRiskReward(t) {
  const closes = periodClosesOf(t);
  const type = OPTION_TYPES[t.typeKey];
  const group = typeGroup(t.typeKey);
  const infinite = isInfiniteLossVariant(t.typeKey, t.rrVariant);

  const { depthPct } = depthInfo(t, closes);
  const depthParams = { ratio: t.ratio, itmWhen: type.itmWhen, window: t.windowDays, depthPct };

  // 母集団1: 絞り込みなし(「分析結果」と同じ母集団)
  const baseWin = summarizeDepthResults(
    computeDepthEntryResults(closes, baseEntryIndices(closes, t.windowDays), depthParams), group);

  // 母集団2: エントリー条件で絞り込みあり(分母は絞り込み後の該当日数)
  const conditional = computeConditionalItmAnalysis(closes, {
    ratio: t.ratio, itmWhen: type.itmWhen, window: t.windowDays,
    conditionMode: t.conditionMode, momentumLookback: t.momentumLookback,
    minMatchDays: t.minMatchDays, momentumDirection: t.momentumDirection,
    momentumThresholdPct: t.momentumThresholdPct,
  });
  const condWin = summarizeDepthResults(
    computeDepthEntryResults(closes, conditional.entryIndices, depthParams), group);

  // 実際の最大損失額。売りは(権利行使価格 or スプレッド幅)−受取プレミアム(満期まで
  // 保有した場合の最悪ケースなので利確割合は関係しない)、買いは支払いプレミアムそのもの。
  // コール売り(単体)は理論上無限大のため計算しない。
  // 損益分岐の計算に使う「勝ちトレードの利益額」は、売りは受取プレミアム×利確割合
  // (反対売買の買い戻しコスト控除後の予想利益)、買いは支払いプレミアム額そのもの。
  // 予想利益(売り)は、コール売り(単体)でも「損切額から損益分岐を確認」セクションで
  // 使うため、無限大かどうかに関わらず計算する。
  let actualMaxLoss = null;
  let premiumForBreakEven = null;
  if (group === "sell") {
    premiumForBreakEven = expectedProfitOnClose(t.rrPremium, t.rrProfitRatio);
    if (!infinite) {
      const basis = lossBasisOf(t);
      actualMaxLoss = (basis !== null && t.rrPremium !== null) ? basis - t.rrPremium : null;
    }
  } else {
    premiumForBreakEven = t.rrPayPremium;
    actualMaxLoss = t.rrPayPremium;
  }

  renderRiskRewardBlock(els.rrBaseSummary, els.rrBaseWarning, {
    group, infinite, winInfo: baseWin, actualMaxLoss, premiumForBreakEven, isBase: true, depthSuffix: depthSuffixOf(t),
  });
  renderRiskRewardBlock(els.rrCondSummary, els.rrCondWarning, {
    group, infinite, winInfo: condWin, actualMaxLoss, premiumForBreakEven, isBase: false, depthSuffix: depthSuffixOf(t),
  });
  renderCutLossSection(t, { group, infinite, premiumForBreakEven, baseWin, condWin });

  els.riskRewardCard.hidden = false;
  setupStatExplain();
}

// 「注文内容」カードを描画する。注文の条件(取引タイプ・プレミアム・満期までの営業日数など)を
// 1行にまとめて表示し、満期時の損益分岐点もここに表示する。
function renderOrderCard(t) {
  refreshExpectedGainField(t);
  const closes = periodClosesOf(t);
  const dates = periodDatesOf(t);
  const type = OPTION_TYPES[t.typeKey];
  const group = typeGroup(t.typeKey);
  const isSp = t.rrVariant === "spread";
  const labels = RISK_VARIANT_LABELS[t.typeKey] || RISK_VARIANT_LABELS.put_sell;
  const { todayStrike } = depthInfo(t, closes);
  const latest = closes[closes.length - 1];

  els.orderTypeLabel.textContent = `：${isSp ? labels.spread : labels.naked}`;
  els.orderTicker.textContent = t.symbol || "―";
  els.orderClose.textContent = `最新終値 ${latest.toFixed(2)}（${dates[dates.length - 1]}）`;
  els.orderDepthPct.textContent = els.rrDepthPct.textContent;

  const fmt = (v) => v.toFixed(2);
  // 売り系スプレッド(ブルプット/ベアコール)は、最大損失額(差額−受取プレミアム額)を利確割合の右に表示する
  const showMaxLoss = group === "sell" && isSp;
  els.orderMaxLossField.hidden = !showMaxLoss;
  if (showMaxLoss) {
    const width = lossBasisOf(t);
    if (width !== null && t.rrPremium !== null) {
      els.orderMaxLoss.textContent = fmt(width - t.rrPremium);
      els.orderMaxLossHint.textContent = `差額${fmt(width)}−受取${fmt(t.rrPremium)}`;
    } else {
      els.orderMaxLoss.textContent = "―";
      els.orderMaxLossHint.textContent = "差額と受取プレミアム額を入力すると表示";
    }
  }
  const pc = type.itmWhen === "below" ? "P" : "C";
  let strikeText;
  if (!isSp) {
    strikeText = `権利行使価格${fmt(todayStrike)}ドル`;
  } else {
    // 比率で決まる権利行使価格(売り系は売り建て側、買い系は買い建て側)と、差額分だけ離れたもう一方の脚。
    // プット系はもう一方が安い側、コール系は高い側。
    const w = t.rrSpreadWidth;
    const far = w === null ? null : (pc === "P" ? todayStrike - w : todayStrike + w);
    const farText = far === null ? "―" : fmt(far);
    strikeText = group === "sell"
      ? `${fmt(todayStrike)}${pc}売/${farText}${pc}買`
      : `${fmt(todayStrike)}${pc}買/${farText}${pc}売`;
  }
  const premium = premiumOf(t);
  const parts = [
    isSp ? labels.spread : labels.naked,
    strikeText,
    `満期まで${t.windowDays}営業日`,
    premium === null ? "プレミアム価格 未入力" : `プレミアム価格${fmt(premium)}ドル`,
  ];
  if (group === "sell" && t.rrProfitRatio !== null) {
    const wari = t.rrProfitRatio / 10;
    parts.push(`${Number.isInteger(wari) ? wari : wari.toFixed(1)}割利確`);
  }
  const gainValue = group === "buy" ? expectedGainOf(t) : null;
  if (gainValue !== null) {
    parts.push(`見越し最大利益${fmt(gainValue)}ドル`);
  }
  els.orderLine.textContent = parts.join("　");

  renderBreakEvenPrice(t, closes, todayStrike);
  els.orderCard.hidden = false;
}

// SPボタン: 単体注文とスプレッド(SP)注文を切り替える。使わない側の入力欄は非表示になり、値は保持される。
function onToggleSp() {
  const t = activeTab();
  if (!t) return;
  t.rrVariant = t.rrVariant === "spread" ? "naked" : "spread";
  updateRiskRewardInputUI(t.typeKey, t.rrVariant);
  if (t.closesFull) renderAll(t);
  syncMirrors();
  persistState();
}

// 同じ入力欄を複数の場所に置くための仕組み。値の持ち主(idで参照する正本)と、
// data-mirror="正本のid"を付けた入力欄(ミラー)の値を常に同期させる。
// ミラーで入力すると正本に値を移して同じ入力イベントを発火させるため、既存の処理がそのまま動く。
function setupMirrors() {
  const canonIds = new Set();
  document.querySelectorAll("[data-mirror]").forEach((m) => {
    const canon = document.getElementById(m.dataset.mirror);
    if (!canon) return;
    canonIds.add(m.dataset.mirror);
    const isSelect = m.tagName === "SELECT";
    if (isSelect) m.innerHTML = canon.innerHTML;
    const evt = isSelect ? "change" : "input";
    m.addEventListener(evt, () => {
      canon.value = m.value;
      canon.dispatchEvent(new Event(evt, { bubbles: true }));
    });
    if (!isSelect) {
      m.addEventListener("blur", () => {
        canon.dispatchEvent(new Event("blur"));
        syncMirrors();
      });
    }
  });
  canonIds.forEach((id) => {
    const canon = document.getElementById(id);
    canon.addEventListener(canon.tagName === "SELECT" ? "change" : "input", syncMirrors);
  });
  syncMirrors();
}

function syncMirrors() {
  document.querySelectorAll("[data-mirror]").forEach((m) => {
    const canon = document.getElementById(m.dataset.mirror);
    if (!canon) return;
    if (m.value !== canon.value) m.value = canon.value;
    m.disabled = canon.disabled;
  });
}

// 満期時の損益分岐点(株価)を描画する。単体・スプレッドとも、上部の比率で決まる権利行使価格
// (売り系は売り建て側、買い系は買い建て側)にプレミアムを加減した値になる
// (スプレッドでは、もう一方の脚との差額=スプレッド幅は損益分岐点に影響しない)。
// プット系は権利行使価格−プレミアム、コール系は権利行使価格＋プレミアム。
// 売り系は受取プレミアム額、買い系は支払いプレミアム額(スプレッドは差し引き後の正味の額)を使う。
function renderBreakEvenPrice(t, closes, todayStrike) {
  const type = OPTION_TYPES[t.typeKey];
  const group = typeGroup(t.typeKey);
  const isPut = type.itmWhen === "below";
  const premium = premiumOf(t);
  const premiumName = group === "sell" ? "受取プレミアム額" : "支払いプレミアム額";
  const formula = `権利行使価格${isPut ? "−" : "＋"}${premiumName}`;
  const latest = closes[closes.length - 1];
  const T = "riskRewardExplain";

  const hasPremium = premium !== null && premium !== undefined && premium >= 0;
  const breakEven = hasPremium ? todayStrike + (isPut ? -premium : premium) : null;
  const diffPct = breakEven === null ? null : breakEven / latest - 1;

  const items = [
    {
      label: "現在の権利行使価格", value: todayStrike.toFixed(2), sub: "終値×比率",
      note: "本日の終値×権利行使価格の比率です。\nスプレッドの場合は、売り系は売り建てる側、買い系は買い建てる側の権利行使価格にあたります(もう一方の権利行使価格との差額は損益分岐点に影響しません)。",
    },
    {
      label: "損益分岐点(満期時の株価)", value: breakEven === null ? "―" : breakEven.toFixed(2),
      sub: breakEven === null ? `${premiumName}を入力すると表示` : formula,
      note: `満期時にこの株価であれば、損益がちょうどゼロになる価格です(${formula})。\n`
        + (group === "sell"
          ? (isPut ? "プット売りは、満期時の株価がこの価格を下回ると損失になります。" : "コール売りは、満期時の株価がこの価格を上回ると損失になります。")
          : (isPut ? "プット買いは、満期時の株価がこの価格を下回ると利益になります。" : "コール買いは、満期時の株価がこの価格を上回ると利益になります。"))
        + "\nスプレッドの場合は、プレミアムに差し引き後の正味の額(受取−支払い)を入力してください。\nプレミアムは1株あたりの額で、手数料は含みません。",
    },
    {
      label: "現在の株価との差", value: diffPct === null ? "―" : (diffPct >= 0 ? "+" : "") + (diffPct * 100).toFixed(2) + "%",
      sub: `現在の株価${latest.toFixed(2)}`,
      note: "損益分岐点が、現在の株価(最新の終値)から見て何%離れているかです。\n例えばプット売りで-8%なら、株価が現在より8%下がるまでは(満期時に)損失にならない、という余裕の目安になります。",
    },
  ];
  els.rrBreakEvenSummary.innerHTML = items.map((it) =>
    `<div class="stat" data-target="${T}" data-note="${it.note}"><b>${it.value}</b><span>${it.label}</span>`
    + (it.sub ? `<span class="stat-sub">${it.sub}</span>` : "") + `</div>`
  ).join("");
}

// リスクリワード分析の1ブロック(絞り込みなし/絞り込みあり、それぞれ)を描画する。
function renderRiskRewardBlock(summaryEl, warningEl, { group, infinite, winInfo, actualMaxLoss, premiumForBreakEven, isBase, depthSuffix }) {
  const { total, winRate, hitCount, recoveredCount, unrecoveredCount, avgRecoveryDays, medianRecoveryDays } = winInfo;
  const winRateText = winRate === null ? "―" : (winRate * 100).toFixed(1) + "%";
  const maxLossText = infinite ? "無限大" : (actualMaxLoss === null ? "―" : actualMaxLoss.toFixed(2));
  const T = "riskRewardExplain";

  let breakEvenLabel;
  let breakEvenValue;
  let breakEvenNote;
  let verdictHtml;
  let verdictNote;
  let lossRateSub = null;
  if (group === "sell") {
    breakEvenLabel = "一回の損切における上限額";
    breakEvenValue = infinite ? null : breakEvenMaxLoss(premiumForBreakEven, winRate);
    breakEvenNote = "勝率をもとに、勝ちトレードで得られる予想利益の合計と、負けトレードでの損失の合計がちょうど釣り合う「1回あたりの損失額」の上限です。\n"
      + "例えば勝率84%なら、10回のトレードのうち平均8.4回勝って予想利益を得て、1.6回負けるとすると、8.4回分の予想利益の合計と1.6回分の損失の合計がちょうど釣り合う、1回あたりの損失額にあたります。\n"
      + "実際の最大損失額がこの金額以下なら統計的に有利、上回っていれば不利です。\n"
      + "この金額(または自分で決めた損切額)だけ損失を確定させたい場合、反対売買(買い戻し)の指値は「約定レート(受取プレミアム額)＋この金額」になります。\n"
      + "(例: 約定レートが1.2、損切りたい金額が2なら、指値は1.2+2=3.2)";
    if (infinite) {
      verdictHtml = `<span class="badge b6">損失無限大のため判定不可</span>`;
      verdictNote = "コール売り(単体)は理論上、株価に上限がないため損失が無限大になり得ます。\n実際の最大損失額が確定できないため、損益分岐の判定はできません。";
    } else if (breakEvenValue === null || actualMaxLoss === null) {
      verdictHtml = `<span class="badge b-neutral">入力待ち</span>`;
      verdictNote = "「注文内容」に、受取プレミアム額（スプレッドの場合は権利行使価格の差額も。必要なら利確割合も）を入力すると判定されます。";
    } else {
      const favorable = actualMaxLoss <= breakEvenValue;
      verdictHtml = `<span class="badge ${favorable ? "b0" : "b6"}">${favorable ? "統計的に有利" : "統計的に不利"}</span>`;
      verdictNote = "実際の最大損失額と、左の「一回の損切における上限額」を比較した結果です。\n実際の最大損失額が上限額以下なら「統計的に有利」、上回っていれば「統計的に不利」です。";
    }
    if (!infinite && winRate !== null) {
      lossRateSub = `ITM${depthSuffix}発生率は${((1 - winRate) * 100).toFixed(1)}%まで`;
    }
  } else {
    breakEvenLabel = "損益分岐に必要な最低利益額(参考)";
    breakEvenValue = breakEvenMinGain(premiumForBreakEven, winRate);
    breakEvenNote = "支払ったプレミアム額と勝率から、損益分岐点となる「勝ったときに最低限必要な利益額」の目安を算出したものです（支払いプレミアム×(1−勝率)÷勝率）。";
    verdictHtml = `<span class="badge b-neutral">参考値（実際の利益額とご自身で比較してください）</span>`;
    verdictNote = "買い系は損失が支払いプレミアムに固定される一方、勝ったときの利益額は銘柄の値動き次第で変動し、このツールでは追跡していません。\nそのため有利/不利の自動判定は行わず、左の金額を参考値として表示しています。";
  }

  // 主表示は、分析結果・エントリー条件で絞り込みと同じ向きの「ITM発生率」にそろえる。
  // 勝率(売りは負けない確率、買いはITMを勝ちとした確率)は損益分岐の計算に使うため、サブ表示で併記する。
  const itmRateText = total === 0 ? "―" : (hitCount / total * 100).toFixed(1) + "%";
  const winRateName = group === "sell" ? "勝率(負けない確率)" : "勝率(ITMを勝ちとした確率)";
  const winRateLabel = `ITM${depthSuffix}発生率`;
  const winRateNote = "判定期間内のいずれかの営業日の終値が、設定した深さ(権利行使価格±◯ドル)以上のITMに届いたエントリー日の割合です。\n「分析結果」「エントリー条件で絞り込み」の「ITM発生エントリー数の割合」と同じ向きの数字です。\n深さが空欄(0ドル)なら「一度でもITMになった割合」になります。\n"
    + (group === "sell"
      ? "売りはITMが少ないほど有利です(届いたエントリー=負け)。下に併記した勝率(負けない確率)は、100%−この率です。"
      : "買いはITMが多いほど有利です(届いたエントリー=勝ち)。下に併記した勝率は、この率と同じ値です。")
    + "\n損益分岐の計算(一回の損切における上限額など)には、勝率を使っています。";
  const winRateSub = `${winRateName} ${winRateText}` + (isBase ? "<br>いつエントリーしてもこの率" : "");
  const maxLossNote = infinite
    ? "コール売り(単体)は株価に上限がないため、理論上損失は無限大になり得ます。"
    : group === "sell"
      ? "株購入価格(プット売り単体は現在の権利行使価格)またはスプレッド幅から受取プレミアム額を差し引いた、満期までITMのまま保有した場合の最悪ケースの損失額です。"
      : "支払ったプレミアム額そのものが、このポジションの最大損失額です(それ以上の損失は発生しません)。";
  const totalNote = isBase
    ? "「分析結果」と同じ母集団(集計期間−判定期間)の件数です。"
    : "「エントリー条件で絞り込み」で指定した値動き条件に当てはまった日数(該当日数)です。\n絞り込み後の件数を分母にすることで、実際にエントリーする場面だけに絞った率になります。";

  const items = [
    { label: "母数(件数)", value: total.toLocaleString("ja-JP"), note: totalNote },
    { label: winRateLabel, value: itmRateText, note: winRateNote, sub: winRateSub },
    { label: "実際の最大損失額", value: maxLossText, note: maxLossNote },
  ];
  if (group === "sell" && !infinite) {
    const profitText = premiumForBreakEven === null ? "―" : premiumForBreakEven.toFixed(2);
    items.push({
      label: "予想利益(利確時)", value: profitText,
      note: "受取プレミアム額×利確割合。\n反対売買(買い戻し)で決済する際、買い戻しコストを差し引いて実際に手元に残る利益の見込み額です。\n(利確割合が未入力の場合は受取プレミアム額そのもの＝100%として計算しています)",
    });
  }
  const avgText = avgRecoveryDays === null ? "―" : avgRecoveryDays.toFixed(1) + "日";
  const avgSub = avgRecoveryDays === null
    ? (hitCount > 0 ? "OTMに戻ったエントリーなし" : "深さに届いたエントリーなし")
    : `中央値${Number.isInteger(medianRecoveryDays) ? medianRecoveryDays : medianRecoveryDays.toFixed(1)}日・戻った${recoveredCount}件の平均`;
  const recoveryNote = group === "sell"
    ? "設定した深さに初めて届いた日から、初めてOTMに戻った日までの営業日数の平均です(参考値)。\n「深さに届いても、平均で◯日待てばOTMに戻る」という目安になり、売り建玉を持ち続けて待つ判断の材料になります。\n期間内にOTMに戻らなかったエントリーは平均・中央値に含めていません。右の「OTMに戻らなかった割合」と合わせて見てください。\n勝率や判定の計算には使っていません。"
    : "設定した深さに初めて届いた日から、初めてOTMに戻った日までの営業日数の平均です(参考値)。\n買いでは「利益が出る深さに届いた後、平均で何日その状態が続いたか(OTMに戻るまで)」という意味になります。\n期間内にOTMに戻らなかったエントリーは平均・中央値に含めていません。\n勝率や判定の計算には使っていません。";
  const unrecoveredRate = hitCount > 0 ? (unrecoveredCount / hitCount * 100).toFixed(1) + "%" : "―";
  const unrecoveredNote = group === "sell"
    ? "設定した深さに届いたエントリーのうち、判定期間の最終日までOTMに戻らなかった割合です(参考値)。\n「待てば戻る」とは言えなかったケースの割合で、この割合が高いと、待つ戦略は危険です。"
    : "設定した深さに届いたエントリーのうち、判定期間の最終日までOTMに戻らなかった(ITMのまま終わった)割合です(参考値)。";
  items.push({
    label: "OTMに戻るまでの平均日数(参考)", value: avgText, note: recoveryNote, sub: avgSub,
  });
  items.push({
    label: "OTMに戻らなかった割合(参考)", value: unrecoveredRate, note: unrecoveredNote,
    sub: hitCount > 0 ? `${unrecoveredCount}件/${hitCount}件` : null,
  });
  items.push({
    label: breakEvenLabel,
    value: breakEvenValue === null ? "―" : (Number.isFinite(breakEvenValue) ? breakEvenValue.toFixed(2) : "無限大"),
    note: breakEvenNote,
    sub: lossRateSub,
  });

  summaryEl.innerHTML = items.map((it) =>
    `<div class="stat" data-target="${T}" data-note="${it.note}"><b>${it.value}</b><span>${it.label}</span>`
    + (it.sub ? `<span class="stat-sub">${it.sub}</span>` : "") + `</div>`
  ).join("")
    + `<div class="stat" data-target="${T}" data-note="${verdictNote}">${verdictHtml}<br><span>判定</span></div>`;

  const level = sampleWarningLevel(total);
  if (level === "strong") {
    warningEl.className = "disc disc-strong";
    warningEl.hidden = false;
    warningEl.textContent = `件数が${total}件と非常に少なく、勝率の信頼性が低い可能性があります。判定期間を短くする、集計期間を延ばす、絞り込み条件を緩めるなどをご検討ください。`;
  } else if (level === "mild") {
    warningEl.className = "disc";
    warningEl.hidden = false;
    warningEl.textContent = `件数が${total}件とやや少なく、勝率の信頼性がやや低い可能性があります。判定期間を短くする、集計期間を延ばす、絞り込み条件を緩めるなどで件数を増やせる場合があります。`;
  } else {
    warningEl.hidden = true;
  }
}

// badgeLevel(0=最も有利〜6=最も不利)をヒートマップ同様の色クラスに変換する
function badgeLevelClass(level) {
  return level === null || level === undefined ? "b-neutral" : `b${level}`;
}

// 各.stat項目・グラフの見出し・フォーム項目のラベルをクリックすると、その項目の
// すぐ下に説明欄を挿入する(フォーム項目はラベルの下ではなく.field全体の下)。
// もう一度クリックすると閉じる(トグル)。各項目は独立してON/OFFでき、他の項目を
// クリックしても閉じない。リスクリワード分析の.stat項目は再描画のたびにDOMごと
// 作り直されるため、この関数は再描画後にも呼び直される。既に配線済みの要素
// (静的な項目)に二重で登録しないよう、配線済みフラグで判定する。
function setupStatExplain() {
  document.querySelectorAll(".stat[data-note], .chart-title[data-note], .field label[data-note], .card-title-toggle[data-note]").forEach((el) => {
    if (el.dataset.explainWired) return;
    el.dataset.explainWired = "1";
    el.addEventListener("click", () => {
      const anchor = el.closest(".field") || el;
      if (el.classList.contains("active")) {
        el.classList.remove("active");
        const box = anchor.nextElementSibling;
        if (box && box.classList.contains("explain-box")) box.remove();
        return;
      }
      el.classList.add("active");
      const box = document.createElement("div");
      box.className = "explain-box";
      box.textContent = el.dataset.note;
      anchor.insertAdjacentElement("afterend", box);
    });
  });
}

function init() {
  initThemeBar("theme-bar");
  initTypeOptions();
  initWindowOptions();
  initPeriodOptions();
  initMomentumLookbackOptions();
  setupTickerHistoryDropdown(els.ticker, els.tickerHistoryDropdown);
  setupStatExplain();

  // 復元の優先順位: URLの共有パラメータ > 同一端末の保存状態 > 新規タブ
  const shareData = parseShareParam();
  if (shareData) {
    loadFromShareRecipes(shareData.recipes);
    mergeTickerHistory(shareData.tickerHistory);
  } else if (!loadFromSavedState()) {
    createTab();
  }

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
  els.conditionModeSelect.addEventListener("change", onFormChange);
  els.momentumLookbackSelect.addEventListener("change", onFormChange);
  els.minMatchDaysInput.addEventListener("input", debounce(onFormChange, 250));
  els.momentumDirectionSelect.addEventListener("change", onFormChange);
  els.momentumThresholdInput.addEventListener("input", debounce(onFormChange, 250));
  els.spBtn.addEventListener("click", onToggleSp);
  els.rrDepthInput.addEventListener("input", debounce(onFormChange, 250));
  els.rrPayPremiumInput.addEventListener("input", debounce(onFormChange, 250));
  els.rrPremiumInput.addEventListener("input", debounce(onFormChange, 250));
  els.rrProfitRatioInput.addEventListener("input", debounce(onFormChange, 250));
  els.rrSpreadWidthInput.addEventListener("input", debounce(onFormChange, 250));
  els.rrCutLossInput.addEventListener("input", debounce(onFormChange, 250));
  els.rrCutLossInput.addEventListener("blur", onCutLossBlur);
  els.rrExpectedGainInput.addEventListener("input", onExpectedGainInput);
  els.rrExpectedGainInput.addEventListener("input", debounce(onFormChange, 250));
  els.rrExpectedGainInput.addEventListener("blur", onExpectedGainBlur);
  els.shareBtn.addEventListener("click", onShareLink);
  els.openDetailBtn.addEventListener("click", onOpenDetail);
  setupMirrors();
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

init();
