import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicJson, assertSourceFiles } from "./store.ts";
import { readManifest, writeManifest, digestSlugs, rawHtmlSlugs } from "./raw.ts";
import { readAccessManifest, writeAccessManifest, validateAccessManifest } from "./access.ts";
import { slugFormatError, uniqueSlug } from "./slug.ts";
import { checkMdx } from "./build.ts";
import type { StoreContext } from "./context.ts";
import { readSharingManifest, removeSharingRecord, setPageSharing, validatePagePolicy, type SharingVisibility } from "./privacy.ts";
import { initializePagePassword, readPasswordSettings, removePasswordBinding } from "./passwords.ts";

export async function pageSlugs(store: StoreContext): Promise<string[]> {
  return [...await digestSlugs(store.root), ...await rawHtmlSlugs(store.root)].sort();
}
export function assertSlug(slug: string): void {
  const invalid = slugFormatError(slug);
  if (invalid) throw new Error(invalid);
}
async function replaceSource(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
export async function importPage(store: StoreContext, input: string, options: { slug?: string; listed?: boolean; unlisted?: boolean; visibility?: SharingVisibility; indexable?: boolean; title?: string; summary?: string } = {}) {
  await assertSourceFiles(store.root);
  if (options.listed && options.unlisted) throw new Error("Choose listed or unlisted metadata, not both.");
  const visibility = options.visibility;
  if (options.indexable !== undefined && visibility === undefined) throw new Error("Choose public explicitly before setting indexing consent.");
  if (visibility) validatePagePolicy({ visibility, indexable: options.indexable ?? false });
  await readSharingManifest(store);
  // Observe existing sources before creating the new one; default profiles only apply to future pages.
  await readPasswordSettings(store);
  const source = resolve(input);
  const extension = extname(source).toLowerCase();
  if (![".html", ".htm", ".mdx"].includes(extension)) throw new Error("Import expects an HTML or MDX file.");
  const kind = extension === ".mdx" ? "digest" : "raw";
  const digests = await digestSlugs(store.root);
  const raw = await rawHtmlSlugs(store.root);
  const slug = options.slug ?? (kind === "digest" ? basename(source, extension) : uniqueSlug(new Set([...digests, ...raw]), 8));
  assertSlug(slug);
  if ((kind === "digest" ? raw : digests).includes(slug)) throw new Error("That slug belongs to a different source format.");
  const access = await readAccessManifest(store.root);
  validateAccessManifest(access, new Set([...digests, ...raw]));
  const destination = join(store.root, kind === "digest" ? "digests" : "raw", `${slug}.${kind === "digest" ? "mdx" : "html"}`);
  if (source === destination) throw new Error("File already lives at the destination; edit it and run build.");
  const bytes = await readFile(source);
  if (kind === "digest") {
    if (options.title || options.summary) throw new Error("Set MDX title and summary in its frontmatter.");
    await checkMdx(source, store);
  } else {
    const html = bytes.toString("utf8");
    if (!Buffer.from(html).equals(bytes) || !/<html\b/i.test(html) || !/<meta\s+[^>]*charset\s*=\s*["']?utf-8/i.test(html)) {
      throw new Error("Raw HTML must be a complete UTF-8 document with a meta charset in its head. The source file is never changed.");
    }
  }
  const manifest = await readManifest(store.root);
  const previous = manifest[slug];
  const oldBytes = existsSync(destination) ? await readFile(destination) : null;
  await mkdir(join(store.root, kind === "digest" ? "digests" : "raw"), { recursive: true });
  await replaceSource(destination, bytes);
  if (kind === "raw") {
    const today = new Date().toISOString().slice(0, 10);
    const title = options.title || previous?.title || bytes.toString("utf8").match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || slug;
    manifest[slug] = { title, created: previous?.created ?? today, unlisted: options.listed ? false : options.unlisted ? true : previous?.unlisted ?? true,
      ...(options.summary || previous?.summary ? { summary: options.summary || previous?.summary } : {}),
      ...(previous && (!oldBytes || !oldBytes.equals(bytes)) ? { updated: today } : previous?.updated ? { updated: previous.updated } : {}) };
    try { await writeManifest(store.root, manifest); }
    catch (error) { if (oldBytes) await replaceSource(destination, oldBytes); else await rm(destination); throw error; }
  }
  if (visibility) await setPageSharing(store, slug, { visibility, indexable: options.indexable });
  await initializePagePassword(store, slug);
  return { slug, kind, source: destination, updated: oldBytes !== null };
}

export async function removePage(store: StoreContext, slug: string): Promise<void> {
  assertSlug(slug); await assertSourceFiles(store.root);
  if (!(await pageSlugs(store)).includes(slug)) throw new Error("No page at that slug.");
  const rawManifest = await readManifest(store.root);
  const access = await readAccessManifest(store.root);
  delete rawManifest[slug]; delete access[slug];
  // Remove the source before its lock. Preview checks source/output binding,
  // so no intermediate step can expose a previously protected built page.
  await rm(join(store.root, "raw", `${slug}.html`), { force: true });
  await rm(join(store.root, "digests", `${slug}.mdx`), { force: true });
  await atomicJson(join(store.root, "raw", "manifest.json"), rawManifest);
  await writeAccessManifest(store.root, access);
  await removeSharingRecord(store, slug);
  await removePasswordBinding(store, slug);
}
