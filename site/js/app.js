import {
  OPTION_TYPES, WINDOW_OPTIONS, DEFAULT_WINDOW,
  PERIOD_OPTIONS, DEFAULT_PERIOD_DAYS,
  MOMENTUM_LOOKBACK_OPTIONS, DEFAULT_MOMENTUM_LOOKBACK,
  computeItmAnalysis, computeConditionalItmAnalysis,
  computeRecentMomentumStrip, computeMomentum, typeGroup, BADGE_LABELS,
} from "./calc.js";
import { renderDayProbChart, DAY_PROB_BANDS } from "./chart.js";
import { renderEntryHeatmap, ENTRY_HEATMAP_BANDS } from "./heatmap.js";
import { initThemeBar } from "./theme.js";

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
    momentumLookback: t.momentumLookback,
    momentumDirection: t.momentumDirection,
    momentumThresholdPct: t.momentumThresholdPct,
  };
}

function applyRecipe(t, rec) {
  Object.assign(t, {
    symbol: rec.symbol ?? t.symbol,
    typeKey: rec.typeKey || t.typeKey,
    ratio: rec.ratio ?? t.ratio,
    windowDays: rec.windowDays ?? t.windowDays,
    periodDays: rec.periodDays ?? t.periodDays,
    momentumLookback: rec.momentumLookback ?? t.momentumLookback,
    momentumDirection: rec.momentumDirection || t.momentumDirection,
    momentumThresholdPct: rec.momentumThresholdPct ?? t.momentumThresholdPct,
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

function parseShareParam() {
  try {
    const raw = new URLSearchParams(location.search).get("share");
    if (!raw) return null;
    // URLSearchParams.get() は自動でデコード済みなので、ここでさらに decodeURIComponent はしない
    const recipes = JSON.parse(raw);
    if (!Array.isArray(recipes) || recipes.length === 0) return null;
    return recipes;
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
  const url = new URL(location.href);
  url.search = "";
  // URLSearchParams.set() が自動でエンコードするので、ここで encodeURIComponent はしない
  url.searchParams.set("share", JSON.stringify(recipes));
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
  momentumLookbackSelect: document.getElementById("momentumLookbackSelect"),
  momentumDirectionSelect: document.getElementById("momentumDirectionSelect"),
  momentumThresholdInput: document.getElementById("momentumThresholdInput"),
  matchedCount: document.getElementById("matchedCount"),
  matchedItmCount: document.getElementById("matchedItmCount"),
  matchedProb: document.getElementById("matchedProb"),
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
  t.momentumLookback = Number(els.momentumLookbackSelect.value) || DEFAULT_MOMENTUM_LOOKBACK;
  t.momentumDirection = els.momentumDirectionSelect.value;
  t.momentumThresholdPct = Number(els.momentumThresholdInput.value) || 0;
  if (t.closesFull) renderAll(t);
  renderTabBar();
  persistState();
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
    momentumLookback: t.momentumLookback,
    momentumDirection: t.momentumDirection,
    momentumThresholdPct: t.momentumThresholdPct,
  });

  els.matchedCount.textContent = conditional.matchedCount.toLocaleString("ja-JP");
  els.matchedItmCount.textContent = conditional.matchedItmCount.toLocaleString("ja-JP");
  els.matchedProb.textContent = conditional.matchedItmProb === null
    ? "―"
    : (conditional.matchedItmProb * 100).toFixed(1) + "%";

  const todayMomentum = computeMomentum(closes, closes.length - 1, t.momentumLookback);
  const thresholdFrac = t.momentumThresholdPct / 100;
  const todayMatches = todayMomentum === null ? null
    : t.momentumDirection === "down" ? todayMomentum <= -thresholdFrac : todayMomentum >= thresholdFrac;

  els.todayMatchBadge.textContent = todayMatches === null ? "データ不足" : todayMatches ? "該当する" : "該当しない";
  els.todayMatchBadge.className = "badge " + (todayMatches === null ? "b-neutral" : todayMatches ? "b-match" : "b-nomatch");

  els.conditionCard.hidden = false;
}

// badgeLevel(0=最も有利〜6=最も不利)をヒートマップ同様の色クラスに変換する
function badgeLevelClass(level) {
  return level === null || level === undefined ? "b-neutral" : `b${level}`;
}

// 各.stat項目・グラフの見出しをクリックすると、対応するdata-target先(直後の
// explain-box)に説明を表示する。同じ項目をもう一度クリックすると閉じる(トグル)。
function setupStatExplain() {
  document.querySelectorAll(".stat[data-target], .chart-title[data-target]").forEach((el) => {
    el.addEventListener("click", () => {
      const targetId = el.dataset.target;
      const box = document.getElementById(targetId);
      if (!box) return;
      const alreadyActive = el.classList.contains("active");
      // 同じdata-targetを共有する項目のactive状態だけを解除する
      document.querySelectorAll(`[data-target="${targetId}"].active`)
        .forEach((other) => other.classList.remove("active"));
      if (alreadyActive) {
        box.hidden = true;
        box.textContent = "";
      } else {
        box.textContent = el.dataset.note;
        box.hidden = false;
        el.classList.add("active");
      }
    });
  });
}

function init() {
  initThemeBar("theme-bar");
  initTypeOptions();
  initWindowOptions();
  initPeriodOptions();
  initMomentumLookbackOptions();
  setupStatExplain();

  // 復元の優先順位: URLの共有パラメータ > 同一端末の保存状態 > 新規タブ
  const shareRecipes = parseShareParam();
  if (shareRecipes) {
    loadFromShareRecipes(shareRecipes);
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
  els.momentumLookbackSelect.addEventListener("change", onFormChange);
  els.momentumDirectionSelect.addEventListener("change", onFormChange);
  els.momentumThresholdInput.addEventListener("input", debounce(onFormChange, 250));
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
