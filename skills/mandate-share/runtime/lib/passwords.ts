import { lstat, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { StoreContext } from "./context.ts";
import { ensureDirectory, readAccessManifest, readOrdinaryFile, validatePasswordEntry, writeAccessManifest, writePrivateJson, type AccessEntry } from "./access.ts";
import { digestSlugs, rawHtmlSlugs } from "./raw.ts";
import { normalizedRequestPath } from "./access-core.ts";
import { slugFormatError } from "./slug.ts";
import { readPagePolicies, readSharingManifest, setPageSharing } from "./privacy.ts";
import { getStorePublicOrigin } from "./onboarding.ts";

export type PasswordBinding = { kind: "custom" } | { kind: "none" } | { kind: "profile"; profile: string; fingerprint: string };
export interface PasswordSettings { schema: 1; protectNewPages: boolean; profiles: Record<string, AccessEntry>; bindings: Record<string, PasswordBinding> }
export interface PasswordSaved { saved: true; storeId: string; target: "default" | "profile" | "page"; profile?: string; slug?: string; publicationRequired: boolean }
export type PasswordTarget = { kind: "default" } | { kind: "profile"; name: string } | { kind: "page"; slug: string };
export const passwordSettingsPath = (store: StoreContext): string => join(store.stateDir, "passwords.json");
const entryFingerprint = (entry: AccessEntry): string => createHash("sha256").update(JSON.stringify([entry.version, entry.algorithm, entry.iterations, entry.salt, entry.verifier])).digest("hex");
export function normalizeProfileName(name: string): string {
  const value = name.trim().toLowerCase().replace(/\s+/gu, "-");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value) || value.length > 64) throw new Error("Password profile names use letters, digits, spaces, and hyphens, up to 64 characters.");
  return value;
}
async function slugs(store: StoreContext): Promise<string[]> { return [...await digestSlugs(store.root), ...await rawHtmlSlugs(store.root)]; }
async function requirePage(store: StoreContext, slug: string): Promise<void> {
  if (slugFormatError(slug) || !(await slugs(store)).includes(slug)) throw new Error("No page at that slug in the selected store.");
}
async function locked<T>(store: StoreContext, work: () => Promise<T>): Promise<T> {
  await ensureDirectory(store.stateDir, true);
  const path = join(store.stateDir, "passwords.lock");
  try { await mkdir(path, { mode: 0o700 }); }
  catch { throw new Error("Another password operation is active. Retry after it completes."); }
  try { return await work(); } finally { await rm(path, { recursive: true, force: true }); }
}
function validateSettings(value: unknown): asserts value is PasswordSettings {
  const state = value as PasswordSettings;
  if (!state || state.schema !== 1 || typeof state.protectNewPages !== "boolean" || !state.profiles || typeof state.profiles !== "object" || Array.isArray(state.profiles) || !state.bindings || typeof state.bindings !== "object" || Array.isArray(state.bindings) || Object.keys(state).some(key => !["schema", "protectNewPages", "profiles", "bindings"].includes(key))) throw new Error("Invalid saved password settings.");
  for (const [name, entry] of Object.entries(state.profiles)) {
    if (normalizeProfileName(name) !== name) throw new Error("Invalid saved password profile name.");
    validatePasswordEntry(entry);
  }
  for (const [slug, binding] of Object.entries(state.bindings)) {
    if (slugFormatError(slug) || !binding || typeof binding !== "object" || Array.isArray(binding)) throw new Error("Invalid saved page/password association.");
    if (binding.kind === "profile") {
      if (typeof binding.profile !== "string" || normalizeProfileName(binding.profile) !== binding.profile || !/^[a-f0-9]{64}$/u.test(binding.fingerprint) || Object.keys(binding).some(key => !["kind", "profile", "fingerprint"].includes(key))) throw new Error("Invalid saved profile association.");
    } else if (!["custom", "none"].includes(binding.kind) || Object.keys(binding).some(key => key !== "kind")) throw new Error("Invalid saved password association.");
  }
}
async function load(store: StoreContext): Promise<PasswordSettings> {
  let state: PasswordSettings;
  let created = false;
  try { state = JSON.parse(await readOrdinaryFile(passwordSettingsPath(store), 4_194_304, true)); validateSettings(state); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Saved password profiles are unreadable; repair passwords.json without exposing its contents.");
    const access = await readAccessManifest(store.root);
    state = { schema: 1, protectNewPages: true, profiles: {}, bindings: Object.fromEntries((await slugs(store)).map(slug => [slug, { kind: Object.hasOwn(access, slug) ? "custom" : "none" }])) };
    created = true;
  }
  if (created) await writePrivateJson(passwordSettingsPath(store), state);
  // Associations describe the copied page verifier, even after its profile is changed.
  const access = await readAccessManifest(store.root);
  let reconciled = false;
  for (const [slug, binding] of Object.entries(state.bindings)) {
    const actual = access[slug];
    if (!Object.hasOwn(access, slug) && binding.kind !== "none") { state.bindings[slug] = { kind: "none" }; reconciled = true; }
    else if (Object.hasOwn(access, slug) && (binding.kind === "none" || binding.kind === "profile" && binding.fingerprint !== entryFingerprint(actual))) { state.bindings[slug] = { kind: "custom" }; reconciled = true; }
  }
  if (reconciled) await writePrivateJson(passwordSettingsPath(store), state);
  return state;
}
/** Contains verifiers: callers must select status/name fields rather than emit this object. */
export async function readPasswordSettings(store: StoreContext): Promise<PasswordSettings> { return locked(store, () => load(store)); }
async function publicationRequired(store: StoreContext): Promise<boolean> { try { return (await lstat(join(store.stateDir, "last-release.json"))).isFile(); } catch { return false; } }
export async function setPasswordProfile(store: StoreContext, name: string, entry: AccessEntry, options: { protectNewPages?: boolean } = {}): Promise<PasswordSaved> {
  const profile = normalizeProfileName(name);
  validatePasswordEntry(entry);
  if (options.protectNewPages !== undefined && (profile !== "default" || typeof options.protectNewPages !== "boolean")) throw new Error("Only the default profile controls automatic protection of new pages.");
  return locked(store, async () => {
    const state = await load(store);
    state.profiles[profile] = { ...entry };
    if (options.protectNewPages !== undefined) state.protectNewPages = options.protectNewPages;
    await writePrivateJson(passwordSettingsPath(store), state);
    return { saved: true, storeId: store.id, target: profile === "default" ? "default" : "profile", profile, publicationRequired: false };
  });
}
export async function setNewPageProtection(store: StoreContext, enabled: boolean): Promise<void> {
  if (typeof enabled !== "boolean") throw new Error("Invalid default protection preference.");
  await locked(store, async () => { const state = await load(store); state.protectNewPages = enabled; await writePrivateJson(passwordSettingsPath(store), state); });
}
async function assign(store: StoreContext, state: PasswordSettings, slug: string, entry: AccessEntry, binding: PasswordBinding): Promise<void> {
  await requirePage(store, slug);
  await setPageSharing(store, slug, { visibility: "private" });
  const access = await readAccessManifest(store.root);
  access[slug] = { ...entry };
  await writeAccessManifest(store.root, access);
  state.bindings[slug] = binding;
}
export async function assignPageProfile(store: StoreContext, slug: string, name: string): Promise<PasswordSaved> {
  const profile = normalizeProfileName(name);
  return locked(store, async () => {
    const state = await load(store);
    if (!Object.hasOwn(state.profiles, profile)) throw new Error("That password profile is not configured for the selected store.");
    const entry = state.profiles[profile];
    await assign(store, state, slug, entry, { kind: "profile", profile, fingerprint: entryFingerprint(entry) });
    await writePrivateJson(passwordSettingsPath(store), state);
    return { saved: true, storeId: store.id, target: "page", slug, profile, publicationRequired: await publicationRequired(store) };
  });
}
export async function setPagePasswordEntry(store: StoreContext, slug: string, entry: AccessEntry): Promise<PasswordSaved> {
  validatePasswordEntry(entry);
  return locked(store, async () => {
    const state = await load(store);
    await assign(store, state, slug, entry, { kind: "custom" });
    await writePrivateJson(passwordSettingsPath(store), state);
    return { saved: true, storeId: store.id, target: "page", slug, publicationRequired: await publicationRequired(store) };
  });
}
/** New pages inherit a configured default; previously observed pages/overrides never rotate implicitly. */
export async function initializePagePassword(store: StoreContext, slug: string): Promise<void> {
  await locked(store, async () => {
    const state = await load(store);
    if (Object.hasOwn(state.bindings, slug)) return;
    const access = await readAccessManifest(store.root);
    if (Object.hasOwn(access, slug)) state.bindings[slug] = { kind: "custom" };
    else if ((await readPagePolicies(store))[slug]?.visibility === "private" && state.protectNewPages && Object.hasOwn(state.profiles, "default")) {
      const entry = state.profiles.default;
      await assign(store, state, slug, entry, { kind: "profile", profile: "default", fingerprint: entryFingerprint(entry) });
    } else state.bindings[slug] = { kind: "none" };
    await writePrivateJson(passwordSettingsPath(store), state);
  });
}
export async function removePasswordBinding(store: StoreContext, slug: string): Promise<void> {
  await locked(store, async () => { const state = await load(store); delete state.bindings[slug]; await writePrivateJson(passwordSettingsPath(store), state); });
}
export async function rotateProfilePages(store: StoreContext, name: string, selectedSlugs: string[]): Promise<PasswordSaved[]> {
  const profile = normalizeProfileName(name);
  if (!Array.isArray(selectedSlugs) || !selectedSlugs.length || new Set(selectedSlugs).size !== selectedSlugs.length) throw new Error("Choose an explicit, nonempty list of distinct pages to rotate.");
  return locked(store, async () => {
    const state = await load(store);
    if (!Object.hasOwn(state.profiles, profile)) throw new Error("That password profile is not configured.");
    for (const slug of selectedSlugs) await requirePage(store, slug);
    const entry = state.profiles[profile];
    for (const slug of selectedSlugs) await assign(store, state, slug, entry, { kind: "profile", profile, fingerprint: entryFingerprint(entry) });
    await writePrivateJson(passwordSettingsPath(store), state);
    const pending = await publicationRequired(store);
    return selectedSlugs.map(slug => ({ saved: true, storeId: store.id, target: "page", slug, profile, publicationRequired: pending }));
  });
}

export function normalizePasswordTarget(target: PasswordTarget): PasswordTarget {
  if (target.kind === "default") return { kind: "default" };
  if (target.kind === "profile") {
    const name = normalizeProfileName(target.name);
    return name === "default" ? { kind: "default" } : { kind: "profile", name };
  }
  if (target.kind === "page" && !slugFormatError(target.slug)) return { kind: "page", slug: target.slug };
  throw new Error("Choose a valid page or password profile.");
}
async function operationFingerprint(store: StoreContext, target: PasswordTarget, state: PasswordSettings): Promise<string> {
  const marker = JSON.parse(await readOrdinaryFile(join(store.root, "store.json"), 4096, false));
  if (marker.id !== store.id || marker.schema !== 1) throw new Error("The selected store changed. Start a new password operation.");
  const parts: unknown[] = [store.id, store.root, target];
  if (target.kind === "page") {
    await requirePage(store, target.slug);
    const candidates: unknown[] = [];
    for (const [directory, extension] of [["raw", "html"], ["digests", "mdx"]]) {
      const path = join(store.root, directory, `${target.slug}.${extension}`);
      try {
        const info = await lstat(path);
        if (!info.isFile()) throw new Error("Password target must have an ordinary source file.");
        const source = await readOrdinaryFile(path, 67_108_864, false);
        candidates.push([directory, info.dev, info.ino, info.mtimeMs, createHash("sha256").update(source).digest("hex")]);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (candidates.length !== 1) throw new Error("The page source changed or is ambiguous. Start a new password operation.");
    const access = await readAccessManifest(store.root), sharing = (await readSharingManifest(store)).pages;
    parts.push(candidates[0], Object.hasOwn(access, target.slug) ? access[target.slug] : null, Object.hasOwn(sharing, target.slug) ? sharing[target.slug] : null, Object.hasOwn(state.bindings, target.slug) ? state.bindings[target.slug] : null);
  } else {
    const profile = target.kind === "default" ? "default" : target.name;
    parts.push(Object.hasOwn(state.profiles, profile) ? state.profiles[profile] : null, profile === "default" ? state.protectNewPages : null);
  }
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
/** Opaque guard kept only in the local operation; never an emitted result. */
export async function capturePasswordOperation(store: StoreContext, input: PasswordTarget): Promise<string> {
  const target = normalizePasswordTarget(input);
  return locked(store, async () => operationFingerprint(store, target, await load(store)));
}
/** Caller holds the short store operation lock, after the human finishes entering a password. */
export async function savePasswordOperation(store: StoreContext, input: PasswordTarget, entry: AccessEntry, expected: string, options: { protectNewPages?: boolean } = {}): Promise<PasswordSaved> {
  const target = normalizePasswordTarget(input);
  validatePasswordEntry(entry);
  if (options.protectNewPages !== undefined && (target.kind !== "default" || typeof options.protectNewPages !== "boolean")) throw new Error("Only a default password controls automatic protection.");
  return locked(store, async () => {
    const state = await load(store);
    if (await operationFingerprint(store, target, state) !== expected) throw new Error("This page or password setting changed while the form was open. Start a new password operation.");
    if (target.kind === "page") await assign(store, state, target.slug, entry, { kind: "custom" });
    else {
      state.profiles[target.kind === "default" ? "default" : target.name] = { ...entry };
      if (options.protectNewPages !== undefined) state.protectNewPages = options.protectNewPages;
    }
    await writePrivateJson(passwordSettingsPath(store), state);
    return target.kind === "page"
      ? { saved: true, storeId: store.id, target: "page", slug: target.slug, publicationRequired: await publicationRequired(store) }
      : { saved: true, storeId: store.id, target: target.kind, profile: target.kind === "default" ? "default" : target.name, publicationRequired: false };
  });
}

export async function resolvePasswordTarget(input: string, stores: StoreContext[], options: { defaultStoreId?: string; origins?: Record<string, string> } = {}): Promise<{ store: StoreContext; slug: string }> {
  if (!/^https?:\/\//iu.test(input)) {
    const store = options.defaultStoreId ? stores.find(item => item.id === options.defaultStoreId) : stores.length === 1 ? stores[0] : undefined;
    if (!store) throw new Error("Choose the store for this page password.");
    await requirePage(store, input);
    return { store, slug: input };
  }
  let url: URL;
  try { url = new URL(input); } catch { throw new Error("Invalid page URL."); }
  if (url.username || url.password || url.search || url.hash || url.protocol !== "https:") throw new Error("Use the clean HTTPS URL of a page in a registered store.");
  const originalPath = /^https:\/\/[^/?#]+(\/[^?#]*)?/iu.exec(input)?.[1] ?? "/";
  const path = input.includes("\\") ? undefined : normalizedRequestPath(originalPath);
  const match = path && /^\/([a-z0-9][a-z0-9-]*)(?:\/|\.(?:html|mdx)\/?)?$/u.exec(path);
  if (!match || slugFormatError(match[1])) throw new Error("The URL does not identify a page slug.");
  const slug = match[1];
  const matches: StoreContext[] = [];
  for (const store of stores) {
    const origins = new Set<string>();
    const explicit = options.origins?.[store.id];
    if (explicit) { try { origins.add(new URL(explicit).origin); } catch {} }
    const currentOrigin = await getStorePublicOrigin(store);
    if (currentOrigin) origins.add(currentOrigin);
    if (origins.has(url.origin) && (await slugs(store)).includes(slug)) matches.push(store);
  }
  if (matches.length !== 1) throw new Error(matches.length ? "That page URL is ambiguous across registered stores." : "That page URL is not known in the registered stores.");
  return { store: matches[0], slug };
}
