import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { contextForRoot } from "../lib/store.ts";
import { createPasswordEntry, readAccessManifest, verifyPassword } from "../lib/access.ts";
import { assignPageProfile, initializePagePassword, passwordSettingsPath, readPasswordSettings, resolvePasswordTarget, rotateProfilePages, setPagePasswordEntry, setPasswordProfile } from "../lib/passwords.ts";
import { readPagePolicies, setPageSharing } from "../lib/privacy.ts";
import { importPage, removePage } from "../lib/content.ts";
import { buildAll } from "../lib/build.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mandate-share-passwords-"))); roots.push(root);
  for (const directory of ["raw", "digests", "access", "components"]) await mkdir(join(root, directory));
  await writeFile(join(root, "store.json"), JSON.stringify({ schema: 1, id: randomUUID() }));
  return contextForRoot(root);
}
const html = '<html><head><meta charset="utf-8"><title>Synthetic fixture</title></head><body>Example</body></html>';
const entry = (value: string) => createPasswordEntry(value, { iterations: 1000 });

test("configured defaults protect future imports and authored pages; existing overrides never rotate implicitly", async () => {
  const store = await fixture();
  await writeFile(join(store.root, "raw/existing.html"), html);
  const first = await entry("synthetic default first"), second = await entry("synthetic default second");
  await setPasswordProfile(store, "default", first);
  await initializePagePassword(store, "existing");
  assert.equal(Object.hasOwn(await readAccessManifest(store.root), "existing"), false);
  const input = join(store.root, "input.html"); await writeFile(input, html);
  await importPage(store, input, { slug: "fresh" });
  assert.deepEqual((await readAccessManifest(store.root)).fresh, first);
  const binding = (await readPasswordSettings(store)).bindings.fresh;
  assert.equal(binding.kind, "profile");
  if (binding.kind === "profile") { assert.equal(binding.profile, "default"); assert.match(binding.fingerprint, /^[a-f0-9]{64}$/u); }
  await setPasswordProfile(store, "default", second);
  await initializePagePassword(store, "fresh");
  assert.deepEqual((await readAccessManifest(store.root)).fresh, first);
  await writeFile(join(store.root, "digests/authored.mdx"), '---\ntitle: Authored example\ndate: "2026-09-08"\n---\n\nText.\n');
  await buildAll(store);
  assert.deepEqual((await readAccessManifest(store.root)).authored, second);
  await importPage(store, input, { slug: "open", visibility: "unlisted" });
  assert.equal(Object.hasOwn(await readAccessManifest(store.root), "open"), false);
  const saved = await readFile(passwordSettingsPath(store), "utf8");
  assert.ok(!saved.includes("synthetic default"));
  assert.equal((await lstat(passwordSettingsPath(store))).mode & 0o777, 0o600);
});

test("named profile assignments copy verifiers, custom overrides persist, and rotation requires explicit page scope", async () => {
  const store = await fixture();
  for (const slug of ["alpha", "beta"]) await writeFile(join(store.root, "raw", `${slug}.html`), html);
  const first = await entry("synthetic team first"), second = await entry("synthetic team second"), custom = await entry("synthetic custom");
  await setPasswordProfile(store, "Project Team", first);
  await assignPageProfile(store, "alpha", "project-team");
  await setPagePasswordEntry(store, "beta", custom);
  await setPasswordProfile(store, "project-team", second);
  assert.deepEqual(await readAccessManifest(store.root), { alpha: first, beta: custom });
  await assert.rejects(rotateProfilePages(store, "project-team", []), /explicit/);
  await assert.rejects(rotateProfilePages(store, "project-team", ["alpha", "missing"]), /No page/);
  assert.deepEqual((await readAccessManifest(store.root)).alpha, first);
  await rotateProfilePages(store, "project-team", ["alpha"]);
  assert.deepEqual(await readAccessManifest(store.root), { alpha: second, beta: custom });
  await setPageSharing(store, "alpha", { visibility: "unlisted" });
  assert.deepEqual((await readPasswordSettings(store)).bindings.alpha, { kind: "none" });
  await initializePagePassword(store, "alpha");
  assert.equal((await readPagePolicies(store)).alpha.visibility, "unlisted");
  await removePage(store, "alpha");
  assert.equal(Object.hasOwn((await readPasswordSettings(store)).bindings, "alpha"), false);
  await assert.rejects(setPasswordProfile(store, "team", first, { protectNewPages: true }), /Only the default/);
});

test("saved profile settings reload without changing their schema or records", async () => {
  const store = await fixture(), other = await fixture();
  const saved = { schema: 1, protectNewPages: true, profiles: { default: { version: 2, algorithm: "pbkdf2-sha256-client", iterations: 1000, salt: "BwcHBwcHBwcHBwcHBwcHBw", verifier: "ujnT5OkAMWv5C8MNNF9ZlZz0lw2j--jNxENab0ftsZ0" } }, bindings: {} } as const;
  const bytes = JSON.stringify(saved, null, 2) + "\n";
  await writeFile(passwordSettingsPath(store), bytes, { mode: 0o600 });
  const settings = await readPasswordSettings(store);
  assert.deepEqual(settings, saved);
  assert.equal(await verifyPassword("fixture password", settings.profiles.default), true);
  assert.equal(await readFile(passwordSettingsPath(store), "utf8"), bytes);
  assert.deepEqual((await readPasswordSettings(other)).profiles, {});
});

test("permissive or linked profile state fails without disclosing its records", async () => {
  const store = await fixture();
  const value = await entry("synthetic private input");
  await setPasswordProfile(store, "default", value);
  const path = passwordSettingsPath(store), bytes = await readFile(path);
  await chmod(path, 0o644);
  await assert.rejects(readPasswordSettings(store), error => error instanceof Error && /unreadable/.test(error.message) && !error.message.includes(value.verifier));
  await rm(path);
  const outside = join(store.root, "private-profile-snapshot.json");
  await writeFile(outside, bytes, { mode: 0o600 });
  await symlink(outside, path);
  await assert.rejects(readPasswordSettings(store), /unreadable/);
  assert.deepEqual(await readFile(outside), bytes);
});

test("page URL resolution accepts only exact registered origins and existing page routes", async () => {
  const a = await fixture(), b = await fixture();
  for (const store of [a, b]) await writeFile(join(store.root, "raw/report.html"), html);
  const options = { origins: { [a.id]: "https://alpha.example.com", [b.id]: "https://beta.example.com" } };
  for (const route of ["/report", "/report/", "/report.html", "/report.mdx"]) assert.equal((await resolvePasswordTarget(`https://alpha.example.com${route}`, [a, b], options)).store.id, a.id);
  for (const url of ["https://evil.example.com/report", "http://alpha.example.com/report", "https://alpha.example.com.evil.example/report", "https://alpha.example.com/report?x=1", "https://person@alpha.example.com/report", "https://alpha.example.com/unknown", "https://alpha.example.com/report/extra", "https://alpha.example.com/%2e%2e/report"]) await assert.rejects(resolvePasswordTarget(url, [a, b], options));
  await assert.rejects(resolvePasswordTarget("report", [a, b]), /Choose the store/);
  assert.equal((await resolvePasswordTarget("report", [a, b], { defaultStoreId: b.id })).store.id, b.id);
  await assert.rejects(resolvePasswordTarget("https://alpha.example.com/report", [a, b], { origins: { [a.id]: "https://alpha.example.com", [b.id]: "https://alpha.example.com" } }), /ambiguous/);
});

test("constructor slugs inherit configured defaults and similarly named profiles use own records", async () => {
  const store = await fixture();
  const defaultEntry = await entry("synthetic default");
  await setPasswordProfile(store, "default", defaultEntry);
  const input = join(store.root, "input.html"); await writeFile(input, html);
  await importPage(store, input, { slug: "constructor" });
  assert.deepEqual((await readAccessManifest(store.root)).constructor, defaultEntry);
  assert.equal(Object.entries((await readPasswordSettings(store)).bindings).find(([slug]) => slug === "constructor")?.[1].kind, "profile");
  await assert.rejects(assignPageProfile(store, "constructor", "constructor"), /not configured/);
  const named = await entry("synthetic named");
  await setPasswordProfile(store, "constructor", named);
  await assignPageProfile(store, "constructor", "constructor");
  assert.deepEqual((await readAccessManifest(store.root)).constructor, named);
  await setPasswordProfile(store, "toString", defaultEntry);
  assert.ok(Object.hasOwn((await readPasswordSettings(store)).profiles, "tostring"));
});
