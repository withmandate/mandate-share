import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { APPEARANCE_JS, READING_JS, THEMES } from "../lib/themes.ts";
import { validateFrontmatter } from "../lib/build.ts";
import { renderArtifact, renderIndex, render404 } from "../lib/shell.ts";
import type { Frontmatter, PageInfo } from "../lib/types.ts";

/** Execute the shipped inline script with controllable browser events/storage. */
function reader({ initialTheme = "clarity", saved = null as string | null, dark = false, blocked = false, html = "" } = {}) {
  const callbacks = new Map<string, (event?: any) => void>();
  const dataset: Record<string, string> = { theme: html ? html.match(/<html[^>]+data-theme="([^"]+)"/)![1]! : initialTheme };
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
  runInNewContext(html ? html.match(/<script>([\s\S]*?)<\/script>/)![1]! : APPEARANCE_JS, { document, window });
  return { dataset, attrs, select, systemAttrs, storage,
    mount() { mounted = true; callbacks.get("DOMContentLoaded")!(); },
    mode(value: string) { callbacks.get(`${value}:click`)!(); },
    system() { callbacks.get("system:click")!(); },
    theme(value: string) { select.value = value; callbacks.get("select:change")!(); },
    os(value: boolean) { media.matches = value; callbacks.get("media")!(); },
    sync(value: string | null, key: string | null = "mandate-share.appearance.v1") { storage.value = value; callbacks.get("storage")!({ key }); },
    restore(value: string | null, darkMode: boolean) { storage.value = value; media.matches = darkMode; callbacks.get("pageshow")!({ persisted: true }); },
  };
}

describe("offline reader appearance", () => {
  test("Clarity and System are the first-paint defaults regardless of page metadata", () => {
    for (const { id } of THEMES) for (const dark of [false, true]) {
      const page = reader({ initialTheme: id, dark });
      assert.deepStrictEqual(page.dataset, { theme: "clarity", mode: dark ? "dark" : "light", appearanceReady: "" });
      page.mount();
      assert.strictEqual(page.select.value, "clarity");
      assert.strictEqual(page.systemAttrs["aria-pressed"], "true");
    }
  });

  test("mode-only choices keep Clarity across pages, including stored mode-only preferences", () => {
    for (const mode of ["light", "dark", "system"]) {
      const first = reader({ initialTheme: "ledger", dark: true });
      first.mount(); first.mode(mode);
      for (const saved of [first.storage.value, JSON.stringify({ mode })]) {
        const next = reader({ initialTheme: "blueprint", saved, dark: true });
        next.mount();
        assert.strictEqual(next.dataset.theme, "clarity");
        assert.strictEqual(next.dataset.mode, mode === "system" ? "dark" : mode);
        next.system();
        assert.deepStrictEqual(JSON.parse(next.storage.value!), { theme: "clarity", mode: "system" });
      }
    }
  });

  test("reader choices persist from the homepage through generated MDX pages and reloads", () => {
    const shells = [renderIndex([], ""), ...THEMES.map(({ id }) => renderArtifact({
      slug: "sample", fm: { title: "Sample", theme: id }, contentHtml: "<p>A sample.</p>", css: "", mdxSource: "A sample.",
    })), render404("")];
    for (const { id } of THEMES) for (const mode of ["light", "dark", "system"]) {
      const homepage = reader({ html: shells[0]!, dark: true });
      homepage.mount(); homepage.theme(id); homepage.mode(mode);
      for (const html of [...shells, shells[0]!]) {
        const page = reader({ html, saved: homepage.storage.value, dark: true });
        assert.strictEqual(page.dataset.theme, id);
        assert.strictEqual(page.dataset.mode, mode === "system" ? "dark" : mode);
        page.mount();
        assert.strictEqual(page.select.value, id);
        assert.strictEqual(page.systemAttrs["aria-pressed"], String(mode === "system"));
      }
    }
  });

  test("explicit mode, System changes, and cross-tab updates keep controls in sync", () => {
    const page = reader({ initialTheme: "ledger", dark: true });
    page.mount();
    page.mode("light");
    assert.strictEqual(page.dataset.mode, "light");
    page.os(false); page.os(true);
    assert.strictEqual(page.dataset.mode, "light");
    page.theme("fieldnotes");
    const reloaded = reader({ initialTheme: "blueprint", saved: page.storage.value, dark: true });
    reloaded.mount();
    assert.strictEqual(reloaded.dataset.theme, "fieldnotes");
    assert.strictEqual(reloaded.dataset.mode, "light");
    reloaded.system();
    assert.strictEqual(reloaded.dataset.mode, "dark");
    assert.strictEqual(reloaded.systemAttrs["aria-pressed"], "true");
    reloaded.os(false);
    assert.strictEqual(reloaded.dataset.mode, "light");
    page.theme("ledger"); page.mode("dark");
    reloaded.sync(page.storage.value);
    assert.strictEqual(reloaded.dataset.theme, "ledger");
    assert.strictEqual(reloaded.select.value, "ledger");
    assert.strictEqual(reloaded.dataset.mode, "dark");
    assert.strictEqual(reloaded.attrs["aria-pressed"], "true");
    reloaded.sync(JSON.stringify({ theme: "blueprint", mode: "light" }), "unrelated-setting");
    assert.strictEqual(reloaded.dataset.theme, "ledger");
    reloaded.sync(null);
    assert.strictEqual(reloaded.dataset.theme, "clarity");
    assert.strictEqual(reloaded.dataset.mode, "light");
    assert.strictEqual(reloaded.systemAttrs["aria-pressed"], "true");
    reloaded.theme("blueprint"); reloaded.mode("dark");
    reloaded.sync(null, null);
    assert.strictEqual(reloaded.dataset.theme, "clarity");
    assert.strictEqual(reloaded.dataset.mode, "light");
  });

  test("back and forward restoration refreshes stored choices and current System appearance", () => {
    const page = reader({ saved: JSON.stringify({ theme: "ledger", mode: "light" }) });
    page.mount();
    page.restore(JSON.stringify({ theme: "fieldnotes", mode: "system" }), true);
    assert.strictEqual(page.dataset.theme, "fieldnotes");
    assert.strictEqual(page.dataset.mode, "dark");
    assert.strictEqual(page.select.value, "fieldnotes");
    assert.strictEqual(page.systemAttrs["aria-pressed"], "true");
    page.restore(null, false);
    assert.strictEqual(page.dataset.theme, "clarity");
    assert.strictEqual(page.dataset.mode, "light");
  });

  test("corrupt preferences and blocked storage preserve working controls", () => {
    for (const saved of ['{"theme":"unknown","mode":"neon"}', '{broken', 'null']) {
      const page = reader({ initialTheme: "ledger", saved });
      page.mount();
      assert.strictEqual(page.dataset.theme, "clarity");
      assert.strictEqual(page.dataset.mode, "light");
      page.theme("<script>");
      assert.strictEqual(page.dataset.theme, "clarity");
    }
    const partial = reader({ saved: JSON.stringify({ theme: "ledger", mode: "invalid" }), dark: true });
    assert.strictEqual(partial.dataset.theme, "ledger");
    assert.strictEqual(partial.dataset.mode, "dark");
    const page = reader({ initialTheme: "ledger", blocked: true, dark: true });
    assert.strictEqual(page.dataset.theme, "clarity");
    assert.strictEqual(page.dataset.mode, "dark");
    page.mount(); page.mode("dark"); page.theme("blueprint");
    page.restore(null, false);
    assert.strictEqual(page.dataset.mode, "dark");
    assert.strictEqual(page.dataset.theme, "blueprint");
  });

  test("theme metadata remains validated and preserved in source while every shell starts with Clarity", () => {
    assert.throws(() => validateFrontmatter({ title: "Sample", theme: "unknown" } as unknown as Frontmatter), (error) => error instanceof Error && error.message.includes("Unknown theme"));
    for (const { id } of THEMES) assert.doesNotThrow(() => validateFrontmatter({ title: "Sample", theme: id }));
    const source = '---\ntitle: Sample\ntheme: ledger\n---\n\nA sample.\n';
    const page = renderArtifact({ slug: "sample", fm: { title: "Sample", theme: "ledger" }, contentHtml: "<p>A sample.</p>", css: "body { color: black; }", mdxSource: source });
    assert.ok((page.indexOf(APPEARANCE_JS)) < (page.indexOf("<style>")));
    assert.ok((page).includes(source));
    for (const html of [page, renderIndex([], ""), render404("")]) {
      assert.ok(html.includes('<html lang="en" data-theme="clarity">'));
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
