import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { contextForRoot } from "../lib/store.ts";
import { createPasswordEntry, derivePasswordProof, gateAccessRequest, passwordChallenge, PASSWORD_VERIFIER_DOMAIN, readAccessManifest, verifyPassword } from "../lib/access.ts";
import { passwordSettingsPath, readPasswordSettings, setPasswordProfile } from "../lib/passwords.ts";
import { startPasswordForm, type PasswordForm } from "../lib/password-form.ts";
import { assertPublishable } from "../lib/privacy.ts";

const roots: string[] = [], forms: PasswordForm[] = [];
afterEach(async () => { for (const form of forms.splice(0)) form.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mandate-share-form-"))); roots.push(root);
  for (const directory of ["raw", "digests", "access", "components"]) await mkdir(join(root, directory));
  await writeFile(join(root, "store.json"), JSON.stringify({ schema: 1, id: randomUUID() }));
  return contextForRoot(root, "Synthetic project");
}
async function pageFixture() { const store = await fixture(); await writeFile(join(store.root, "raw/report.html"), '<html><head><meta charset="utf-8"></head><body>Example</body></html>'); return store; }
async function openForm(options: Parameters<typeof startPasswordForm>[0]) { const form = await startPasswordForm(options); forms.push(form); return form; }
function configFrom(html: string): { salt: string; iterations: number; maximumBytes: number; verifierDomain: string; nonce: string } {
  const match = /const config=(\{[^\n]+?\}),form=/u.exec(html); assert.ok(match); return JSON.parse(match[1]);
}
async function submit(form: PasswordForm, password = "synthetic form password") {
  const html = await (await fetch(form.url)).text(), config = configFrom(html);
  const entry = await createPasswordEntry(password, { salt: Buffer.from(config.salt, "base64url"), iterations: config.iterations });
  return fetch(form.url, { method: "POST", headers: { origin: new URL(form.url).origin, "content-type": "application/json", "x-mandate-operation": config.nonce }, body: JSON.stringify({ verifier: entry.verifier }) });
}

test("the actual owner form submits only a v2 second hash and saves a publishable password record", async () => {
  const store = await pageFixture();
  await writeFile(join(store.stateDir, "last-release.json"), "{}", { mode: 0o600 });
  const form = await openForm({ store, target: { kind: "page", slug: "report" } });
  assert.equal(existsSync(join(store.stateDir, "operation.lock")), false);
  assert.equal(existsSync(join(store.stateDir, "passwords.lock")), false);
  const response = await fetch(form.url), html = await response.text();
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(response.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  assert.match(html, /Page: report/); assert.match(html, /Store: Synthetic project/);
  assert.ok(!html.includes(store.root));
  const config = configFrom(html);
  assert.equal(config.verifierDomain, PASSWORD_VERIFIER_DOMAIN);
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/u.exec(html)?.[1]; assert.ok(script);
  const password = { value: "synthetic browser password", disabled: true, focus() {} }, confirmation = { ...password };
  const button = { disabled: true }, status = { textContent: "" };
  let handler: ((event: { preventDefault(): void }) => Promise<void>) | undefined;
  const formElement = { hidden: false, querySelector: () => button, addEventListener: (_type: string, callback: typeof handler) => { handler = callback; } };
  let posted: unknown;
  const browserFetch = async (_path: string, init: RequestInit) => {
    posted = JSON.parse(String(init.body));
    assert.deepEqual(Object.keys(posted as object), ["verifier"]);
    assert.ok(!String(init.body).includes("synthetic browser password"));
    return fetch(form.url, { ...init, headers: { ...init.headers, origin: new URL(form.url).origin } });
  };
  runInNewContext(script, {
    window: { crypto }, crypto, TextEncoder, Uint8Array, atob, btoa, fetch: browserFetch, location: new URL(form.url),
    document: { getElementById: (id: string) => ({ "password-form": formElement, password, confirmation, status })[id] },
  });
  assert.equal(button.disabled, false); assert.ok(handler);
  await handler({ preventDefault() {} });
  assert.equal(formElement.hidden, true); assert.equal(password.value, ""); assert.equal(confirmation.value, "");
  const result = await form.completed;
  assert.deepEqual(result, { saved: true, storeId: store.id, target: "page", slug: "report", publicationRequired: true });
  assert.match(status.textContent, /Publish this page/);
  const saved = (await readAccessManifest(store.root)).report;
  assert.equal(saved.version, 2);
  assert.equal(saved.algorithm, "pbkdf2-sha256-client");
  assert.equal(saved.salt, config.salt);
  assert.equal(saved.iterations, config.iterations);
  assert.equal(saved.verifier, (posted as { verifier: string }).verifier);
  assert.equal(await verifyPassword("synthetic browser password", saved), true);
  const proof = await derivePasswordProof("synthetic browser password", saved);
  assert.notEqual(saved.verifier, proof);
  assert.equal(JSON.stringify(posted).includes(proof), false, "the owner browser must not submit the reusable client key");
  assert.equal((await readFile(join(store.root, "access/manifest.json"), "utf8")).includes(proof), false);
  assert.equal((await assertPublishable(store)).report.visibility, "private");
  const context = { storeId: store.id, signingKey: Buffer.alloc(32, 5).toString("base64") };
  const unlock = (proof: string) => gateAccessRequest(new Request("https://fixture.example/report", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ proof, challenge: passwordChallenge(saved) }),
  }), { report: saved }, async () => new Response("Synthetic report"), context);
  assert.equal((await unlock(saved.verifier)).status, 401);
  assert.equal((await unlock(proof)).status, 303);
  assert.ok(!(await readFile(passwordSettingsPath(store), "utf8")).includes("synthetic browser password"));
  assert.ok(!JSON.stringify(result).includes((posted as { verifier: string }).verifier));
});

test("strict Host, Origin and operation token reject unrelated requests without consuming a valid form", async () => {
  const store = await fixture(), form = await openForm({ store, target: { kind: "default" }, protectNewPages: true });
  const html = await (await fetch(form.url)).text(), config = configFrom(html), origin = new URL(form.url).origin;
  const wrongHost = await new Promise<number>(resolve => { const req = request(form.url, { headers: { host: "example.com" } }, response => { response.resume(); resolve(response.statusCode!); }); req.end(); });
  assert.equal(wrongHost, 404);
  assert.equal((await fetch(`${form.url}?next=elsewhere`)).status, 404);
  assert.equal((await fetch(form.url, { method: "PUT" })).status, 405);
  for (const headers of [{ origin: "https://example.com", "x-mandate-operation": config.nonce }, { origin, "x-mandate-operation": "wrong" }, { "x-mandate-operation": config.nonce }] as Record<string, string>[]) {
    assert.equal((await fetch(form.url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: '{}' })).status, 403);
  }
  assert.equal((await submit(form)).status, 200);
  assert.equal((await form.completed).target, "default");
  const saved = (await readPasswordSettings(store)).profiles.default;
  assert.equal(saved.version, 2);
  assert.equal(saved.algorithm, "pbkdf2-sha256-client");
  assert.equal(saved.salt, config.salt);
  assert.equal(await verifyPassword("synthetic form password", saved), true);
  const next = await openForm({ store, target: { kind: "default" }, protectNewPages: true });
  const nextConfig = configFrom(await (await fetch(next.url)).text());
  assert.notEqual(nextConfig.salt, config.salt, "each owner operation generates a fresh salt");
});

test("plaintext-shaped, oversized, or malformed submissions never persist or echo their body", async () => {
  for (const body of ['{"password":"synthetic must not echo"}', '{"proof":"synthetic must not echo"}', 'x'.repeat(1500), '{"verifier":"bad"}', JSON.stringify({ verifier: "A".repeat(43), version: 1 }), JSON.stringify({ verifier: "A".repeat(43), salt: "A".repeat(22) })]) {
    const store = await fixture(), form = await openForm({ store, target: { kind: "default" } });
    const config = configFrom(await (await fetch(form.url)).text());
    const response = await fetch(form.url, { method: "POST", headers: { origin: new URL(form.url).origin, "content-type": "application/json", "x-mandate-operation": config.nonce }, body });
    assert.equal(response.status, 409); assert.ok(!(await response.text()).includes("synthetic must not echo"));
    await assert.rejects(form.completed, /did not complete/);
    assert.deepEqual((await readPasswordSettings(store)).profiles, {});
  }
});

test("a consumed operation cannot be replayed", async () => {
  const store = await fixture(), form = await openForm({ store, target: { kind: "default" } });
  const config = configFrom(await (await fetch(form.url)).text());
  const value = await createPasswordEntry("synthetic", { salt: Buffer.from(config.salt, "base64url"), iterations: config.iterations });
  const init = { method: "POST", headers: { origin: new URL(form.url).origin, "content-type": "application/json", "x-mandate-operation": config.nonce }, body: JSON.stringify({ verifier: value.verifier }) };
  const responses = await Promise.all([fetch(form.url, init), fetch(form.url, init)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 410]);
  await form.completed;
});

test("page source changes and profile changes invalidate forms opened against older state", async () => {
  const store = await pageFixture(), form = await openForm({ store, target: { kind: "page", slug: "report" } });
  await writeFile(join(store.root, "raw/report.html"), '<html><head><meta charset="utf-8"></head><body>Replacement</body></html>');
  assert.equal((await submit(form)).status, 409); await assert.rejects(form.completed, /did not complete/);
  assert.deepEqual(await readAccessManifest(store.root), {});
  const profileForm = await openForm({ store, target: { kind: "profile", name: "team" } });
  const newer = await createPasswordEntry("synthetic newer", { iterations: 1000 }); await setPasswordProfile(store, "team", newer);
  assert.equal((await submit(profileForm)).status, 409); await assert.rejects(profileForm.completed, /did not complete/);
  assert.deepEqual((await readPasswordSettings(store)).profiles.team, newer);
});

test("abandoned or closed forms expire with no locks or passwords left behind", async () => {
  const store = await fixture(), expired = await openForm({ store, target: { kind: "default" }, lifetimeMs: 25 });
  await assert.rejects(expired.completed, /expired/);
  const closed = await openForm({ store, target: { kind: "default" } }); closed.close(); await assert.rejects(closed.completed, /closed/);
  assert.equal(existsSync(join(store.stateDir, "operation.lock")), false);
  assert.equal(existsSync(join(store.stateDir, "passwords.lock")), false);
  assert.deepEqual((await readPasswordSettings(store)).profiles, {});
});
