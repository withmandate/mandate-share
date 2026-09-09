import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatedWranglerConfig, readPublisherConfig, validatePublisherConfig, writePublisherConfig } from "../lib/cloudflare.ts";

const target = { worker: "fixture-share", accountId: "a".repeat(32), workersDev: true as const };
describe("store Cloudflare configuration", () => {
  test("validates an explicit destination, canonicalizes DNS, and rejects overrides", () => {
    assert.deepStrictEqual(validatePublisherConfig(target), target);
    assert.strictEqual(validatePublisherConfig({ worker: target.worker, accountId: target.accountId, hostname: "Share.Example.com" }).hostname, "share.example.com");
    for (const bad of [null, { ...target, worker: "../escape" }, { ...target, accountId: "secret" }, { ...target, hostname: "share.example.com" }, { ...target, workersDev: false }, { ...target, main: "elsewhere.ts" }, { ...target, hostname: undefined, workersDev: undefined }, { worker: target.worker, accountId: target.accountId, hostname: "https://example.com" }]) assert.throws(() => validatePublisherConfig(bad));
  });
  test("generated config references only private candidate paths and the gate before every protected-store request", () => {
    const config = generatedWranglerConfig(target, ["private", "private"]);
    assert.strictEqual(config.main, "./worker/index.ts");
    assert.strictEqual(config.assets.directory, "./assets");
    assert.deepStrictEqual(config.assets.run_worker_first, ["/*"]);
    assert.strictEqual(config.preview_urls, false);
    assert.strictEqual(config.assets.binding, "ASSETS");
    assert.deepStrictEqual(config.ratelimits[0].simple, { limit: 10, period: 60 });
    assert.equal(config.ratelimits[0].name, "PASSWORD_ATTEMPTS");
    assert.match(config.ratelimits[0].namespace_id, /^[1-9][0-9]*$/);
    assert.equal(config.ratelimits[0].namespace_id, generatedWranglerConfig(target, []).ratelimits[0].namespace_id);
    assert.notEqual(config.ratelimits[0].namespace_id, generatedWranglerConfig({ ...target, worker: "another-fixture" }, []).ratelimits[0].namespace_id);
    assert.deepStrictEqual(generatedWranglerConfig(target, Array.from({ length: 101 }, (_, i) => `page-${i}`)).assets.run_worker_first, ["/*"]);
    assert.deepStrictEqual(generatedWranglerConfig(target, []).assets.run_worker_first, ["/*"]);
    assert.throws(() => generatedWranglerConfig(target, ["bad/path"]));
  });
  test("publisher state stays under its store and uses private permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "mandate-share-config-"));
    try {
      await mkdir(join(root, ".mandate-share"));
      const path = await writePublisherConfig(root, target);
      assert.strictEqual(path, join(root, ".mandate-share/publisher.json"));
      assert.deepStrictEqual(await readPublisherConfig(root), target);
      assert.strictEqual((await stat(path)).mode & 0o777, 0o600);
      assert.ok(((await readFile(path, "utf8"))).includes("fixture-share"));
      await writePublisherConfig(root, { ...target, worker: "another-fixture" });
      assert.strictEqual((await stat(path)).mode & 0o777, 0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
