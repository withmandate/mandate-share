import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const runtime = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const loader = join(runtime, "node_modules/tsx/dist/loader.mjs");

test("CLI private defaults, explicit listing, named passwords and targeted rotation", async () => {
  const base = await mkdtemp(join(tmpdir(), "share-cli-privacy-"));
  const store = join(base, "pages");
  const env = { ...process.env, MANDATE_SHARE_HOME: join(base, "config"), MANDATE_SHARE_CACHE: join(base, "cache"), TSX_TSCONFIG_PATH: join(runtime, "tsconfig.json") };
  const cli = (args: string[], input?: string, expected = 0) => {
    const result = spawnSync(process.execPath, ["--import", loader, join(runtime, "cli.ts"), ...args], { cwd: base, env, input, encoding: "utf8", timeout: 45_000 });
    assert.equal(result.status, expected, result.stderr || result.stdout);
    const output = expected ? result.stderr : result.stdout;
    for (const secret of ["SYNTHETIC DEFAULT VALUE", "SYNTHETIC CLIENT REVIEW VALUE", "SYNTHETIC CHANGED VALUE"]) assert.ok(!output.includes(secret), "password must not be echoed");
    return JSON.parse(output);
  };
  try {
    assert.equal(cli(["setup"]).data.status, "choose-folder");
    cli(["setup", "--path", store, "--confirm", "invalid", "--login"], undefined, 1);
    cli(["setup", "--path", store, "--workers-dev"], undefined, 1);
    cli(["setup", "--path", store, "--workers-dev", "--worker", "INVALID", "--account-id", "a".repeat(32)], undefined, 1);
    assert.equal(existsSync(store), false, "invalid setup must not create a pages folder");
    assert.equal(existsSync(join(base, "config", "config.json")), false, "invalid setup must not register a store");
    cli(["store", "add", "personal", "--path", store, "--default"]);
    cli(["password", "--default", "--stdin"], "SYNTHETIC DEFAULT VALUE\n");
    await writeFile(join(store, "digests", "briefing.mdx"), "---\ntitle: Private title\n---\n\nPrivate body.\n");
    const built = cli(["build"]).data;
    assert.equal(built.pages[0].visibility, "private");
    assert.equal(built.pages[0].protected, true);
    assert.ok(!(await readFile(join(store, ".mandate-share", "dist", "index.html"), "utf8")).includes("Private title"));
    cli(["password", "--profile", "client-review", "--stdin"], "SYNTHETIC CLIENT REVIEW VALUE\n");
    cli(["password", "briefing", "--use-profile", "client-review"]);
    const before = await readFile(join(store, "access", "manifest.json"), "utf8");
    cli(["password", "--profile", "client-review", "--stdin"], "SYNTHETIC CHANGED VALUE\n");
    assert.equal(await readFile(join(store, "access", "manifest.json"), "utf8"), before, "profile update must not rotate pages implicitly");
    cli(["password", "--rotate-profile", "client-review", "briefing"]);
    assert.notEqual(await readFile(join(store, "access", "manifest.json"), "utf8"), before);
    cli(["sharing", "briefing", "--unlisted"]);
    assert.equal(cli(["list"]).data[0].protected, false);
    assert.ok(!(await readFile(join(store, ".mandate-share", "dist", "index.html"), "utf8")).includes("Private title"));
    cli(["sharing", "briefing", "--public"]);
    assert.ok((await readFile(join(store, ".mandate-share", "dist", "index.html"), "utf8")).includes("Private title"));
    assert.equal(cli(["list"]).data[0].indexable, false);
    cli(["sharing", "briefing", "--public", "--indexable"]);
    assert.equal(cli(["list"]).data[0].indexable, true);
    cli(["sharing", "briefing", "--private", "--indexable"], undefined, 1);
    assert.equal(cli(["list"]).data[0].visibility, "public", "invalid sharing choice must not partially mutate consent");
    cli(["password", "--default", "extra-argument", "--stdin"], "unused\n", 1);
    assert.ok(!JSON.stringify(cli(["password", "--list"])).includes("verifier"));
  } finally { await rm(base, { recursive: true, force: true }); }
});
