// 配色テーマ（ライト/ダーク × アクセントプリセット）の管理。
// 銘柄診断ツールと同じ設計・同じlocalStorageキー("pp_theme")を使うことで、
// どちらかのツールで選んだ配色がもう一方にも引き継がれる。
// 実際の見た目はcss/style.cssの `:root[data-pal=...]` / `:root[data-mode=...]` 側が担い、
// このファイルはON/OFFの属性付け替えとlocalStorageの読み書き・UI描画だけを行う。

const STORAGE_KEY = "pp_theme";

const PALETTES = [
  { id: "genko", label: "現行" },
  { id: "blueplus", label: "ブルー＋", swatch: "#2563eb" },
  { id: "teal", label: "ティール", swatch: "#0d7c72" },
  { id: "slate", label: "スレート", swatch: "#334c86" },
  { id: "sand", label: "サンド", swatch: "#b1500a" },
  { id: "violet", label: "バイオレット", swatch: "#6d28d9" },
  { id: "rose", label: "ローズ", swatch: "#c2255c" },
];

function readTheme() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch (e) {
    return {};
  }
}

function writeTheme(theme) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
  } catch (e) {
    // 保存できなくても致命的ではない(プライベートブラウジング等)ので無視する
  }
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme.pal && theme.pal !== "genko") {
    root.setAttribute("data-pal", theme.pal);
  } else {
    root.removeAttribute("data-pal");
  }
  if (theme.mode === "dark" || theme.mode === "light") {
    root.setAttribute("data-mode", theme.mode);
  } else {
    root.removeAttribute("data-mode");
  }
}

function currentMode(theme) {
  if (theme.mode === "dark" || theme.mode === "light") return theme.mode;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function renderThemeBar(container) {
  const theme = readTheme();
  container.innerHTML = "";

  const label = document.createElement("span");
  label.className = "tb-lbl";
  label.textContent = "配色";
  container.appendChild(label);

  for (const p of PALETTES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sw";
    btn.dataset.pal = p.id;
    btn.title = p.label;
    btn.setAttribute("aria-label", p.label);
    btn.setAttribute("aria-pressed", String((theme.pal || "genko") === p.id));
    if (p.swatch) btn.style.setProperty("--tb-c", p.swatch);
    btn.addEventListener("click", () => {
      const next = { ...readTheme(), pal: p.id };
      writeTheme(next);
      applyTheme(next);
      renderThemeBar(container);
    });
    container.appendChild(btn);
  }

  const sep = document.createElement("span");
  sep.className = "tb-sep";
  container.appendChild(sep);

  const mode = currentMode(theme);
  const modeBtn = document.createElement("button");
  modeBtn.type = "button";
  modeBtn.className = "tb-btn";
  modeBtn.textContent = mode === "dark" ? "ライトに切替" : "ダークに切替";
  modeBtn.addEventListener("click", () => {
    const next = { ...readTheme(), mode: mode === "dark" ? "light" : "dark" };
    writeTheme(next);
    applyTheme(next);
    renderThemeBar(container);
  });
  container.appendChild(modeBtn);

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "tb-reset";
  resetBtn.textContent = "標準に戻す";
  resetBtn.addEventListener("click", () => {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* 無視 */ }
    applyTheme({});
    renderThemeBar(container);
  });
  container.appendChild(resetBtn);
}

export function initThemeBar(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  renderThemeBar(container);
}
