import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile, symlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { StoreContext } from "../lib/context.ts";
import { applyAdoption, applyOnboarding, assertOnboardingReady, createOnboardingProvider, getStorePublicOrigin, inspectAdoption, inspectOnboarding, loginOnboarding, type AdoptionStatus, type CloudflareAccount, type CloudflareDomain, type OnboardingProvider, type OnboardingStatus, type ProviderCommand } from "../lib/onboarding.ts";
import { readPublisherConfig } from "../lib/cloudflare.ts";
import { hashBytes } from "../lib/release.ts";
import { prepareRelease, publishRelease, setupPublisher, type PublisherOptions } from "../lib/publisher.ts";
import { setPageSharing } from "../lib/privacy.ts";

const roots: string[] = [];
const account = { id: "a".repeat(32), name: "Synthetic account" };
const versionId = "11111111-1111-4111-8111-111111111111";
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true }); });
async function fixture(): Promise<StoreContext> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mandate-share-onboarding-")));
  roots.push(root);
  const store = { id: randomUUID(), name: "test", root, runtimeRoot: resolve(import.meta.dirname, ".."), stateDir: join(root, ".mandate-share"), outDir: join(root, ".mandate-share/dist") };
  await mkdir(store.stateDir);
  await writeFile(join(root, "store.json"), JSON.stringify({ schema: 1, id: store.id }));
  return store;
}
function fake() {
  const state = { authenticated: true, accounts: [account] as CloudflareAccount[], subdomain: null as string | null, workers: new Map<string, string[]>(), domains: new Map<string, CloudflareDomain>(), registrations: [] as string[], reads: [] as string[], logins: 0, failRegistration: false };
  const provider: OnboardingProvider = {
    identity: async () => ({ authenticated: state.authenticated, accounts: state.authenticated ? state.accounts : [] }),
    login: async () => { state.logins++; state.authenticated = true; },
    getSubdomain: async id => { state.reads.push(`subdomain:${id}`); return state.subdomain; },
    createSubdomain: async (_id, value) => { state.registrations.push(value); state.subdomain = value; if (state.failRegistration) throw new Error("synthetic secret must be suppressed"); return value; },
    getWorker: async (_id, name) => { state.reads.push(`worker:${name}`); return { exists: state.workers.has(name), versionIds: state.workers.get(name) ?? [] }; },
    getDomain: async (id, hostname) => { state.reads.push(`domain:${id}:${hostname}`); return state.domains.get(hostname) ?? null; },
  };
  return { state, provider, options: { provider, knownStores: [] } };
}
function ready(status: OnboardingStatus) {
  assert.equal(status.status, "ready");
  if (status.status !== "ready") throw new Error("expected a proposal");
  return status.proposal;
}

test("login and account choice precede one stable concrete proposal; apply is resumable", async () => {
  const store = await fixture();
  const boundary = fake(); boundary.state.authenticated = false;
  assert.equal((await inspectOnboarding(store, {}, boundary.options)).status, "login-required");
  await loginOnboarding(store, boundary.options);
  assert.equal(boundary.state.logins, 1);
  boundary.state.accounts.push({ id: "b".repeat(32), name: "Second account" });
  const choice = await inspectOnboarding(store, {}, boundary.options);
  assert.equal(choice.status, "choose-account");
  assert.deepEqual(boundary.state.registrations, []);
  const first = ready(await inspectOnboarding(store, { accountId: account.id }, boundary.options));
  const repeated = ready(await inspectOnboarding(store, {}, boundary.options));
  assert.deepEqual(first, repeated);
  assert.deepEqual(first.actions, ["register-account-subdomain", "save-store-destination"]);
  assert.equal(JSON.stringify(first).includes(account.id), false);
  assert.equal((await stat(join(store.stateDir, "onboarding.json"))).mode & 0o777, 0o600);
  await assert.rejects(applyOnboarding(store, "0".repeat(64), boundary.options), /stale/);
  const applied = await applyOnboarding(store, first.digest, boundary.options);
  assert.equal(applied.status, "configured");
  assert.deepEqual(boundary.state.registrations, [first.subdomain]);
  assert.equal((await readPublisherConfig(store.root)).worker, first.worker);
  assert.equal(await getStorePublicOrigin(store), first.url);
  assert.deepEqual(await applyOnboarding(store, first.digest, boundary.options), applied);
  assert.equal((await inspectOnboarding(store, {}, boundary.options)).status, "configured");
  assert.equal(boundary.state.registrations.length, 1);
});

test("existing account addresses are reused, never renamed, and ownership conflicts choose another generated site", async () => {
  const store = await fixture(); const boundary = fake(); boundary.state.subdomain = "already-registered";
  const initial = ready(await inspectOnboarding(store, {}, boundary.options));
  boundary.state.workers.set(initial.worker, [versionId]);
  const changed = ready(await inspectOnboarding(store, {}, boundary.options));
  assert.notEqual(changed.worker, initial.worker);
  assert.equal(changed.subdomain, "already-registered");
  assert.deepEqual(changed.actions, ["save-store-destination"]);
  await assert.rejects(inspectOnboarding(store, { subdomain: "rename-attempt" }, boundary.options), /will not rename/);
  await assert.rejects(inspectOnboarding(store, { worker: initial.worker }, boundary.options), /not owned/);
  await applyOnboarding(store, changed.digest, boundary.options);
  assert.deepEqual(boundary.state.registrations, []);
});

test("apply rechecks account, address, worker and store identity before any registration", async () => {
  const store = await fixture(); const other = await fixture(); const boundary = fake();
  const proposal = ready(await inspectOnboarding(store, {}, boundary.options));
  await assert.rejects(applyOnboarding(other, proposal.digest, boundary.options), /stale/);
  boundary.state.accounts = [];
  await assert.rejects(applyOnboarding(store, proposal.digest, boundary.options), /no longer/);
  boundary.state.accounts = [account]; boundary.state.subdomain = "somebody-created-this";
  await assert.rejects(applyOnboarding(store, proposal.digest, boundary.options), /address changed/);
  boundary.state.subdomain = null; boundary.state.workers.set(proposal.worker, [versionId]);
  await assert.rejects(applyOnboarding(store, proposal.digest, boundary.options), /ownership changed/);
  assert.deepEqual(boundary.state.registrations, []);
});

test("uncertain registration preserves progress and never blindly replays the write", async () => {
  const store = await fixture(); const boundary = fake(); boundary.state.failRegistration = true;
  const proposal = ready(await inspectOnboarding(store, {}, boundary.options));
  await assert.rejects(applyOnboarding(store, proposal.digest, boundary.options), error => error instanceof Error && error.message.includes("uncertain") && !error.message.includes("synthetic secret"));
  await assert.rejects(applyOnboarding(store, proposal.digest, boundary.options), /already attempted/);
  const resumed = ready(await inspectOnboarding(store, {}, boundary.options));
  assert.equal(resumed.subdomain, proposal.subdomain);
  assert.deepEqual(resumed.actions, ["save-store-destination"]);
  await applyOnboarding(store, resumed.digest, boundary.options);
  assert.equal(boundary.state.registrations.length, 1);
});

test("readiness requires the current address and a matching locally published version", async () => {
  const store = await fixture(); const boundary = fake();
  const proposal = ready(await inspectOnboarding(store, {}, boundary.options));
  await applyOnboarding(store, proposal.digest, boundary.options);
  await assertOnboardingReady(store, boundary.options);
  boundary.state.workers.set(proposal.worker, [versionId]);
  await assert.rejects(assertOnboardingReady(store, boundary.options), /ownership changed/);
  await writeFile(join(store.stateDir, "last-release.json"), JSON.stringify({ schema: "mandate-share.receipt/v1", store: { id: store.id, rootFingerprint: hashBytes(store.root) }, target: { worker: proposal.worker, accountFingerprint: hashBytes(account.id) }, versionId }));
  await assertOnboardingReady(store, boundary.options);
  boundary.state.workers.set(proposal.worker, ["22222222-2222-4222-8222-222222222222"]);
  await assert.rejects(assertOnboardingReady(store, boundary.options), /ownership changed/);
  boundary.state.workers.delete(proposal.worker); boundary.state.subdomain = "changed-account-address";
  await assert.rejects(assertOnboardingReady(store, boundary.options), /address changed/);
});

test("provider adapter uses pinned Wrangler, fixed API endpoints and redacts credentials/errors", async () => {
  const store = await fixture(); const commands: ProviderCommand[] = []; const requests: { url: string; method: string }[] = [];
  let response: unknown = { success: true, result: [account], result_info: { total_pages: 1 } }; let status = 200;
  const provider = createOnboardingProvider(store, {
    runner: async call => {
      commands.push(call);
      const type = call.command[2];
      return { code: 0, stdout: type === "auth" ? JSON.stringify({ type: "oauth", token: "synthetic-credential-never-emit" }) : "suppressed browser output" };
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-credential-never-emit");
      assert.equal(init?.redirect, "error");
      requests.push({ url: String(input), method: init?.method ?? "GET" });
      return Response.json(response, { status });
    }) as typeof fetch,
  });
  assert.deepEqual(await provider.identity(), { authenticated: true, accounts: [account] });
  await provider.login();
  response = { success: true, result: { subdomain: "existing" } };
  assert.equal(await provider.getSubdomain(account.id), "existing");
  assert.equal(await provider.createSubdomain(account.id, "existing"), "existing");
  response = { success: true, result: { deployments: [{ versions: [{ version_id: versionId, percentage: 100 }] }] } };
  assert.deepEqual(await provider.getWorker(account.id, "test-worker"), { exists: true, versionIds: [versionId] });
  status = 404; response = { success: false, errors: [{ code: 10007, message: "secret-server-error" }] };
  assert.equal(await provider.getSubdomain(account.id), null);
  assert.equal((await provider.getWorker(account.id, "missing")).exists, false);
  status = 403; response = { success: false, errors: [{ code: 9109, message: "synthetic-credential-never-emit" }] };
  await assert.rejects(provider.getSubdomain(account.id), error => error instanceof Error && !error.message.includes("synthetic-credential"));
  assert.ok(requests.every(request => request.url === "https://api.cloudflare.com/client/v4/accounts?page=1&per_page=50" || request.url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${account.id}/workers/`)));
  for (const call of commands) {
    assert.equal(call.command[0], process.execPath);
    assert.equal(call.command[1], join(store.runtimeRoot, "node_modules/wrangler/bin/wrangler.js"));
    assert.equal(call.env.WRANGLER_WRITE_LOGS, "false");
    assert.equal(call.env.WRANGLER_SEND_METRICS, "false");
    assert.equal(call.env.CLOUDFLARE_API_BASE_URL, undefined);
    assert.equal(call.command.join(" ").includes("synthetic-credential"), false);
    if (call.command[2] === "auth") assert.equal(call.command[call.command.indexOf("--profile") + 1], "default");
  }
  assert.equal((await readFile(join(store.stateDir, "provider-onboarding/empty.env"), "utf8")), "");
});

test("malformed saved proposals and symlink state cannot redirect setup", async () => {
  const store = await fixture(); const boundary = fake();
  const proposal = ready(await inspectOnboarding(store, {}, boundary.options));
  const path = join(store.stateDir, "onboarding.json");
  const state = JSON.parse(await readFile(path, "utf8")); state.proposal.subdomain = "changed";
  await writeFile(path, JSON.stringify(state));
  await assert.rejects(applyOnboarding(store, proposal.digest, boundary.options), /proposal changed/);
  await rm(path); await symlink(join(store.root, "store.json"), path);
  await assert.rejects(inspectOnboarding(store, {}, boundary.options), /regular file/);
  assert.deepEqual(boundary.state.registrations, []);
});

test("known URL mapping rejects a copied receipt and discovers a validated advanced publication", async () => {
  const store = await fixture();
  await writeFile(join(store.stateDir, "publisher.json"), JSON.stringify({ accountId: account.id, worker: "advanced-worker", workersDev: true }));
  const receipt = { schema: "mandate-share.receipt/v1", store: { id: store.id, rootFingerprint: hashBytes(store.root) }, target: { accountFingerprint: hashBytes(account.id), worker: "advanced-worker", workersDev: true }, url: "https://advanced-worker.account-label.workers.dev" };
  const path = join(store.stateDir, "last-release.json");
  await writeFile(path, JSON.stringify(receipt));
  assert.equal(await getStorePublicOrigin(store), receipt.url);
  await writeFile(path, JSON.stringify({ ...receipt, store: { ...receipt.store, id: randomUUID() } }));
  assert.equal(await getStorePublicOrigin(store), undefined);
  for (const url of ["https://secret@advanced-worker.account-label.workers.dev", "https://advanced-worker.account-label.workers.dev?token=secret", "https://other-worker.account-label.workers.dev", "https://advanced-worker.too.many.workers.dev"]) {
    await writeFile(path, JSON.stringify({ ...receipt, url }));
    assert.equal(await getStorePublicOrigin(store), undefined);
  }
});

test("explicit hostname transitions preserve ownership checks and resume after complete or incomplete guided setup", async () => {
  for (const stage of ["login-required", "ready", "configured"] as const) {
    const store = await fixture(); const boundary = fake();
    boundary.state.authenticated = stage !== "login-required";
    const first = await inspectOnboarding(store, {}, boundary.options);
    if (stage === "configured") await applyOnboarding(store, ready(first).digest, boundary.options);
    const before = JSON.parse(await readFile(join(store.stateDir, "onboarding.json"), "utf8"));
    const config = { accountId: account.id, worker: before.worker, hostname: "share.example.com" };
    await setupPublisher(store, config, []);
    boundary.state.authenticated = true;
    const priorReads = boundary.state.reads.length;
    await assertOnboardingReady(store, boundary.options);
    const inspected = await inspectOnboarding(store, {}, boundary.options);
    assert.equal(inspected.status, "configured");
    if (inspected.status !== "configured") throw new Error("expected current hostname");
    assert.equal(inspected.url, "https://share.example.com");
    assert.equal(boundary.state.reads.slice(priorReads).some(read => read.startsWith("subdomain:")), false);
    const saved = JSON.parse(await readFile(join(store.stateDir, "onboarding.json"), "utf8"));
    assert.deepEqual(saved.applied, before.applied, "retain the saved guided configuration");
    boundary.state.workers.set(config.worker, [versionId]);
    await assert.rejects(assertOnboardingReady(store, boundary.options), /ownership changed/);
    assert.equal(boundary.state.registrations.length, stage === "configured" ? 1 : 0);
  }
});

const existingTarget = { accountId: account.id, worker: "existing-site", hostname: "share.example.com" };
const laterVersion = "22222222-2222-4222-8222-222222222222";
const existingDomain: CloudflareDomain = { accountId: account.id, id: "domain-record", hostname: existingTarget.hostname, worker: existingTarget.worker, environment: "production", zoneId: "c".repeat(32) };
function existingSite() {
  const boundary = fake();
  boundary.state.workers.set(existingTarget.worker, [versionId]);
  boundary.state.domains.set(existingTarget.hostname, { ...existingDomain });
  return boundary;
}
function adoptionReady(status: AdoptionStatus) {
  assert.equal(status.status, "ready");
  if (status.status !== "ready") throw new Error("expected an adoption proposal");
  return status.proposal;
}

test("an existing target requires exact adoption confirmation and never fabricates publication state", async () => {
  const store = await fixture(), evidenceStore = await fixture(), boundary = existingSite();
  const evidence = join(evidenceStore.root, "destination.json");
  await writeFile(evidence, JSON.stringify(existingTarget));
  const target = JSON.parse(await readFile(evidence, "utf8"));
  const proposal = adoptionReady(await inspectAdoption(store, target, boundary.options));
  assert.deepEqual(proposal, adoptionReady(await inspectAdoption(store, target, boundary.options)));
  assert.equal(proposal.url, "https://share.example.com");
  assert.deepEqual(proposal.versionIds, [versionId]);
  assert.deepEqual(proposal.actions, ["adopt-existing-destination"]);
  assert.equal(JSON.stringify(proposal).includes(account.id), false);
  await assert.rejects(readPublisherConfig(store.root), /not configured/);
  await assert.rejects(readFile(join(store.stateDir, "last-release.json")), { code: "ENOENT" });
  await assert.rejects(applyAdoption(store, "0".repeat(64), boundary.options), /stale/);
  const other = await fixture();
  await assert.rejects(applyAdoption(other, proposal.digest, boundary.options), /another store/);
  const result = await applyAdoption(store, proposal.digest, boundary.options);
  assert.equal(result.status, "configured");
  assert.deepEqual(await readPublisherConfig(store.root), existingTarget);
  assert.deepEqual(await applyAdoption(store, proposal.digest, boundary.options), result);
  await assertOnboardingReady(store, boundary.options);
  assert.equal((await inspectOnboarding(store, {}, boundary.options)).status, "configured");
  assert.equal(await getStorePublicOrigin(store), "https://share.example.com");
  await assert.rejects(readFile(join(store.stateDir, "last-release.json")), { code: "ENOENT" });
  assert.deepEqual(boundary.state.registrations, []);
  assert.equal(boundary.state.reads.some(read => read.startsWith("subdomain:")), false, "custom-domain adoption needs no workers.dev account address");
  assert.equal((await stat(join(store.stateDir, "onboarding.json"))).mode & 0o777, 0o600);
});

test("adoption rejects stale versions, account access, hostname binding and local target changes before applying", async () => {
  for (const drift of ["versions", "account", "domain-worker", "domain-account", "domain-id", "domain-zone", "domain-missing", "environment", "local-config", "local-receipt"] as const) {
    const store = await fixture(), boundary = existingSite();
    const proposal = adoptionReady(await inspectAdoption(store, existingTarget, boundary.options));
    if (drift === "versions") boundary.state.workers.set(existingTarget.worker, [laterVersion]);
    if (drift === "account") boundary.state.accounts = [];
    if (drift === "domain-worker") boundary.state.domains.get(existingTarget.hostname)!.worker = "other-site";
    if (drift === "domain-account") boundary.state.domains.get(existingTarget.hostname)!.accountId = "b".repeat(32);
    if (drift === "domain-id") boundary.state.domains.get(existingTarget.hostname)!.id = "replacement-domain";
    if (drift === "domain-zone") boundary.state.domains.get(existingTarget.hostname)!.zoneId = "d".repeat(32);
    if (drift === "domain-missing") boundary.state.domains.delete(existingTarget.hostname);
    if (drift === "environment") boundary.state.domains.get(existingTarget.hostname)!.environment = "staging";
    if (drift === "local-config") await writeFile(join(store.stateDir, "publisher.json"), JSON.stringify({ ...existingTarget, worker: "other-local-site" }));
    if (drift === "local-receipt") await writeFile(join(store.stateDir, "last-release.json"), JSON.stringify({ changed: true }));
    await assert.rejects(applyAdoption(store, proposal.digest, boundary.options), /changed|account|hostname|versions|publication state/);
    const state = JSON.parse(await readFile(join(store.stateDir, "onboarding.json"), "utf8"));
    assert.equal(state.adoption.approvedAt, undefined);
    assert.deepEqual(boundary.state.registrations, []);
  }
});

test("adoption pins the existing versions until a publisher receipt establishes the store's new live version", async () => {
  const store = await fixture(), boundary = existingSite();
  const proposal = adoptionReady(await inspectAdoption(store, existingTarget, boundary.options));
  await applyAdoption(store, proposal.digest, boundary.options);
  boundary.state.workers.set(existingTarget.worker, [laterVersion]);
  await assert.rejects(assertOnboardingReady(store, boundary.options), /versions changed/);
  const receiptPath = join(store.stateDir, "last-release.json");
  const receipt = { schema: "mandate-share.receipt/v1", store: { id: store.id, rootFingerprint: hashBytes(store.root) }, target: { worker: existingTarget.worker, accountFingerprint: hashBytes(account.id), hostname: existingTarget.hostname }, versionId: laterVersion };
  await writeFile(receiptPath, JSON.stringify(receipt)); // Synthetic output of the publisher boundary.
  await assertOnboardingReady(store, boundary.options);
  await applyAdoption(store, proposal.digest, boundary.options);
  assert.deepEqual(JSON.parse(await readFile(receiptPath, "utf8")), receipt);
  boundary.state.workers.set(existingTarget.worker, [versionId]);
  await assert.rejects(assertOnboardingReady(store, boundary.options), /published version/);
  boundary.state.workers.set(existingTarget.worker, [laterVersion]);
  boundary.state.domains.get(existingTarget.hostname)!.id = "recreated-domain";
  await assert.rejects(assertOnboardingReady(store, boundary.options), /hostname.*changed/);
  boundary.state.domains.set(existingTarget.hostname, { ...existingDomain });
  await writeFile(receiptPath, JSON.stringify({ ...receipt, store: { ...receipt.store, id: randomUUID() } }));
  await assert.rejects(assertOnboardingReady(store, boundary.options), /published version/);
});

test("the release pipeline rechecks adoption and its first receipt supports subsequent updates", async () => {
  const store = await fixture(), boundary = existingSite();
  for (const directory of ["digests", "raw", "access"]) await mkdir(join(store.root, directory));
  const source = "<!doctype html>\r\n<h1>Adopted site fixture</h1>\r\n";
  await writeFile(join(store.root, "raw/page.html"), source);
  await writeFile(join(store.root, "raw/manifest.json"), JSON.stringify({ page: { title: "Adopted site fixture", unlisted: true, created: "2026-09-08" } }));
  await setPageSharing(store, "page", { visibility: "unlisted" });
  const adoption = adoptionReady(await inspectAdoption(store, existingTarget, boundary.options));
  await applyAdoption(store, adoption.digest, boundary.options);
  let uploads = 0;
  const options: PublisherOptions = { ...boundary.options, build: async selected => {
    await mkdir(selected.outDir, { recursive: true });
    await writeFile(join(selected.outDir, "page.html"), await readFile(join(selected.root, "raw/page.html")));
  }, runner: async call => {
    if (call.phase === "compile") await writeFile(join(call.cwd, "bundle/index.js"), "// synthetic compiled worker\n");
    if (call.phase === "publish") {
      const config = JSON.parse(await readFile(join(call.cwd, "deploy.json"), "utf8"));
      assert.equal(config.account_id, account.id);
      assert.equal(config.name, existingTarget.worker);
      assert.deepEqual(config.routes, [{ pattern: existingTarget.hostname, custom_domain: true }]);
      assert.equal(await readFile(join(call.cwd, "assets/page.html"), "utf8"), source);
      uploads++;
      boundary.state.workers.set(existingTarget.worker, [laterVersion]);
    }
    return { code: 0, versionId: laterVersion };
  } };
  const planned = await prepareRelease(store, options);
  boundary.state.workers.set(existingTarget.worker, [laterVersion]);
  await assert.rejects(publishRelease(store, planned.plan.releaseDigest, options), /versions changed/);
  assert.equal(uploads, 0);
  await assert.rejects(readFile(join(store.stateDir, "last-release.json")), { code: "ENOENT" });
  boundary.state.workers.set(existingTarget.worker, [versionId]);
  const published = await publishRelease(store, planned.plan.releaseDigest, options);
  assert.equal(uploads, 1);
  const receipt = JSON.parse(await readFile(published.receiptPath, "utf8"));
  assert.equal(receipt.versionId, laterVersion);
  assert.equal(receipt.digest, planned.plan.releaseDigest);
  assert.equal(receipt.target.hostname, existingTarget.hostname);
  await assertOnboardingReady(store, boundary.options);
  const update = await prepareRelease(store, options);
  boundary.state.domains.get(existingTarget.hostname)!.worker = "different-site";
  await assert.rejects(publishRelease(store, update.plan.releaseDigest, options), /hostname/);
  assert.equal(uploads, 1);
  boundary.state.domains.set(existingTarget.hostname, { ...existingDomain });
  await publishRelease(store, update.plan.releaseDigest, options);
  assert.equal(uploads, 2);
  assert.deepEqual(boundary.state.registrations, []);
});

test("local configuration alone grants no adoption and a new adoption review invalidates earlier release confirmation", async () => {
  const store = await fixture(), boundary = existingSite();
  await writeFile(join(store.stateDir, "publisher.json"), JSON.stringify(existingTarget));
  await writeFile(join(store.stateDir, "release-active.json"), JSON.stringify({ digest: "a".repeat(64) }));
  const proposal = adoptionReady(await inspectAdoption(store, existingTarget, boundary.options));
  await assert.rejects(assertOnboardingReady(store, boundary.options), /incomplete/);
  await assert.rejects(readFile(join(store.stateDir, "release-active.json")), { code: "ENOENT" });
  await applyAdoption(store, proposal.digest, boundary.options);
  await writeFile(join(store.stateDir, "release-active.json"), JSON.stringify({ digest: "b".repeat(64) }));
  const replacement = adoptionReady(await inspectAdoption(store, existingTarget, boundary.options));
  assert.notEqual(replacement.digest, proposal.digest);
  await assert.rejects(applyAdoption(store, proposal.digest, boundary.options), /stale/);
  await assert.rejects(readFile(join(store.stateDir, "release-active.json")), { code: "ENOENT" });
  await applyAdoption(store, replacement.digest, boundary.options);
  const path = join(store.stateDir, "onboarding.json");
  const state = JSON.parse(await readFile(path, "utf8")); state.adoption.proposal.config.hostname = "another.example.com";
  await writeFile(path, JSON.stringify(state));
  await assert.rejects(assertOnboardingReady(store, boundary.options), /changed|invalid/);
});

test("adoption reports unsupported hostname verification and binds existing workers.dev addresses without registering them", async () => {
  const store = await fixture(), boundary = existingSite();
  delete boundary.provider.getDomain;
  await assert.rejects(inspectAdoption(store, existingTarget, boundary.options), /cannot verify.*Update the runtime/);
  await assert.rejects(inspectAdoption(store, { accountId: account.id, worker: existingTarget.worker, workersDev: true }, boundary.options), /address is missing/);
  boundary.state.subdomain = "existing-address";
  const proposal = adoptionReady(await inspectAdoption(store, { accountId: account.id, worker: existingTarget.worker, workersDev: true }, boundary.options));
  assert.equal(proposal.url, "https://existing-site.existing-address.workers.dev");
  await applyAdoption(store, proposal.digest, boundary.options);
  await assertOnboardingReady(store, boundary.options);
  assert.equal(await getStorePublicOrigin(store), proposal.url);
  boundary.state.subdomain = "different-address";
  await assert.rejects(assertOnboardingReady(store, boundary.options), /address.*changed/);
  assert.deepEqual(boundary.state.registrations, []);
});

test("domain adapter uses account-scoped hostname-filtered GET and rejects ambiguous or malformed results", async () => {
  const store = await fixture(); const requests: string[] = [];
  let rows: unknown[] = [{ id: "domain-record", hostname: "share.example.com", service: "existing-site", zone_id: "c".repeat(32), environment: "production" }];
  let pages = 1;
  const provider = createOnboardingProvider(store, {
    runner: async () => ({ code: 0, stdout: JSON.stringify({ type: "oauth", token: "synthetic-authentication" }) }),
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push(String(url)); assert.equal(init?.method, undefined); assert.equal(init?.redirect, "error");
      return Response.json({ success: true, result: rows, result_info: { total_pages: pages } });
    }) as typeof fetch,
  });
  assert.deepEqual(await provider.getDomain!(account.id, "share.example.com"), existingDomain);
  assert.equal(requests[0], `https://api.cloudflare.com/client/v4/accounts/${account.id}/workers/domains?hostname=share.example.com`);
  rows = []; assert.equal(await provider.getDomain!(account.id, "share.example.com"), null);
  rows = [{ id: "domain-record", hostname: "share.example.com", service: "existing-site", zone_id: "c".repeat(32) }];
  assert.equal((await provider.getDomain!(account.id, "share.example.com"))?.environment, "production");
  rows.push(rows[0]); await assert.rejects(provider.getDomain!(account.id, "share.example.com"), /ambiguous/);
  rows = [{ hostname: "share.example.com", service: "existing-site", zone_id: "c".repeat(32) }];
  await assert.rejects(provider.getDomain!(account.id, "share.example.com"), /invalid/);
  pages = 2; await assert.rejects(provider.getDomain!(account.id, "share.example.com"), /incomplete/);
});
