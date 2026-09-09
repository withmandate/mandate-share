import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, pbkdf2Sync } from "node:crypto";
import {
  ACCESS_COOKIE_TTL_SECONDS, MAX_PASSWORD_FORM_BYTES, MAX_PBKDF2_ITERATIONS,
  accessCookieName, accessCookieValue, accessSigningKeyPath, applyPasswordDirective,
  createPasswordEntry, derivePasswordProof, gateAccessRequest, getAccessContext, normalizedRequestPath, passwordChallenge,
  protectedRoutePatterns, readAccessManifest, resolvePasswordDirective, validateAccessManifest,
  verifyAccessCookie, verifyPassword, writeAccessManifest, type AccessContext, type AccessEntry,
} from "../lib/access.ts";
import type { StoreContext } from "../lib/context.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const context: AccessContext = { storeId: "fixture-alpha", signingKey: Buffer.alloc(32, 3).toString("base64") };
const secondContext: AccessContext = { storeId: "fixture-beta", signingKey: Buffer.alloc(32, 5).toString("base64") };
const now = Date.parse("2026-09-08T12:00:00Z");
const entry = () => createPasswordEntry("fixture password", { iterations: 1_000, salt: new Uint8Array(16).fill(7) });
const asset = async () => new Response("EXACT FIXTURE BYTES", { headers: { "content-type": "text/html" } });
const form = (path: string, password: string, extra: RequestInit = {}) => new Request(`https://fixture.example${path}`, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ password }), ...extra, duplex: "half",
} as RequestInit);
const proofRequest = (path: string, fields: URLSearchParams) => form(path, "", { body: fields });
const proofForm = async (path: string, password: string, value: AccessEntry) => proofRequest(path, new URLSearchParams({
  proof: await derivePasswordProof(password, value), challenge: passwordChallenge(value),
}));

async function storeFixture(): Promise<StoreContext> {
  const root = await mkdtemp(join(tmpdir(), "mandate-share-access-test-"));
  roots.push(root);
  return { id: crypto.randomUUID(), name: "fixture", root, runtimeRoot: join(root, "runtime"), stateDir: join(root, ".state"), outDir: join(root, ".state", "out") };
}

describe("strict password records and selected-store defaults", () => {
  test("stores only a salted verifier and bounds work/input", async () => {
    const value = await entry();
    const proof = await derivePasswordProof("fixture password", value);
    assert.equal(value.version, 2);
    assert.equal(value.algorithm, "pbkdf2-sha256-client");
    assert.equal(proof, pbkdf2Sync("fixture password", Buffer.alloc(16, 7), 1000, 32, "sha256").toString("base64url"), "the browser proof is the standard 256-bit PBKDF2 result");
    assert.equal(value.verifier, createHash("sha256").update("mandate-share:password-verifier:v2\0").update(Buffer.from(proof, "base64url")).digest("base64url"));
    assert.notEqual(value.verifier, proof);
    assert.equal(JSON.stringify(value).includes(proof), false);
    assert.ok(!(JSON.stringify(value)).includes("fixture password"));
    assert.strictEqual(await verifyPassword("fixture password", value), true);
    assert.strictEqual(await verifyPassword("wrong", value), false);
    assert.strictEqual(await verifyPassword("x".repeat(1025), value), false);
    assert.throws(() => validateAccessManifest({ brief: { ...value, password: "never stored" } }), (error) => error instanceof Error && error.message.includes("unsupported key"));
    assert.throws(() => validateAccessManifest({ brief: { ...value, iterations: MAX_PBKDF2_ITERATIONS + 1 } }), (error) => error instanceof Error && error.message.includes("iterations"));
    assert.throws(() => validateAccessManifest({ brief: value }, new Set(["different"])), (error) => error instanceof Error && error.message.includes("missing page"));
    assert.doesNotThrow(() => validateAccessManifest({ "page--two": value }));
    assert.throws(() => validateAccessManifest({ "../page": value }), (error) => error instanceof Error && error.message.includes("invalid slug"));
    validateAccessManifest(Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`page-${i}`, value])));
    assert.throws(() => validateAccessManifest({ brief: { ...value, version: 0 } }), /version/);
    assert.throws(() => validateAccessManifest({ brief: { ...value, algorithm: "unsupported" } }), /algorithm/);
    await assert.rejects(derivePasswordProof("fixture password", { ...value, salt: `${value.salt}=` }), /base64url/);
    await assert.rejects(derivePasswordProof("fixture password", { ...value, iterations: 0 }), /iterations/);
    await assert.rejects(derivePasswordProof("", value), /empty/);
    assert.equal((await createPasswordEntry("new password")).iterations, 100_000);
  });

  test("never consults an ambient password default", () => {
    assert.deepStrictEqual(resolvePasswordDirective(undefined, false), { kind: "preserve" });
    assert.deepStrictEqual(resolvePasswordDirective(undefined, true), { kind: "remove" });
    assert.deepStrictEqual(resolvePasswordDirective(true, false, "fixture alpha"), { kind: "set", password: "fixture alpha" });
    assert.deepStrictEqual(resolvePasswordDirective(true, false, "fixture beta"), { kind: "set", password: "fixture beta" });
    assert.throws(() => resolvePasswordDirective(true, false), (error) => error instanceof Error && error.message.includes("selected store"));
    assert.throws(() => resolvePasswordDirective("secret", true), (error) => error instanceof Error && error.message.includes("at most one"));
    assert.throws(() => resolvePasswordDirective("", false), (error) => error instanceof Error && error.message.includes("empty"));
  });

  test("matches the slug validator when creating Worker route patterns", () => {
    assert.deepStrictEqual(protectedRoutePatterns(["zeta", "alpha", "alpha", "page--two"]), ["/alpha*", "/page--two*", "/zeta*"]);
    assert.throws(() => protectedRoutePatterns(["index"]), (error) => error instanceof Error && error.message.includes("reserved"));
    assert.throws(() => protectedRoutePatterns(["x".repeat(81)]), (error) => error instanceof Error && error.message.includes("80"));
  });
});

describe("private per-store signing state", () => {
  test("concurrent creation persists one independent 0600 key outside the access manifest", async () => {
    const store = await storeFixture();
    const contexts = await Promise.all(Array.from({ length: 8 }, () => getAccessContext(store)));
    assert.strictEqual(new Set(contexts.map((value) => value.signingKey)).size, 1);
    assert.strictEqual(contexts[0].storeId, store.id);
    assert.strictEqual((await lstat(accessSigningKeyPath(store))).mode & 0o777, 0o600);
    assert.notDeepStrictEqual(await getAccessContext(await storeFixture()), contexts[0]);
    await applyPasswordDirective(store.root, "brief", { kind: "set", password: "fixture password" });
    const source = await readFile(join(store.root, "access", "manifest.json"), "utf8");
    assert.ok(!(source).includes(contexts[0].signingKey));
    assert.ok(!(source).includes("fixture password"));
  });

  test("refuses permissive and symlink signing-key files", async () => {
    const store = await storeFixture();
    await getAccessContext(store);
    await chmod(accessSigningKeyPath(store), 0o644);
    await assert.rejects(getAccessContext(store), (error) => error instanceof Error && error.message.includes("0600"));
    await rm(accessSigningKeyPath(store));
    const elsewhere = join(store.root, "elsewhere");
    await writeFile(elsewhere, `${context.signingKey}\n`, { mode: 0o600 });
    await symlink(elsewhere, accessSigningKeyPath(store));
    await assert.rejects(getAccessContext(store));
    assert.strictEqual(await readFile(elsewhere, "utf8"), `${context.signingKey}\n`);
  });

  test("password replace/remove preserves adjacent records and rejects access symlinks", async () => {
    const store = await storeFixture();
    const value = await entry();
    await writeAccessManifest(store.root, { brief: value, neighbor: value });
    assert.strictEqual(await applyPasswordDirective(store.root, "brief", { kind: "preserve" }), "protected");
    await applyPasswordDirective(store.root, "brief", { kind: "set", password: "new fixture password" });
    const changed = await readAccessManifest(store.root);
    assert.deepStrictEqual(changed.neighbor, value);
    assert.strictEqual(await verifyPassword("fixture password", changed.brief), false);
    assert.strictEqual(await verifyPassword("new fixture password", changed.brief), true);
    await applyPasswordDirective(store.root, "brief", { kind: "remove" });
    assert.deepStrictEqual(await readAccessManifest(store.root), { neighbor: value });
    await rm(join(store.root, "access"), { recursive: true });
    const elsewhere = join(store.root, "other-access");
    await mkdir(elsewhere);
    await symlink(elsewhere, join(store.root, "access"));
    await assert.rejects(writeAccessManifest(store.root, { brief: value }), (error) => error instanceof Error && error.message.includes("ordinary directory"));
  });
});

describe("store, page, and current-password cookie binding", () => {
  test("rejects another store, another page, tampering, expiry, rotation, and verifier-only forgery", async () => {
    const value = await entry();
    const cookie = await accessCookieValue("brief", value, context, now);
    assert.strictEqual(await verifyAccessCookie(cookie, "brief", value, context, now + 1000), true);
    assert.strictEqual(await verifyAccessCookie(cookie, "neighbor", value, context, now), false);
    assert.strictEqual(await verifyAccessCookie(cookie, "brief", value, { ...context, storeId: secondContext.storeId }, now), false);
    assert.strictEqual(await verifyAccessCookie(cookie, "brief", value, { ...context, signingKey: secondContext.signingKey }, now), false);
    assert.strictEqual(await verifyAccessCookie(cookie + "x", "brief", value, context, now), false);
    assert.strictEqual(await verifyAccessCookie(cookie, "brief", value, context, now + ACCESS_COOKIE_TTL_SECONDS * 1000), false);
    const changed = await createPasswordEntry("fixture password", { iterations: 1000 });
    assert.strictEqual(await verifyAccessCookie(cookie, "brief", changed, context, now), false);
    const verifierAsKey = Buffer.from(value.verifier, "base64url").toString("base64");
    const forged = await accessCookieValue("brief", value, { ...context, signingKey: verifierAsKey }, now);
    assert.strictEqual(await verifyAccessCookie(forged, "brief", value, context, now), false);
    assert.notStrictEqual(accessCookieName("brief", context), accessCookieName("brief", secondContext));
  });
});

describe("request gate", () => {
  test("locks every page/source route while leaving neighboring prefixes and public bytes alone", async () => {
    const manifest = { brief: await entry() };
    let calls = 0;
    const fetchAsset = async () => { calls++; return asset(); };
    for (const path of ["/brief", "/brief/", "/brief.html", "/brief.html/", "/brief.mdx", "/brief.mdx/", "/%62rief", "/brief/subpath"]) {
      const response = await gateAccessRequest(new Request(`https://fixture.example${path}`), manifest, fetchAsset, context);
      assert.strictEqual(response.status, 401);
      assert.ok(!(await response.text()).includes("EXACT FIXTURE BYTES"));
    }
    assert.strictEqual(calls, 0);
    for (const path of ["/public", "/brief-neighbor", "/briefly", "/constructor"]) {
      const response = await gateAccessRequest(new Request(`https://fixture.example${path}`), manifest, fetchAsset, context);
      assert.strictEqual(await response.text(), "EXACT FIXTURE BYTES");
    }
    assert.strictEqual(calls, 4);
    for (const path of ["/%2fbrief", "/brief%2f", "/%5cbrief", "/%2562rief", "/%", "/brief%00", "//brief"]) {
      assert.strictEqual(normalizedRequestPath(path), undefined);
      assert.strictEqual((await gateAccessRequest(new Request(`https://fixture.example${path}`), manifest, fetchAsset, context)).status, 400);
    }
    assert.strictEqual(calls, 4);
  });

  test("wrong/correct proofs, no-store authorized bytes, HEAD, and stale cookies", async () => {
    const manifest = { brief: await entry() };
    const wrong = await gateAccessRequest(await proofForm("/brief", "wrong", manifest.brief), manifest, asset, context, { now });
    assert.strictEqual(wrong.status, 401);
    assert.ok((await wrong.text()).includes("Incorrect password"));
    const success = await gateAccessRequest(await proofForm("/brief?from=fixture", "fixture password", manifest.brief), manifest, asset, context, { now });
    assert.strictEqual(success.status, 303);
    assert.strictEqual(success.headers.get("location"), "/brief?from=fixture");
    const setCookie = success.headers.get("set-cookie")!;
    for (const flag of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/"]) assert.ok((setCookie).includes(flag));
    const cookie = setCookie.split(";", 1)[0];
    const unlocked = await gateAccessRequest(new Request("https://fixture.example/brief.mdx", { headers: { cookie } }), manifest, asset, context, { now });
    assert.strictEqual(await unlocked.text(), "EXACT FIXTURE BYTES");
    assert.strictEqual(unlocked.headers.get("cache-control"), "private, no-store");
    const head = await gateAccessRequest(new Request("https://fixture.example/brief", { method: "HEAD" }), manifest, asset, context, { now });
    assert.strictEqual(head.status, 401);
    assert.strictEqual(await head.text(), "");
    const duplicates = await gateAccessRequest(new Request("https://fixture.example/brief", { headers: { cookie: `${cookie}; ${cookie}` } }), manifest, asset, context, { now });
    assert.strictEqual(duplicates.status, 401);
    const changed = { brief: await createPasswordEntry("new password", { iterations: 1000 }) };
    assert.strictEqual((await gateAccessRequest(new Request("https://fixture.example/brief", { headers: { cookie } }), changed, asset, context, { now })).status, 401);
    assert.strictEqual((await gateAccessRequest(new Request("https://fixture.example/brief", { headers: { cookie } }), {}, asset, context, { now })).status, 200);
  });

  test("v2 accepts only bounded canonical proof and current challenge without running PBKDF2", async (t) => {
    const value = await entry(), manifest = { brief: value };
    const proof = await derivePasswordProof("fixture password", value), challenge = passwordChallenge(value);
    const expensive = t.mock.method(crypto.subtle, "deriveBits", async () => { throw new Error("PBKDF2 must not run while checking a v2 request"); });
    let assets = 0;
    const fetchAsset = async () => { assets++; return asset(); };
    const post = (fields: URLSearchParams) => gateAccessRequest(proofRequest("/brief", fields), manifest, fetchAsset, context, { now });
    const valid = await post(new URLSearchParams({ proof, challenge }));
    assert.equal(valid.status, 303);
    assert.equal((await post(new URLSearchParams({ proof: value.verifier, challenge }))).status, 401, "the stored verifier is not a login proof");
    assert.equal((await post(new URLSearchParams({ proof: "A".repeat(43), challenge }))).status, 401);
    const invalid = [
      new URLSearchParams({ password: "fixture password" }),
      new URLSearchParams({ proof, challenge, password: "fixture password" }),
      new URLSearchParams({ proof, challenge, username: "shared-page" }),
      new URLSearchParams({ proof }), new URLSearchParams({ challenge }),
      new URLSearchParams({ proof, challenge: `2.${value.iterations + 1}.${value.salt}` }),
      new URLSearchParams({ proof, challenge: `2.${value.iterations}.${Buffer.alloc(16, 9).toString("base64url")}` }),
      new URLSearchParams({ proof, challenge: `1.${value.iterations}.${value.salt}` }),
      ...["", "A".repeat(42), "A".repeat(44), `${proof}=`, `${proof.slice(0, -1)}B`, "x".repeat(1024)].map(proof => new URLSearchParams({ proof, challenge })),
      new URLSearchParams([["proof", proof], ["proof", proof], ["challenge", challenge]]),
      new URLSearchParams([["proof", proof], ["challenge", challenge], ["challenge", challenge]]),
    ];
    for (const fields of invalid) {
      const response = await post(fields);
      assert.equal(response.status, 400);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.text();
      assert.equal(body.includes(proof), false);
      assert.equal(body.includes("fixture password"), false);
    }
    assert.equal(expensive.mock.callCount(), 0);
    assert.equal(assets, 0);
    const cookie = valid.headers.get("set-cookie")!.split(";", 1)[0];
    const authorized = await gateAccessRequest(new Request("https://fixture.example/brief.mdx", { headers: { cookie } }), manifest, fetchAsset, context, { now });
    assert.equal(await authorized.text(), "EXACT FIXTURE BYTES");
    assert.equal(expensive.mock.callCount(), 0);
  });

  test("v2 prompt exposes only derivation parameters and cannot submit a plaintext fallback", async () => {
    const value = await entry(), manifest = { brief: value };
    const proof = await derivePasswordProof("fixture password", value);
    const response = await gateAccessRequest(new Request("https://fixture.example/brief"), manifest, asset, context);
    const html = await response.text();
    assert.equal(response.status, 401);
    assert.ok(html.includes(value.salt));
    assert.ok(html.includes(passwordChallenge(value)));
    assert.equal(html.includes(value.verifier), false);
    assert.equal(html.includes(proof), false);
    assert.equal(html.includes(context.signingKey), false);
    assert.match(html, /<input id="password" disabled type="password"/);
    assert.doesNotMatch(html, /<input[^>]*name="password"|<input[^>]*name="username"/);
    assert.match(html, /<button type="submit" disabled>/);
    const publicPage = await gateAccessRequest(new Request("https://fixture.example/public"), manifest, asset, context);
    assert.equal(await publicPage.text(), "EXACT FIXTURE BYTES");
  });

  test("saved verifier and cookie encodings remain readable", async () => {
    const saved: AccessEntry = { version: 2, algorithm: "pbkdf2-sha256-client", iterations: 1000, salt: "BwcHBwcHBwcHBwcHBwcHBw", verifier: "ujnT5OkAMWv5C8MNNF9ZlZz0lw2j--jNxENab0ftsZ0" };
    const cookie = "1789473600.xKW7Hkt63OPriK76BpU8uJO49vaj8cHnSjf-OcDhqgw";
    validateAccessManifest({ brief: saved });
    assert.equal(await verifyPassword("fixture password", saved), true);
    assert.deepEqual(await entry(), saved);
    assert.equal(await accessCookieValue("brief", saved, context, now), cookie);
    assert.equal(await verifyAccessCookie(cookie, "brief", saved, context, now), true);
    assert.equal((await gateAccessRequest(form("/brief", "fixture password"), { brief: saved }, asset, context, { now })).status, 400);
  });

  test("stops a stalled or broken password body without serving an asset", async () => {
    const manifest = { brief: await entry() };
    let cancelled = false;
    const stalled = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const timedOut = await gateAccessRequest(form("/brief", "unused", { body: stalled }), manifest, asset, context, { bodyTimeoutMs: 10 });
    assert.strictEqual(timedOut.status, 408);
    assert.strictEqual(cancelled, true);
    const broken = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("synthetic stream failure")); } });
    assert.strictEqual((await gateAccessRequest(form("/brief", "unused", { body: broken }), manifest, asset, context)).status, 400);
  });

  test("rejects methods, unrelated origin, invalid content types, and oversized streamed bodies", async () => {
    const manifest = { brief: await entry() };
    const unsupported = await gateAccessRequest(new Request("https://fixture.example/brief", { method: "DELETE" }), manifest, asset, context);
    assert.strictEqual(unsupported.status, 405);
    assert.strictEqual((await gateAccessRequest(form("/brief", "fixture password", { headers: { "content-type": "text/plain" } }), manifest, asset, context)).status, 415);
    assert.strictEqual((await gateAccessRequest(form("/brief", "fixture password", { headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://another.example" } }), manifest, asset, context)).status, 403);
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024)); }, cancel() { cancelled = true; } });
    const response = await gateAccessRequest(form("/brief", "unused", { body }), manifest, asset, context);
    assert.strictEqual(response.status, 413);
    assert.strictEqual(cancelled, true);
    assert.ok((pulls) < (MAX_PASSWORD_FORM_BYTES / 1024 + 4));
  });
});
