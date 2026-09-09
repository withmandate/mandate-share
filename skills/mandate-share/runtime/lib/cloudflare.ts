import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { protectedRoutePatterns } from "./access-core.ts";

export interface PublisherConfig {
  worker: string;
  accountId: string;
  workersDev?: true;
  workersDevSubdomain?: string;
  hostname?: string;
}

export interface WranglerConfig {
  name: string;
  account_id: string;
  compatibility_date: string;
  workers_dev: boolean;
  preview_urls: false;
  main: string;
  ratelimits: Array<{ name: string; namespace_id: string; simple: { limit: number; period: 60 } }>;
  routes?: Array<{ pattern: string; custom_domain: true }>;
  assets: {
    directory: string;
    html_handling: "auto-trailing-slash";
    not_found_handling: "404-page";
    binding: "ASSETS";
    run_worker_first: string[];
  };
}

export const localConfigDir = (root: string): string => join(root, ".mandate-share");
export const publisherConfigPath = (root: string): string => join(localConfigDir(root), "publisher.json");

export function validatePublisherConfig(input: unknown): PublisherConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("publisher config must be an object");
  if (Object.keys(input).some((key) => !["worker", "accountId", "workersDev", "workersDevSubdomain", "hostname"].includes(key))) {
    throw new Error("publisher config contains an unsupported field");
  }
  const candidate = input as Partial<PublisherConfig>;
  if (typeof candidate.worker !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(candidate.worker)) {
    throw new Error("Worker name must be 1-63 lowercase letters, digits, or hyphens and cannot start or end with a hyphen");
  }
  if (typeof candidate.accountId !== "string" || !/^[a-f0-9]{32}$/u.test(candidate.accountId)) {
    throw new Error("account ID must contain 32 lowercase hexadecimal characters");
  }
  if (candidate.workersDev !== undefined && candidate.workersDev !== true) throw new Error("workersDev must be true when supplied");
  const hasWorkersDev = candidate.workersDev === true;
  const hasHostname = typeof candidate.hostname === "string" && candidate.hostname.length > 0;
  if (candidate.workersDevSubdomain !== undefined && (!hasWorkersDev || typeof candidate.workersDevSubdomain !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(candidate.workersDevSubdomain))) throw new Error("workers.dev account subdomain must be a valid DNS label on a workers.dev target");
  if (Number(hasWorkersDev) + Number(hasHostname) !== 1 || (candidate.hostname !== undefined && !hasHostname)) {
    throw new Error("publisher config must choose exactly one of workersDev or hostname");
  }
  if (hasHostname) {
    const hostname = candidate.hostname!.toLowerCase();
    if (hostname.length > 253 || !hostname.includes(".") ||
      !hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) {
      throw new Error("hostname must be a bare DNS hostname such as share.example.com, without scheme, path, or port");
    }
    return { worker: candidate.worker, accountId: candidate.accountId, hostname };
  }
  return { worker: candidate.worker, accountId: candidate.accountId, workersDev: true, ...(candidate.workersDevSubdomain ? { workersDevSubdomain: candidate.workersDevSubdomain } : {}) };
}

/** Config paths are relative to one private candidate, never to the installed runtime. */
export function generatedWranglerConfig(config: PublisherConfig, protectedSlugs: Iterable<string>): WranglerConfig {
  const target = validatePublisherConfig(config);
  const protectedRoutes = protectedRoutePatterns(protectedSlugs);
  return {
    name: target.worker,
    account_id: target.accountId,
    compatibility_date: "2026-08-26",
    workers_dev: target.workersDev === true,
    preview_urls: false,
    main: "./worker/index.ts",
    ratelimits: [{
      name: "PASSWORD_ATTEMPTS",
      // Stable per destination; avoid borrowing another application's counter namespace.
      namespace_id: BigInt(`0x${createHash("sha256").update(`mandate-share:password-attempts:${target.accountId}:${target.worker}`).digest("hex").slice(0, 15)}`).toString(),
      simple: { limit: 10, period: 60 },
    }],
    ...(target.hostname ? { routes: [{ pattern: target.hostname, custom_domain: true as const }] } : {}),
    assets: {
      directory: "./assets",
      html_handling: "auto-trailing-slash",
      not_found_handling: "404-page",
      binding: "ASSETS",
      // Every response needs the selected page's privacy and search policy, including raw HTML.
      run_worker_first: ["/*"],
    },
  };
}

export async function readPublisherConfig(root: string): Promise<PublisherConfig> {
  const path = publisherConfigPath(root);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("publisher config must be a regular file");
    return validatePublisherConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("publisher is not configured; run mandate-share setup with an account, Worker, and workers.dev or hostname target");
    }
    if (error instanceof SyntaxError) throw new Error("publisher config is not valid JSON");
    throw error;
  }
}

export async function writePublisherConfig(root: string, config: PublisherConfig): Promise<string> {
  const validated = validatePublisherConfig(config);
  const directory = localConfigDir(root);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("publisher state directory must not be a symlink");
  await chmod(directory, 0o700);
  const path = publisherConfigPath(root);
  const temporary = join(directory, `.publisher-${randomUUID()}.json`);
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  return path;
}
