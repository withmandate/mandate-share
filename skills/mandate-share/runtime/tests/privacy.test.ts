import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { contextForRoot } from "../lib/store.ts";
import { buildAll } from "../lib/build.ts";
import { importPage, removePage } from "../lib/content.ts";
import { assertPublishable, isHomepageCurrent, readPagePolicies, setPageSharing, validatePagePolicies } from "../lib/privacy.ts";
import { createPasswordEntry, gateAccessRequest, getAccessContext, readAccessManifest, writeAccessManifest } from "../lib/access.ts";
import { setPagePasswordEntry } from "../lib/passwords.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mandate-share-privacy-"))); roots.push(root);
  for (const dir of ["raw", "digests", "access", "components"]) await mkdir(join(root, dir));
  await writeFile(join(root, "store.json"), JSON.stringify({ schema: 1, id: randomUUID() }));
  return contextForRoot(root);
}
const document = (title: string) => `<!doctype html>\r\n<html><head><meta charset="utf-8"><title>${title}</title></head><body>${title}</body></html>\r\n`;
const mdx = (title: string) => `---\ntitle: "${title}"\ndate: "2026-09-08"\ntopic: guide\nunlisted: false\n---\n\n# A synthetic page\n`;

test("listing hints never grant public consent, and private pages fail closed until assigned", async () => {
  const store = await fixture();
  const input = join(store.root, "input.html"); await writeFile(input, document("Hidden raw metadata"));
  await importPage(store, input, { slug: "metadata-raw", listed: true });
  await writeFile(join(store.root, "digests/metadata-mdx.mdx"), mdx("Hidden MDX metadata"));
  const policy = await readPagePolicies(store);
  assert.deepEqual(policy, { "metadata-mdx": { visibility: "private", indexable: false }, "metadata-raw": { visibility: "private", indexable: false } });
  await assert.rejects(assertPublishable(store), /Private pages need a password/);
  const access = await getAccessContext(store);
  for (const path of ["/metadata-raw", "/metadata-mdx.html", "/metadata-mdx.mdx", "/metadata-mdx/"]) {
    const result = await gateAccessRequest(new Request(`https://example.com${path}`), {}, async () => new Response("SHOULD NOT SERVE"), access, { policy });
    assert.equal(result.status, 403); assert.equal(result.headers.get("x-robots-tag"), "noindex, nofollow"); assert.ok(!(await result.text()).includes("metadata"));
  }
  await buildAll(store);
  const index = await readFile(join(store.outDir, "index.html"), "utf8");
  assert.ok(!index.includes("Hidden raw metadata")); assert.ok(!index.includes("Hidden MDX metadata"));
  assert.equal(await readFile(join(store.outDir, "metadata-raw.html"), "utf8"), document("Hidden raw metadata"));
  assert.match(await readFile(join(store.outDir, "metadata-mdx.html"), "utf8"), /name="robots" content="noindex, nofollow"/);
});

test("homepage contains only explicit public pages, sorted by source update time, and consent drift invalidates it", async () => {
  const store = await fixture();
  for (const slug of ["older", "newer", "linked", "secret"]) await writeFile(join(store.root, "digests", `${slug}.mdx`), mdx(`${slug} metadata`));
  await setPageSharing(store, "older", { visibility: "public" });
  await setPageSharing(store, "newer", { visibility: "public", indexable: true });
  await setPageSharing(store, "linked", { visibility: "unlisted" });
  await setPagePasswordEntry(store, "secret", await createPasswordEntry("synthetic access", { iterations: 1000 }));
  await utimes(join(store.root, "digests/older.mdx"), new Date("2026-01-01"), new Date("2026-01-01"));
  await utimes(join(store.root, "digests/newer.mdx"), new Date("2026-09-01"), new Date("2026-09-01"));
  await assertPublishable(store);
  const result = await buildAll(store);
  assert.equal(result.pages.find(page => page.slug === "secret")?.protected, true);
  const index = await readFile(join(store.outDir, "index.html"), "utf8");
  assert.ok(index.includes('href="./newer.html"')); assert.ok(index.includes('href="./older.html"'));
  assert.ok(index.indexOf('href="./newer.html"') < index.indexOf('href="./older.html"'));
  assert.ok(!index.includes("linked metadata")); assert.ok(!index.includes("secret metadata"));
  assert.match(await readFile(join(store.outDir, "newer.html"), "utf8"), /name="robots" content="index, follow"/);
  assert.match(await readFile(join(store.outDir, "older.html"), "utf8"), /name="robots" content="noindex, nofollow"/);
  assert.equal(await isHomepageCurrent(store), true);
  await setPageSharing(store, "newer", { visibility: "private" });
  assert.equal(await isHomepageCurrent(store), false);
  await assert.rejects(assertPublishable(store), /newer/);
});

test("only opted-in public HTML indexes; source, error, unknown, and password routes remain noindex", async () => {
  const store = await fixture(); await writeFile(join(store.root, "digests/report.mdx"), mdx("Report"));
  await setPageSharing(store, "report", { visibility: "public", indexable: true });
  const policy = await readPagePolicies(store), context = await getAccessContext(store);
  for (const path of ["/report", "/report.html", "/report/"]) {
    const result = await gateAccessRequest(new Request(`https://example.com${path}`), {}, async () => new Response("bytes"), context, { policy });
    assert.equal(result.headers.get("x-robots-tag"), "index, follow");
  }
  for (const [path, status] of [["/report.mdx", 200], ["/report.mdx/", 200], ["/404.html", 404], ["/report", 500], ["/unknown", 200]] as const) {
    const result = await gateAccessRequest(new Request(`https://example.com${path}`), {}, async () => new Response("bytes", { status }), context, { policy });
    assert.equal(result.headers.get("x-robots-tag"), "noindex, nofollow");
    if (path === "/unknown") assert.equal(result.status, 404);
  }
  await setPagePasswordEntry(store, "report", await createPasswordEntry("synthetic lock", { iterations: 1000 }));
  assert.deepEqual((await readPagePolicies(store)).report, { visibility: "private", indexable: false });
  const prompt = await gateAccessRequest(new Request("https://example.com/report"), await readAccessManifest(store.root), async () => new Response("bytes"), context, { policy: await readPagePolicies(store) });
  assert.equal(prompt.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(await prompt.text(), /Password required/);
  for (const request of [
    new Request("https://example.com/report", { method: "DELETE" }),
    new Request("https://example.com/report", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    new Request("https://example.com/report", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://elsewhere.example" }, body: "password=synthetic" }),
  ]) {
    const error = await gateAccessRequest(request, await readAccessManifest(store.root), async () => new Response("bytes"), context, { policy: await readPagePolicies(store) });
    assert.ok(error.status >= 400); assert.equal(error.headers.get("x-robots-tag"), "noindex, nofollow");
  }
  await setPageSharing(store, "report", { visibility: "unlisted" });
  assert.deepEqual(await readAccessManifest(store.root), {});
  await assertPublishable(store);
});

test("invalid consent fails closed and removal erases old sharing permission before a slug can be reused", async () => {
  const store = await fixture(); await writeFile(join(store.root, "raw/report.html"), document("Old"));
  await assert.rejects(setPageSharing(store, "report", { visibility: "unlisted", indexable: true }), /public/);
  assert.throws(() => validatePagePolicies({ report: { visibility: "public", indexable: false, password: "extra" } }));
  await setPageSharing(store, "report", { visibility: "public", indexable: true });
  await removePage(store, "report");
  await writeFile(join(store.root, "raw/report.html"), document("New"));
  assert.deepEqual((await readPagePolicies(store)).report, { visibility: "private", indexable: false });
  await writeAccessManifest(store.root, { report: await createPasswordEntry("synthetic", { iterations: 1000 }) });
  await setPageSharing(store, "report", { visibility: "private" });
  assert.equal((await assertPublishable(store)).report.indexable, false);
  await writeFile(join(store.root, "access/sharing.json"), '{"schema":1,"pages":{"report":{"visibility":"public","indexable":true,"consentAt":"not-a-date"}}}');
  await assert.rejects(readPagePolicies(store), /consent/);
});

test("a slug matching an inherited object property still defaults to private", async () => {
  const store = await fixture(); await writeFile(join(store.root, "raw/constructor.html"), document("Synthetic hidden metadata"));
  const policy = await readPagePolicies(store);
  assert.deepEqual(policy.constructor, { visibility: "private", indexable: false });
  await assert.rejects(assertPublishable(store), /constructor/);
  const response = await gateAccessRequest(new Request("https://example.com/constructor"), {}, async () => new Response("hidden bytes"), await getAccessContext(store), { policy });
  assert.equal(response.status, 403);
});

test("search opt-out remains crawlable so crawlers can read noindex after the last indexed page is removed", async () => {
  const store = await fixture();
  await writeFile(join(store.root, "raw/report.html"), document("Report"));
  await buildAll(store);
  assert.equal(await readFile(join(store.outDir, "robots.txt"), "utf8"), "User-agent: *\nAllow: /\n");
  await setPageSharing(store, "report", { visibility: "public", indexable: true });
  await buildAll(store);
  await setPageSharing(store, "report", { visibility: "unlisted" });
  await buildAll(store);
  assert.equal(await readFile(join(store.outDir, "robots.txt"), "utf8"), "User-agent: *\nAllow: /\n");
  const response = await gateAccessRequest(new Request("https://example.com/report"), {}, async () => new Response("Report"), await getAccessContext(store), { policy: await readPagePolicies(store) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
});
