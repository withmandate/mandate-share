import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { StoreContext } from "./context.ts";

export const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const configHome = (): string => resolve(process.env.MANDATE_SHARE_HOME || join(homedir(), ".config", "mandate-share"));
export const cacheHome = (): string => resolve(process.env.MANDATE_SHARE_CACHE || join(homedir(), ".cache", "mandate-share"));
export const registryPath = (): string => join(configHome(), "config.json");
interface Registry { schema: 1; defaultStore?: string; stores: Record<string, { root: string }> }
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function readRegistry(): Promise<Registry> {
  if (!existsSync(registryPath())) return { schema: 1, stores: {} };
  let input: unknown;
  try { input = JSON.parse(await readFile(registryPath(), "utf8")); }
  catch { throw new Error("Store registry is unreadable or invalid JSON; repair config.json before continuing."); }
  const r = input as Registry;
  if (!r || r.schema !== 1 || !r.stores || typeof r.stores !== "object" || Array.isArray(r.stores) ||
      Object.keys(r).some(k => !["schema", "defaultStore", "stores"].includes(k))) throw new Error("Unsupported store registry.");
  for (const [name, entry] of Object.entries(r.stores)) {
    if (!NAME.test(name) || !entry || typeof entry.root !== "string" || !isAbsolute(entry.root) ||
        Object.keys(entry).some(k => k !== "root")) throw new Error("Invalid store registry entry.");
  }
  if (r.defaultStore !== undefined && (typeof r.defaultStore !== "string" || !Object.hasOwn(r.stores, r.defaultStore))) {
    throw new Error("Default store does not exist in the registry.");
  }
  return r;
}

/** Canonicalize even a path whose final directories have not been created yet. */
async function physicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  let parent = absolute;
  const tail: string[] = [];
  while (!existsSync(parent)) {
    if (dirname(parent) === parent) throw new Error("Cannot resolve store path.");
    tail.unshift(basename(parent)); parent = dirname(parent);
  }
  return join(await realpath(parent), ...tail);
}
const contains = (parent: string, child: string): boolean => child === parent || child.startsWith(parent + sep);

async function validateRoot(input: string, others: StoreContext[] = []): Promise<string> {
  if (!input || !isAbsolute(input)) throw new Error("Store path must be absolute.");
  const root = await physicalPath(input);
  if (root === dirname(root) || root === await physicalPath(homedir())) throw new Error("Choose a dedicated store folder, not the home or filesystem root.");
  const packageRoot = resolve(runtimeRoot, "..");
  const reservedRoots = [packageRoot, configHome(), cacheHome()];
  if (process.env.MANDATE_SHARE_INSTALLED_SKILL) reservedRoots.push(process.env.MANDATE_SHARE_INSTALLED_SKILL);
  let ancestor = runtimeRoot;
  while (dirname(ancestor) !== ancestor) {
    if (existsSync(join(ancestor, ".git"))) { reservedRoots.push(ancestor); break; }
    ancestor = dirname(ancestor);
  }
  for (const reserved of reservedRoots) {
    const path = await physicalPath(reserved);
    if (contains(root, path) || contains(path, root)) throw new Error("Store folders must be separate from the installed tool, configuration, and runtime cache.");
  }
  for (const other of others) {
    if (contains(root, other.root) || contains(other.root, root)) throw new Error(`Store overlaps registered store '${other.name}'.`);
  }
  return root;
}

export async function contextForRoot(input: string, name?: string): Promise<StoreContext> {
  const root = await validateRoot(input);
  if (await physicalPath(join(root, "store.json")) !== join(root, "store.json")) throw new Error("Store marker must not be a symlink.");
  let marker: { schema?: number; id?: string };
  try { marker = JSON.parse(await readFile(join(root, "store.json"), "utf8")); }
  catch { throw new Error("This folder is not an initialized store; use store add first."); }
  if (marker.schema !== 1 || typeof marker.id !== "string" || !/^[a-f0-9-]{36}$/.test(marker.id) ||
      Object.keys(marker).some(k => !["schema", "id"].includes(k))) throw new Error("Invalid store.json marker.");
  const stateDir = join(root, ".mandate-share");
  for (const directory of ["digests", "raw", "access", "components", ".mandate-share"]) {
    const actual = await physicalPath(join(root, directory));
    if (actual !== join(root, directory)) throw new Error(`Store directory '${directory}' must not be a symlink.`);
  }
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  return { id: marker.id, name: name ?? basename(root), root, runtimeRoot, stateDir, outDir: join(stateDir, "dist") };
}

export async function listStores(): Promise<StoreContext[]> {
  const registry = await readRegistry();
  const stores: StoreContext[] = [];
  for (const name of Object.keys(registry.stores).sort()) {
    const context = await contextForRoot(registry.stores[name]!.root, name);
    if (stores.some(s => s.id === context.id || contains(s.root, context.root) || contains(context.root, s.root))) {
      throw new Error("Registered stores overlap or reuse the same store identity.");
    }
    stores.push(context);
  }
  return stores;
}

export async function resolveStore(name?: string, root?: string): Promise<StoreContext> {
  if (name && root) throw new Error("Choose --store or --store-root, not both.");
  if (root) {
    const context = await contextForRoot(root);
    for (const other of await listStores()) {
      if (other.root === context.root && other.id === context.id) return other;
      if (other.id === context.id || contains(other.root, context.root) || contains(context.root, other.root)) throw new Error("Explicit store root overlaps or duplicates a registered store.");
    }
    return context;
  }
  const registry = await readRegistry();
  const selected = name || registry.defaultStore;
  if (!selected) throw new Error("No default store. Run store add NAME --path /absolute/folder --default.");
  if (!Object.hasOwn(registry.stores, selected)) throw new Error(`Unknown store '${selected}'. Use store list.`);
  const stores = await listStores();
  return stores.find(s => s.name === selected)!;
}

export async function addStore(name: string, input: string, makeDefault = false): Promise<StoreContext> {
  if (!NAME.test(name)) throw new Error("Store name must use lowercase letters, digits, and hyphens.");
  return withLock(configHome(), async () => {
    const registry = await readRegistry();
    if (Object.hasOwn(registry.stores, name)) throw new Error(`Store '${name}' already exists.`);
    const root = await validateRoot(input, await listStores());
    await mkdir(root, { recursive: true, mode: 0o700 });
    const markerPath = join(root, "store.json");
    if (!existsSync(markerPath)) {
      const entries = await readdir(root);
      if (entries.some(e => ![".git", ".gitignore"].includes(e))) throw new Error("Choose an empty folder or an already initialized store.");
      const ignore = join(root, ".gitignore");
      try { if (!(await lstat(ignore)).isFile()) throw new Error("Existing .gitignore must be an ordinary file."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await atomicJson(markerPath, { schema: 1, id: randomUUID() });
      for (const folder of ["digests", "raw", "access", "components", ".mandate-share"]) {
        await mkdir(join(root, folder), { recursive: true, mode: 0o700 });
      }
      const previous = existsSync(ignore) ? await readFile(ignore, "utf8") : "";
      const temporary = `${ignore}.${randomUUID()}.tmp`;
      await writeFile(temporary, previous + (previous && !previous.endsWith("\n") ? "\n" : "") + ".mandate-share/\n.env*\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, ignore);
    }
    const context = await contextForRoot(root, name);
    if ((await listStores()).some(s => s.id === context.id)) throw new Error("That store identity is already registered.");
    registry.stores[name] = { root };
    if (makeDefault || !registry.defaultStore) registry.defaultStore = name;
    await atomicJson(registryPath(), registry);
    return context;
  });
}

export async function useStore(name: string): Promise<void> {
  await withLock(configHome(), async () => {
    const registry = await readRegistry();
    if (!Object.hasOwn(registry.stores, name)) throw new Error(`Unknown store '${name}'.`);
    await resolveStore(name);
    registry.defaultStore = name;
    await atomicJson(registryPath(), registry);
  });
}

/** Mutations serialize; a leftover lock is reported rather than silently stolen. */
export async function withLock<T>(directory: string, work: () => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, "operation.lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch { throw new Error(`Another operation holds ${lock}; retry after it finishes. If it crashed, inspect the owner file before removing the lock.`); }
  try {
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
    return await work();
  } finally { await rm(lock, { recursive: true, force: true }); }
}

export async function assertSourceFiles(root: string): Promise<void> {
  for (const folder of ["digests", "raw", "access", "components"]) {
    const base = join(root, folder);
    if (!existsSync(base)) continue;
    for (const entry of await readdir(base, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`Only regular files are supported in ${folder}/ (${entry.name}).`);
      const path = await realpath(join(base, entry.name));
      if (relative(base, path).startsWith("..")) throw new Error("Store source escapes its directory.");
    }
  }
}
