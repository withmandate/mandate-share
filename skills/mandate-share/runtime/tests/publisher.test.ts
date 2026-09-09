import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile, cp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setPageSharing } from "../lib/privacy.ts";
import { applyOnboarding, inspectOnboarding, type OnboardingProvider } from "../lib/onboarding.ts";
import type { StoreContext } from "../lib/context.ts";
import { createPasswordEntry, getAccessContext, writeAccessManifest } from "../lib/access.ts";
import { setupPublisher, prepareRelease, publishRelease, parseProviderOutput, runWrangler, type PublisherOptions, type WranglerInvocation, type WranglerRunner } from "../lib/publisher.ts";
import { releaseInventory } from "../lib/release.ts";

const roots: string[] = [];
const runtimeRoot = resolve(import.meta.dirname, "..");
const target = { worker: "fixture-publisher", accountId: "b".repeat(32), workersDev: true as const };
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(name = "fixture"): Promise<StoreContext> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mandate-share-publisher-")));
  roots.push(root);
  const store = { id: randomUUID(), name, root, runtimeRoot, stateDir: join(root, ".mandate-share"), outDir: join(root, ".mandate-share/dist") };
  for (const path of ["digests", "raw", "access", ".mandate-share"]) await mkdir(join(root, path));
  await writeFile(join(root, "store.json"), JSON.stringify({ schema: 1, id: store.id }));
  await writeFile(join(root, "raw/page.html"), "<!doctype html>\r\n<h1>Fixture</h1>\r\n");
  await writeFile(join(root, "raw/manifest.json"), JSON.stringify({ page: { title: "Fixture", unlisted: true, created: "2026-09-08" } }));
  await setPageSharing(store, "page", { visibility: "unlisted" });
  await setupPublisher(store, target, []);
  return store;
}
function boundary() {
  const calls: WranglerInvocation[] = [];
  let builds = 0;
  let uploaded: Awaited<ReturnType<typeof releaseInventory>> | undefined;
  const runner: WranglerRunner = async (call) => {
    calls.push(call);
    const config = JSON.parse(await readFile(call.command[call.command.indexOf("--config") + 1], "utf8"));
    assert.strictEqual(config.account_id, target.accountId);
    if (call.phase === "compile") {
      const source = await readFile(join(call.cwd, "worker/index.ts"), "utf8");
      await writeFile(join(call.cwd, "bundle/index.js"), `// controlled compiler artifact\n${source}`);
      await writeFile(join(call.cwd, "bundle/README.md"), "wrangler fixture");
      await writeFile(join(call.cwd, "bundle/index.js.map"), "fixture sourcemap");
    } else if (call.phase === "publish") uploaded = await releaseInventory(call.cwd);
    return { code: 0, stdout: "suppressed account and token output\nhttps://fixture-publisher.synthetic-account.workers.dev\nCurrent Version ID: 11111111-1111-4111-8111-111111111111", stderr: "suppressed provider output" };
  };
  const options: PublisherOptions = { runner, knownStores: [], build: async (store) => {
    builds++;
    await rm(store.outDir, { force: true, recursive: true });
    await mkdir(store.outDir);
    await cp(join(store.root, "raw/page.html"), join(store.outDir, "page.html"));
    if (existsSync(join(store.root, "raw/other.html"))) await cp(join(store.root, "raw/other.html"), join(store.outDir, "other.html"));
  } };
  return { options, calls, builds: () => builds, uploaded: () => uploaded };
}

test("prepare is offline; publish uploads only frozen bytes, consumes digest, and records local state", async () => {
  const store = await fixture();
  await writeAccessManifest(store.root, { page: await createPasswordEntry("fixture secret", { iterations: 1000 }) });
  const fake = boundary();
  const summary = await prepareRelease(store, fake.options);
  assert.deepStrictEqual(fake.calls.map((c) => c.phase), ["compile", "validate"]);
  for (const call of fake.calls) {
    assert.ok((call.command).includes("--dry-run"));
    assert.strictEqual(call.command[1], join(runtimeRoot, "node_modules/wrangler/bin/wrangler.js"));
    assert.strictEqual(call.env.HOME, undefined);
    assert.strictEqual(call.env.XDG_CONFIG_HOME.startsWith(summary.candidatePath), true);
    assert.ok((call.command).includes("--profile"));
    assert.strictEqual(call.env.CLOUDFLARE_API_TOKEN, undefined);
    assert.strictEqual(call.env.CLOUDFLARE_API_BASE_URL, "http://127.0.0.1:1");
    assert.strictEqual(call.env.WRANGLER_SEND_METRICS, "false");
  }
  const context = await getAccessContext(store);
  const source = await readFile(join(summary.candidatePath, "payload/worker/index.ts"), "utf8");
  assert.ok((source).includes(context.signingKey));
  assert.ok((source).includes(store.id));
  assert.ok(!(JSON.stringify(summary)).includes(context.signingKey));
  assert.ok(!(JSON.stringify(summary)).includes(target.accountId));
  assert.strictEqual((await stat(join(summary.candidatePath, "payload/worker/index.ts"))).mode & 0o777, 0o600);
  await writeFile(join(store.outDir, "page.html"), "unrelated subsequent build output");
  const result = await publishRelease(store, summary.plan.releaseDigest, fake.options);
  assert.strictEqual(fake.builds(), 1);
  assert.deepStrictEqual(fake.calls.map((c) => c.phase), ["compile", "validate", "publish"]);
  assert.ok((fake.calls[2].command).includes("--no-bundle"));
  assert.ok(!(fake.calls[2].command).includes("--dry-run"));
  assert.deepStrictEqual(fake.uploaded(), summary.plan.payload);
  assert.strictEqual(result.remoteVerified, false);
  assert.strictEqual(result.url, "https://fixture-publisher.synthetic-account.workers.dev");
  assert.strictEqual(JSON.parse(await readFile(result.receiptPath, "utf8")).digest, summary.plan.releaseDigest);
  await assert.rejects(publishRelease(store, summary.plan.releaseDigest, fake.options), (error) => error instanceof Error && error.message.includes("consumed"));
});

test("different stores, target drift, source drift, and candidate mutations reject before upload", async () => {
  const store = await fixture();
  const other = await fixture("other");
  const fake = boundary();
  const first = await prepareRelease(store, fake.options);
  await assert.rejects(publishRelease(other, first.plan.releaseDigest, fake.options));
  await assert.rejects(publishRelease(store, "0".repeat(64), fake.options), (error) => error instanceof Error && error.message.includes("stale"));
  await setupPublisher(store, { ...target, worker: "changed-target" }, []);
  await assert.rejects(publishRelease(store, first.plan.releaseDigest, fake.options), (error) => error instanceof Error && error.message.includes("target changed"));
  await setupPublisher(store, target, []);
  await writeFile(join(store.root, "raw/page.html"), "changed source");
  await assert.rejects(publishRelease(store, first.plan.releaseDigest, fake.options), (error) => error instanceof Error && error.message.includes("inputs changed"));
  const second = await prepareRelease(store, fake.options);
  await assert.rejects(publishRelease(store, first.plan.releaseDigest, fake.options), (error) => error instanceof Error && error.message.includes("stale"));
  await writeFile(join(second.candidatePath, "payload/bundle/index.js"), "mutated bundle");
  await assert.rejects(publishRelease(store, second.plan.releaseDigest, fake.options), (error) => error instanceof Error && error.message.includes("candidate changed"));
  assert.strictEqual((fake.calls.filter((call) => call.phase === "publish")).length, 0);
});

test("signing key and copied-store identity drift reject; symlink assets reject", async () => {
  const store = await fixture();
  const fake = boundary();
  const summary = await prepareRelease(store, fake.options);
  const signingPath = join(store.stateDir, "access-signing-key");
  await writeFile(signingPath, `${Buffer.alloc(32, 5).toString("base64")}\n`, { mode: 0o600 });
  await assert.rejects(publishRelease(store, summary.plan.releaseDigest, fake.options), (error) => error instanceof Error && error.message.includes("signing state changed"));
  const copied = await fixture("copied");
  await cp(store.stateDir, copied.stateDir, { recursive: true });
  await assert.rejects(publishRelease(copied, summary.plan.releaseDigest, fake.options), (error) => error instanceof Error && error.message.includes("different store"));
  const symlinked = boundary();
  symlinked.options.build = async (selected) => { await mkdir(selected.outDir, { recursive: true }); await symlink(join(selected.root, "raw/page.html"), join(selected.outDir, "page.html")); };
  await assert.rejects(prepareRelease(await fixture("symlink"), symlinked.options), (error) => error instanceof Error && error.message.includes("symlinks"));
});

test("removals compare with the last successful local receipt and target bindings cannot collide", async () => {
  const store = await fixture();
  await writeFile(join(store.root, "raw/other.html"), "another fixture");
  await setPageSharing(store, "other", { visibility: "unlisted" });
  const fake = boundary();
  const first = await prepareRelease(store, fake.options);
  await publishRelease(store, first.plan.releaseDigest, fake.options);
  await rm(join(store.root, "raw/other.html"));
  const second = await prepareRelease(store, fake.options);
  assert.deepStrictEqual(second.plan.removals, ["other.html"]);
  assert.ok((second.receiptBasis).includes("remote state has not been checked"));
  const other = await fixture("other");
  await assert.rejects(setupPublisher(other, target, [store, other]), (error) => error instanceof Error && error.message.includes("already bound"));
  await setupPublisher(store, { worker: "domain-one", accountId: target.accountId, hostname: "share.example.com" }, []);
  await assert.rejects(setupPublisher(other, { worker: "domain-two", accountId: "c".repeat(32), hostname: "SHARE.EXAMPLE.COM" }, [store, other]), (error) => error instanceof Error && error.message.includes("already bound"));
});

test("a failed upload consumes confirmation and never writes a success receipt", async () => {
  const store = await fixture();
  const fake = boundary();
  const prepared = await prepareRelease(store, fake.options);
  const failing: PublisherOptions = { ...fake.options, runner: async () => ({ code: 1, stdout: target.accountId, stderr: "token fixture secret" }) };
  await assert.rejects(publishRelease(store, prepared.plan.releaseDigest, failing), (error) => error instanceof Error && error.message.includes("result is uncertain"));
  assert.strictEqual(existsSync(join(store.stateDir, "last-release.json")), false);
  await assert.rejects(publishRelease(store, prepared.plan.releaseDigest, fake.options), (error) => error instanceof Error && error.message.includes("consumed"));
});


test("real store build enters the full release pipeline and raw bytes remain unchanged", async () => {
  const store = await fixture();
  const source = '---\ntitle: Release fixture\nunlisted: true\n---\n# Release fixture\n\n<Callout>Selected store only.</Callout>\n';
  await writeFile(join(store.root, "digests/note.mdx"), source);
  await writeAccessManifest(store.root, { note: await createPasswordEntry("fixture-only", { iterations: 1000 }) });
  const fake = boundary();
  const options = { runner: fake.options.runner, knownStores: [] };
  const prepared = await prepareRelease(store, options);
  const files = prepared.plan.assets.files.map((file) => file.path);
  assert.ok((files).includes("page.html"));
  assert.ok((files).includes("note.html"));
  assert.ok((files).includes("note.mdx"));
  assert.ok((files).includes("index.html"));
  assert.strictEqual(await readFile(join(prepared.candidatePath, "payload/assets/page.html"), "utf8"), await readFile(join(store.root, "raw/page.html"), "utf8"));
  assert.strictEqual(await readFile(join(prepared.candidatePath, "payload/assets/note.mdx"), "utf8"), source);
  const result = await publishRelease(store, prepared.plan.releaseDigest, options);
  assert.strictEqual(result.uploaded, true);
  assert.deepStrictEqual(fake.calls.map((call) => call.phase), ["compile", "validate", "publish"]);
});

test("pinned Wrangler and workerd enforce HTTPS before the generated store gate for every asset alias", { timeout: 30_000 }, async () => {
  const store = await fixture();
  await writeFile(join(store.root, "digests/note.mdx"), '---\ntitle: Protected fixture\nunlisted: true\n---\n# Protected fixture\n');
  await writeFile(join(store.root, "raw/note-more.html"), "<!doctype html><h1>Public neighbor</h1>");
  await setPageSharing(store, "note-more", { visibility: "unlisted" });
  const sharedEntry = await createPasswordEntry("runtime-fixture-only", { iterations: 1000 });
  await writeFile(join(store.root, "raw/note-copy.html"), "<!doctype html><h1>Same password</h1>");
  await writeFile(join(store.root, "raw/note-custom.html"), "<!doctype html><h1>Separate password</h1>");
  await writeAccessManifest(store.root, { note: sharedEntry, "note-copy": sharedEntry, "note-custom": await createPasswordEntry("runtime-fixture-only", { iterations: 1000 }) });
  const prepared = await prepareRelease(store, { knownStores: [] });
  const workerPath = join(prepared.candidatePath, "payload/bundle/index.js");
  const assets = join(prepared.candidatePath, "payload/assets");
  const scriptPath = join(store.stateDir, "workerd-proof.mjs");
  // Miniflare 5's v4 converter currently needs source bytes instead of its legacy scriptPath option.
  const script = `
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from ${JSON.stringify(join(runtimeRoot, "node_modules/miniflare/dist/src/index.js"))};
import { readFile } from "node:fs/promises";
const mf = new Miniflare({...convertV4MiniflareOptions({name:"fixture",modules:true,script:await readFile(${JSON.stringify(workerPath)},"utf8"),compatibilityDate:"2026-08-26",host:"127.0.0.1",port:0,cf:false,log:new Log(LogLevel.NONE),ratelimits:{PASSWORD_ATTEMPTS:{namespace_id:"123",simple:{limit:10,period:60}}},assets:{directory:${JSON.stringify(assets)},binding:"ASSETS",run_worker_first:["/*"],routerConfig:{has_user_worker:true},assetConfig:{html_handling:"auto-trailing-slash",not_found_handling:"404-page"}}}),telemetry:{enabled:false}});
try {
  await mf.ready;
  for (const method of ["GET", "HEAD"]) {
    for (const path of ["/", "/page", "/note", "/note.mdx", "/note%2Emdx?download=1&view=source"]) {
      const response = await mf.dispatchFetch("http://fixture.local" + path,{method,redirect:"manual"});
      if (response.status !== 308 || response.headers.get("location") !== "https://fixture.local" + path) throw new Error("HTTP redirect failed: " + method + " " + path + " " + response.status);
      if (response.headers.get("cache-control") !== "no-store" || response.headers.get("x-robots-tag") !== "noindex, nofollow" || response.headers.has("set-cookie") || await response.text() !== "") throw new Error("HTTP redirect exposed content or session state");
    }
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    for (const path of ["/note", "/page"]) {
      const response = await mf.dispatchFetch("http://fixture.local" + path,{method,headers:{"content-type":"application/x-www-form-urlencoded"},body:"password=runtime-fixture-only",redirect:"manual"});
      if (response.status !== 400 || response.headers.has("location") || response.headers.has("set-cookie") || await response.text() !== "") throw new Error("HTTP method was not rejected before authentication: " + method);
      if (response.headers.get("cache-control") !== "no-store" || response.headers.get("x-robots-tag") !== "noindex, nofollow") throw new Error("HTTP rejection headers failed");
    }
  }
  const statuses = {};
  for (const path of ["/note","/note/","/note.html","/note.mdx","/%6eote","/note%2ehtml","/note%2Emdx"]) {
    const response = await mf.dispatchFetch("https://fixture.local" + path,{redirect:"manual"});
    statuses[path] = response.status;
    if (response.status !== 401) throw new Error("protected alias escaped: " + path + " " + response.status);
  }
  for (const path of ["/page","/note-more"]) {
    const response = await mf.dispatchFetch("https://fixture.local" + path,{redirect:"manual"});
    statuses[path] = response.status;
    if (response.status !== 200) throw new Error("public control failed: " + path);
  }
async function browserForm(html, password) {
  const challenge = /name="challenge" value="([^"]+)"/.exec(html)?.[1];
  const params = /^2\\.(\\d+)\\.([A-Za-z0-9_-]+)$/.exec(challenge ?? '');
  if (!params) throw new Error('No native-browser password challenge.');
  const salt = Uint8Array.from(atob(params[2].replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations:Number(params[1])},key,256));
  const proof = btoa(String.fromCharCode(...bits)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
  return new URLSearchParams({proof,challenge});
}

  const post = async (password, path="/note", ip="192.0.2.10") => mf.dispatchFetch("https://fixture.local"+path,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded","cf-connecting-ip":ip},body:(await browserForm(await (await mf.dispatchFetch("https://fixture.local"+path)).text(),password)).toString(),redirect:"manual"});
  const wrong = await post("wrong");
  const correct = await post("runtime-fixture-only");
  if (wrong.status !== 401 || correct.status !== 303) throw new Error("password flow failed");
  if (!correct.headers.get("set-cookie").includes("; Secure")) throw new Error("HTTPS session cookie is not secure");
  const cookie = correct.headers.get("set-cookie").split(";")[0];
  const insecureSession = await mf.dispatchFetch("http://fixture.local/note",{headers:{cookie},redirect:"manual"});
  if (insecureSession.status !== 308 || insecureSession.headers.has("set-cookie") || await insecureSession.text() !== "") throw new Error("HTTP session bypassed transport protection");
  const html = await mf.dispatchFetch("https://fixture.local/note",{headers:{cookie},redirect:"manual"});
  const source = await mf.dispatchFetch("https://fixture.local/note.mdx",{headers:{cookie},redirect:"manual"});
  if (html.status !== 200 || source.status !== 200) throw new Error("authorized assets failed");
  let limited;
  for (let i=0;i<30;i++) {
    limited = await post("wrong", i%2 ? "/note-copy" : "/note.mdx");
    if (limited.status===429) break;
    if (limited.status!==401) throw new Error("unexpected attempt status: "+limited.status);
  }
  if (limited.status!==429 || limited.headers.get("retry-after")!=="60" || limited.headers.has("set-cookie")) throw new Error("shared-profile attempts were not limited");
  if ((await post("runtime-fixture-only","/note-copy")).status!==429) throw new Error("shared profile escaped rate limit");
  if ((await post("runtime-fixture-only","/note","192.0.2.11")).status!==303) throw new Error("independent visitor blocked");
  if ((await post("runtime-fixture-only","/note-custom")).status!==303) throw new Error("independent password profile blocked");
  if ((await mf.dispatchFetch("https://fixture.local/note",{headers:{cookie}})).status!==200) throw new Error("existing access blocked by limiter");
  if (html.headers.get("strict-transport-security")!=="max-age=31536000" || source.headers.get("referrer-policy")!=="same-origin") throw new Error("security response headers missing");
  console.log(JSON.stringify({httpsEnforced:true,rateLimited:true,statuses,wrong:wrong.status,correct:correct.status,html:html.status,source:source.status}));
} finally { await mf.dispose(); }
`;
  await writeFile(scriptPath, script, { mode: 0o600 });
  const { stdout } = await promisify(execFile)(process.execPath, [scriptPath], { cwd: store.stateDir, env: { PATH: process.env.PATH ?? "", WRANGLER_SEND_METRICS: "false" }, timeout: 25_000 });
  const result = JSON.parse(stdout);
  assert.strictEqual(result.httpsEnforced, true);
  assert.strictEqual(result.rateLimited, true);
  assert.strictEqual(result.statuses["/%6eote"], 401);
  assert.strictEqual(result.statuses["/note-more"], 200);
  assert.strictEqual(result.wrong, 401);
  assert.strictEqual(result.correct, 303);
  assert.strictEqual(result.html, 200);
  assert.strictEqual(result.source, 200);
  assert.strictEqual(prepared.uploaded, false);
});


test("provider URL parsing returns only the selected Worker root, without credentials or query values", () => {
  assert.strictEqual(parseProviderOutput("https://fixture-publisher.synthetic-account.workers.dev", target.worker).url, "https://fixture-publisher.synthetic-account.workers.dev");
  for (const url of ["https://other-worker.synthetic-account.workers.dev", "https://fixture-publisher.synthetic-account.workers.dev.evil.example", "https://secret@fixture-publisher.synthetic-account.workers.dev", "https://fixture-publisher.synthetic-account.workers.dev?token=secret", "https://fixture-publisher.synthetic-account.workers.dev/path", "https://fixture-publisher.synthetic-account.workers.dev#secret", "http://fixture-publisher.synthetic-account.workers.dev", "https://fixture-publisher.synthetic-account.workers.dev:8443", "https://fixture-publisher.too.many.workers.dev"]) assert.strictEqual(parseProviderOutput(url, target.worker).url, undefined);
});


test("runtime changes and edited plans invalidate the saved confirmation", async () => {
  const store = await fixture();
  const fixtureRuntime = await realpath(await mkdtemp(join(tmpdir(), "mandate-share-runtime-fixture-")));
  roots.push(fixtureRuntime);
  store.runtimeRoot = fixtureRuntime;
  for (const directory of ["lib", "node_modules/wrangler/bin", "node_modules/wrangler/wrangler-dist"]) await mkdir(join(fixtureRuntime, directory), { recursive: true });
  for (const file of ["access-core.ts", "unlock-client.ts", "privacy-core.ts", "slug.ts"]) await cp(join(runtimeRoot, "lib", file), join(fixtureRuntime, "lib", file));
  for (const path of ["package.json", "node_modules/wrangler/package.json"]) await writeFile(join(fixtureRuntime, path), '{"name":"synthetic-runtime","version":"0.0.0"}');
  for (const path of ["package-lock.json", "node_modules/wrangler/bin/wrangler.js", "node_modules/wrangler/wrangler-dist/cli.js"]) await writeFile(join(fixtureRuntime, path), "synthetic test tool");
  const fake = boundary();
  const first = await prepareRelease(store, fake.options);
  await writeFile(join(fixtureRuntime, "lib/added.ts"), "// changed local tool");
  await assert.rejects(publishRelease(store, first.plan.releaseDigest, fake.options), (error) => error instanceof Error && error.message.includes("runtime or publishing tool changed"));
  const second = await prepareRelease(store, fake.options);
  const edited = { ...second.plan, protectedSlugs: ["not-in-reviewed-plan"] };
  await writeFile(join(second.candidatePath, "plan.json"), JSON.stringify(edited));
  await assert.rejects(publishRelease(store, second.plan.releaseDigest, fake.options), (error) => error instanceof Error && error.message.includes("does not match"));
  assert.strictEqual((fake.calls.filter((call) => call.phase === "publish")).length, 0);
});

test("a changed local receipt invalidates an already prepared removal inventory", async () => {
  const store = await fixture();
  const fake = boundary();
  const first = await prepareRelease(store, fake.options);
  const result = await publishRelease(store, first.plan.releaseDigest, fake.options);
  const second = await prepareRelease(store, fake.options);
  await writeFile(result.receiptPath, (await readFile(result.receiptPath, "utf8")) + "\n");
  await assert.rejects(publishRelease(store, second.plan.releaseDigest, fake.options), (error) => error instanceof Error && error.message.includes("local release receipt changed"));
});

test("zero-exit provider cancellation cannot become a successful local receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "mandate-share-provider-boundary-"));
  roots.push(root);
  const invocation = { command: [process.execPath, "-e", 'console.log("Deployment cancelled")'], cwd: root, env: { PATH: process.env.PATH ?? "" }, phase: "publish" as const, expectedWorker: target.worker };
  assert.notStrictEqual((await runWrangler(invocation)).code, 0);
  invocation.command[2] = 'console.log("Current Version ID: 11111111-1111-4111-8111-111111111111\\nhttps://fixture-publisher.synthetic-account.workers.dev")';
  const result = await runWrangler(invocation);
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.url, "https://fixture-publisher.synthetic-account.workers.dev");
  assert.strictEqual(result.stdout, undefined);
});

test("simultaneous CLI publisher setups cannot bind one destination to two registered stores", async () => {
  const first = await fixture("first");
  const second = await fixture("second");
  const registry = await mkdtemp(join(tmpdir(), "mandate-share-publisher-registry-"));
  roots.push(registry);
  const previous = process.env.MANDATE_SHARE_HOME;
  try {
    process.env.MANDATE_SHARE_HOME = registry;
    await writeFile(join(registry, "config.json"), JSON.stringify({ schema: 1, stores: { first: { root: first.root }, second: { root: second.root } } }));
    await rm(join(first.stateDir, "publisher.json"));
    await rm(join(second.stateDir, "publisher.json"));
    const outcomes = await Promise.allSettled([setupPublisher(first, target), setupPublisher(second, target)]);
    assert.strictEqual((outcomes.filter((outcome) => outcome.status === "fulfilled")).length, 1);
    const other = outcomes[0].status === "fulfilled" ? second : first;
    await assert.rejects(setupPublisher(other, target), (error) => error instanceof Error && error.message.includes("already bound"));
    assert.strictEqual(existsSync(join(other.stateDir, "publisher.json")), false);
  } finally {
    if (previous === undefined) delete process.env.MANDATE_SHARE_HOME; else process.env.MANDATE_SHARE_HOME = previous;
  }
});

test("default-private pages cannot enter a release without a verifier, even with hidden listing metadata", async () => {
  const store = await fixture();
  await writeFile(join(store.root, "raw/secret.html"), "<!doctype html><h1>Synthetic private title</h1>");
  const fake = boundary();
  await assert.rejects(prepareRelease(store, fake.options), /Private pages need a password/);
  assert.equal(fake.calls.length, 0);
  await setPageSharing(store, "secret", { visibility: "unlisted" });
  const prepared = await prepareRelease(store, fake.options);
  await setPageSharing(store, "secret", { visibility: "private" });
  await assert.rejects(publishRelease(store, prepared.plan.releaseDigest, fake.options), /inputs changed|privacy changed/);
  assert.equal(fake.calls.filter(call => call.phase === "publish").length, 0);
});

test("more than 100 private pages use one Worker route and a bounded header file", async () => {
  const store = await fixture(); const fake = boundary();
  const entry = await createPasswordEntry("synthetic profile", { iterations: 1_000 });
  const manifest = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`protected-${index}`, entry]));
  await Promise.all(Object.keys(manifest).map(slug => writeFile(join(store.root, "raw", `${slug}.html`), `<!doctype html><h1>${slug}</h1>`)));
  await writeAccessManifest(store.root, manifest);
  const prepared = await prepareRelease(store, { runner: fake.options.runner, knownStores: [] });
  assert.equal(prepared.plan.protectedSlugs.length, 101);
  assert.deepEqual(JSON.parse(await readFile(join(prepared.candidatePath, "payload/deploy.json"), "utf8")).assets.run_worker_first, ["/*"]);
  const headers = await readFile(join(prepared.candidatePath, "payload/assets/_headers"), "utf8");
  assert.equal(headers.split("\n").filter(line => line.startsWith("/")).length, 2);
  const index = await readFile(join(prepared.candidatePath, "payload/assets/index.html"), "utf8");
  assert.equal(index.includes("protected-0"), false);
});

test("guided setup binds the release address and rechecks provider drift before frozen upload", async () => {
  const store = await fixture(); const fake = boundary();
  let subdomain = "synthetic-account"; let checks = 0; let versions: string[] = [];
  const provider: OnboardingProvider = {
    identity: async () => { checks++; return { authenticated: true, accounts: [{ id: target.accountId, name: "Synthetic" }] }; },
    login: async () => { throw new Error("test must not start login"); },
    getSubdomain: async () => subdomain,
    createSubdomain: async () => { throw new Error("test must not register an existing address"); },
    getWorker: async () => ({ exists: versions.length > 0, versionIds: versions }),
  };
  const proposal = await inspectOnboarding(store, {}, { provider, knownStores: [] });
  assert.equal(proposal.status, "ready");
  if (proposal.status !== "ready") throw new Error("expected proposal");
  await applyOnboarding(store, proposal.proposal.digest, { provider, knownStores: [] });
  const options = { ...fake.options, provider };
  const prepared = await prepareRelease(store, options);
  assert.equal(prepared.plan.target.workersDevSubdomain, "synthetic-account");
  subdomain = "changed-after-review";
  await assert.rejects(publishRelease(store, prepared.plan.releaseDigest, options), /address changed/);
  assert.equal(fake.calls.filter(call => call.phase === "publish").length, 0);
  subdomain = "synthetic-account";
  const result = await publishRelease(store, prepared.plan.releaseDigest, options);
  versions = [result.versionId!];
  await prepareRelease(store, options);
  assert.ok(checks >= 6);
  assert.equal(fake.builds(), 2);
});

test("guided-to-hostname transition invalidates old confirmation and preserves ownership, removals and frozen upload", async () => {
  const store = await fixture(); const fake = boundary();
  await writeFile(join(store.root, "raw/other.html"), "old synthetic page");
  await setPageSharing(store, "other", { visibility: "unlisted" });
  let versions: string[] = []; let hostnameMode = false;
  const provider: OnboardingProvider = {
    identity: async () => ({ authenticated: true, accounts: [{ id: target.accountId, name: "Synthetic" }] }),
    login: async () => { throw new Error("must not login"); },
    getSubdomain: async () => { if (hostnameMode) throw new Error("obsolete account address must not be consulted"); return "synthetic-account"; },
    createSubdomain: async () => { throw new Error("must not register an account address"); },
    getWorker: async () => ({ exists: versions.length > 0, versionIds: versions }),
  };
  const options = { ...fake.options, provider };
  const inspected = await inspectOnboarding(store, {}, options);
  if (inspected.status !== "ready") throw new Error("expected guided proposal");
  await applyOnboarding(store, inspected.proposal.digest, options);
  const first = await prepareRelease(store, options);
  versions = [(await publishRelease(store, first.plan.releaseDigest, options)).versionId!];
  const stale = await prepareRelease(store, options);
  await setupPublisher(store, { worker: target.worker, accountId: target.accountId, hostname: "share.example.com" }, []);
  hostnameMode = true;
  await assert.rejects(publishRelease(store, stale.plan.releaseDigest, options), /state is missing|stale/);
  assert.equal((await inspectOnboarding(store, {}, options)).status, "configured");
  await rm(join(store.root, "raw/other.html"));
  const prepared = await prepareRelease(store, options);
  assert.equal(prepared.plan.target.hostname, "share.example.com");
  assert.deepEqual(prepared.plan.removals, ["other.html"]);
  versions = ["22222222-2222-4222-8222-222222222222"];
  await assert.rejects(publishRelease(store, prepared.plan.releaseDigest, options), /ownership changed/);
  versions = ["11111111-1111-4111-8111-111111111111"];
  const beforeUpload = fake.builds();
  const result = await publishRelease(store, prepared.plan.releaseDigest, options);
  assert.equal(result.url, "https://share.example.com");
  assert.equal(fake.builds(), beforeUpload);
  assert.deepEqual(fake.uploaded(), prepared.plan.payload);
  await assert.rejects(publishRelease(store, prepared.plan.releaseDigest, options), /consumed/);
});
