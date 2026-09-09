import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { atomicJson } from "./store.ts";
import { slugFormatError } from "./slug.ts";

/**
 * Raw HTML passthrough pages.
 *
 * A raw page is an arbitrary HTML file the user wants hosted at a slug without
 * going through MDX. The file is copied verbatim into `raw/<slug>.html` (the
 * committed source of record) and the build copies it on to `dist/<slug>.html`
 * untouched. Because raw HTML carries no frontmatter, listing metadata —
 * title, visibility, dates — lives here in `raw/manifest.json`.
 */
export interface RawEntry {
  /** Card title in the gallery (falls back to the slug). */
  title: string;
  /** YYYY-MM-DD the page was first shared. */
  created: string;
  /** YYYY-MM-DD of the most recent content swap, set on update. */
  updated?: string;
  /** Listing hint only. Explicit access/sharing.json consent governs exposure. */
  unlisted: boolean;
  /** Optional one-line dek on the gallery card. */
  summary?: string;
}

export type RawManifest = Record<string, RawEntry>;

export const rawDir = (root: string): string => join(root, "raw");
export const manifestPath = (root: string): string => join(rawDir(root), "manifest.json");

export async function readManifest(root: string): Promise<RawManifest> {
  const p = manifestPath(root);
  if (!existsSync(p)) return {};
  let input: unknown;
  try { input = JSON.parse(await readFile(p, "utf8")); }
  catch { throw new Error("raw/manifest.json is not valid JSON"); }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid raw page manifest.");
  for (const [slug, value] of Object.entries(input)) {
    const entry = value as RawEntry;
    if (slugFormatError(slug) || !entry || typeof entry !== "object" || Array.isArray(entry) ||
        typeof entry.title !== "string" || typeof entry.created !== "string" || typeof entry.unlisted !== "boolean" ||
        (entry.updated !== undefined && typeof entry.updated !== "string") ||
        (entry.summary !== undefined && typeof entry.summary !== "string") ||
        Object.keys(entry).some(key => !["title", "created", "updated", "unlisted", "summary"].includes(key))) {
      throw new Error("Invalid raw page manifest entry.");
    }
  }
  return input as RawManifest;
}

/** Write the manifest with slugs sorted, so diffs stay stable. */
export async function writeManifest(root: string, m: RawManifest): Promise<void> {
  const ordered = Object.fromEntries(Object.keys(m).sort().map((k) => [k, m[k]]));
  await atomicJson(manifestPath(root), ordered);
}

/** Slugs that have a `raw/<slug>.html` source on disk. */
export async function rawHtmlSlugs(root: string): Promise<string[]> {
  const dir = rawDir(root);
  if (!existsSync(dir)) return [];
  return (await readdir(dir))
    .filter((f) => f.endsWith(".html"))
    .map((f) => basename(f, ".html"))
    .sort();
}

/** Slugs claimed by `digests/*.mdx`. */
export async function digestSlugs(root: string): Promise<string[]> {
  const dir = join(root, "digests");
  if (!existsSync(dir)) return [];
  return (await readdir(dir))
    .filter((f) => f.endsWith(".mdx"))
    .map((f) => basename(f, ".mdx"))
    .sort();
}
