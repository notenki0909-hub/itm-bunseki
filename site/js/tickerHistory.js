// ティッカー入力欄の履歴(直近使用したティッカー)を管理する。
// 分析ページ(app.js)・詳細マトリクスページ(detail.js)の両方から共有される
// 単一のlocalStorageキーを使う。<input list="...">に紐づく<datalist>へ
// 反映することで、ブラウザ標準のプルダウン候補として表示させる。
const STORAGE_KEY = "itm-tool-ticker-history-v1";
const MAX_ENTRIES = 20;

export function loadTickerHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((s) => typeof s === "string") : [];
  } catch (e) {
    return [];
  }
}

// 直近使用したティッカーを先頭に、重複を除いて保存する(最大MAX_ENTRIES件)。
export function addTickerToHistory(symbol) {
  const s = (symbol || "").trim().toUpperCase();
  if (!s) return;
  const list = [s, ...loadTickerHistory().filter((t) => t !== s)].slice(0, MAX_ENTRIES);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch (e) {
    // 保存できなくても致命的ではない(プライベートブラウジング等で失敗することがある)ので無視する
  }
}

export function renderTickerDatalist(datalistEl) {
  if (!datalistEl) return;
  datalistEl.innerHTML = loadTickerHistory().map((s) => `<option value="${s}"></option>`).join("");
}
