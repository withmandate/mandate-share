import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { StoreContext } from "./context.ts";
import { ensureDirectory, readAccessManifest, readOrdinaryFile, writeAccessManifest, writePrivateJson } from "./access.ts";
import { digestSlugs, rawHtmlSlugs } from "./raw.ts";
import { slugFormatError } from "./slug.ts";
import { validatePagePolicy, type PagePolicy, type PagePolicyManifest } from "./privacy-core.ts";
export * from "./privacy-core.ts";

export interface SharingRecord extends PagePolicy { consentAt: string }
interface SharingManifest { schema: 1; pages: Record<string, SharingRecord> }
export const sharingPath = (store: StoreContext): string => join(store.root, "access", "sharing.json");
export const buildPolicyPath = (store: StoreContext): string => join(store.stateDir, "build-policy.json");

async function sources(store: StoreContext): Promise<string[]> {
  const [mdx, raw] = await Promise.all([digestSlugs(store.root), rawHtmlSlugs(store.root)]);
  if (new Set([...mdx, ...raw]).size !== mdx.length + raw.length) throw new Error("A page slug has both raw and MDX sources.");
  return [...mdx, ...raw].sort();
}
export async function readSharingManifest(store: StoreContext): Promise<SharingManifest> {
  if (!(await ensureDirectory(join(store.root, "access"), false))) return { schema: 1, pages: {} };
  let parsed: SharingManifest;
  try { parsed = JSON.parse(await readOrdinaryFile(sharingPath(store), 2_097_152, false)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schema: 1, pages: {} };
    throw new Error("Sharing consent is unreadable; repair access/sharing.json before continuing.");
  }
  if (!parsed || parsed.schema !== 1 || !parsed.pages || typeof parsed.pages !== "object" || Array.isArray(parsed.pages) || Object.keys(parsed).some(key => !["schema", "pages"].includes(key))) throw new Error("Invalid sharing consent manifest.");
  for (const [slug, entry] of Object.entries(parsed.pages)) {
    if (slugFormatError(slug) || !entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.consentAt !== "string" || !Number.isFinite(Date.parse(entry.consentAt)) || Object.keys(entry).some(key => !["visibility", "indexable", "consentAt"].includes(key))) throw new Error("Invalid sharing consent entry.");
    validatePagePolicy({ visibility: entry.visibility, indexable: entry.indexable });
  }
  return parsed;
}
export async function readPagePolicies(store: StoreContext): Promise<PagePolicyManifest> {
  const [slugs, consent, access] = await Promise.all([sources(store), readSharingManifest(store), readAccessManifest(store.root)]);
  return Object.fromEntries(slugs.map(slug => {
    const entry = Object.hasOwn(consent.pages, slug) ? consent.pages[slug] : undefined;
    const privatePage = Object.hasOwn(access, slug) || !entry || entry.visibility === "private";
    return [slug, privatePage ? { visibility: "private", indexable: false } : { visibility: entry.visibility, indexable: entry.indexable }];
  }));
}
/** Only this explicit operation records permission for an open link, homepage, or indexing. */
export async function setPageSharing(store: StoreContext, slug: string, choice: { visibility: PagePolicy["visibility"]; indexable?: boolean }): Promise<PagePolicy> {
  if (slugFormatError(slug) || !(await sources(store)).includes(slug)) throw new Error("No page at that slug in the selected store.");
  const policy: PagePolicy = { visibility: choice.visibility, indexable: choice.indexable ?? false };
  validatePagePolicy(policy);
  const manifest = await readSharingManifest(store);
  manifest.pages[slug] = { ...policy, consentAt: new Date().toISOString() };
  // Record consent first. A still-present verifier keeps the page private until removal succeeds.
  await writePrivateJson(sharingPath(store), manifest);
  if (policy.visibility !== "private") {
    const access = await readAccessManifest(store.root);
    if (Object.hasOwn(access, slug)) { delete access[slug]; await writeAccessManifest(store.root, access); }
  }
  return policy;
}
export async function removeSharingRecord(store: StoreContext, slug: string): Promise<void> {
  const manifest = await readSharingManifest(store);
  if (Object.hasOwn(manifest.pages, slug)) { delete manifest.pages[slug]; await writePrivateJson(sharingPath(store), manifest); }
}
export async function assertPublishable(store: StoreContext): Promise<PagePolicyManifest> {
  const [policy, access] = await Promise.all([readPagePolicies(store), readAccessManifest(store.root)]);
  const missing = Object.entries(policy).filter(([slug, value]) => value.visibility === "private" && !Object.hasOwn(access, slug)).map(([slug]) => slug);
  if (missing.length) throw new Error(`Private pages need a password before publication: ${missing.join(", ")}. Assign a password or explicitly choose a password-free link/public page.`);
  return policy;
}
export function pagePolicyFingerprint(policy: PagePolicyManifest): string {
  const ordered = Object.fromEntries(Object.keys(policy).sort().map(slug => [slug, policy[slug]]));
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}
export async function recordBuiltPolicy(store: StoreContext, policy: PagePolicyManifest): Promise<void> {
  const info = await lstat(store.outDir);
  await writePrivateJson(buildPolicyPath(store), { schema: 1, fingerprint: pagePolicyFingerprint(policy), outputDevice: info.dev, outputInode: info.ino });
}
export async function isHomepageCurrent(store: StoreContext): Promise<boolean> {
  try {
    await ensureDirectory(store.stateDir, false);
    const value = JSON.parse(await readOrdinaryFile(buildPolicyPath(store), 4096, false));
    const info = await lstat(store.outDir);
    return value.schema === 1 && info.isDirectory() && value.outputDevice === info.dev && value.outputInode === info.ino && value.fingerprint === pagePolicyFingerprint(await readPagePolicies(store));
  } catch { return false; }
}
