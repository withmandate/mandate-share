import { unlockBody } from "./unlock-helpers.ts";
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer, request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { applyPasswordDirective, createPasswordEntry, writeAccessManifest } from "../lib/access.ts";
import { buildAll } from "../lib/build.ts";
import { readPagePolicies, recordBuiltPolicy, setPageSharing } from "../lib/privacy.ts";
import { importPage, removePage } from "../lib/content.ts";
import { VERSION, type StoreContext } from "../lib/context.ts";
import { ensureReviewServer, findReviewServer, PREVIEW_HEALTH_PATH, previewRegistryPath, previewRuntimeId, startServer } from "../lib/serve.ts";

const roots: string[] = [];
const servers: Awaited<ReturnType<typeof startServer>>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(label: string, password = "fixture password"): Promise<StoreContext> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mandate-share-preview-test-")));
  roots.push(root);
  const store: StoreContext = { id: crypto.randomUUID(), name: label, root, runtimeRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."), stateDir: join(root, ".state"), outDir: join(root, ".state", "out") };
  await mkdir(store.outDir, { recursive: true });
  await mkdir(join(store.root, "digests"));
  for (const slug of ["public", "brief", "brief-neighbor", "escape"]) {
    const source = slug === "brief" ? `${label} PRIVATE SOURCE\r\n` : `SYNTHETIC ${slug} PREVIEW SOURCE`;
    await writeFile(join(store.root, "digests", `${slug}.mdx`), source);
    await writeFile(join(store.outDir, `${slug}.mdx`), source);
  }
  await writeFile(join(store.outDir, "index.html"), `${label} INDEX`);
  await writeFile(join(store.outDir, "public.html"), `${label} PUBLIC`);
  await writeFile(join(store.outDir, "brief.html"), `${label} PRIVATE HTML\r\n`);
  await writeFile(join(store.outDir, "brief.mdx"), `${label} PRIVATE SOURCE\r\n`);
  await writeFile(join(store.outDir, "brief-neighbor.html"), `${label} NEIGHBOR`);
  await writeAccessManifest(root, { brief: await createPasswordEntry(password, { iterations: 1000 }) });
  for (const slug of ["public", "brief-neighbor", "escape"]) await setPageSharing(store, slug, { visibility: "unlisted" });
  await recordBuiltPolicy(store, await readPagePolicies(store));
  return store;
}

async function serve(store: StoreContext) {
  const server = await startServer(0, { store });
  servers.push(server);
  return { server, base: `http://127.0.0.1:${server.port}` };
}

async function unlock(base: string, password = "fixture password"): Promise<Response> {
  return fetch(`${base}/brief`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: await unlockBody(await (await fetch(`${base}/brief`)).text(), password) });
}

describe("loopback preview and exact-store reuse", () => {
  test("identifies only store/version/runtime and reuses matching health without a detached process", async () => {
    const store = await fixture("ALPHA");
    const { server, base } = await serve(store);
    assert.strictEqual(server.hostname, "127.0.0.1");
    assert.ok((server.port) > (0));
    assert.deepStrictEqual(await (await fetch(`${base}${PREVIEW_HEALTH_PATH}`)).json(), { id: store.id, version: VERSION, runtimeId: previewRuntimeId(store) });
    assert.strictEqual(await findReviewServer(store), base);
    assert.strictEqual(await ensureReviewServer("brief", store), `${base}/brief`);
    assert.strictEqual(await ensureReviewServer("", store), `${base}/`);
    assert.deepStrictEqual(JSON.parse(await readFile(previewRegistryPath(store), "utf8")), { id: store.id, version: VERSION, runtimeId: previewRuntimeId(store), port: server.port, pid: process.pid });
    const hostileHost = await new Promise<number | undefined>((done, reject) => {
      const request = httpRequest(`${base}${PREVIEW_HEALTH_PATH}`, { headers: { host: "attacker.example" } }, response => { response.resume(); done(response.statusCode); });
      request.once("error", reject); request.end();
    });
    assert.strictEqual(hostileHost, 403);
  });

  test("refuses another store on a stale port and starts a second live store on a free port", async () => {
    const first = await fixture("ALPHA");
    const second = await fixture("BETA");
    const a = await serve(first);
    await writeFile(previewRegistryPath(second), JSON.stringify({ id: second.id, version: VERSION, runtimeId: previewRuntimeId(second), port: a.server.port }));
    assert.strictEqual(await findReviewServer(second), undefined);
    const b = await serve(second);
    assert.notStrictEqual(b.server.port, a.server.port);
    assert.strictEqual(await ensureReviewServer("brief", first), `${a.base}/brief`);
    assert.strictEqual(await ensureReviewServer("brief", second), `${b.base}/brief`);
    assert.strictEqual(await (await fetch(`${a.base}/public`)).text(), "ALPHA PUBLIC");
    assert.strictEqual(await (await fetch(`${b.base}/public`)).text(), "BETA PUBLIC");
    a.server.stop(true);
    assert.strictEqual(await findReviewServer(first), undefined);
  });

  test("does not reuse a preview from an earlier runtime cache with the same package version", async () => {
    const store = await fixture("ALPHA");
    const original = await serve(store);
    const runtimeRoot = join(store.root, "fixture-updated-runtime");
    await mkdir(join(runtimeRoot, "lib"), { recursive: true });
    for (const file of ["serve.ts", "access-core.ts", "access.ts", "privacy-core.ts", "privacy.ts", "context.ts"]) await cp(join(store.runtimeRoot, "lib", file), join(runtimeRoot, "lib", file));
    const updated = { ...store, runtimeRoot };
    assert.strictEqual(await findReviewServer(updated), undefined);
    const fresh = await serve(updated);
    assert.notStrictEqual(fresh.base, original.base);
    assert.strictEqual(await findReviewServer(updated), fresh.base);
    assert.strictEqual(await findReviewServer(store), undefined);
  });

  test("never treats an unrelated HTTP service as this preview", async () => {
    const store = await fixture("ALPHA");
    const unrelatedHttp = createServer((_request, response) => { response.setHeader("x-robots-tag", "noindex, nofollow"); response.end("ordinary web app"); });
    await new Promise<void>(done => unrelatedHttp.listen(0, "127.0.0.1", done));
    const unrelated = { port: (unrelatedHttp.address() as { port: number }).port, stop() { unrelatedHttp.close(); unrelatedHttp.closeAllConnections(); } };
    try {
      await writeFile(previewRegistryPath(store), JSON.stringify({ id: store.id, version: VERSION, runtimeId: previewRuntimeId(store), port: unrelated.port }));
      assert.strictEqual(await findReviewServer(store), undefined);
      const actual = await serve(store);
      assert.notStrictEqual(actual.server.port, unrelated.port);
      assert.strictEqual(await findReviewServer(store), actual.base);
    } finally { unrelated.stop(); }
  });
});

describe("real HTTP password and source journeys", () => {
  test("two same-slug stores keep passwords, cookies, HTML/source bytes, changes, and removal isolated", async () => {
    const first = await fixture("ALPHA", "alpha password");
    const second = await fixture("BETA", "beta password");
    const a = await serve(first);
    const b = await serve(second);
    for (const base of [a.base, b.base]) {
      for (const path of ["/brief", "/brief/", "/brief.html", "/brief.html/", "/brief.mdx", "/brief.mdx/"]) {
        assert.strictEqual((await fetch(`${base}${path}`)).status, 401);
      }
      assert.strictEqual((await fetch(`${base}/brief-neighbor`)).status, 200);
    }
    assert.strictEqual((await unlock(a.base, "beta password")).status, 401);
    assert.strictEqual((await unlock(b.base, "alpha password")).status, 401);
    const aUnlocked = await unlock(a.base, "alpha password");
    const bUnlocked = await unlock(b.base, "beta password");
    assert.strictEqual(aUnlocked.status, 303);
    assert.strictEqual(bUnlocked.status, 303);
    const cookieA = aUnlocked.headers.get("set-cookie")!.split(";", 1)[0];
    const cookieB = bUnlocked.headers.get("set-cookie")!.split(";", 1)[0];
    assert.notStrictEqual(cookieA.split("=", 1)[0], cookieB.split("=", 1)[0]);
    assert.strictEqual((await fetch(`${b.base}/brief`, { headers: { cookie: cookieA } })).status, 401);
    assert.strictEqual((await fetch(`${a.base}/brief`, { headers: { cookie: cookieB } })).status, 401);
    // A browser sends both localhost cookies on both ports. Each store selects its own name.
    const cookies = `${cookieA}; ${cookieB}`;
    for (const [base, label] of [[a.base, "ALPHA"], [b.base, "BETA"]]) {
      for (const path of ["/brief", "/brief/", "/brief.html", "/brief.html/"]) {
        const response = await fetch(`${base}${path}`, { headers: { cookie: cookies } });
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers.get("cache-control"), "private, no-store");
        assert.strictEqual(await response.text(), `${label} PRIVATE HTML\r\n`);
      }
      for (const path of ["/brief.mdx", "/brief.mdx/"]) {
        assert.strictEqual(await (await fetch(`${base}${path}`, { headers: { cookie: cookies } })).text(), `${label} PRIVATE SOURCE\r\n`);
      }
      assert.strictEqual(await (await fetch(`${base}/brief.mdx`, { method: "HEAD", headers: { cookie: cookies } })).text(), "");
    }
    await applyPasswordDirective(first.root, "brief", { kind: "set", password: "alpha replacement" });
    assert.strictEqual((await fetch(`${a.base}/brief`, { headers: { cookie: cookies } })).status, 401);
    assert.strictEqual((await fetch(`${b.base}/brief`, { headers: { cookie: cookies } })).status, 200);
    assert.strictEqual((await unlock(a.base, "alpha password")).status, 401);
    assert.strictEqual((await unlock(a.base, "alpha replacement")).status, 303);
    await setPageSharing(first, "brief", { visibility: "unlisted" });
    assert.strictEqual(await (await fetch(`${a.base}/brief.mdx`)).text(), "ALPHA PRIVATE SOURCE\r\n");
    assert.strictEqual((await fetch(`${b.base}/brief.mdx`)).status, 401);
  });

  test("a removed protected source cannot leak through stale output after a failed rebuild", async () => {
    const store = await fixture("ALPHA");
    const { base } = await serve(store);
    await rm(join(store.root, "digests", "brief.mdx"));
    await writeAccessManifest(store.root, {});
    for (const path of ["/brief", "/brief.html", "/brief.mdx"]) {
      const response = await fetch(`${base}${path}`);
      assert.strictEqual(response.status, 404);
      assert.ok(!(await response.text()).includes("ALPHA PRIVATE"));
    }
    assert.strictEqual((await fetch(`${base}/`)).status, 404);
  });

  test("failed rebuilds cannot expose former protected output when its slug is reused for raw HTML or MDX", async () => {
    for (const kind of ["raw", "mdx"] as const) {
      const store = await fixture(`REUSE-${kind}`);
      await rm(join(store.root, "digests"), { recursive: true });
      await mkdir(join(store.root, "digests"));
      const privateSource = '---\ntitle: "Private synthetic fixture"\nunlisted: true\n---\n\nFORMER_PROTECTED_FIXTURE_CONTENT\n';
      await writeFile(join(store.root, "digests", "brief.mdx"), privateSource);
      await buildAll(store);
      const { base } = await serve(store);
      assert.strictEqual((await fetch(`${base}/brief`)).status, 401);
      await writeFile(join(store.root, "digests", "broken.mdx"), "<UnavailableFixtureComponent />");
      await removePage(store, "brief");
      await assert.rejects(buildAll(store));
      const input = join(store.root, kind === "raw" ? "replacement.html" : "replacement.mdx");
      const replacement = kind === "raw"
        ? '<!doctype html><html><head><meta charset="utf-8"></head><body>NEW_PUBLIC_RAW_FIXTURE</body></html>'
        : '---\ntitle: "Replacement synthetic fixture"\nunlisted: true\n---\n\nNEW_PUBLIC_MDX_FIXTURE\n';
      await writeFile(input, replacement);
      await importPage(store, input, { slug: "brief", unlisted: true });
      await setPageSharing(store, "brief", { visibility: "unlisted" });
      await assert.rejects(buildAll(store));
      for (const path of ["/brief", "/brief/", "/brief.html", "/brief.html/", "/brief.mdx", "/brief.mdx/"]) {
        const response = await fetch(`${base}${path}`);
        assert.strictEqual(response.status, 404);
        assert.ok(!(await response.text()).includes("FORMER_PROTECTED_FIXTURE_CONTENT"));
      }
      // A successful rebuild restores only the replacement and its valid source forms.
      await rm(join(store.root, "digests", "broken.mdx"));
      await buildAll(store);
      const fresh = await fetch(`${base}/brief`);
      assert.strictEqual(fresh.status, 200);
      assert.ok((await fresh.text()).includes(kind === "raw" ? "NEW_PUBLIC_RAW_FIXTURE" : "NEW_PUBLIC_MDX_FIXTURE"));
      const source = await fetch(`${base}/brief.mdx`);
      assert.strictEqual(source.status, kind === "raw" ? 404 : 200);
      if (kind === "mdx") assert.strictEqual(await source.text(), replacement);
    }
  });

  test("denies mismatched raw bytes, ambiguous source kinds, and broken or missing MDX companions", async () => {
    const store = await fixture("BINDING");
    const { base } = await serve(store);
    await setPageSharing(store, "brief", { visibility: "unlisted" });
    await mkdir(join(store.root, "raw"));
    const raw = "SYNTHETIC RAW HTML BYTES";
    await writeFile(join(store.root, "raw", "raw-fixture.html"), raw);
    await writeFile(join(store.outDir, "raw-fixture.html"), raw);
    await writeFile(join(store.outDir, "raw-fixture.mdx"), "STALE MDX SOURCE");
    await setPageSharing(store, "raw-fixture", { visibility: "unlisted" });
    assert.strictEqual(await (await fetch(`${base}/raw-fixture`)).text(), raw);
    assert.strictEqual((await fetch(`${base}/raw-fixture.mdx`)).status, 404);
    await writeFile(join(store.root, "raw", "raw-fixture.html"), `${raw} UPDATED`);
    assert.strictEqual((await fetch(`${base}/raw-fixture`)).status, 404);
    await writeFile(join(store.root, "raw", "brief.html"), "AMBIGUOUS RAW SOURCE");
    assert.strictEqual((await fetch(`${base}/brief`)).status, 503);
    assert.strictEqual((await fetch(`${base}/brief.mdx`)).status, 503);
    await rm(join(store.root, "raw", "brief.html"));
    const original = await readFile(join(store.outDir, "brief.mdx"));
    await rm(join(store.outDir, "brief.mdx"));
    assert.strictEqual((await fetch(`${base}/brief`)).status, 404);
    await symlink(join(store.root, "digests", "brief.mdx"), join(store.outDir, "brief.mdx"));
    assert.strictEqual((await fetch(`${base}/brief`)).status, 404);
    await rm(join(store.outDir, "brief.mdx"));
    await writeFile(join(store.outDir, "brief.mdx"), original);
    await rm(join(store.outDir, "brief.html"));
    assert.strictEqual((await fetch(`${base}/brief.mdx`)).status, 404);
    await writeFile(join(store.outDir, "brief.html"), "SYNTHETIC RESTORED HTML");
    assert.strictEqual((await fetch(`${base}/brief`)).status, 200);
    await writeFile(join(store.root, "digests", "brief.mdx"), "SOURCE CHANGED WITHOUT REBUILD");
    assert.strictEqual((await fetch(`${base}/brief`)).status, 404);
    assert.strictEqual((await fetch(`${base}/brief.mdx`)).status, 404);
  });

  test("rejects hostile paths, source symlinks, methods, and malformed access state without data leaks", async () => {
    const store = await fixture("ALPHA");
    const { base } = await serve(store);
    for (const path of ["/%2fbrief", "/brief%2f", "/%5cbrief", "/%2562rief", "/%", "/brief%00"]) {
      assert.strictEqual((await fetch(`${base}${path}`)).status, 400);
    }
    // The Node adapter normalizes repeated leading slashes; the normalized route remains locked.
    assert.strictEqual((await fetch(`${base}//brief`)).status, 401);
    for (const path of ["/access/manifest.json", "/.state/access-signing-key", "/_headers", "/brief-neighbor/secret", "/unknown"]) {
      assert.strictEqual((await fetch(`${base}${path}`)).status, 404);
    }
    assert.strictEqual((await fetch(`${base}/brief`, { method: "PUT" })).status, 405);
    assert.strictEqual((await fetch(`${base}/public`, { method: "POST", body: "unused" })).status, 405);
    assert.strictEqual(await (await fetch(`${base}/public`, { method: "HEAD" })).text(), "");
    const outside = join(store.root, "outside.html");
    await writeFile(outside, "OUTSIDE PRIVATE FIXTURE");
    await symlink(outside, join(store.outDir, "escape.html"));
    const symlinkResponse = await fetch(`${base}/escape`);
    assert.strictEqual(symlinkResponse.status, 404);
    assert.ok(!(await symlinkResponse.text()).includes("OUTSIDE PRIVATE FIXTURE"));
    await writeFile(join(store.root, "access", "manifest.json"), "invalid SECRET FIXTURE JSON");
    const corrupt = await fetch(`${base}/brief`);
    assert.strictEqual(corrupt.status, 503);
    const body = await corrupt.text();
    assert.ok(!(body).includes("SECRET FIXTURE"));
    assert.ok(!(body).includes(store.root));
  });
});

test('Node HTTP adapter bounds streamed and declared bodies, recovers after an abort, and keeps response cookies', async () => {
  const store = await fixture('NODE-HTTP');
  const { base } = await serve(store);
  const requestStatus = (headers: Record<string, string>, bytes: string): Promise<number | undefined> => new Promise((done, reject) => {
    const request = httpRequest(`${base}/brief`, { method: 'POST', headers }, response => { response.resume(); done(response.statusCode); });
    request.once('error', reject); request.end(bytes);
  });
  const oversized = 'x'.repeat(70_000);
  assert.equal(await requestStatus({ 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(oversized.length) }, oversized), 413);
  assert.equal(await requestStatus({ 'content-type': 'application/x-www-form-urlencoded', 'transfer-encoding': 'chunked' }, oversized), 413);
  await new Promise<void>(done => {
    const request = httpRequest(`${base}/brief`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'transfer-encoding': 'chunked' } });
    request.once('error', () => done()); request.write('password=partial'); request.destroy(); setTimeout(done, 20);
  });
  assert.equal((await fetch(`${base}/brief`)).status, 401);
  const accepted = await unlock(base);
  assert.equal(accepted.status, 303);
  assert.match(accepted.headers.get('set-cookie') ?? '', /HttpOnly/);
  assert.equal(accepted.headers.get('x-robots-tag'), 'noindex, nofollow');
});

test('a replaced preview retires itself without acting on another store or process', async () => {
  const store = await fixture('REPLACEMENT');
  const first = await serve(store);
  const path = previewRegistryPath(store);
  const original = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...original, id: crypto.randomUUID(), port: original.port + 1 }));
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal((await fetch(`${first.base}${PREVIEW_HEALTH_PATH}`)).status, 200, 'a foreign store record must not retire this server');
  const second = await serve(store);
  const deadline = Date.now() + 3500;
  let retired = false;
  while (Date.now() < deadline) {
    try { await fetch(`${first.base}${PREVIEW_HEALTH_PATH}`, { signal: AbortSignal.timeout(250) }); }
    catch { retired = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(retired, true, 'the superseded listener must close');
  assert.equal((await fetch(`${second.base}${PREVIEW_HEALTH_PATH}`)).status, 200, 'the replacement remains available');
});
