import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export interface ReleaseFile { path: string; bytes: number; hash: string }
export interface ReleaseInventory { files: ReleaseFile[]; bytes: number; digest: string }
export const MAX_ASSET_FILES = 20_000;
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;

/** Conservative Free-plan limits; larger paid-plan destinations are not inferred. */
export function assertAssetLimits(inventory: ReleaseInventory): void {
  if (inventory.files.length > MAX_ASSET_FILES) throw new Error(`release exceeds ${MAX_ASSET_FILES} asset files`);
  if (inventory.files.some(file => file.bytes > MAX_ASSET_BYTES)) throw new Error("release contains an asset larger than 25 MiB");
}

export function assertHeaderLimits(contents: string): void {
  const lines = contents.split(/\r?\n/u);
  if (lines.some(line => line.length > 2_000)) throw new Error("release header line exceeds 2,000 characters");
  const rules = lines.filter(line => line.trim() && !/^\s|#/u.test(line));
  if (rules.length > 100) throw new Error("release exceeds 100 header rules");
}
export interface ReleaseTarget { worker: string; accountFingerprint: string; workersDev?: true; workersDevSubdomain?: string; hostname?: string }
export interface ReleasePlan {
  schema: "mandate-share.release/v1";
  candidateId: string;
  preparedAt: string;
  store: { id: string; rootFingerprint: string };
  target: ReleaseTarget;
  protectedSlugs: string[];
  accessManifestHash: string;
  signingContextHash: string;
  pagePolicyHash: string;
  sources: ReleaseInventory;
  runtime: ReleaseInventory;
  payload: ReleaseInventory;
  workerBundle: ReleaseInventory;
  assets: ReleaseInventory;
  previousLocalReceiptHash: string | null;
  removals: string[];
  releaseDigest: string;
}

export function hashBytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export const hashJson = (value: unknown): string => hashBytes(canonicalJson(value));

export function createReleasePlan(input: Omit<ReleasePlan, "releaseDigest">): ReleasePlan {
  return { ...input, releaseDigest: hashJson(input) };
}

function safeRelativePath(path: string): void {
  if (!path || isAbsolute(path) || path.split(/[\\/]/u).some((part) => !part || part === "." || part === "..")) {
    throw new Error("release contains an unsafe relative path");
  }
}

export async function releaseFiles(root: string, paths: Iterable<string>): Promise<ReleaseFile[]> {
  const files: ReleaseFile[] = [];
  for (const path of [...new Set(paths)].sort()) {
    safeRelativePath(path);
    let current = root;
    for (const part of path.split("/")) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new Error("release inputs cannot contain symlinks");
    }
    if (!(await lstat(current)).isFile()) throw new Error("release inputs must be regular files");
    const content = await readFile(current);
    files.push({ path, bytes: content.byteLength, hash: hashBytes(content) });
  }
  return files;
}

export function inventoryFromFiles(files: ReleaseFile[]): ReleaseInventory {
  const ordered = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files: ordered, bytes: ordered.reduce((sum, file) => sum + file.bytes, 0), digest: hashJson(ordered) };
}

/** Symlinks and special files fail closed; nothing can silently escape the inventory. */
export async function releaseInventory(root: string): Promise<ReleaseInventory> {
  const paths: string[] = [];
  async function walk(directory: string): Promise<void> {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("release directory must not be a symlink");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) paths.push(relative(root, path).split(sep).join("/"));
      else throw new Error("release inputs cannot contain symlinks or special files");
    }
  }
  await walk(root);
  return inventoryFromFiles(await releaseFiles(root, paths));
}

export function assertReleaseConfirmation(expected: string | undefined, actual: string): void {
  if (!expected || !/^[a-f0-9]{64}$/u.test(expected)) throw new Error("publish requires a lowercase 64-character release digest from plan");
  if (expected !== actual) throw new Error("release confirmation does not match the saved candidate; run plan and review its inventory");
}
