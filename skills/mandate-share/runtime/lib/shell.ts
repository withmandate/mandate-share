import type { Frontmatter, PageInfo } from "./types.ts";
import { APPEARANCE_JS, READING_JS, appearanceControls, DEFAULT_THEME } from "./themes.ts";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The only sequence that can break out of a <script type="text/mdx"> block. */
const escMdxPayload = (s: string): string => s.replace(/<\/script/gi, "<\\/script");

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function formatDate(date: string | Date | undefined): string {
  if (!date) return "";
  const iso = date instanceof Date ? date.toISOString().slice(0, 10) : String(date);
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

export const estimateTokens = (bytes: number): number => Math.round(bytes / 4);

/** Tiny inline script for the copy buttons. No framework, no network. */
const COPY_JS = `
document.querySelectorAll("[data-copy]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const kind = btn.getAttribute("data-copy");
    const text = kind === "mdx"
      ? (document.getElementById("mdx-source")?.textContent ?? "").trim() + "\\n"
      : "<!doctype html>\\n" + document.documentElement.outerHTML;
    const label = btn.textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "copied";
    } catch {
      btn.textContent = "copy blocked";
    }
    setTimeout(() => { btn.textContent = label; }, 1400);
  });
});
`.trim();

function head(title: string, summary: string, css: string, indexable = false): string {
  return `<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="mandate-share" />
<link rel="icon" href="data:," />
<meta name="robots" content="${indexable ? "index, follow" : "noindex, nofollow"}" />
${summary ? `<meta name="description" content="${esc(summary)}" />\n` : ""}<title>${esc(title)}</title>
<script>${APPEARANCE_JS}</script>
<style>
${css}
</style>
</head>`;
}

function readerBar(title: string, progress = false): string {
  return `<div class="reader-bar" data-reader-bar>
<div class="reader-bar-inner"><span class="reader-title" data-reader-title aria-hidden="true">${esc(title)}</span>${appearanceControls()}</div>
${progress ? '<div class="reading-progress" aria-hidden="true"><span data-reading-progress></span></div>' : ""}
</div>`;
}

/**
 * Assembles a digest into a single self-contained HTML artifact:
 * inline CSS, no external requests, and the original MDX source embedded
 * in <script type="text/mdx" id="mdx-source"> so agents handed only the
 * HTML file can recover the clean structured source.
 */
export function renderArtifact(opts: {
  slug: string;
  fm: Frontmatter;
  contentHtml: string;
  css: string;
  mdxSource: string;
  indexable?: boolean;
  sourceActions?: boolean;
}): string {
  const { slug, fm, contentHtml, css, mdxSource } = opts;
  const title = fm.title ?? slug;
  const topic = fm.topic ?? "guide";
  const layout = fm.layout ?? "narrow";
  const date = formatDate(fm.date);
  const metadata = [fm.topic && fm.topic !== "guide" ? esc(fm.topic) : "", date ? esc(date) : "", fm.sample ? '<span class="chip">sample data</span>' : ""].filter(Boolean).join(" · ");

  return `<!doctype html>
<html lang="en" data-theme="${DEFAULT_THEME}">
${head(title, fm.summary ?? "", css, opts.indexable === true)}
<body data-topic="${esc(topic)}" data-layout="${esc(layout)}">
${readerBar(title, true)}
<div class="page">
<header class="masthead">
${metadata ? `<p class="page-meta">${metadata}</p>` : ""}
<h1 class="headline" id="page-title">${esc(title)}</h1>
${fm.summary ? `<p class="dek">${esc(fm.summary)}</p>` : ""}
</header>
<main class="content" data-reading-content>
${contentHtml}
</main>
<footer class="colophon">
${opts.sourceActions === false ? "" : `<div class="actions">
<button type="button" class="action" data-copy="html">copy html</button>
<button type="button" class="action" data-copy="mdx">copy mdx</button>
<a class="action" href="./${esc(slug)}.mdx" download>download mdx</a>
<a class="action" href="./index.html">public pages</a>
</div>`}
<p class="colophon-note">Made with Mandate Share. This page includes its original source.</p>
</footer>
</div>
<script type="text/mdx" id="mdx-source">
${escMdxPayload(mdxSource)}
</script>
<script>
${COPY_JS}
${READING_JS}
</script>
</body>
</html>
`;
}

/** Theme-consistent 404, used by the local server and static hosts alike. */
export function render404(css: string): string {
  return `<!doctype html>
<html lang="en" data-theme="${DEFAULT_THEME}">
${head("404 — Mandate Share", "nothing at this address", css)}
<body data-topic="guide">
${readerBar("Mandate Share")}
<div class="page">
<header class="masthead">
<p class="page-meta">404</p>
<h1 class="headline" id="page-title">Nothing at this address</h1>
<p class="dek">This page may have moved or may not be published yet.</p>
</header>
<main class="content">
<p><a href="/index.html">Browse public pages</a></p>
</main>
</div>
<script>${READING_JS}</script>
</body>
</html>
`;
}

/**
 * Header rules for static hosts (Cloudflare Workers assets / Pages read
 * a _headers file from the deploy directory):
 *   - a sitewide X-Robots-Tag so even verbatim raw pages are de-indexed
 *     (the strong signal — robots.txt is only advisory)
 *   - explicit per-file content types for the mdx sources so browsers
 *     display them as text instead of downloading
 */
export function renderHeaders(_pages: PageInfo[]): string {
  return `/*\n  X-Robots-Tag: noindex, nofollow\n\n/*.mdx\n  Content-Type: text/markdown; charset=utf-8\n`;
}

/** Public consent is checked again here even when the builder already filtered. */
export function renderIndex(pages: PageInfo[], css: string): string {
  const listed = pages.filter(page => page.visibility === "public" && !page.protected)
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")) || a.slug.localeCompare(b.slug));
  const rows = listed.map(page => {
    const updated = formatDate(page.updatedAt);
    return `<article class="public-page-row">
<div class="public-page-text"><h2 class="card-title"><a href="./${esc(page.slug)}.html">${esc(page.fm.title ?? page.slug)}</a></h2>
${page.fm.summary ? `<p class="card-summary">${esc(page.fm.summary)}</p>` : ""}
${updated ? `<p class="public-page-date">Updated <time datetime="${esc(page.updatedAt ?? "")}">${esc(updated)}</time></p>` : ""}</div>
<a class="public-page-open" href="./${esc(page.slug)}.html" aria-label="Open ${esc(page.fm.title ?? page.slug)}"><span aria-hidden="true">↗</span></a>
</article>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en" data-theme="${DEFAULT_THEME}">
${head("Public pages — Mandate Share", "Pages deliberately shared with everyone.", css)}
<body data-topic="guide">
${readerBar("Public pages")}
<div class="page">
<header class="masthead">
<h1 class="headline" id="page-title">Public pages</h1>
<p class="dek">${listed.length ? "Shared with everyone. Most recently updated first." : "Nothing has been made public here."}</p>
</header>
<main class="content">${rows}</main>
<footer class="colophon"><p class="colophon-note">Made with Mandate Share.</p></footer>
</div>
<script>${READING_JS}</script>
</body>
</html>
`;
}
