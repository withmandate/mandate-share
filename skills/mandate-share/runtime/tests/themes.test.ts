import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { APPEARANCE_JS, READING_JS } from "../lib/themes.ts";
import { validateFrontmatter } from "../lib/build.ts";
import { renderArtifact, renderIndex, render404 } from "../lib/shell.ts";
import type { Frontmatter, PageInfo } from "../lib/types.ts";

/** Execute the shipped inline script with controllable browser events/storage. */
function reader({ authored = "clarity", saved = null as string | null, dark = false, blocked = false } = {}) {
  const callbacks = new Map<string, (event?: any) => void>();
  const dataset: Record<string, string> = { theme: authored };
  const attrs: Record<string, string> = {};
  const systemAttrs: Record<string, string> = {};
  const select = { value: "", addEventListener: (name: string, fn: any) => callbacks.set(`select:${name}`, fn) };
  const choices = ["light", "dark", "system"].map(mode => ({
    dataset: { modeChoice: mode },
    setAttribute: (key: string, value: string) => { (mode === "system" ? systemAttrs : mode === "dark" ? attrs : {})[key] = value; },
    addEventListener: (name: string, fn: any) => callbacks.set(`${mode}:${name}`, fn),
  }));
  let mounted = false;
  const document = {
    documentElement: { dataset }, readyState: "loading",
    querySelectorAll: (query: string) => !mounted ? [] : query === "[data-theme-select]" ? [select] : query === "[data-mode-choice]" ? choices : [],
    addEventListener: (name: string, fn: any) => callbacks.set(name, fn),
  };
  const media = { matches: dark, addEventListener: (_name: string, fn: any) => callbacks.set("media", fn) };
  const storage = { value: saved };
  const window = {
    matchMedia: () => media,
    localStorage: {
      getItem: () => { if (blocked) throw new Error("Storage blocked"); return storage.value; },
      setItem: (_key: string, value: string) => { if (blocked) throw new Error("Storage blocked"); storage.value = value; },
    },
    addEventListener: (name: string, fn: any) => callbacks.set(name, fn),
  };
  runInNewContext(APPEARANCE_JS, { document, window });
  return { dataset, attrs, select, systemAttrs, storage,
    mount() { mounted = true; callbacks.get("DOMContentLoaded")!(); },
    mode(value: string) { callbacks.get(`${value}:click`)!(); },
    system() { callbacks.get("system:click")!(); },
    theme(value: string) { select.value = value; callbacks.get("select:change")!(); },
    os(value: boolean) { media.matches = value; callbacks.get("media")!(); },
    sync(value: string | null) { storage.value = value; callbacks.get("storage")!({ key: "mandate-share.appearance.v1" }); },
  };
}

describe("offline reader appearance", () => {
  test("mode-only changes preserve each page's authored theme default", () => {
    const first = reader({ authored: "ledger" });
    first.mount(); first.mode("dark");
    assert.deepStrictEqual(JSON.parse(first.storage.value!), { mode: "dark" });
    const next = reader({ authored: "blueprint", saved: first.storage.value });
    next.mount();
    assert.strictEqual(next.dataset.theme, "blueprint");
    assert.strictEqual(next.dataset.mode, "dark");
    next.system();
    assert.deepStrictEqual(JSON.parse(next.storage.value!), { mode: "system" });
  });
  test("first paint, reader overrides, reload, system reset and cross-tab changes", () => {
    const page = reader({ authored: "ledger", dark: true });
    assert.deepStrictEqual(page.dataset, { theme: "ledger", mode: "dark", appearanceReady: "" });
    page.mount();
    assert.strictEqual(page.select.value, "ledger");
    assert.strictEqual(page.systemAttrs["aria-pressed"], "true");
    page.mode("light");
    assert.strictEqual(page.dataset.mode, "light");
    page.os(false); page.os(true);
    assert.strictEqual(page.dataset.mode, "light");
    page.theme("fieldnotes");
    const reloaded = reader({ authored: "blueprint", saved: page.storage.value, dark: true });
    reloaded.mount();
    assert.strictEqual(reloaded.dataset.theme, "fieldnotes");
    assert.strictEqual(reloaded.dataset.mode, "light");
    reloaded.system();
    assert.strictEqual(reloaded.dataset.mode, "dark");
    assert.strictEqual(reloaded.systemAttrs["aria-pressed"], "true");
    reloaded.os(false);
    assert.strictEqual(reloaded.dataset.mode, "light");
    reloaded.sync(null);
    assert.strictEqual(reloaded.dataset.theme, "blueprint");
  });

  test("corrupt preferences and blocked storage preserve working controls", () => {
    for (const saved of ['{"theme":"unknown","mode":"neon"}', '{broken', 'null']) {
      const page = reader({ authored: "ledger", saved });
      page.mount();
      assert.strictEqual(page.dataset.theme, "ledger");
      assert.strictEqual(page.dataset.mode, "light");
      page.theme("<script>");
      assert.strictEqual(page.dataset.theme, "ledger");
    }
    const page = reader({ blocked: true });
    page.mount(); page.mode("dark"); page.theme("blueprint");
    assert.strictEqual(page.dataset.mode, "dark");
    assert.strictEqual(page.dataset.theme, "blueprint");
  });

  test("author theme is validated and generated shells preserve embedded source", () => {
    assert.throws(() => validateFrontmatter({ title: "Sample", theme: "unknown" } as unknown as Frontmatter), (error) => error instanceof Error && error.message.includes("Unknown theme"));
    const source = '---\ntitle: Sample\ntheme: ledger\n---\n\nA sample.\n';
    const page = renderArtifact({ slug: "sample", fm: { title: "Sample", theme: "ledger" }, contentHtml: "<p>A sample.</p>", css: "body { color: black; }", mdxSource: source });
    assert.ok((page).includes('<html lang="en" data-theme="ledger">'));
    assert.ok((page.indexOf(APPEARANCE_JS)) < (page.indexOf("<style>")));
    assert.ok((page).includes(source));
    for (const html of [page, renderIndex([], ""), render404("")]) {
      assert.ok((html).includes('data-mode-choice="dark"'));
      assert.ok((html).includes('aria-label="Theme"'));
      assert.ok((html).includes('data-mode-choice="system"'));
      assert.ok((html).includes('data-appearance-menu'));
    }
  });
});

test("reading progress reaches the article end and adapts to short or expanded content", () => {
  const events = new Map<string, () => void>();
  let start = 250, bottom = 2250;
  const line = { style: { transform: "" }, dataset: { progress: "" } };
  const bar = { dataset: { titleVisible: "" }, getBoundingClientRect: () => ({ height: 50, bottom: 50 }) };
  const window = { scrollY: 0, innerHeight: 800, addEventListener: (name: string, fn: () => void) => events.set(name, fn), requestAnimationFrame: (fn: () => void) => fn() };
  const article = { getBoundingClientRect: () => ({ top: start - window.scrollY, bottom: bottom - window.scrollY }) };
  const document = { getElementById: () => ({ getBoundingClientRect: () => ({ bottom: 200 - window.scrollY }) }), querySelector: (selector: string) => selector === "[data-reader-bar]" ? bar : selector === "[data-reading-content]" ? article : line };
  runInNewContext(READING_JS, { document, window });
  assert.equal(line.dataset.progress, "0");
  assert.equal(bar.dataset.titleVisible, "false");
  window.scrollY = 825; events.get("scroll")!();
  assert.equal(line.dataset.progress, "50");
  assert.equal(bar.dataset.titleVisible, "true");
  window.scrollY = 1450; events.get("scroll")!();
  assert.equal(line.dataset.progress, "100");
  bottom = 3500; events.get("resize")!();
  assert.equal(line.dataset.progress, "50");
  start = 100; bottom = 400; window.scrollY = 0; events.get("resize")!();
  assert.equal(line.dataset.progress, "100");
  assert.equal(bar.dataset.titleVisible, "false");
});

test("homepage requires explicit public access and orders by updated date", () => {
  const page = (slug: string, visibility: string, updatedAt: string, protectedPage = false) => ({ slug, kind: "digest", fm: { title: slug }, htmlBytes: 1, visibility, updatedAt, protected: protectedPage }) as PageInfo;
  const html = renderIndex([
    page("private-title", "private", "2026-09-09"), page("link-title", "unlisted", "2026-09-09"),
    page("protected-title", "public", "2026-09-09", true), page("older-public", "public", "2026-08-01"),
    page("newer-public", "public", "2026-09-08"),
  ], "");
  for (const hidden of ["private-title", "link-title", "protected-title"]) assert.ok(!html.includes(hidden));
  assert.ok(html.indexOf("newer-public") < html.indexOf("older-public"));
});


test("reader title follows the heading on pages without article progress", () => {
  const events = new Map<string, () => void>();
  const bar = { dataset: { titleVisible: "" }, getBoundingClientRect: () => ({ height: 50, bottom: 50 }) };
  const window = { scrollY: 0, addEventListener: (name: string, fn: () => void) => events.set(name, fn), requestAnimationFrame: (fn: () => void) => fn() };
  const document = { querySelector: (selector: string) => selector === "[data-reader-bar]" ? bar : null, getElementById: () => ({ getBoundingClientRect: () => ({ bottom: 200 - window.scrollY }) }) };
  runInNewContext(READING_JS, { document, window });
  assert.equal(bar.dataset.titleVisible, "false");
  window.scrollY = 200; events.get("scroll")!();
  assert.equal(bar.dataset.titleVisible, "true");
  window.scrollY = 0; events.get("scroll")!();
  assert.equal(bar.dataset.titleVisible, "false");
});
