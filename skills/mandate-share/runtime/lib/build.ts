import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { renderCatalog } from "./catalog.ts";
import { readAccessManifest, validateAccessManifest } from "./access.ts";
import { renderMdx } from "./mdx.tsx";
import { rawDir, rawHtmlSlugs, readManifest } from "./raw.ts";
import { loadRegistry } from "./registry.ts";
import { render404, renderArtifact, renderHeaders, renderIndex } from "./shell.ts";
import { slugFormatError } from "./slug.ts";
import { assertSourceFiles } from "./store.ts";
import type { StoreContext } from "./context.ts";
import type { Frontmatter, PageInfo } from "./types.ts";
import { isTheme } from "./themes.ts";
import { pagePolicyFingerprint, readPagePolicies, recordBuiltPolicy } from "./privacy.ts";
import { initializePagePassword, readPasswordSettings } from "./passwords.ts";
import { digestSlugs } from "./raw.ts";

export interface BuildResult { pages: PageInfo[]; componentCount: number; ms: number }
export function validateFrontmatter(fm: Frontmatter): void {
  if (typeof fm.title !== "string" || !fm.title.trim()) throw new Error("MDX frontmatter requires a non-empty title.");
  for (const key of ["summary", "topic"] as const) if (fm[key] !== undefined && typeof fm[key] !== "string") throw new Error(`Frontmatter ${key} must be text.`);
  if (fm.date !== undefined && !(fm.date instanceof Date) && (typeof fm.date !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(fm.date))) throw new Error("Frontmatter date must be an ISO date.");
  if (fm.layout !== undefined && !["narrow", "wide", "full"].includes(fm.layout)) throw new Error("Unknown page layout.");
  if (fm.theme !== undefined && !isTheme(fm.theme)) throw new Error("Unknown theme. Choose clarity, ledger, fieldnotes, or blueprint.");
  for (const key of ["sample", "unlisted"] as const) if (fm[key] !== undefined && typeof fm[key] !== "boolean") throw new Error(`Frontmatter ${key} must be boolean.`);
}
export async function checkMdx(file: string, store: StoreContext): Promise<void> {
  await assertSourceFiles(store.root);
  const { components } = await loadRegistry(store);
  validateFrontmatter((await renderMdx(await readFile(file, "utf8"), components)).frontmatter);
}
/** A failed build preserves the previously completed output. */
export async function buildAll(store: StoreContext): Promise<BuildResult> {
  const started = performance.now();
  await assertSourceFiles(store.root);
  await readPasswordSettings(store);
  for (const slug of [...await digestSlugs(store.root), ...await rawHtmlSlugs(store.root)]) await initializePagePassword(store, slug);
  const policy = await readPagePolicies(store);
  const access = await readAccessManifest(store.root);
  const css = await readFile(join(store.runtimeRoot, "styles", "theme.css"), "utf8");
  const { components, entries } = await loadRegistry(store);
  for (const entry of entries) {
    try { await renderMdx(entry.meta.example, components); }
    catch (error) { throw new Error(`${entry.file}: component example failed: ${error instanceof Error ? error.message : error}`); }
  }
  await mkdir(store.stateDir, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(store.stateDir, "build-"));
  const pages: PageInfo[] = [];
  try {
    const digestDir = join(store.root, "digests");
    const files = existsSync(digestDir) ? (await readdir(digestDir)).filter(f => f.endsWith(".mdx")).sort() : [];
    for (const file of files) {
      const slug = basename(file, ".mdx");
      const invalid = slugFormatError(slug);
      if (invalid) throw new Error(`digests/${file}: ${invalid}`);
      const source = await readFile(join(digestDir, file), "utf8");
      const rendered = await renderMdx(source, components);
      validateFrontmatter(rendered.frontmatter);
      const artifact = renderArtifact({ slug, fm: rendered.frontmatter, contentHtml: rendered.html, css, mdxSource: source, indexable: policy[slug].visibility === "public" && policy[slug].indexable });
      await writeFile(join(staging, `${slug}.html`), artifact, { mode: 0o600 });
      await writeFile(join(staging, `${slug}.mdx`), source, { mode: 0o600 });
      pages.push({ slug, kind: "digest", fm: rendered.frontmatter, ...policy[slug], protected: Object.hasOwn(access, slug), updatedAt: (await stat(join(digestDir, file))).mtime.toISOString(), unlisted: policy[slug].visibility !== "public", mdxBytes: Buffer.byteLength(source), htmlBytes: Buffer.byteLength(artifact) });
    }
    const digestSlugs = new Set(pages.map(p => p.slug));
    const manifest = await readManifest(store.root);
    const rawSlugs = await rawHtmlSlugs(store.root);
    for (const slug of rawSlugs) {
      const invalid = slugFormatError(slug);
      if (invalid) throw new Error(`raw/${slug}.html: ${invalid}`);
      if (digestSlugs.has(slug)) throw new Error(`Duplicate slug '${slug}' in raw and MDX sources.`);
      const src = join(rawDir(store.root), `${slug}.html`);
      await copyFile(src, join(staging, `${slug}.html`));
      const entry = manifest[slug];
      pages.push({ slug, kind: "raw", fm: { title: entry?.title ?? slug, date: entry?.updated ?? entry?.created, summary: entry?.summary }, ...policy[slug], protected: Object.hasOwn(access, slug), updatedAt: (await stat(src)).mtime.toISOString(), unlisted: policy[slug].visibility !== "public", htmlBytes: (await stat(src)).size });
    }
    for (const slug of Object.keys(manifest)) if (!rawSlugs.includes(slug)) throw new Error(`Raw manifest points to missing page '${slug}'.`);
    validateAccessManifest(await readAccessManifest(store.root), new Set(pages.map(p => p.slug)));
    await writeFile(join(staging, "index.html"), renderIndex(pages.filter(page => page.visibility === "public" && !page.protected).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.slug.localeCompare(b.slug)), css), { mode: 0o600 });
    await writeFile(join(staging, "404.html"), render404(css), { mode: 0o600 });
    await writeFile(join(staging, "_headers"), renderHeaders(pages), { mode: 0o600 });
    // Crawlers must be able to read noindex on open pages and password prompts.
    // Disallow would hide that directive and can leave an externally linked URL indexed.
    await writeFile(join(staging, "robots.txt"), "User-agent: *\nAllow: /\n", { mode: 0o600 });
    if (pagePolicyFingerprint(await readPagePolicies(store)) !== pagePolicyFingerprint(policy)) throw new Error("Page privacy changed during the build; retry.");
    const catalog = join(store.stateDir, "COMPONENTS.md");
    try { if (!(await lstat(catalog)).isFile()) throw new Error("Generated catalog must be a regular file."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const catalogTemporary = `${catalog}.${randomUUID()}.tmp`;
    await writeFile(catalogTemporary, renderCatalog(entries), { mode: 0o600, flag: "wx" });
    await rename(catalogTemporary, catalog);
    const previous = join(store.stateDir, "dist-previous");
    await rm(previous, { recursive: true, force: true });
    const hadPrevious = existsSync(store.outDir);
    if (hadPrevious) await rename(store.outDir, previous);
    try { await rename(staging, store.outDir); }
    catch (error) { if (hadPrevious) await rename(previous, store.outDir); throw error; }
    await rm(previous, { recursive: true, force: true });
    await recordBuiltPolicy(store, policy);
    return { pages, componentCount: entries.length, ms: Math.round(performance.now() - started) };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
