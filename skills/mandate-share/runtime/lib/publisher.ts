import { chmod, cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { assertPublishable, isHomepageCurrent, readPagePolicies } from "./privacy.ts";
import { assertOnboardingReady, providerEnvironment, withExplicitPublisherTransition, type OnboardingProvider } from "./onboarding.ts";
import type { StoreContext } from "./context.ts";
import { buildAll } from "./build.ts";
import { getAccessContext, readAccessManifest, validateAccessManifest } from "./access.ts";
import { configHome, listStores } from "./store.ts";
import { generatedWranglerConfig, publisherConfigPath, readPublisherConfig, validatePublisherConfig, writePublisherConfig, type PublisherConfig } from "./cloudflare.ts";
import { assertReleaseConfirmation, assertAssetLimits, assertHeaderLimits, createReleasePlan, hashBytes, hashJson, inventoryFromFiles, releaseFiles, releaseInventory, type ReleaseFile, type ReleaseInventory, type ReleasePlan, type ReleaseTarget } from "./release.ts";

export interface WranglerInvocation {
  command: string[];
  cwd: string;
  env: Record<string, string>;
  phase: "compile" | "validate" | "publish";
  expectedWorker: string;
}
export type WranglerRunner = (invocation: WranglerInvocation) => Promise<{ code: number; stdout?: string; stderr?: string; versionId?: string; url?: string }>;
export interface PublisherOptions {
  /** Programmatic test boundary; the public CLI never accepts a runner or build override. */
  runner?: WranglerRunner;
  build?: (store: StoreContext) => Promise<unknown>;
  knownStores?: StoreContext[];
  provider?: OnboardingProvider;
}
export interface ReleaseSummary {
  store: { id: string; name: string };
  candidatePath: string;
  plan: ReleasePlan;
  uploaded: false;
  receiptBasis: "last successful local receipt; remote state has not been checked";
}
export interface PublishResult {
  store: { id: string; name: string };
  digest: string;
  target: ReleaseTarget;
  uploaded: true;
  receiptPath: string;
  remoteVerified: false;
  url?: string;
  versionId?: string;
}
interface Receipt {
  schema: "mandate-share.receipt/v1";
  store: ReleasePlan["store"];
  target: ReleaseTarget;
  digest: string;
  publishedAt: string;
  assets: ReleaseInventory;
  remoteVerified: false;
  versionId?: string;
  url?: string;
}
const receiptPath = (store: StoreContext): string => join(store.stateDir, "last-release.json");
const activePath = (store: StoreContext): string => join(store.stateDir, "release-active.json");
const releaseRoot = (store: StoreContext): string => join(store.stateDir, "releases");

async function optionalFile(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("publisher state must contain regular files");
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function readJson(path: string): Promise<unknown> {
  const value = await optionalFile(path);
  if (value === undefined) throw new Error("saved release state is missing; run plan again");
  try { return JSON.parse(value); } catch { throw new Error("saved release state is not valid JSON; run plan again"); }
}
async function writePrivate(path: string, value: string): Promise<void> {
  await writeFile(path, value, { mode: 0o600, flag: "wx" });
}
async function replaceJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writePrivate(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}
async function secureTree(root: string): Promise<void> {
  const inventory = await releaseInventory(root);
  await chmod(root, 0o700);
  for (const file of inventory.files) await chmod(join(root, file.path), 0o600);
}
async function assertStore(store: StoreContext): Promise<ReleasePlan["store"]> {
  const canonical = await realpath(store.root);
  if (canonical !== store.root || store.stateDir !== join(store.root, ".mandate-share") || store.outDir !== join(store.stateDir, "dist")) {
    throw new Error("publisher requires a canonical store context");
  }
  const marker = await readJson(join(store.root, "store.json")) as { schema?: number; id?: string };
  if (marker.schema !== 1 || marker.id !== store.id) throw new Error("publisher store identity changed; select the store again");
  await mkdir(store.stateDir, { recursive: true, mode: 0o700 });
  if ((await realpath(store.stateDir)) !== store.stateDir) throw new Error("publisher state cannot escape the store through a symlink");
  await chmod(store.stateDir, 0o700);
  return { id: store.id, rootFingerprint: hashBytes(canonical) };
}
async function withLock<T>(store: StoreContext, work: () => Promise<T>): Promise<T> {
  await assertStore(store);
  const lock = join(store.stateDir, "publisher.lock");
  try { await mkdir(lock, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("another publisher operation is active; if it exited, remove the store's publisher.lock directory and run plan again");
    throw error;
  }
  try { return await work(); } finally { await rm(lock, { recursive: true, force: true }); }
}
function targetFor(config: PublisherConfig): ReleaseTarget {
  return { worker: config.worker, accountFingerprint: hashBytes(config.accountId), ...(config.hostname ? { hostname: config.hostname } : { workersDev: true as const, ...(config.workersDevSubdomain ? { workersDevSubdomain: config.workersDevSubdomain } : {}) }) };
}
async function checkBindings(store: StoreContext, config: PublisherConfig, knownStores?: StoreContext[]): Promise<void> {
  for (const other of knownStores ?? await listStores()) {
    if (other.root === store.root && other.id === store.id) continue;
    if (await optionalFile(publisherConfigPath(other.root)) === undefined) continue;
    const bound = await readPublisherConfig(other.root);
    if ((bound.accountId === config.accountId && bound.worker === config.worker) || (bound.hostname && bound.hostname === config.hostname)) {
      throw new Error(`Cloudflare destination is already bound to store "${other.name}"; independent stores need separate Workers and hostnames`);
    }
  }
}
export async function assertPublisherBinding(store: StoreContext, knownStores?: StoreContext[]): Promise<void> {
  await assertStore(store);
  await checkBindings(store, await readPublisherConfig(store.root), knownStores);
}
export async function assertDestinationAvailable(store: StoreContext, config: PublisherConfig, knownStores?: StoreContext[]): Promise<void> {
  await assertStore(store);
  await checkBindings(store, validatePublisherConfig(config), knownStores);
}
export async function setupPublisher(store: StoreContext, input: PublisherConfig, knownStores?: StoreContext[], options: { guided?: boolean } = {}): Promise<string> {
  return withLock(store, async () => {
    const config = validatePublisherConfig(input);
    // Serialize real CLI setup calls across stores, so two simultaneous bindings cannot both pass the check.
    const directory = knownStores === undefined ? configHome() : undefined;
    const lock = directory ? join(directory, "publisher-bindings.lock") : undefined;
    if (directory) await mkdir(directory, { recursive: true, mode: 0o700 });
    if (lock) {
      try { await mkdir(lock, { mode: 0o700 }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("another publisher setup is active; retry after it finishes (remove publisher-bindings.lock only after checking that its process exited)");
        throw error;
      }
    }
    try {
      await checkBindings(store, config, knownStores);
      const write = () => writePublisherConfig(store.root, config);
      return options.guided ? await write() : await withExplicitPublisherTransition(store, config, write);
    } finally { if (lock) await rm(lock, { recursive: true, force: true }); }
  });
}
async function inputInventory(root: string, paths: string[]): Promise<ReleaseInventory> {
  const files: ReleaseFile[] = [];
  for (const path of paths) {
    let info;
    try { info = await lstat(join(root, path)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (info.isDirectory()) {
      for (const file of (await releaseInventory(join(root, path))).files) files.push({ ...file, path: `${path}/${file.path}` });
    } else files.push(...await releaseFiles(root, [path]));
  }
  return inventoryFromFiles(files);
}
const sourceInventory = (store: StoreContext): Promise<ReleaseInventory> => inputInventory(store.root, ["store.json", "digests", "raw", "access", "components", ".mandate-share/passwords.json"]);
const contentInventory = (store: StoreContext): Promise<ReleaseInventory> => inputInventory(store.root, ["store.json", "digests", "raw", "components"]);
async function runtimeInventory(store: StoreContext): Promise<ReleaseInventory> {
  const files = (await inputInventory(store.runtimeRoot, ["package.json", "package-lock.json", "lib", "components", "styles", "cli.ts"])).files;
  // The installed lock and actual Wrangler executable are part of the confirmation.
  await releaseFiles(store.runtimeRoot, ["node_modules/wrangler/package.json", "node_modules/wrangler/bin/wrangler.js", "node_modules/wrangler/wrangler-dist/cli.js"]);
  // npm creates executable links inside dependencies. Hash the link and its confined target bytes.
  const dependencies = join(store.runtimeRoot, "node_modules");
  async function walkDependency(path: string): Promise<void> {
    const info = await lstat(path);
    if (info.isDirectory()) { for (const entry of await readdir(path)) await walkDependency(join(path, entry)); return; }
    if (!info.isFile() && !info.isSymbolicLink()) throw new Error("publishing dependencies contain a special file");
    const resolved = await realpath(path);
    if (!resolved.startsWith(`${dependencies}${sep}`) || !(await lstat(resolved)).isFile()) throw new Error("publishing dependency link escapes its installation");
    const bytes = await readFile(resolved);
    files.push({ path: relative(store.runtimeRoot, path).split(sep).join("/"), bytes: bytes.byteLength, hash: info.isSymbolicLink() ? hashJson([await readlink(path), hashBytes(bytes)]) : hashBytes(bytes) });
  }
  for (const path of ["wrangler", "esbuild", "@esbuild", "tsx", "miniflare", "workerd", "@cloudflare"]) {
    try { await walkDependency(join(dependencies, path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const bytes = await readFile(process.execPath);
  files.push({ path: "tool/node-executable", bytes: bytes.byteLength, hash: hashBytes(bytes) });
  return inventoryFromFiles(files);
}
async function receipt(store: StoreContext): Promise<{ hash: string | null; value?: Receipt }> {
  const text = await optionalFile(receiptPath(store));
  if (text === undefined) return { hash: null };
  let value: Receipt;
  try { value = JSON.parse(text); } catch { throw new Error("last local receipt is invalid"); }
  if (value.schema !== "mandate-share.receipt/v1" || hashJson(value.store) !== hashJson(await assertStore(store)) || !Array.isArray(value.assets?.files)) {
    throw new Error("last local receipt belongs to a different store or is invalid");
  }
  return { hash: hashBytes(text), value };
}

/** No inherited account, .env, proxy, code-injection, or endpoint override enters a dry run. */
export async function wranglerInvocation(store: StoreContext, candidate: string, phase: WranglerInvocation["phase"]): Promise<WranglerInvocation> {
  const executable = process.execPath;
  const payload = join(candidate, "payload");
  const sandbox = join(candidate, "provider-state");
  await mkdir(sandbox, { recursive: true, mode: 0o700 });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "", XDG_CONFIG_HOME: sandbox, XDG_CACHE_HOME: sandbox,
    TMPDIR: sandbox, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG: phase === "publish" ? "log" : "error", WRANGLER_LOG_SANITIZE: "true",
    WRANGLER_LOG_PATH: join(sandbox, "wrangler.log"), CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    CI: "true", NO_COLOR: "1", WRANGLER_WRITE_LOGS: "false",
  };
  if (phase === "publish") {
    delete env.XDG_CONFIG_HOME;
    // Provider-managed OAuth remains in its ordinary home. Tokens are accepted only from the process environment.
    Object.assign(env, providerEnvironment());
  } else {
    // Fails closed if a future Wrangler dry-run unexpectedly attempts a Cloudflare API call.
    env.CLOUDFLARE_API_BASE_URL = "http://127.0.0.1:1";
    env.CF_API_BASE_URL = "http://127.0.0.1:1";
  }
  const command = [executable, join(store.runtimeRoot, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--config", join(payload, phase === "compile" ? "compile.json" : "deploy.json"), "--env-file", join(payload, "empty.env")];
  if (phase !== "publish") command.push("--profile", `mandate-share-plan-${candidate.split("/").pop()}`);
  else command.push("--profile", "default");
  if (phase === "compile") command.push("--dry-run", "--outdir", join(payload, "bundle"));
  else command.push("--no-bundle");
  if (phase === "validate") command.push("--dry-run", "--outdir", join(candidate, "validation"));
  const config = await readJson(join(payload, "deploy.json")) as { name: string };
  return { command, cwd: payload, env, phase, expectedWorker: config.name };
}
export function parseProviderOutput(stdout: string, expectedWorker: string): { versionId?: string; url?: string } {
  const versionId = /Current Version ID:\s*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/iu.exec(stdout)?.[1];
  let url: string | undefined;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(expectedWorker)) return {};
  const hostname = new RegExp(`^${expectedWorker}\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.workers\\.dev$`, "u");
  for (const match of stdout.matchAll(/https:\/\/[^\s]+/gu)) {
    try {
      const candidate = new URL(match[0]);
      if (candidate.protocol === "https:" && hostname.test(candidate.hostname) && !candidate.username && !candidate.password && !candidate.port && candidate.pathname === "/" && !candidate.search && !candidate.hash && (match[0] === candidate.origin || match[0] === `${candidate.origin}/`)) url = candidate.origin;
    } catch { /* Ignore provider text that is not an exact destination URL. */ }
  }
  return { ...(versionId ? { versionId } : {}), ...(url ? { url } : {}) };
}
export const runWrangler: WranglerRunner = async ({ command, cwd, env, phase, expectedWorker }) => {
  // Capture both pipes; never include provider output in an error or receipt.
  const { stdout, code } = await new Promise<{ stdout: string; code: number }>((resolve) => {
    const child = execFile(command[0], command.slice(1), { cwd, env, maxBuffer: 8 * 1024 * 1024, timeout: 300_000, windowsHide: true }, (error, stdout) => resolve({ stdout, code: error ? typeof error.code === "number" ? error.code : -1 : 0 }));
    child.stdin?.end();
  });
  const result = parseProviderOutput(stdout, expectedWorker);
  // Cancellation can exit zero. Record success only after Wrangler confirms an uploaded version.
  if (phase === "publish" && code === 0 && !result.versionId) return { code: -1 };
  return { code, ...result };
};
async function invoke(store: StoreContext, candidate: string, phase: WranglerInvocation["phase"], options: PublisherOptions): Promise<{ versionId?: string; url?: string }> {
  let result;
  const invocation = await wranglerInvocation(store, candidate, phase);
  try { result = await (options.runner ?? runWrangler)(invocation); }
  catch { throw new Error(`Wrangler ${phase} could not start; check the pinned runtime installation and Node.js 22+`); }
  if (result.code !== 0) {
    if (phase === "publish") throw new Error("Wrangler publish failed or its result is uncertain; this confirmation is consumed. Check the destination in Cloudflare before preparing another release. Provider output was withheld to protect credentials.");
    throw new Error(`Wrangler ${phase} failed (exit ${result.code}); nothing uploaded. Check the runtime installation and generated candidate configuration. Provider output was withheld to protect credentials.`);
  }
  const parsed = parseProviderOutput(`${result.stdout ?? ""}\n${result.url ?? ""}`, invocation.expectedWorker);
  return { ...parsed, ...(result.versionId && /^[a-f0-9-]{36}$/u.test(result.versionId) ? { versionId: result.versionId } : {}) };
}
function workerSource(manifest: unknown, context: unknown, policy: unknown): string {
  return `import { gateAccessRequest, validateAccessManifest } from "./access-core.ts";
const manifest = ${JSON.stringify(manifest)};
const context = ${JSON.stringify(context)};
const policy = ${JSON.stringify(policy)};
validateAccessManifest(manifest);
export default {
  fetch(request: Request, env: { ASSETS: { fetch(request: Request): Promise<Response> }; PASSWORD_ATTEMPTS: { limit(options: { key: string }): Promise<{ success: boolean }> } }) {
    const url = new URL(request.url);
    if (url.protocol !== "https:") {
      const headers = new Headers({ "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });
      if (url.protocol === "http:" && (request.method === "GET" || request.method === "HEAD")) {
        url.protocol = "https:";
        headers.set("location", url.href);
        return new Response(null, { status: 308, headers });
      }
      return new Response(null, { status: 400, headers });
    }
    return gateAccessRequest(request, manifest, (assetRequest) => env.ASSETS.fetch(assetRequest), context, {
      policy,
      checkPasswordAttempt: async (entry) => {
        const ip = request.headers.get("cf-connecting-ip");
        if (!ip || !/^[0-9a-fA-F:.]{3,45}$/.test(ip)) throw new Error("visitor address unavailable");
        // Cloudflare supplies the address. A profile shares its salt across page aliases.
        const { success } = await env.PASSWORD_ATTEMPTS.limit({ key: context.storeId + ":" + entry.salt + ":" + ip });
        return success;
      },
    });
  }
};
`;
}

export async function prepareRelease(store: StoreContext, options: PublisherOptions = {}): Promise<ReleaseSummary> {
  return withLock(store, async () => {
    const identity = await assertStore(store);
    const config = await readPublisherConfig(store.root);
    await checkBindings(store, config, options.knownStores);
    await assertOnboardingReady(store, options);
    const contentBefore = await contentInventory(store);
    const runtime = await runtimeInventory(store);
    const context = await getAccessContext(store);
    const previous = await receipt(store);
    await (options.build ?? buildAll)(store);
    if ((await contentInventory(store)).digest !== contentBefore.digest) throw new Error("store changed during build; run plan again");
    // Building can assign a saved default to new private pages. Freeze the resulting access policy.
    const policy = await assertPublishable(store);
    if (!options.build && !await isHomepageCurrent(store)) throw new Error("built homepage privacy is stale; run plan again");
    const sources = await sourceInventory(store);
    const manifest = await readAccessManifest(store.root);
    validateAccessManifest(manifest);
    const candidateId = randomUUID();
    await mkdir(releaseRoot(store), { recursive: true, mode: 0o700 });
    if (await realpath(releaseRoot(store)) !== releaseRoot(store)) throw new Error("release directory cannot be a symlink");
    const candidate = join(releaseRoot(store), candidateId);
    const payload = join(candidate, "payload");
    await mkdir(join(payload, "worker"), { recursive: true, mode: 0o700 });
    await mkdir(join(payload, "bundle"), { mode: 0o700 });
    assertAssetLimits(await releaseInventory(store.outDir));
    const headers = await optionalFile(join(store.outDir, "_headers"));
    if (headers !== undefined) assertHeaderLimits(headers);
    await cp(store.outDir, join(payload, "assets"), { recursive: true, dereference: false });
    const baseConfig = generatedWranglerConfig(config, Object.keys(manifest));
    await writePrivate(join(payload, "empty.env"), "");
    await writePrivate(join(payload, "compile.json"), `${JSON.stringify(baseConfig, null, 2)}\n`);
    await writePrivate(join(payload, "deploy.json"), `${JSON.stringify({ ...baseConfig, main: "./bundle/index.js" }, null, 2)}\n`);
    await writePrivate(join(payload, "worker/index.ts"), workerSource(manifest, context, policy));
    for (const file of ["access-core.ts", "unlock-client.ts", "privacy-core.ts", "slug.ts"]) {
      await writePrivate(join(payload, "worker", file), await readFile(join(store.runtimeRoot, "lib", file), "utf8"));
    }
    await invoke(store, candidate, "compile", options);
    await rm(join(payload, "bundle/README.md"), { force: true });
    await rm(join(payload, "bundle/index.js.map"), { force: true });
    const workerBundle = await releaseInventory(join(payload, "bundle"));
    if (workerBundle.files.length !== 1 || workerBundle.files[0].path !== "index.js") throw new Error("Wrangler produced an unexpected bundle; nothing uploaded");
    await invoke(store, candidate, "validate", options);
    await secureTree(candidate);
    const assets = await releaseInventory(join(payload, "assets"));
    // Assets belong to the Worker; changing its hostname does not create another asset namespace.
    const sameTarget = previous.value && previous.value.target.worker === config.worker && previous.value.target.accountFingerprint === hashBytes(config.accountId);
    const present = new Set(assets.files.map((file) => file.path));
    const removals = sameTarget ? previous.value!.assets.files.filter((file) => !present.has(file.path)).map((file) => file.path).sort() : [];
    const plan = createReleasePlan({
      schema: "mandate-share.release/v1", candidateId, preparedAt: new Date().toISOString(), store: identity,
      target: targetFor(config), protectedSlugs: Object.keys(manifest).sort(), accessManifestHash: hashJson(manifest),
      signingContextHash: hashJson(context), pagePolicyHash: hashJson(policy), sources, runtime, payload: await releaseInventory(payload), workerBundle, assets,
      previousLocalReceiptHash: previous.hash, removals,
    });
    await assertOnboardingReady(store, options);
    await assertCurrent(store, plan, options);
    await writePrivate(join(candidate, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
    await replaceJson(activePath(store), { candidateId, digest: plan.releaseDigest });
    return { store: { id: store.id, name: store.name }, candidatePath: candidate, plan, uploaded: false, receiptBasis: "last successful local receipt; remote state has not been checked" };
  });
}
async function assertCurrent(store: StoreContext, plan: ReleasePlan, options: PublisherOptions): Promise<void> {
  if (hashJson(plan.store) !== hashJson(await assertStore(store))) throw new Error("release belongs to a different store");
  const config = await readPublisherConfig(store.root);
  await checkBindings(store, config, options.knownStores);
  if (hashJson(targetFor(config)) !== hashJson(plan.target)) throw new Error("publisher target changed; run plan again");
  if ((await sourceInventory(store)).digest !== plan.sources.digest) throw new Error("store inputs changed; run plan again");
  if ((await runtimeInventory(store)).digest !== plan.runtime.digest) throw new Error("runtime or publishing tool changed; run plan again");
  if (hashJson(await readAccessManifest(store.root)) !== plan.accessManifestHash || hashJson(await getAccessContext(store)) !== plan.signingContextHash) throw new Error("access or signing state changed; run plan again");
  if (hashJson(await readPagePolicies(store)) !== plan.pagePolicyHash) throw new Error("page privacy changed; run plan again");
  if ((await receipt(store)).hash !== plan.previousLocalReceiptHash) throw new Error("local release receipt changed; run plan again");
}

export async function publishRelease(store: StoreContext, digest: string, options: PublisherOptions = {}): Promise<PublishResult> {
  assertReleaseConfirmation(digest, digest);
  return withLock(store, async () => {
    const active = await readJson(activePath(store)) as { candidateId?: string; digest?: string };
    if (typeof active.candidateId !== "string" || !/^[a-f0-9-]{36}$/u.test(active.candidateId) || active.digest !== digest) throw new Error("confirmation is stale or belongs to another store; run plan and review its inventory");
    const candidate = join(releaseRoot(store), active.candidateId);
    if (await realpath(candidate) !== candidate) throw new Error("saved candidate cannot contain a symlink");
    if (await optionalFile(join(candidate, "attempt.json")) !== undefined) throw new Error("this release confirmation has already been consumed; run plan again");
    const plan = await readJson(join(candidate, "plan.json")) as ReleasePlan;
    if (plan.schema !== "mandate-share.release/v1" || plan.candidateId !== active.candidateId) throw new Error("saved release plan is invalid");
    const { releaseDigest, ...core } = plan;
    assertReleaseConfirmation(digest, releaseDigest);
    assertReleaseConfirmation(digest, hashJson(core));
    await assertOnboardingReady(store, options);
    await assertCurrent(store, plan, options);
    if (hashJson(await releaseInventory(join(candidate, "payload"))) !== hashJson(plan.payload)) throw new Error("frozen release candidate changed; run plan again");
    // Consume before invoking the provider: an interrupted or ambiguous upload must not be replayed automatically.
    await writePrivate(join(candidate, "attempt.json"), `${JSON.stringify({ digest, startedAt: new Date().toISOString() })}\n`);
    const published = await invoke(store, candidate, "publish", options);
    const versionId = published.versionId;
    const url = plan.target.hostname ? `https://${plan.target.hostname}` : plan.target.workersDevSubdomain ? `https://${plan.target.worker}.${plan.target.workersDevSubdomain}.workers.dev` : published.url;
    const value: Receipt = { schema: "mandate-share.receipt/v1", store: plan.store, target: plan.target, digest, publishedAt: new Date().toISOString(), assets: plan.assets, remoteVerified: false, ...(versionId ? { versionId } : {}), ...(url ? { url } : {}) };
    await replaceJson(receiptPath(store), value);
    return { store: { id: store.id, name: store.name }, digest, target: plan.target, uploaded: true, receiptPath: receiptPath(store), remoteVerified: false, ...(versionId ? { versionId } : {}), ...(url ? { url } : {}) };
  });
}
