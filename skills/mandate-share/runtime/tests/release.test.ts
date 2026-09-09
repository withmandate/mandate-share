import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertAssetLimits, assertHeaderLimits, assertReleaseConfirmation, canonicalJson, hashJson, inventoryFromFiles, MAX_ASSET_BYTES, releaseFiles, releaseInventory } from "../lib/release.ts";

test("inventory hashes exact bytes, sorted paths, additions and removals", async () => {
  const root = await mkdtemp(join(tmpdir(), "mandate-share-inventory-"));
  try {
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "z.html"), "original\r\n");
    await writeFile(join(root, "nested/a.mdx"), "# Fixture");
    const initial = await releaseInventory(root);
    assert.deepStrictEqual(initial.files.map((f) => f.path), ["nested/a.mdx", "z.html"]);
    assert.strictEqual(initial.bytes, 19);
    assert.strictEqual((await releaseInventory(root)).digest, initial.digest);
    await writeFile(join(root, "z.html"), "original\n");
    assert.notStrictEqual((await releaseInventory(root)).digest, initial.digest);
    await rm(join(root, "nested/a.mdx"));
    assert.strictEqual(((await releaseInventory(root)).files).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("symlinks and path traversal cannot enter a release", async () => {
  const root = await mkdtemp(join(tmpdir(), "mandate-share-inventory-"));
  try {
    await writeFile(join(root, "target"), "fixture");
    await symlink(join(root, "target"), join(root, "link"));
    await assert.rejects(releaseInventory(root), (error) => error instanceof Error && error.message.includes("symlinks"));
    await assert.rejects(releaseFiles(root, ["../escape"]), (error) => error instanceof Error && error.message.includes("unsafe"));
    await assert.rejects(releaseFiles(root, ["link"]), (error) => error instanceof Error && error.message.includes("symlinks"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("canonical plans and exact digest confirmation", () => {
  assert.strictEqual(canonicalJson({ b: 1, a: [2] }), '{"a":[2],"b":1}');
  const digest = hashJson({ a: 1, b: 2 });
  assert.strictEqual(digest, hashJson({ b: 2, a: 1 }));
  assertReleaseConfirmation(digest, digest);
  assert.throws(() => assertReleaseConfirmation(undefined, digest));
  assert.throws(() => assertReleaseConfirmation("A".repeat(64), digest));
  assert.throws(() => assertReleaseConfirmation("0".repeat(64), digest), (error) => error instanceof Error && error.message.includes("does not match"));
});

test("release capacity checks use asset files and exact header limits", () => {
  const files = Array.from({ length: 20_000 }, (_, index) => ({ path: `${index}.html`, bytes: 1, hash: "fixture" }));
  assertAssetLimits(inventoryFromFiles(files));
  assert.throws(() => assertAssetLimits(inventoryFromFiles([...files, { path: "last.mdx", bytes: 1, hash: "fixture" }])), /20.*000/);
  assertAssetLimits(inventoryFromFiles([{ path: "max.html", bytes: MAX_ASSET_BYTES, hash: "fixture" }]));
  assert.throws(() => assertAssetLimits(inventoryFromFiles([{ path: "oversize.html", bytes: MAX_ASSET_BYTES + 1, hash: "fixture" }])), /25 MiB/);
  assertHeaderLimits(Array.from({ length: 100 }, (_, index) => `/${index}\n  X-Robots-Tag: noindex`).join("\n"));
  assert.throws(() => assertHeaderLimits(Array.from({ length: 101 }, (_, index) => `/${index}\n  X-Robots-Tag: noindex`).join("\n")), /100 header/);
  assertHeaderLimits(`/*\n  X-Test: ${"a".repeat(1990)}`);
  assert.throws(() => assertHeaderLimits(`/*\n  X-Test: ${"a".repeat(1991)}`), /2,000/);
});
