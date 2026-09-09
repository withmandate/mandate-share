import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bootstrapRuntime, runtimeSources } from "../skills/mandate-share/scripts/run.mjs";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mandate share bootstrap "));
  roots.push(root);
  const runtime = join(root, "installed skill", "runtime");
  for (const folder of ["lib", "components", "styles"]) await mkdir(join(runtime, folder), { recursive: true });
  await writeFile(join(runtime, "package.json"), JSON.stringify({ name: "synthetic-bootstrap-fixture", version: "0.1.0", type: "module", dependencies: { "is-number": "7.0.0" } }));
  await writeFile(join(runtime, "cli.ts"), 'console.log(JSON.stringify({ok:true,fixture:"original",argv:process.argv.slice(2)}));\n');
  await writeFile(join(runtime, "tsconfig.json"), "{}");
  const lock = spawnSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: runtime, env: { ...process.env, npm_config_cache: join(root, "dependency-cache") } });
  if (lock.status !== 0) throw new Error(lock.stderr.toString());
  await writeFile(join(runtime, "lib", "fixture.ts"), 'export const fixture = "original";\n');
  const options = { runtimeRoot: runtime, cacheRoot: join(root, "cache with spaces"), configRoot: join(root, "config") };
  return { root, runtime, options };
}

describe("portable locked runtime cache", () => {
  test("two concurrent calls restore one complete cache and preserve external populated state across source updates", async () => {
    const { root, runtime, options } = await fixture();
    const store = join(root, "private store");
    await mkdir(join(store, ".mandate-share"), { recursive: true });
    const protectedFiles = ["page.mdx", "component.tsx", "listing.json", ".mandate-share/passwords.json", ".mandate-share/publisher.json"];
    for (const file of protectedFiles) await writeFile(join(store, file), `SYNTHETIC ${file}`);
    const original = await Promise.all(protectedFiles.map(file => readFile(join(store, file))));
    const [a, b] = await Promise.all([bootstrapRuntime(options), bootstrapRuntime(options)]);
    assert.strictEqual(a, b);
    assert.strictEqual(await bootstrapRuntime(options), a);
    assert.ok((await readFile(join(a, "cli.ts"), "utf8")).includes("original"));
    assert.deepStrictEqual(await readdir(options.cacheRoot + "/runtimes"), [a.split("/").at(-1)!]);
    await writeFile(join(runtime, "lib", "fixture.ts"), 'export const fixture = "updated";\n');
    const updated = await bootstrapRuntime(options);
    assert.notStrictEqual(updated, a);
    assert.ok((await readFile(join(a, "lib", "fixture.ts"), "utf8")).includes("original"));
    assert.ok((await readFile(join(updated, "lib", "fixture.ts"), "utf8")).includes("updated"));
    for (let index = 0; index < protectedFiles.length; index++) assert.deepStrictEqual(await readFile(join(store, protectedFiles[index])), original[index]);
  });

  test("arbitrary JSON remains excluded from executable source", async () => {
    const { runtime, options } = await fixture();
    await writeFile(join(runtime, "lib", "private-settings.json"), '{}');
    await assert.rejects(bootstrapRuntime(options), /Unexpected runtime source/);
  });

  test("does not copy tests or dependencies and works from read-only installed source", async () => {
    const { runtime, options } = await fixture();
    for (const folder of ["tests", "node_modules"]) {
      await mkdir(join(runtime, folder), { recursive: true });
      await writeFile(join(runtime, folder, "private.txt"), "NOT RUNTIME SOURCE");
    }
    for (const file of await runtimeSources(runtime)) await chmod(join(runtime, file), 0o444);
    await chmod(runtime, 0o555);
    try {
      const cache = await bootstrapRuntime(options);
      assert.ok((await readFile(join(cache, "cli.ts"), "utf8")).includes("original"));
      assert.strictEqual((await readdir(cache)).includes("tests"), false);
      assert.strictEqual((await readdir(join(cache, "node_modules"))).includes("private.txt"), false);
    } finally { await chmod(runtime, 0o755); }
  });

  test("fails incomplete installs without activating a cache, then allows a clean retry", async () => {
    const { runtime, options } = await fixture();
    const originalPackage = await readFile(join(runtime, "package.json"));
    await writeFile(join(runtime, "package.json"), JSON.stringify({ name: "synthetic-bootstrap-fixture", version: "0.1.0", dependencies: { "synthetic-unavailable-fixture": "0.0.0" } }));
    await assert.rejects(bootstrapRuntime(options), (error) => error instanceof Error && error.message.includes("Locked dependency installation failed"));
    assert.deepStrictEqual(await readdir(join(options.cacheRoot, "runtimes")), []);
    await writeFile(join(runtime, "package.json"), originalPackage);
    assert.ok((await readFile(join(await bootstrapRuntime(options), "cli.ts"), "utf8")).includes("original"));
  });

  test("refuses mixed source changed during dependency installation before activating or executing it", async () => {
    const { options } = await fixture();
    await assert.rejects(bootstrapRuntime({ ...options, install: async (stage: string) => {
      await writeFile(join(stage, "cli.ts"), "SYNTHETIC MIXED VERSION SOURCE");
    } }), (error) => error instanceof Error && error.message.includes("source changed during dependency installation"));
    assert.deepStrictEqual(await readdir(join(options.cacheRoot, "runtimes")), []);
    assert.ok((await readFile(join(await bootstrapRuntime(options), "cli.ts"), "utf8")).includes("original"));
  });

  test("refuses source symlinks, store/cache overlap, missing runtime pieces, and a modified ready cache", async () => {
    const { root, runtime, options } = await fixture();
    const cache = await bootstrapRuntime(options);
    await writeFile(join(cache, "cli.ts"), "MODIFIED CACHE");
    await assert.rejects(bootstrapRuntime(options), (error) => error instanceof Error && error.message.includes("cache is incomplete or changed"));
    await assert.rejects(bootstrapRuntime({ ...options, cacheRoot: runtime }), (error) => error instanceof Error && error.message.includes("separate"));
    const store = join(root, "store");
    await mkdir(store);
    await writeFile(join(store, "store.json"), "{}");
    await assert.rejects(bootstrapRuntime({ ...options, cacheRoot: join(store, "cache") }), (error) => error instanceof Error && error.message.includes("inside a user store"));
    await symlink(join(root, "store.json"), join(runtime, "lib", "escape.ts"));
    await assert.rejects(runtimeSources(runtime), (error) => error instanceof Error && error.message.includes("Unexpected runtime source"));
    await rm(join(runtime, "lib", "escape.ts"));
    await rm(join(runtime, "package-lock.json"));
    await assert.rejects(bootstrapRuntime(options));
  });
});
