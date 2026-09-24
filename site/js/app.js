import {
  OPTION_TYPES, WINDOW_OPTIONS, DEFAULT_WINDOW,
  PERIOD_OPTIONS, DEFAULT_PERIOD_DAYS,
  MOMENTUM_LOOKBACK_OPTIONS, DEFAULT_MOMENTUM_LOOKBACK,
  computeItmAnalysis, computeConditionalItmAnalysis,
  computeRecentMomentumStrip, computeMomentum, typeGroup, BADGE_LABELS,
  RISK_VARIANT_LABELS, isInfiniteLossVariant, computeWinRateByItmDays,
  breakEvenMaxLoss, breakEvenMinGain, sampleWarningLevel, expectedProfitOnClose,
  breakEvenWinRateFromLoss,
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
    rrThreshold: t.rrThreshold,
    rrLossBasis: t.rrLossBasis,
    rrPremium: t.rrPremium,
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
    rrThreshold: rec.rrThreshold ?? t.rrThreshold,
    rrLossBasis: rec.rrLossBasis ?? t.rrLossBasis,
    rrPremium: rec.rrPremium ?? t.rrPremium,
    rrProfitRatio: rec.rrProfitRatio ?? t.rrProfitRatio,
    rrCutLoss: rec.rrCutLoss ?? t.rrCutLoss,
    rrExpectedGain: rec.rrExpectedGain ?? t.rrExpectedGain,
    rrSpreadWidth: rec.rrSpreadWidth ?? t.rrSpreadWidth,
  });
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
  rrVariantSelect: document.getElementById("rrVariantSelect"),
  rrThresholdInput: document.getElementById("rrThresholdInput"),
  rrLossBasisInput: document.getElementById("rrLossBasisInput"),
  rrLossBasisLabel: document.getElementById("rrLossBasisLabel"),
  rrPremiumInput: document.getElementById("rrPremiumInput"),
  rrProfitRatioInput: document.getElementById("rrProfitRatioInput"),
  rrInfiniteNote: document.getElementById("rrInfiniteNote"),
  rrBaseSummary: document.getElementById("rrBaseSummary"),
  rrBaseWarning: document.getElementById("rrBaseWarning"),
  rrCondSummary: document.getElementById("rrCondSummary"),
  rrCondWarning: document.getElementById("rrCondWarning"),
  rrSpreadWidthField: document.getElementById("rrSpreadWidthField"),
  rrSpreadWidthInput: document.getElementById("rrSpreadWidthInput"),
  rrExpectedGainField: document.getElementById("rrExpectedGainField"),
  rrExpectedGainInput: document.getElementById("rrExpectedGainInput"),
  rrExpectedGainWarning: document.getElementById("rrExpectedGainWarning"),
  rrCutLossInput: document.getElementById("rrCutLossInput"),
  rrCutLossWarning: document.getElementById("rrCutLossWarning"),
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
    rrThreshold: 4,
    rrLossBasis: null,
    rrPremium: null,
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

  initRiskRewardVariantOptions(t.typeKey);
  els.rrVariantSelect.value = t.rrVariant;
  els.rrThresholdInput.value = t.rrThreshold;
  els.rrLossBasisInput.value = t.rrLossBasis ?? "";
  els.rrPremiumInput.value = t.rrPremium ?? "";
  els.rrProfitRatioInput.value = t.rrProfitRatio ?? "";
  els.rrCutLossInput.value = t.rrCutLoss ?? "";
  els.rrExpectedGainInput.value = t.rrExpectedGain ?? "";
  els.rrSpreadWidthInput.value = t.rrSpreadWidth ?? "";
  els.rrCutLossWarning.hidden = true;
  els.rrExpectedGainWarning.hidden = true;
  updateRiskRewardInputUI(t.typeKey, t.rrVariant);
  updateCutLossInputUI(t.typeKey, t.rrVariant);
  setStatus("");

  if (t.closesFull) {
    renderAll(t);
  } else {
    els.todayCard.hidden = true;
    els.result.hidden = true;
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
  els.todayCard.hidden = true;
  els.result.hidden = true;
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
  const typeChanged = t.typeKey !== els.typeSelect.value;
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

  if (typeChanged) {
    // 取引タイプが変わると「取引の種類」の選択肢のラベル(単体/スプレッド名)が
    // 変わるため作り直す。選択自体(単体 or スプレッド)は維持する。
    initRiskRewardVariantOptions(t.typeKey);
    els.rrVariantSelect.value = t.rrVariant;
  }
  t.rrVariant = els.rrVariantSelect.value;
  t.rrThreshold = Number(els.rrThresholdInput.value) || 1;
  t.rrLossBasis = els.rrLossBasisInput.value === "" ? null : Number(els.rrLossBasisInput.value);
  t.rrPremium = els.rrPremiumInput.value === "" ? null : Number(els.rrPremiumInput.value);
  t.rrProfitRatio = els.rrProfitRatioInput.value === "" ? null : Number(els.rrProfitRatioInput.value);
  t.rrCutLoss = els.rrCutLossInput.value === "" ? null : Number(els.rrCutLossInput.value);
  t.rrExpectedGain = els.rrExpectedGainInput.value === "" ? null : Number(els.rrExpectedGainInput.value);
  t.rrSpreadWidth = els.rrSpreadWidthInput.value === "" ? null : Number(els.rrSpreadWidthInput.value);
  updateRiskRewardInputUI(t.typeKey, t.rrVariant);
  updateCutLossInputUI(t.typeKey, t.rrVariant);

  if (t.closesFull) renderAll(t);
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
  renderTodayCard(t);
  renderMainAnalysis(t);
  renderConditionCard(t);
  renderRiskReward(t);
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
  els.totalItmDays.textContent = analysis.totalItmDays.toLocaleString("ja-JP");
  els.overallProb.textContent = analysis.overallItmProb === null
    ? "―"
    : (analysis.overallItmProb * 100).toFixed(1) + "%";
  const group = typeGroup(t.typeKey);
  els.chartWrap.innerHTML = renderDayProbChart(analysis.dayProb, group);
  els.heatmapWrap.innerHTML = renderEntryHeatmap(analysis.perEntry, t.windowDays, group);
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

  const conditional = computeConditionalItmAnalysis(closes, {
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

// 「取引の種類」プルダウンの選択肢を、上部の取引タイプに合わせて
// 単体/スプレッドの2択に作り直す(ラベルだけが変わる。値は常にnaked/spread)。
function initRiskRewardVariantOptions(typeKey) {
  const labels = RISK_VARIANT_LABELS[typeKey] || RISK_VARIANT_LABELS.put_sell;
  els.rrVariantSelect.innerHTML =
    `<option value="naked">${labels.naked}</option><option value="spread">${labels.spread}</option>`;
}

// 選択中の取引の種類(売り/買い、単体/スプレッド、コール売り単体=無限大)に応じて、
// 損失額・受取プレミアムの入力欄のラベルと有効/無効を切り替える。
function updateRiskRewardInputUI(typeKey, variant) {
  const group = typeGroup(typeKey);
  const infinite = isInfiniteLossVariant(typeKey, variant);

  els.rrInfiniteNote.hidden = !infinite;
  els.rrLossBasisInput.disabled = infinite;
  els.rrPremiumInput.disabled = group === "buy";
  els.rrProfitRatioInput.disabled = group === "buy";

  if (infinite) {
    els.rrLossBasisLabel.textContent = "損失額(無限大)";
  } else if (group === "buy") {
    els.rrLossBasisLabel.textContent = "支払いプレミアム額";
  } else if (variant === "spread") {
    els.rrLossBasisLabel.textContent = "権利行使価格の差額(スプレッド幅)";
  } else {
    els.rrLossBasisLabel.textContent = "株購入価格";
  }
}

// 「損切額から損益分岐を確認」欄の表示切り替え。見越し最大利益額は買い系のみ、
// スプレッド幅(見越し最大利益額の上限計算用)はブルコール/ベアプットのみ表示する。
function updateCutLossInputUI(typeKey, variant) {
  const group = typeGroup(typeKey);
  els.rrExpectedGainField.hidden = group !== "buy";
  els.rrSpreadWidthField.hidden = !(group === "buy" && variant === "spread");
}

// 損切額・見越し最大利益額の理論上の上限を求める。
//   売り(無限大でない): 実際の最大損失額(損失額入力−受取プレミアム額)
//   売り(コール売り単体=無限大): 上限なし(null)
//   買いの損切額: 支払いプレミアム額(常に有限)
//   買いの見越し最大利益額: スプレッド買いはスプレッド幅−支払いプレミアム額、単体買いは上限なし
function computeCutLossCaps(t) {
  const group = typeGroup(t.typeKey);
  const infinite = isInfiniteLossVariant(t.typeKey, t.rrVariant);
  let cutLossCap = null;
  let gainCap = null;
  if (group === "sell") {
    if (!infinite && t.rrLossBasis !== null && t.rrPremium !== null) {
      cutLossCap = t.rrLossBasis - t.rrPremium;
    }
  } else {
    if (t.rrLossBasis !== null) cutLossCap = t.rrLossBasis;
    if (t.rrVariant === "spread" && t.rrSpreadWidth !== null && t.rrLossBasis !== null) {
      const cap = t.rrSpreadWidth - t.rrLossBasis;
      gainCap = cap >= 0 ? cap : null;
    }
  }
  return { cutLossCap, gainCap };
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
    els.rrCutLossWarning.hidden = false;
    els.rrCutLossWarning.textContent = `上限(${cutLossCap.toFixed(2)})を超えていたため、${cutLossCap.toFixed(2)}に調整しました`;
  } else {
    els.rrCutLossWarning.hidden = true;
  }
  if (t.closesFull) renderAll(t);
  persistState();
}

// 見越し最大利益額入力欄も同様に、フォーカスが外れたときだけ上限に丸める。
function onExpectedGainBlur() {
  const t = activeTab();
  if (!t) return;
  t.rrExpectedGain = els.rrExpectedGainInput.value === "" ? null : Number(els.rrExpectedGainInput.value);
  const { gainCap } = computeCutLossCaps(t);
  if (gainCap !== null && t.rrExpectedGain !== null && t.rrExpectedGain > gainCap) {
    t.rrExpectedGain = gainCap;
    els.rrExpectedGainInput.value = gainCap.toFixed(2);
    els.rrExpectedGainWarning.hidden = false;
    els.rrExpectedGainWarning.textContent = `上限(${gainCap.toFixed(2)})を超えていたため、${gainCap.toFixed(2)}に調整しました`;
  } else {
    els.rrExpectedGainWarning.hidden = true;
  }
  if (t.closesFull) renderAll(t);
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
  const gain = group === "sell" ? premiumForBreakEven : t.rrExpectedGain;
  const loss = t.rrCutLoss;
  const neededWinRate = breakEvenWinRateFromLoss(gain, loss);

  const neededText = neededWinRate === null ? "―" : (neededWinRate * 100).toFixed(1) + "%";
  const neededSub = neededWinRate === null ? null : tenTrialText(neededWinRate);

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
      label: "損益分岐勝率", value: neededText, sub: neededSub,
      note: group === "sell"
        ? "損切額と予想利益(利確時)から、期待値がちょうどゼロになる勝率を算出したものです。\n(p=損切額÷(予想利益+損切額))\n実績の勝率(絞り込みなし/あり)は一切使っていません。"
        : "損切額と見越し最大利益額から、期待値がちょうどゼロになる勝率を算出したものです。\n(p=損切額÷(見越し最大利益額+損切額))\n実績の勝率(絞り込みなし/あり)は一切使っていません。",
    },
    {
      label: baseVerdict.label, value: `<span class="badge ${baseVerdict.badge}">${baseVerdict.value}</span>`, isBadge: true,
      note: "上の「絞り込みなし」の実績勝率が、左の損益分岐勝率以上であれば「統計的に有利」です。",
    },
    {
      label: condVerdict.label, value: `<span class="badge ${condVerdict.badge}">${condVerdict.value}</span>`, isBadge: true,
      note: "上の「エントリー条件で絞り込みあり」の実績勝率が、左の損益分岐勝率以上であれば「統計的に有利」です。",
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
  const dates = periodDatesOf(t);
  const type = OPTION_TYPES[t.typeKey];
  const group = typeGroup(t.typeKey);
  const infinite = isInfiniteLossVariant(t.typeKey, t.rrVariant);

  // 母集団1: 絞り込みなし(「分析結果」と同じ母集団)
  const baseAnalysis = computeItmAnalysis(closes, {
    ratio: t.ratio, itmWhen: type.itmWhen, window: t.windowDays, group,
  }, dates);
  const baseItmDaysList = baseAnalysis.perEntry.map((e) => e.itmDaysInWindow);
  const baseWin = computeWinRateByItmDays(baseItmDaysList, t.rrThreshold, group);

  // 母集団2: エントリー条件で絞り込みあり(分母は絞り込み後の該当日数)
  const conditional = computeConditionalItmAnalysis(closes, {
    ratio: t.ratio, itmWhen: type.itmWhen, window: t.windowDays,
    conditionMode: t.conditionMode, momentumLookback: t.momentumLookback,
    minMatchDays: t.minMatchDays, momentumDirection: t.momentumDirection,
    momentumThresholdPct: t.momentumThresholdPct,
  });
  const condWin = computeWinRateByItmDays(conditional.itmDaysList, t.rrThreshold, group);

  // 実際の最大損失額。売りは(権利行使価格 or スプレッド幅)−受取プレミアム(満期まで
  // 保有した場合の最悪ケースなので利確割合は関係しない)、買いは支払いプレミアムそのもの。
  // コール売り(単体)は理論上無限大のため計算しない。
  // 損益分岐の計算に使う「勝ちトレードの利益額」は、売りは受取プレミアム×利確割合
  // (反対売買の買い戻しコスト控除後の予想利益)、買いは支払いプレミアム(=損失額入力そのもの)。
  // 予想利益(売り)は、コール売り(単体)でも「損切額から損益分岐を確認」セクションで
  // 使うため、無限大かどうかに関わらず計算する。
  let actualMaxLoss = null;
  let premiumForBreakEven = null;
  if (group === "sell") {
    premiumForBreakEven = expectedProfitOnClose(t.rrPremium, t.rrProfitRatio);
    if (!infinite) {
      actualMaxLoss = (t.rrLossBasis !== null && t.rrPremium !== null) ? t.rrLossBasis - t.rrPremium : null;
    }
  } else {
    premiumForBreakEven = t.rrLossBasis;
    actualMaxLoss = t.rrLossBasis;
  }

  renderRiskRewardBlock(els.rrBaseSummary, els.rrBaseWarning, {
    group, infinite, winInfo: baseWin, actualMaxLoss, premiumForBreakEven, isBase: true,
  });
  renderRiskRewardBlock(els.rrCondSummary, els.rrCondWarning, {
    group, infinite, winInfo: condWin, actualMaxLoss, premiumForBreakEven, isBase: false,
  });
  renderCutLossSection(t, { group, infinite, premiumForBreakEven, baseWin, condWin });

  els.riskRewardCard.hidden = false;
  setupStatExplain();
}

// リスクリワード分析の1ブロック(絞り込みなし/絞り込みあり、それぞれ)を描画する。
function renderRiskRewardBlock(summaryEl, warningEl, { group, infinite, winInfo, actualMaxLoss, premiumForBreakEven, isBase }) {
  const { total, winRate } = winInfo;
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
      verdictNote = "損失額入力・受取プレミアム額（必要なら利確割合も）を入力すると判定されます。";
    } else {
      const favorable = actualMaxLoss <= breakEvenValue;
      verdictHtml = `<span class="badge ${favorable ? "b0" : "b6"}">${favorable ? "統計的に有利" : "統計的に不利"}</span>`;
      verdictNote = "実際の最大損失額と、左の「一回の損切における上限額」を比較した結果です。\n実際の最大損失額が上限額以下なら「統計的に有利」、上回っていれば「統計的に不利」です。";
    }
    if (!infinite && winRate !== null) {
      lossRateSub = `敗率は${((1 - winRate) * 100).toFixed(1)}%まで`;
    }
  } else {
    breakEvenLabel = "損益分岐に必要な最低利益額(参考)";
    breakEvenValue = breakEvenMinGain(premiumForBreakEven, winRate);
    breakEvenNote = "支払ったプレミアム額と勝率から、損益分岐点となる「勝ったときに最低限必要な利益額」の目安を算出したものです（支払いプレミアム×(1−勝率)÷勝率）。";
    verdictHtml = `<span class="badge b-neutral">参考値（実際の利益額とご自身で比較してください）</span>`;
    verdictNote = "買い系は損失が支払いプレミアムに固定される一方、勝ったときの利益額は銘柄の値動き次第で変動し、このツールでは追跡していません。\nそのため有利/不利の自動判定は行わず、左の金額を参考値として表示しています。";
  }

  const winRateLabel = group === "sell" ? "勝率(負けない確率)" : "勝率(ITMを勝ちとした確率)";
  const winRateNote = group === "sell"
    ? "判定期間内のITM日数がしきい値未満だった(負けなかった)エントリー日の割合です。\n売りはITMが少ないほど有利なため「負けない確率」と表現しています。"
    : "判定期間内のITM日数がしきい値以上だった(勝った)エントリー日の割合です。\n買いはITMが多いほど有利なため「ITMを勝ちとした確率」と表現しています。";
  const winRateSub = isBase ? "いつエントリーしてもこの勝率" : null;
  const maxLossNote = infinite
    ? "コール売り(単体)は株価に上限がないため、理論上損失は無限大になり得ます。"
    : group === "sell"
      ? "損失額入力(株購入価格またはスプレッド幅)から受取プレミアム額を差し引いた、満期までITMのまま保有した場合の最悪ケースの損失額です。"
      : "支払ったプレミアム額そのものが、このポジションの最大損失額です(それ以上の損失は発生しません)。";
  const totalNote = isBase
    ? "「分析結果」と同じ母集団(集計期間−判定期間)の件数です。"
    : "「エントリー条件で絞り込み」で指定した値動き条件に当てはまった日数(該当日数)です。\n絞り込み後の件数を分母にすることで、実際にエントリーする場面だけに絞った勝率になります。";

  const items = [
    { label: "母数(件数)", value: total.toLocaleString("ja-JP"), note: totalNote },
    { label: winRateLabel, value: winRateText, note: winRateNote, sub: winRateSub },
    { label: "実際の最大損失額", value: maxLossText, note: maxLossNote },
  ];
  if (group === "sell" && !infinite) {
    const profitText = premiumForBreakEven === null ? "―" : premiumForBreakEven.toFixed(2);
    items.push({
      label: "予想利益(利確時)", value: profitText,
      note: "受取プレミアム額×利確割合。\n反対売買(買い戻し)で決済する際、買い戻しコストを差し引いて実際に手元に残る利益の見込み額です。\n(利確割合が未入力の場合は受取プレミアム額そのもの＝100%として計算しています)",
    });
  }
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
  document.querySelectorAll(".stat[data-note], .chart-title[data-note], .field label[data-note]").forEach((el) => {
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
  els.rrVariantSelect.addEventListener("change", onFormChange);
  els.rrThresholdInput.addEventListener("input", debounce(onFormChange, 250));
  els.rrLossBasisInput.addEventListener("input", debounce(onFormChange, 250));
  els.rrPremiumInput.addEventListener("input", debounce(onFormChange, 250));
  els.rrProfitRatioInput.addEventListener("input", debounce(onFormChange, 250));
  els.rrSpreadWidthInput.addEventListener("input", debounce(onFormChange, 250));
  els.rrCutLossInput.addEventListener("input", debounce(onFormChange, 250));
  els.rrCutLossInput.addEventListener("blur", onCutLossBlur);
  els.rrExpectedGainInput.addEventListener("input", debounce(onFormChange, 250));
  els.rrExpectedGainInput.addEventListener("blur", onExpectedGainBlur);
  els.shareBtn.addEventListener("click", onShareLink);
  els.openDetailBtn.addEventListener("click", onOpenDetail);
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

init();
