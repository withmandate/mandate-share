import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StoreContext } from "./context.ts";
import { slugFormatError } from "./slug.ts";
import {
  createPasswordEntry,
  validateAccessManifest,
  type AccessContext,
  type AccessManifest,
  type PasswordDirective,
} from "./access-core.ts";

export * from "./access-core.ts";

export const accessDir = (root: string): string => join(root, "access");
export const accessManifestPath = (root: string): string => join(accessDir(root), "manifest.json");
export const accessSigningKeyPath = (store: StoreContext): string => join(store.stateDir, "access-signing-key");

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export async function ensureDirectory(path: string, create: boolean): Promise<boolean> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("access state directory must be an ordinary directory");
    return true;
  } catch (error) {
    if (!create && missing(error)) return false;
    throw error;
  }
}

export async function readOrdinaryFile(path: string, maximumBytes: number, secret: boolean): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximumBytes) throw new Error("invalid access state file");
    if (secret && (info.mode & 0o077) !== 0) throw new Error("private state file permissions must be 0600; repair them before continuing");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function readAccessManifest(root: string): Promise<AccessManifest> {
  if (!(await ensureDirectory(accessDir(root), false))) return {};
  let source: string;
  try {
    source = await readOrdinaryFile(accessManifestPath(root), 1_048_576, false);
  } catch (error) {
    if (missing(error)) return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    // A parse exception can quote file contents. Keep potential secret material out of errors.
    throw new Error("access/manifest.json is not valid JSON");
  }
  validateAccessManifest(parsed);
  return parsed;
}

export async function writeAccessManifest(root: string, manifest: AccessManifest): Promise<void> {
  validateAccessManifest(manifest);
  await ensureDirectory(accessDir(root), true);
  const path = accessManifestPath(root);
  try {
    if (!(await lstat(path)).isFile()) throw new Error("access/manifest.json must be an ordinary file");
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const ordered = Object.fromEntries(Object.keys(manifest).sort().map((slug) => [slug, manifest[slug]]));
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(ordered, null, 2)}\n`);
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Store secrets are external user state and never part of access/manifest.json. */
export async function getAccessContext(store: StoreContext): Promise<AccessContext> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(store.id)) throw new Error("invalid access store identity");
  await ensureDirectory(store.stateDir, true);
  const path = accessSigningKeyPath(store);
  try {
    await lstat(path);
  } catch (error) {
    if (!missing(error)) throw error;
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")}\n`);
      } finally {
        await handle.close();
      }
      try {
        // Atomic create-if-absent: concurrent preview/build calls choose the same complete secret.
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
  const source = await readOrdinaryFile(path, 128, true);
  const signingKey = source.endsWith("\n") ? source.slice(0, -1) : source;
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(signingKey) || Buffer.from(signingKey, "base64").toString("base64") !== signingKey) {
    throw new Error("access signing key is invalid; restore the store's key or remove it to revoke all existing unlocks");
  }
  return { storeId: store.id, signingKey };
}

export async function applyPasswordDirective(
  root: string,
  slug: string,
  directive: PasswordDirective,
  existingManifest?: AccessManifest,
): Promise<"protected" | "unprotected" | "unchanged"> {
  const formatError = slugFormatError(slug);
  if (formatError) throw new Error(formatError);
  const manifest = { ...(existingManifest ?? (await readAccessManifest(root))) };
  validateAccessManifest(manifest);
  if (directive.kind === "preserve") return Object.hasOwn(manifest, slug) ? "protected" : "unprotected";
  if (directive.kind === "remove") {
    const existed = Object.hasOwn(manifest, slug);
    delete manifest[slug];
    if (existed) await writeAccessManifest(root, manifest);
    return "unprotected";
  }
  manifest[slug] = await createPasswordEntry(directive.password);
  await writeAccessManifest(root, manifest);
  return "protected";
}

/** Atomic private JSON replacement without following existing file or directory links. */
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await ensureDirectory(dirname(path), true);
  try { if (!(await lstat(path)).isFile()) throw new Error("Private state must be an ordinary file."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); } finally { await handle.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
