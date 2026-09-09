import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { assertPublicFile } from "../scripts/check-package.mjs";

describe("public package boundary", () => {
  test("allows synthetic examples and rejects undeclared files, private paths, verifier state, and keys", () => {
    const allowed = new Set(["fixture.ts", "fixture.json"]);
    assert.doesNotThrow(() => assertPublicFile("fixture.ts", Buffer.from('const url = "https://example.com/sample";'), allowed));
    assert.throws(() => assertPublicFile("digests/private.mdx", Buffer.from("private"), allowed), (error) => error instanceof Error && error.message.includes("Unapproved"));
    const userHome = "/" + ["Users", "private-person", "notes"].join("/");
    assert.throws(() => assertPublicFile("fixture.ts", Buffer.from(userHome), allowed), (error) => error instanceof Error && error.message.includes("private home"));
    assert.throws(() => assertPublicFile("fixture.json", Buffer.from(JSON.stringify({ page: { algorithm: "pbkdf2-sha256", verifier: "synthetic" } })), allowed), (error) => error instanceof Error && error.message.includes("Access state"));
    assert.throws(() => assertPublicFile("fixture.json", Buffer.from(JSON.stringify({ page: { algorithm: "pbkdf2-sha256-client", verifier: "synthetic" } })), allowed), (error) => error instanceof Error && error.message.includes("Access state"));
    for (const algorithm of ["pbkdf2-sha256", "pbkdf2-sha256-client"]) {
      const profiles = { schema: 1, profiles: { default: { version: 2, algorithm, salt: "synthetic", verifier: "synthetic" } } };
      assert.throws(() => assertPublicFile("fixture.json", Buffer.from(JSON.stringify(profiles)), allowed), /Access state/);
      assert.throws(() => assertPublicFile("fixture.json", Buffer.from(JSON.stringify({ nested: [profiles] })), allowed), /Access state/);
    }
    assert.throws(() => assertPublicFile("fixture.json", Buffer.from(JSON.stringify({ nested: [{ accountId: "synthetic" }] })), allowed), /Private publisher state/);
    assert.throws(() => assertPublicFile("fixture.json", Buffer.from(JSON.stringify({ nested: { signingKey: "synthetic" } })), allowed), /Private publisher state/);
    assert.throws(() => assertPublicFile("fixture.json", Buffer.from(JSON.stringify({ signingKey: "synthetic" })), allowed), (error) => error instanceof Error && error.message.includes("Private publisher state"));
    const key = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
    assert.throws(() => assertPublicFile("fixture.ts", Buffer.from(key), allowed), (error) => error instanceof Error && error.message.includes("private key"));
  });

  test("resolves literal module dependencies from their source location and rejects repository escapes", () => {
    const file = "src/nested/entry.ts";
    const allowed = new Set([file, "entry.ts", "src/entry.ts"]);
    for (const source of [
      'import value from "../../../outside/module.ts";',
      'import "../../../outside/side-effect.js";',
      'export { value } /* source */ from\n "../../../outside/re-export.ts";',
      'export * from "../../../outside/re-export.ts";',
      'const loaded = import("../../../outside/lazy.mjs");',
      'const loaded = require("../../../outside/common.cjs");',
      String.raw`import value from "..\u002f..\u002f..\u002foutside/escaped.ts";`,
      'import value from "../%2e%2e/%2e%2e/outside/encoded.ts";',
    ]) assert.throws(() => assertPublicFile(file, Buffer.from(source), allowed), /escapes the public repository/);
    const parentImport = Buffer.from('import value from "../shared.ts";');
    assert.doesNotThrow(() => assertPublicFile("src/entry.ts", parentImport, allowed));
    assert.throws(() => assertPublicFile("entry.ts", parentImport, allowed), /escapes the public repository/);
  });

  test("allows internal and package imports while ignoring comments, text examples, and regex literals", () => {
    const file = "src/nested/entry.ts";
    const source = [
      'import { value } from "../../shared.ts";',
      'import type { Shape } from "../types.ts";',
      'import "./side-effect.js";',
      'export * from "../shared.ts";',
      'import React from "react";',
      'import { readFile } from "node:fs/promises";',
      'const loaded = import("../../shared.ts?revision=1");',
      '// import value from "../../../outside/comment.ts";',
      '/* export * from "../../../outside/comment.ts"; */',
      'const example = \'import value from "../../../outside/example.ts";\';',
      'const template = `import value from "../../../outside/example.ts";`;',
      String.raw`const pattern = /import value from "..\/..\/..\/outside\/example.ts"/;`,
      'const ratio = 4 / 2; import value from "../shared.ts";',
    ].join('\n');
    assert.doesNotThrow(() => assertPublicFile(file, Buffer.from(source), new Set([file])));
  });

});
