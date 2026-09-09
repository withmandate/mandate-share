import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StoreContext } from "./context.ts";
import { readPublisherConfig, validatePublisherConfig, type PublisherConfig } from "./cloudflare.ts";
import { configHome } from "./store.ts";
import { hashBytes, hashJson } from "./release.ts";

export interface CloudflareAccount { id: string; name: string }
export interface CloudflareIdentity { authenticated: boolean; accounts: CloudflareAccount[] }
export interface CloudflareWorker { exists: boolean; versionIds: string[] }
export interface CloudflareDomain { accountId: string; id: string; hostname: string; worker: string; environment: string; zoneId: string }
/** Injection is programmatic only. CLI flags never accept provider endpoints or credentials. */
export interface OnboardingProvider {
  identity(): Promise<CloudflareIdentity>;
  login(): Promise<void>;
  getSubdomain(accountId: string): Promise<string | null>;
  createSubdomain(accountId: string, subdomain: string): Promise<string>;
  getWorker(accountId: string, worker: string): Promise<CloudflareWorker>;
  /** Required for adopting a custom hostname; older injected providers may omit this capability. */
  getDomain?(accountId: string, hostname: string): Promise<CloudflareDomain | null>;
}
export interface OnboardingOptions { provider?: OnboardingProvider; knownStores?: StoreContext[] }
export interface OnboardingInput { accountId?: string; worker?: string; subdomain?: string }
export interface OnboardingProposal {
  digest: string;
  account: { name: string; fingerprint: string };
  worker: string;
  subdomain: string;
  url: string;
  actions: ("register-account-subdomain" | "save-store-destination")[];
}
export type OnboardingStatus =
  | { status: "login-required"; next: string }
  | { status: "choose-account"; accounts: CloudflareAccount[]; next: string }
  | { status: "ready"; proposal: OnboardingProposal; next: string }
  | { status: "configured"; url: string; worker: string; next: string };
export interface AdoptionProposal {
  digest: string;
  account: { name: string; fingerprint: string };
  worker: string;
  hostname?: string;
  subdomain?: string;
  url: string;
  versionIds: string[];
  actions: ["adopt-existing-destination"];
}
export type AdoptionStatus = { status: "ready"; proposal: AdoptionProposal; next: string } | Extract<OnboardingStatus, { status: "configured" }>;
interface AdoptionCore {
  nonce: string;
  store: { id: string; rootFingerprint: string };
  account: CloudflareAccount;
  config: PublisherConfig;
  configBefore: string | null;
  receiptBefore: string | null;
  workerBefore: CloudflareWorker;
  domain: CloudflareDomain | null;
  subdomain: string | null;
}
interface AdoptionRecord { proposal: AdoptionCore & { digest: string }; approvedAt?: string }
interface ProposalCore {
  nonce: string;
  store: { id: string; rootFingerprint: string };
  account: CloudflareAccount;
  config: PublisherConfig;
  configBefore: string | null;
  subdomain: string;
  existingSubdomain: string | null;
  workerBefore: CloudflareWorker;
}
interface SavedOnboarding {
  schema: 1;
  store: ProposalCore["store"];
  worker: string;
  subdomain: string;
  accountId?: string;
  proposal?: ProposalCore & { digest: string };
  attemptedDigest?: string;
  applied?: { digest: string; config: PublisherConfig; subdomain: string };
  explicit?: { config: PublisherConfig; recordedAt: string };
  adoption?: AdoptionRecord;
}
const statePath = (store: StoreContext) => join(store.stateDir, "onboarding.json");
const validName = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value);
const validAccount = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
const nextPublication = "Create or review a sample, configure its password, then review the complete release inventory before publishing. This destination has not been verified live.";
const identityFor = (store: StoreContext) => ({ id: store.id, rootFingerprint: hashBytes(store.root) });
const onboardingUrl = (accountId: string) => `https://dash.cloudflare.com/${accountId}/workers/onboarding`;

async function optionalJson(path: string): Promise<any | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("setup state must be a regular file");
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw new Error("setup state is invalid");
    throw error;
  }
}
async function save(store: StoreContext, state: SavedOnboarding): Promise<void> {
  const temporary = `${statePath(store)}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, statePath(store));
}
async function assertStore(store: StoreContext): Promise<void> {
  if (await realpath(store.root) !== store.root || store.stateDir !== join(store.root, ".mandate-share")) throw new Error("setup requires a canonical selected store");
  const marker = await optionalJson(join(store.root, "store.json"));
  if (marker?.schema !== 1 || marker.id !== store.id) throw new Error("setup store identity changed");
  await mkdir(store.stateDir, { recursive: true, mode: 0o700 });
  if (await realpath(store.stateDir) !== store.stateDir) throw new Error("setup state cannot be a symlink");
  await chmod(store.stateDir, 0o700);
}
async function load(store: StoreContext): Promise<SavedOnboarding> {
  await assertStore(store);
  const state = await optionalJson(statePath(store));
  if (!state) return { schema: 1, store: identityFor(store), worker: `mandate-share-${randomBytes(6).toString("hex")}`, subdomain: `share-${randomBytes(6).toString("hex")}` };
  if (state.schema !== 1 || hashJson(state.store) !== hashJson(identityFor(store)) || !validName(state.worker) || !validName(state.subdomain) || (state.accountId !== undefined && !validAccount(state.accountId))) throw new Error("saved setup belongs to another store or is invalid");
  if (state.applied) {
    validatePublisherConfig(state.applied.config);
    if (!validName(state.applied.subdomain)) throw new Error("saved setup address is invalid");
  }
  if (state.explicit) {
    validatePublisherConfig(state.explicit.config);
    if (typeof state.explicit.recordedAt !== "string" || !Number.isFinite(Date.parse(state.explicit.recordedAt))) throw new Error("saved explicit destination is invalid");
  }
  if (state.adoption) validateAdoption(state.adoption, store);
  return state;
}
async function lock<T>(directory: string, name: string, work: () => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("setup lock directory cannot be a symlink");
  const path = join(directory, name);
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("another setup operation is active; retry after it finishes"); throw error; }
  try { return await work(); } finally { await rm(path, { recursive: true, force: true }); }
}
async function withStoreLock<T>(store: StoreContext, work: () => Promise<T>): Promise<T> {
  await assertStore(store);
  return lock(store.stateDir, "onboarding.lock", work);
}
async function currentConfig(store: StoreContext): Promise<PublisherConfig | undefined> {
  if (await optionalJson(join(store.stateDir, "publisher.json")) === undefined) return undefined;
  return readPublisherConfig(store.root);
}

/** setupPublisher holds the publisher lock; this records explicit local intent without provider writes. */
export async function withExplicitPublisherTransition<T>(store: StoreContext, config: PublisherConfig, write: () => Promise<T>): Promise<T> {
  return withStoreLock(store, async () => {
    if (await optionalJson(statePath(store)) === undefined) return write();
    const state = await load(store);
    const before = await currentConfig(store);
    const result = await write();
    if (hashJson(before) !== hashJson(config)) {
      // Switching away and back must still require a new reviewed release inventory.
      await rm(join(store.stateDir, "release-active.json"), { force: true });
    }
    state.explicit = { config, recordedAt: new Date().toISOString() };
    state.accountId = config.accountId;
    state.worker = config.worker;
    delete state.proposal;
    delete state.attemptedDigest;
    delete state.adoption;
    await save(store, state);
    return result;
  });
}

function explicitSubdomain(state: SavedOnboarding, config: PublisherConfig): string | undefined {
  return config.workersDevSubdomain ?? (config.accountId === state.applied?.config.accountId ? state.applied.subdomain : undefined);
}
async function ownedWorker(store: StoreContext, config: PublisherConfig, worker: CloudflareWorker): Promise<boolean> {
  if (!worker.exists) return true;
  const receipt = await optionalJson(join(store.stateDir, "last-release.json"));
  return receipt?.schema === "mandate-share.receipt/v1" && hashJson(receipt.store) === hashJson(identityFor(store)) &&
    receipt.target?.accountFingerprint === hashBytes(config.accountId) && receipt.target.worker === config.worker &&
    typeof receipt.versionId === "string" && worker.versionIds.length === 1 && worker.versionIds[0] === receipt.versionId;
}
function proposalResult(proposal: ProposalCore & { digest: string }): OnboardingStatus {
  return { status: "ready", proposal: { digest: proposal.digest, account: { name: proposal.account.name, fingerprint: hashBytes(proposal.account.id) }, worker: proposal.config.worker, subdomain: proposal.subdomain, url: `https://${proposal.config.worker}.${proposal.subdomain}.workers.dev`, actions: [...(proposal.existingSubdomain === null ? ["register-account-subdomain" as const] : []), "save-store-destination"] }, next: "Review this account and address, then apply this exact setup digest. No pages have been uploaded." };
}
function configuredResult(config: PublisherConfig, subdomain: string): OnboardingStatus {
  return { status: "configured", worker: config.worker, url: config.hostname ? `https://${config.hostname}` : `https://${config.worker}.${subdomain}.workers.dev`, next: nextPublication };
}

function liveWorker(value: CloudflareWorker): CloudflareWorker {
  if (!value || value.exists !== true || !Array.isArray(value.versionIds) || !value.versionIds.length || value.versionIds.length > 100 ||
      new Set(value.versionIds).size !== value.versionIds.length || value.versionIds.some(id => typeof id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id))) {
    throw new Error("The existing Worker has no verifiable deployment. Check its live deployment before adopting it.");
  }
  return { exists: true, versionIds: [...value.versionIds].sort() };
}
function domainBinding(value: CloudflareDomain | null, config: PublisherConfig): CloudflareDomain {
  if (!value || value.accountId !== config.accountId || value.hostname !== config.hostname || value.worker !== config.worker || value.environment !== "production" ||
      typeof value.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/u.test(value.id) || typeof value.zoneId !== "string" || !/^[a-f0-9]{16,64}$/u.test(value.zoneId)) {
    throw new Error("The hostname is not bound to this Worker in the selected account's production environment. Check the existing hostname in Cloudflare; adoption will not change its mapping.");
  }
  return { accountId: value.accountId, id: value.id, hostname: value.hostname, worker: value.worker, environment: value.environment, zoneId: value.zoneId };
}
function validateAdoption(value: AdoptionRecord, store: StoreContext): void {
  const proposal = value?.proposal;
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal) || typeof proposal.digest !== "string" || !/^[a-f0-9]{64}$/u.test(proposal.digest) ||
      Object.keys(value).some(key => !["proposal", "approvedAt"].includes(key)) ||
      Object.keys(proposal).some(key => !["nonce", "store", "account", "config", "configBefore", "receiptBefore", "workerBefore", "domain", "subdomain", "digest"].includes(key))) throw new Error("Saved destination adoption is invalid; prepare a new adoption review.");
  const { digest, ...core } = proposal;
  const validHash = (hash: unknown) => hash === null || typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash);
  const config = validatePublisherConfig(proposal.config);
  if (hashJson(core) !== digest || hashJson(core.store) !== hashJson(identityFor(store)) || typeof core.nonce !== "string" || !core.nonce ||
      !core.account || core.account.id !== config.accountId || typeof core.account.name !== "string" || !validHash(core.configBefore) || !validHash(core.receiptBefore) ||
      (value.approvedAt !== undefined && (typeof value.approvedAt !== "string" || !Number.isFinite(Date.parse(value.approvedAt))))) throw new Error("Saved destination adoption changed or belongs to another store; prepare a new adoption review.");
  liveWorker(core.workerBefore);
  if (config.hostname) { domainBinding(core.domain, config); if (core.subdomain !== null) throw new Error("Invalid adopted hostname state."); }
  else if (!validName(core.subdomain) || config.workersDevSubdomain !== core.subdomain || core.domain !== null) throw new Error("Invalid adopted account address state.");
}
async function adoptionSnapshot(config: PublisherConfig, provider: OnboardingProvider): Promise<{ account: CloudflareAccount; workerBefore: CloudflareWorker; domain: CloudflareDomain | null; subdomain: string | null }> {
  const identity = await provider.identity();
  const account = identity.authenticated && identity.accounts.find(item => item.id === config.accountId);
  if (!account) throw new Error("The current Cloudflare login cannot access the adoption account. Sign in to the intended account and prepare adoption again.");
  let domain: CloudflareDomain | null = null, subdomain: string | null = null;
  if (config.hostname) {
    if (!provider.getDomain) throw new Error("This provider cannot verify an existing hostname. Update the runtime or provider adapter before adopting a custom domain.");
    domain = domainBinding(await provider.getDomain(config.accountId, config.hostname), config);
  } else {
    subdomain = await provider.getSubdomain(config.accountId);
    if (!validName(subdomain) || config.workersDevSubdomain && config.workersDevSubdomain !== subdomain) throw new Error("The existing workers.dev address is missing or changed. Check the account address before adopting it; adoption does not register or rename addresses.");
  }
  return { account, workerBefore: liveWorker(await provider.getWorker(config.accountId, config.worker)), domain, subdomain };
}
const localReceipt = (store: StoreContext): Promise<any | undefined> => optionalJson(join(store.stateDir, "last-release.json"));
const optionalHash = (value: unknown): string | null => value === undefined ? null : hashJson(value);
function adoptedResult(config: PublisherConfig, subdomain: string | null): Extract<OnboardingStatus, { status: "configured" }> {
  return { status: "configured", worker: config.worker, url: config.hostname ? `https://${config.hostname}` : `https://${config.worker}.${subdomain}.workers.dev`, next: "The existing destination is adopted locally. Review the complete page release inventory before replacing its live version. No pages have been uploaded by adoption." };
}
async function checkAdoptionReady(store: StoreContext, record: AdoptionRecord, config: PublisherConfig, provider: OnboardingProvider): Promise<void> {
  validateAdoption(record, store);
  const proposal = record.proposal;
  if (!record.approvedAt || hashJson(config) !== hashJson(proposal.config)) throw new Error("Existing-destination adoption is incomplete or its local target changed. Prepare and confirm the intended destination again.");
  const live = await adoptionSnapshot(config, provider);
  if (hashJson(live.domain) !== hashJson(proposal.domain) || live.subdomain !== proposal.subdomain) throw new Error("The adopted hostname or account address changed. Prepare a new adoption review before publishing.");
  const receipt = await localReceipt(store);
  if (optionalHash(receipt) === proposal.receiptBefore) {
    if (hashJson(live.workerBefore) !== hashJson(proposal.workerBefore)) throw new Error("The adopted Worker's deployed versions changed before the first publication. Prepare a new adoption review.");
  } else if (!await ownedWorker(store, config, live.workerBefore) || (config.hostname ? receipt?.target?.hostname !== config.hostname : receipt?.target?.workersDev !== true)) {
    throw new Error("The adopted destination no longer matches this store's published version. Check the live deployment before continuing.");
  }
}

/** Existing configuration is target evidence only. This step prepares a review and never grants adoption or writes to Cloudflare. */
export async function inspectAdoption(store: StoreContext, input: PublisherConfig, options: OnboardingOptions = {}): Promise<AdoptionStatus> {
  return withStoreLock(store, async () => {
    const state = await load(store);
    const selected = validatePublisherConfig(input);
    const { assertDestinationAvailable } = await import("./publisher.ts");
    await assertDestinationAvailable(store, selected, options.knownStores);
    const live = await adoptionSnapshot(selected, options.provider ?? createOnboardingProvider(store));
    const config = live.subdomain ? { ...selected, workersDevSubdomain: live.subdomain } : selected;
    const core: AdoptionCore = { nonce: state.adoption && !state.adoption.approvedAt ? state.adoption.proposal.nonce : randomUUID(), store: identityFor(store), config, configBefore: optionalHash(await currentConfig(store)), receiptBefore: optionalHash(await localReceipt(store)), ...live };
    const proposal = { ...core, digest: hashJson(core) };
    state.adoption = { proposal };
    delete state.proposal;
    delete state.attemptedDigest;
    await rm(join(store.stateDir, "release-active.json"), { force: true });
    await save(store, state);
    return { status: "ready", proposal: { digest: proposal.digest, account: { name: live.account.name, fingerprint: hashBytes(live.account.id) }, worker: config.worker,
      ...(config.hostname ? { hostname: config.hostname } : { subdomain: live.subdomain! }), url: adoptedResult(config, live.subdomain).url,
      versionIds: [...live.workerBefore.versionIds], actions: ["adopt-existing-destination"] },
      next: "Confirm this exact account, existing Worker, address, and deployed versions before adoption. Existing local configuration alone is not permission to replace a site. Adoption uploads no pages; publication still requires its separate complete inventory." };
  });
}

/** Record the caller's exact reviewed adoption, then configure the store. No receipt or remote resource is created. */
export async function applyAdoption(store: StoreContext, digest: string, options: OnboardingOptions = {}): Promise<AdoptionStatus> {
  return withStoreLock(store, async () => {
    const state = await load(store);
    const record = state.adoption;
    if (!/^[a-f0-9]{64}$/u.test(digest) || !record || record.proposal.digest !== digest) throw new Error("Adoption confirmation is stale or belongs to another store. Prepare the intended destination again.");
    validateAdoption(record, store);
    const proposal = record.proposal, config = validatePublisherConfig(proposal.config), provider = options.provider ?? createOnboardingProvider(store);
    return lock(options.knownStores === undefined ? configHome() : store.stateDir, `onboarding-account-${hashBytes(config.accountId)}.lock`, async () => {
      const current = await currentConfig(store);
      if (record.approvedAt && hashJson(current) === hashJson(config)) {
        await checkAdoptionReady(store, record, config, provider);
        return adoptedResult(config, proposal.subdomain);
      }
      if (optionalHash(current) !== proposal.configBefore || optionalHash(await localReceipt(store)) !== proposal.receiptBefore) throw new Error("Local destination or publication state changed since adoption was reviewed. Prepare adoption again.");
      const { setupPublisher, assertDestinationAvailable } = await import("./publisher.ts");
      await assertDestinationAvailable(store, config, options.knownStores);
      const live = await adoptionSnapshot(config, provider);
      if (hashJson(live.workerBefore) !== hashJson(proposal.workerBefore) || hashJson(live.domain) !== hashJson(proposal.domain) || live.subdomain !== proposal.subdomain) throw new Error("The existing Worker's versions, hostname, or account address changed since adoption was reviewed. Prepare adoption again.");
      // Persist consent before the local configuration write. A failed write can resume with this same reviewed digest.
      record.approvedAt ??= new Date().toISOString();
      await rm(join(store.stateDir, "release-active.json"), { force: true });
      await save(store, state);
      await setupPublisher(store, config, options.knownStores, { guided: true });
      return adoptedResult(config, proposal.subdomain);
    });
  });
}

export async function loginOnboarding(store: StoreContext, options: OnboardingOptions = {}): Promise<CloudflareIdentity> {
  await assertStore(store);
  const provider = options.provider ?? createOnboardingProvider(store);
  await provider.login();
  return provider.identity();
}

export async function inspectOnboarding(store: StoreContext, input: OnboardingInput = {}, options: OnboardingOptions = {}): Promise<OnboardingStatus> {
  return withStoreLock(store, async () => {
    const state = await load(store);
    const provider = options.provider ?? createOnboardingProvider(store);
    const identity = await provider.identity();
    await save(store, state);
    if (!identity.authenticated) return { status: "login-required", next: "Open Cloudflare sign-in, finish account verification, and approve Wrangler in your browser." };
    const configBefore = await currentConfig(store);
    if (state.adoption && Object.values(input).every(value => value === undefined)) {
      if (!state.adoption.approvedAt || !configBefore) throw new Error("An existing destination is awaiting adoption confirmation. Review and confirm its adoption digest before continuing.");
      await checkAdoptionReady(store, state.adoption, configBefore, provider);
      return adoptedResult(configBefore, state.adoption.proposal.subdomain);
    }
    if (state.explicit && hashJson(configBefore) === hashJson(state.explicit.config) && Object.values(input).every(value => value === undefined)) {
      const config = state.explicit.config;
      const subdomain = explicitSubdomain(state, config);
      if (config.hostname || subdomain) {
        await checkReady(store, config, subdomain, provider);
        return configuredResult(config, subdomain ?? "");
      }
      // A different workers.dev account needs the normal address discovery and approval below.
    }
    const accountId = input.accountId ?? state.accountId ?? (identity.accounts.length === 1 ? identity.accounts[0].id : undefined);
    if (!accountId) return { status: "choose-account", accounts: identity.accounts, next: identity.accounts.length ? "Choose the account that should own your shared pages." : "Your login has no accessible account. Finish Cloudflare account setup or request account access, then resume." };
    const account = identity.accounts.find(item => item.id === accountId);
    if (!account) throw new Error("the selected account is not accessible to the current Cloudflare login");
    if (input.worker !== undefined && !validName(input.worker)) throw new Error("site name must be a lowercase DNS label, at most 63 characters");
    if (input.subdomain !== undefined && !validName(input.subdomain)) throw new Error("account address must be a lowercase DNS label, at most 63 characters");
    const existingSubdomain = await provider.getSubdomain(account.id);
    if (existingSubdomain !== null && input.subdomain && input.subdomain !== existingSubdomain) throw new Error("this account already has an address; setup will not rename it");
    const subdomain = existingSubdomain ?? input.subdomain ?? state.subdomain;
    let worker = input.worker ?? (configBefore?.accountId === account.id ? configBefore.worker : state.worker);
    let workerBefore = await provider.getWorker(account.id, worker);
    for (let attempt = 0; workerBefore.exists && !await ownedWorker(store, { accountId, worker, workersDev: true }, workerBefore); attempt++) {
      if (input.worker || configBefore?.worker === worker) throw new Error("that site already exists and its deployed version is not owned by this store; choose a new site name");
      if (attempt >= 5) throw new Error("could not find an unused site name; run setup again");
      worker = `mandate-share-${randomBytes(6).toString("hex")}`;
      workerBefore = await provider.getWorker(account.id, worker);
    }
    state.worker = worker; state.subdomain = subdomain; state.accountId = account.id;
    const config: PublisherConfig = { worker, accountId: account.id, workersDev: true, workersDevSubdomain: subdomain };
    if (state.applied && hashJson(configBefore) === hashJson(state.applied.config) && hashJson(config) === hashJson(state.applied.config) && existingSubdomain === state.applied.subdomain) {
      await save(store, state);
      return configuredResult(config, subdomain);
    }
    const core: ProposalCore = { nonce: state.proposal && !state.attemptedDigest ? state.proposal.nonce : randomUUID(), store: state.store, account, config, configBefore: configBefore ? hashJson(configBefore) : null, existingSubdomain, subdomain, workerBefore };
    state.proposal = { ...core, digest: hashJson(core) };
    delete state.attemptedDigest;
    await save(store, state);
    return proposalResult(state.proposal);
  });
}

export async function applyOnboarding(store: StoreContext, digest: string, options: OnboardingOptions = {}): Promise<OnboardingStatus> {
  return withStoreLock(store, async () => {
    const state = await load(store);
    const proposal = state.proposal;
    if (!/^[a-f0-9]{64}$/u.test(digest) || !proposal || proposal.digest !== digest) throw new Error("setup confirmation is stale or belongs to another store; inspect setup again");
    const { digest: savedDigest, ...core } = proposal;
    if (hashJson(core) !== savedDigest || hashJson(core.store) !== hashJson(identityFor(store))) throw new Error("saved setup proposal changed; inspect setup again");
    const config = validatePublisherConfig(proposal.config);
    if (!validName(proposal.subdomain) || !config.workersDev) throw new Error("saved setup destination is invalid");
    const provider = options.provider ?? createOnboardingProvider(store);
    if (!(await provider.identity()).accounts.some(account => account.id === config.accountId)) throw new Error("Cloudflare login no longer has access to the selected account");
    return lock(options.knownStores === undefined ? configHome() : store.stateDir, `onboarding-account-${hashBytes(config.accountId)}.lock`, async () => {
      const current = await currentConfig(store);
      if (state.applied?.digest === digest && hashJson(current) === hashJson(config)) {
        await checkReady(store, config, state.applied.subdomain, provider);
        return configuredResult(config, state.applied.subdomain);
      }
      if ((current ? hashJson(current) : null) !== proposal.configBefore) throw new Error("store destination changed since setup was reviewed");
      if (state.attemptedDigest === digest) throw new Error("this setup registration was already attempted; inspect the account address again before continuing");
      const { setupPublisher, assertDestinationAvailable } = await import("./publisher.ts");
      await assertDestinationAvailable(store, config, options.knownStores);
      const subdomain = await provider.getSubdomain(config.accountId);
      if (subdomain !== proposal.existingSubdomain) throw new Error("account address changed since setup was reviewed; inspect setup again");
      const worker = await provider.getWorker(config.accountId, config.worker);
      if (hashJson(worker) !== hashJson(proposal.workerBefore) || !await ownedWorker(store, config, worker)) throw new Error("site ownership changed since setup was reviewed; inspect setup again");
      if (subdomain === null) {
        state.attemptedDigest = digest;
        await save(store, state);
        try { await provider.createSubdomain(config.accountId, proposal.subdomain); }
        catch { throw new Error(`Account address registration failed or is uncertain. Resume setup to check it; if Cloudflare needs browser setup, open ${onboardingUrl(config.accountId)}.`); }
      }
      if (await provider.getSubdomain(config.accountId) !== proposal.subdomain) throw new Error("Cloudflare has not confirmed the proposed account address; resume setup before publishing");
      await setupPublisher(store, config, options.knownStores, { guided: true });
      state.applied = { digest, config, subdomain: proposal.subdomain };
      delete state.explicit;
      delete state.adoption;
      delete state.attemptedDigest;
      await save(store, state);
      return configuredResult(config, proposal.subdomain);
    });
  });
}

async function checkReady(store: StoreContext, config: PublisherConfig, subdomain: string | undefined, provider: OnboardingProvider): Promise<void> {
  if (!(await provider.identity()).accounts.some(account => account.id === config.accountId)) throw new Error("Cloudflare account access changed; resume setup");
  if (config.workersDev && (!subdomain || await provider.getSubdomain(config.accountId) !== subdomain)) throw new Error("Cloudflare account address changed or is unconfirmed; resume setup");
  if (!await ownedWorker(store, config, await provider.getWorker(config.accountId, config.worker))) throw new Error("Cloudflare site ownership changed; resume setup before publishing");
}
/** Guided destinations are rechecked online before freeze/upload; compilation itself stays offline. */
export async function assertOnboardingReady(store: StoreContext, options: OnboardingOptions = {}): Promise<void> {
  if (await optionalJson(statePath(store)) === undefined) return; // Explicit advanced configuration retains the offline planning API.
  const state = await load(store);
  const config = await readPublisherConfig(store.root);
  if (state.adoption) {
    await checkAdoptionReady(store, state.adoption, config, options.provider ?? createOnboardingProvider(store));
    return;
  }
  if (state.explicit && hashJson(config) === hashJson(state.explicit.config)) {
    await checkReady(store, config, explicitSubdomain(state, config), options.provider ?? createOnboardingProvider(store));
    return;
  }
  if (!state.applied || hashJson(config) !== hashJson(state.applied.config)) throw new Error("guided setup is incomplete or its destination changed; resume setup");
  await checkReady(store, config, state.applied.subdomain, options.provider ?? createOnboardingProvider(store));
}

/** Local mapping only: an address from this store's applied setup, bound to its current target. */
export async function getStorePublicOrigin(store: StoreContext): Promise<string | undefined> {
  const config = await currentConfig(store);
  if (!config) return undefined;
  if (config.hostname) return `https://${config.hostname}`;
  if (await optionalJson(statePath(store)) !== undefined) {
    const state = await load(store);
    if (state.adoption?.approvedAt && hashJson(config) === hashJson(state.adoption.proposal.config)) return adoptedResult(config, state.adoption.proposal.subdomain).url;
    if (state.applied && hashJson(config) === hashJson(state.applied.config)) return `https://${config.worker}.${state.applied.subdomain}.workers.dev`;
  }
  const receipt = await optionalJson(join(store.stateDir, "last-release.json"));
  if (receipt?.schema !== "mandate-share.receipt/v1" || hashJson(receipt.store) !== hashJson(identityFor(store)) || receipt.target?.accountFingerprint !== hashBytes(config.accountId) || receipt.target.worker !== config.worker || receipt.target.workersDev !== true || typeof receipt.url !== "string") return undefined;
  try {
    const url = new URL(receipt.url);
    const prefix = `${config.worker}.`;
    const suffix = ".workers.dev";
    if (url.protocol !== "https:" || url.origin !== receipt.url || !url.hostname.startsWith(prefix) || !url.hostname.endsWith(suffix) || !validName(url.hostname.slice(prefix.length, -suffix.length))) return undefined;
    return url.origin;
  } catch { return undefined; }
}

export interface ProviderCommand { command: string[]; cwd: string; env: NodeJS.ProcessEnv; timeout: number }
export type ProviderCommandRunner = (command: ProviderCommand) => Promise<{ code: number; stdout: string }>;
export const runProviderCommand: ProviderCommandRunner = ({ command, cwd, env, timeout }) => new Promise(resolve => {
  const child = execFile(command[0], command.slice(1), { cwd, env, timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => resolve({ code: error ? typeof error.code === "number" ? error.code : -1 : 0, stdout }));
  child.stdin?.end();
});
export function providerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false", WRANGLER_LOG: "log", NO_COLOR: "1", CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" };
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "LANG", "CLOUDFLARE_AUTH_USE_KEYRING", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL"]) if (process.env[key]) env[key] = process.env[key];
  return env;
}

/** All provider output and credentials remain inside this adapter. No raw error is propagated. */
export function createOnboardingProvider(store: StoreContext, transport: { runner?: ProviderCommandRunner; fetch?: typeof fetch } = {}): OnboardingProvider {
  const runner = transport.runner ?? runProviderCommand;
  const fetcher = transport.fetch ?? fetch;
  async function command(args: string[], login = false): Promise<{ code: number; stdout: string }> {
    const cwd = join(store.stateDir, "provider-onboarding");
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    if (await realpath(cwd) !== cwd) throw new Error("provider working directory cannot be a symlink");
    const emptyEnv = join(cwd, "empty.env");
    try { await writeFile(emptyEnv, "", { flag: "wx", mode: 0o600 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if ((await lstat(emptyEnv)).isSymbolicLink() || await readFile(emptyEnv, "utf8") !== "") throw new Error("provider environment file changed");
    try { return await runner({ command: [process.execPath, join(store.runtimeRoot, "node_modules/wrangler/bin/wrangler.js"), ...args, "--env-file", emptyEnv], cwd, env: { ...providerEnvironment(), ...(login ? {} : { CI: "true" }) }, timeout: login ? 360_000 : 30_000 }); }
    catch { throw new Error("Cloudflare command could not run; check Node.js and the installed Share runtime"); }
  }
  async function credentials(): Promise<any | undefined> {
    // login always uses default. Explicit selection avoids directory-bound experimental profiles.
    const result = await command(["auth", "token", "--json", "--profile", "default"]);
    if (result.code !== 0) return undefined;
    let auth: any;
    try { auth = JSON.parse(result.stdout); } catch { throw new Error("Cloudflare authentication is unavailable; resume browser sign-in"); }
    return auth;
  }
  async function api(path: string, init: RequestInit = {}, auth?: any): Promise<{ status: number; body: any }> {
    auth ??= await credentials();
    if (!auth) throw new Error("Cloudflare authentication expired; resume browser sign-in");
    try {
      const headers = new Headers({ "content-type": "application/json" });
      if (["oauth", "api_token"].includes(auth?.type) && typeof auth.token === "string" && auth.token) headers.set("authorization", `Bearer ${auth.token}`);
      else if (auth?.type === "api_key" && typeof auth.key === "string" && typeof auth.email === "string") { headers.set("x-auth-key", auth.key); headers.set("x-auth-email", auth.email); }
      else throw new Error("unusable authentication");
      const response = await fetcher(`https://api.cloudflare.com/client/v4${path}`, { ...init, headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
      const body = await response.json();
      return { status: response.status, body };
    } catch { throw new Error("Cloudflare did not return a usable response; check connectivity and resume setup"); }
  }
  function accountPath(accountId: string): string { if (!validAccount(accountId)) throw new Error("invalid selected account"); return `/accounts/${accountId}/workers`; }
  function requireResult(response: { status: number; body: any }): any {
    if (response.status < 200 || response.status >= 300 || response.body?.success !== true) throw new Error("Cloudflare refused this setup operation; check account permissions or finish setup in its dashboard");
    return response.body.result;
  }
  return {
    async identity() {
      const auth = await credentials();
      if (!auth) return { authenticated: false, accounts: [] };
      const accounts: CloudflareAccount[] = [];
      for (let page = 1; ; page++) {
        if (page > 100) throw new Error("Cloudflare returned too many account pages; narrow account access before continuing");
        const response = await api(`/accounts?page=${page}&per_page=50`, {}, auth);
        const result = requireResult(response);
        if (!Array.isArray(result)) throw new Error("Cloudflare returned an invalid account list");
        for (const account of result) {
          if (!validAccount(account?.id) || typeof account.name !== "string") throw new Error("Cloudflare returned an invalid account list");
          if (!accounts.some(item => item.id === account.id)) accounts.push({ id: account.id, name: account.name.replace(/[\x00-\x1f\x7f]/gu, "").slice(0, 200) });
        }
        const pages = response.body.result_info?.total_pages;
        if (typeof pages === "number" ? page >= pages : result.length < 50) break;
      }
      return { authenticated: true, accounts };
    },
    async login() { if ((await command(["login"], true)).code !== 0) throw new Error("Cloudflare sign-in was not completed; finish login and authorization in the browser, then resume setup"); },
    async getSubdomain(accountId) {
      const response = await api(`${accountPath(accountId)}/subdomain`);
      if (response.body?.errors?.some((error: any) => error.code === 10007)) return null;
      const result = requireResult(response);
      if (!validName(result?.subdomain)) throw new Error("Cloudflare returned an invalid account address");
      return result.subdomain;
    },
    async createSubdomain(accountId, subdomain) {
      if (!validName(subdomain)) throw new Error("invalid proposed account address");
      const result = requireResult(await api(`${accountPath(accountId)}/subdomain`, { method: "PUT", body: JSON.stringify({ subdomain }) }));
      if (result?.subdomain !== subdomain) throw new Error("Cloudflare did not confirm the proposed account address");
      return subdomain;
    },
    async getWorker(accountId, worker) {
      if (!validName(worker)) throw new Error("invalid proposed site name");
      const response = await api(`${accountPath(accountId)}/scripts/${worker}/deployments`);
      if (response.body?.errors?.some((error: any) => error.code === 10007 || error.code === 10090)) return { exists: false, versionIds: [] };
      const result = requireResult(response);
      if (!Array.isArray(result?.deployments)) throw new Error("Cloudflare returned invalid deployment metadata");
      const versions = result.deployments[0]?.versions ?? [];
      if (!Array.isArray(versions) || versions.some((version: any) => typeof version.version_id !== "string" || !/^[a-f0-9-]{36}$/u.test(version.version_id))) throw new Error("Cloudflare returned invalid deployment metadata");
      return { exists: true, versionIds: versions.map((version: any) => version.version_id).sort() };
    },
    async getDomain(accountId, hostname) {
      const normalized = validatePublisherConfig({ accountId, worker: "domain-lookup", hostname }).hostname!;
      const response = await api(`${accountPath(accountId)}/domains?hostname=${encodeURIComponent(normalized)}`);
      const result = requireResult(response);
      if (!Array.isArray(result) || (response.body.result_info?.total_pages ?? 1) > 1) throw new Error("Cloudflare returned incomplete hostname bindings. Verify the hostname in the selected account before adopting it.");
      const matches = result.filter((entry: any) => typeof entry?.hostname === "string" && entry.hostname.toLowerCase() === normalized);
      if (!matches.length) return null;
      if (matches.length !== 1) throw new Error("Cloudflare returned ambiguous hostname bindings; adoption requires exactly one existing mapping.");
      const entry = matches[0];
      if (!validName(entry.service) || entry.environment !== undefined && (typeof entry.environment !== "string" || !entry.environment || entry.environment.length > 128)) throw new Error("Cloudflare returned an invalid hostname binding.");
      const domain = { accountId, id: entry.id, hostname: normalized, worker: entry.service, environment: entry.environment ?? "production", zoneId: entry.zone_id };
      if (typeof domain.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/u.test(domain.id) || typeof domain.zoneId !== "string" || !/^[a-f0-9]{16,64}$/u.test(domain.zoneId)) throw new Error("Cloudflare returned an invalid hostname binding.");
      return domain;
    },
  };
}
