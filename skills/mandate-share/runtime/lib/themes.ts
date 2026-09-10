/** Stable theme names shared by frontmatter validation and the offline reader. */
export const THEMES = [
  { id: "clarity", name: "Clarity" },
  { id: "ledger", name: "Ledger" },
  { id: "fieldnotes", name: "Fieldnotes" },
  { id: "blueprint", name: "Blueprint" },
] as const;

export type Theme = typeof THEMES[number]["id"];
export const DEFAULT_THEME: Theme = "clarity";
export const isTheme = (value: unknown): value is Theme => THEMES.some(theme => theme.id === value);

/** Runs in the head before paint. No framework, network, or required browser storage. */
export const APPEARANCE_JS = `(() => {
  const names = ${JSON.stringify(THEMES.map(theme => theme.id))};
  const key = "mandate-share.appearance.v1";
  const root = document.documentElement;
  const defaultTheme = ${JSON.stringify(DEFAULT_THEME)};
  let theme = defaultTheme;
  let preference = "system";
  let media;
  try { media = window.matchMedia("(prefers-color-scheme: dark)"); } catch {}
  function read() {
    let stored;
    try { stored = window.localStorage.getItem(key); } catch { return; }
    theme = defaultTheme;
    preference = "system";
    try {
      const saved = JSON.parse(stored || "null");
      if (saved && names.includes(saved.theme)) theme = saved.theme;
      if (saved && ["light", "dark", "system"].includes(saved.mode)) preference = saved.mode;
    } catch {}
  }
  function save() {
    try { window.localStorage.setItem(key, JSON.stringify({ theme, mode: preference })); } catch {}
  }
  function apply() {
    const mode = preference === "system" ? (media?.matches ? "dark" : "light") : preference;
    root.dataset.theme = theme;
    root.dataset.mode = mode;
    root.dataset.appearanceReady = "";
    document.querySelectorAll("[data-theme-select]").forEach(select => { select.value = theme; });
    document.querySelectorAll("[data-mode-choice]").forEach(button => {
      button.setAttribute("aria-pressed", String(preference === button.dataset.modeChoice));
    });
  }
  function bind() {
    document.querySelectorAll("[data-theme-select]").forEach(select => select.addEventListener("change", () => {
      if (!names.includes(select.value)) return;
      theme = select.value; save(); apply();
    }));
    document.querySelectorAll("[data-mode-choice]").forEach(button => button.addEventListener("click", () => {
      const next = button.dataset.modeChoice;
      if (!["light", "dark", "system"].includes(next)) return;
      preference = next; save(); apply();
    }));
    document.querySelectorAll("[data-appearance-menu]").forEach(menu => {
      document.addEventListener("click", event => { if (menu.open && !menu.contains(event.target)) menu.open = false; });
      document.addEventListener("keydown", event => {
        if (event.key === "Escape" && menu.open) { menu.open = false; menu.querySelector("summary").focus(); }
      });
      document.addEventListener("focusin", event => { if (menu.open && !menu.contains(event.target)) menu.open = false; });
    });
    apply();
  }
  read(); apply();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind, { once: true });
  else bind();
  const onSystemChange = () => { if (preference === "system") apply(); };
  if (media?.addEventListener) media.addEventListener("change", onSystemChange);
  else if (media?.addListener) media.addListener(onSystemChange);
  window.addEventListener("storage", event => { if (event.key === key || event.key === null) { read(); apply(); } });
  window.addEventListener("pageshow", event => { if (event.persisted) { read(); apply(); } });
})();`;

export function appearanceControls(): string {
  return `<details class="appearance-menu" data-appearance-menu>
<summary class="appearance-trigger" aria-label="Reading appearance"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="8"/><path d="M12 4v16M12 4a8 8 0 0 1 0 16" fill="currentColor"/></svg><span>Appearance</span></summary>
<div class="appearance-controls" role="group" aria-label="Reading appearance settings">
<label class="theme-picker">Theme<span class="theme-select-field"><select data-theme-select aria-label="Theme">${THEMES.map(theme => `<option value="${theme.id}">${theme.name}</option>`).join("")}</select><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m7 10 5 5 5-5"/></svg></span></label>
<div class="mode-choices" role="group" aria-label="Color mode">${["light", "dark", "system"].map(mode => `<button type="button" class="appearance-button" data-mode-choice="${mode}" aria-pressed="${mode === "system"}">${mode[0]!.toUpperCase() + mode.slice(1)}</button>`).join("")}</div>
</div>
</details>`;
}

/** Progress is article-relative; footer length does not change the endpoint. */
export const READING_JS = `(() => {
  const bar = document.querySelector("[data-reader-bar]");
  const article = document.querySelector("[data-reading-content]");
  const line = document.querySelector("[data-reading-progress]");
  const heading = document.getElementById("page-title");
  if (!bar) return;
  let scheduled = false;
  function measure() {
    scheduled = false;
    const barRect = bar.getBoundingClientRect();
    if (heading) bar.dataset.titleVisible = String(heading.getBoundingClientRect().bottom <= barRect.bottom);
    if (!article || !line) return;
    const rect = article.getBoundingClientRect();
    const top = rect.top + window.scrollY - barRect.height;
    const end = rect.bottom + window.scrollY - window.innerHeight;
    const value = end <= top ? 1 : Math.min(1, Math.max(0, (window.scrollY - top) / (end - top)));
    line.style.transform = "scaleX(" + value + ")";
    line.dataset.progress = String(Math.round(value * 100));
  }
  function schedule() { if (!scheduled) { scheduled = true; window.requestAnimationFrame(measure); } }
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  if (typeof ResizeObserver !== "undefined") { const observer = new ResizeObserver(schedule); if (article) observer.observe(article); if (heading) observer.observe(heading); observer.observe(bar); observer.observe(document.body); }
  document.fonts?.ready.then(schedule);
  measure();
})();`;
