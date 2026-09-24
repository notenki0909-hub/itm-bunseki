// ティッカー入力欄の履歴(直近使用したティッカー)を管理する。
// 分析ページ(app.js)・詳細マトリクスページ(detail.js)の両方から共有される
// 単一のlocalStorageキーを使う。
//
// 表示にはHTML標準の<input list>+<datalist>ではなく自前のドロップダウンを
// 使う。datalistはブラウザが現在の入力値でフィルタするため、既にティッカーが
// 入力済みのタブでクリックすると「今の値と一致する1件」しか出てこず、履歴を
// 選び直せないという問題があった。自前実装なら、クリック/フォーカス時は
// 入力値に関わらず常に全履歴を表示できる。
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

// ティッカー入力欄(inputEl)の下に、履歴を一覧表示するドロップダウン(dropdownEl)
// を配線する。クリック/フォーカス時は入力値に関わらず常に全履歴を表示し、
// 入力中はその文字列を含む候補だけに絞り込む。候補をクリックすると入力欄に
// 反映されるだけで、分析は自動実行しない(従来通り「分析する」やEnterが必要)。
export function setupTickerHistoryDropdown(inputEl, dropdownEl) {
  if (!inputEl || !dropdownEl) return;

  function renderItems(filterText) {
    const q = (filterText || "").trim().toUpperCase();
    const list = loadTickerHistory().filter((s) => !q || s.includes(q));
    if (list.length === 0) {
      close();
      return;
    }
    dropdownEl.innerHTML = list
      .map((s) => `<div class="ticker-dropdown-item" data-symbol="${s}">${s}</div>`)
      .join("");
    dropdownEl.hidden = false;
  }

  function openFull() {
    // 入力欄に既に値があっても、開いた瞬間は常に全履歴を見せる。
    renderItems("");
  }

  function close() {
    dropdownEl.hidden = true;
    dropdownEl.innerHTML = "";
  }

  inputEl.addEventListener("focus", openFull);
  inputEl.addEventListener("click", openFull);
  inputEl.addEventListener("input", () => renderItems(inputEl.value));
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  // clickではなくmousedownで拾う: inputのblurより先に発火させ、
  // blurで先に閉じてしまって選択が反映されない事態を防ぐ。
  dropdownEl.addEventListener("mousedown", (e) => {
    const item = e.target.closest(".ticker-dropdown-item");
    if (!item) return;
    e.preventDefault();
    inputEl.value = item.dataset.symbol;
    close();
  });
  document.addEventListener("mousedown", (e) => {
    if (e.target === inputEl || dropdownEl.contains(e.target)) return;
    close();
  });
}
