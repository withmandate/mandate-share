import { test } from "node:test";
import assert from "node:assert/strict";
import { createPasswordEntry, derivePasswordProof, gateAccessRequest, passwordChallenge, type AccessEntry } from "../lib/access-core.ts";

const context = { storeId: "security-fixture", signingKey: Buffer.alloc(32, 9).toString("base64") };
const asset = async () => new Response("<!doctype html><script>window.artifact=true</script>", { headers: { "content-type": "text/html" } });

test("unlock prompt restricts executable content and framing without altering artifact bytes", async () => {
  const entry = await createPasswordEntry("synthetic passphrase", { iterations: 1000 });
  const manifest = { brief: entry };
  const request = () => new Request("https://fixture.example/brief");
  const response = await gateAccessRequest(request(), manifest, asset, context);
  const html = await response.text();
  const nonce = /<script nonce="([A-Za-z0-9_-]{22})">/.exec(html)?.[1];
  assert.ok(nonce);
  assert.ok(html.includes(`<style nonce="${nonce}">`));
  const csp = response.headers.get("content-security-policy")!;
  for (const directive of ["default-src 'none'", `script-src 'nonce-${nonce}'`, `style-src 'nonce-${nonce}'`, "form-action 'self'", "base-uri 'none'", "frame-ancestors 'none'"]) assert.ok(csp.includes(directive));
  assert.ok(!csp.includes("unsafe-inline"));
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  const another = await gateAccessRequest(request(), manifest, asset, context);
  assert.notEqual(another.headers.get("content-security-policy"), csp);
  const body = new URLSearchParams({ proof: await derivePasswordProof("synthetic passphrase", entry), challenge: passwordChallenge(entry) });
  const login = await gateAccessRequest(new Request(request(), { method: "POST", body }), manifest, asset, context);
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie")!.split(";", 1)[0];
  const unlocked = await gateAccessRequest(new Request(request(), { headers: { cookie } }), manifest, asset, context);
  const publicPage = await gateAccessRequest(new Request("https://fixture.example/public"), manifest, asset, context);
  for (const page of [unlocked, publicPage]) {
    assert.equal(page.headers.get("content-security-policy"), null);
    assert.equal(await page.text(), await (await asset()).text());
  }
  for (const result of [response, another, login, unlocked, publicPage]) {
    assert.equal(result.headers.get("referrer-policy"), "same-origin");
    assert.equal(result.headers.get("x-content-type-options"), "nosniff");
    assert.equal(result.headers.get("strict-transport-security"), "max-age=31536000");
  }
  const local = await gateAccessRequest(new Request("http://127.0.0.1/brief"), manifest, asset, context);
  assert.equal(local.headers.get("strict-transport-security"), null);
});

test("attempt control runs before proof/body processing, fails closed, and leaves reading unaffected", async () => {
  const entry = await createPasswordEntry("synthetic passphrase", { iterations: 1000 });
  const manifest = { brief: entry };
  let calls = 0, allowed = true, unavailable = false;
  const options = { checkPasswordAttempt: async (seen: AccessEntry) => {
    assert.deepEqual(seen, entry); calls++;
    if (unavailable) throw new Error("fixture limiter unavailable");
    return allowed;
  } };
  const body = new URLSearchParams({ proof: await derivePasswordProof("synthetic passphrase", entry), challenge: passwordChallenge(entry) });
  const post = (fields = body) => gateAccessRequest(new Request("https://fixture.example/brief", { method: "POST", body: fields }), manifest, asset, context, options);
  const valid = await post();
  assert.equal(valid.status, 303); assert.equal(calls, 1);
  allowed = false;
  for (const fields of [body, new URLSearchParams("malformed=1")]) {
    const limited = await post(fields);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
    assert.equal(limited.headers.get("cache-control"), "no-store");
    assert.equal(limited.headers.get("set-cookie"), null);
    assert.ok(limited.headers.get("content-security-policy")?.includes("frame-ancestors 'none'"));
    const html = await limited.text();
    assert.ok(!html.includes(entry.verifier));
    assert.ok(html.includes('id="mandate-share-unlock"'));
  }
  unavailable = true;
  assert.equal((await post()).status, 503);
  const beforeReads = calls;
  const cookie = valid.headers.get("set-cookie")!.split(";", 1)[0];
  for (const [path, headers, status] of [["/brief", {}, 401], ["/brief.mdx", { cookie }, 200], ["/public", {}, 200]] as const) {
    const response = await gateAccessRequest(new Request(`https://fixture.example${path}`, { headers }), manifest, asset, context, options);
    assert.equal(response.status, status);
  }
  assert.equal(calls, beforeReads);
  unavailable = false; allowed = true;
  assert.equal((await post()).status, 303);
});
