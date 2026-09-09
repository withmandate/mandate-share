import { test } from "node:test";
import assert from "node:assert/strict";
import { pbkdf2Sync, webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import { gzipSync } from "node:zlib";
import { unlockScript, type UnlockParameters } from "../lib/unlock-client.ts";

const parameters: UnlockParameters = { salt: Buffer.alloc(16, 7).toString("base64url"), iterations: 100_000 };
const challengeValue = `2.${parameters.iterations}.${parameters.salt}`;
interface SubmitEvent { preventDefault(): void }
class Element {
  id = ""; type = ""; name = ""; value = ""; textContent = ""; hidden = false; disabled = false; focused = false;
  attributes = new Map<string, string>(); parent?: Form;
  constructor(readonly tag: string) {}
  setAttribute(name: string, value: string) { this.attributes.set(name, value); if (name === "name") this.name = value; }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); if (name === "name") this.name = ""; }
  remove() { if (this.parent) this.parent.nodes = this.parent.nodes.filter(node => node !== this); }
  focus() { this.focused = true; }
}
class Form extends Element {
  nodes: Element[] = []; listeners = new Map<string, (event: SubmitEvent) => Promise<void>>();
  method = "post"; enctype = ""; valid = true; validityChecks = 0;
  get elements() { return this.nodes.filter(node => node.tag === "input" || node.tag === "button"); }
  append(node: Element) { node.parent = this; this.nodes.push(node); }
  querySelector(selector: string) {
    if (selector === "#password") return this.nodes.find(node => node.id === "password");
    if (selector === 'button[type="submit"]') return this.nodes.find(node => node.tag === "button" && node.type === "submit");
    return this.querySelectorAll(selector)[0];
  }
  querySelectorAll(selector: string) {
    const name = /^input\[name="([a-z]+)"\]$/u.exec(selector)?.[1];
    return this.nodes.filter(node => node.tag === "input" && node.name === name);
  }
  addEventListener(name: string, listener: (event: SubmitEvent) => Promise<void>) { this.listeners.set(name, listener); }
  reportValidity() { this.validityChecks++; return this.valid && !!this.querySelector("#password")?.value; }
}
interface FixtureOptions {
  parameters?: UnlockParameters; url?: string; action?: string; secure?: boolean; missingCrypto?: boolean;
  failOnce?: "import" | "derive" | "submit";
}
function fixture(options: FixtureOptions = {}) {
  const config = options.parameters ?? parameters;
  const form = new Form("form"); form.id = "mandate-share-unlock"; form.setAttribute("action", options.action ?? "/brief");
  const password = new Element("input"); password.id = "password"; password.type = "password"; password.name = "password"; password.disabled = true;
  const button = new Element("button"); button.type = "submit"; button.disabled = true;
  const challenge = new Element("input"); challenge.type = "hidden"; challenge.name = "challenge"; challenge.value = `2.${config.iterations}.${config.salt}`;
  const unrelated = new Element("input"); unrelated.type = "hidden"; unrelated.name = "username"; unrelated.value = "SHOULD NOT BE POSTED";
  for (const item of [password, button, challenge, unrelated]) form.append(item);
  const facts = { imports: 0, derivations: 0, prevented: 0, requests: 0, storage: 0, logs: 0 };
  const posted: Array<{ entries: Record<string, string>; passwordValue: string; passwordName: string; method: string; action: string | null }> = [];
  const pageEvents = new Map<string, (event: { persisted: boolean }) => void>();
  let failure = options.failOnce;
  const subtle = {
    importKey: async (...args: Parameters<typeof webcrypto.subtle.importKey>) => {
      facts.imports++; if (failure === "import") { failure = undefined; throw new Error("synthetic import failure"); }
      return webcrypto.subtle.importKey(...args);
    },
    deriveBits: async (...args: Parameters<typeof webcrypto.subtle.deriveBits>) => {
      facts.derivations++; if (failure === "derive") { failure = undefined; throw new Error("synthetic derive failure"); }
      return webcrypto.subtle.deriveBits(...args);
    },
  };
  function nativeSubmit(this: Form) {
    if (failure === "submit") { failure = undefined; throw new Error("synthetic submission failure"); }
    posted.push({ entries: Object.fromEntries(this.elements.filter(item => item.name && !item.disabled).map(item => [item.name, item.value])), passwordValue: password.value, passwordName: password.name, method: this.method, action: this.getAttribute("action") });
  }
  const globals = {
    document: { getElementById: (id: string) => id === form.id ? form : undefined, createElement: (tag: string) => new Element(tag) },
    location: new URL(options.url ?? "https://fixture.example/brief?from=test"),
    isSecureContext: options.secure ?? true,
    crypto: options.missingCrypto ? undefined : { subtle }, TextEncoder, Uint8Array, URL, atob, btoa,
    HTMLFormElement: { prototype: { submit: nativeSubmit } },
    addEventListener: (name: string, callback: (event: { persisted: boolean }) => void) => pageEvents.set(name, callback),
    fetch: () => { facts.requests++; throw new Error("unexpected network request"); },
    get localStorage() { facts.storage++; throw new Error("unexpected browser storage"); },
    console: { log: () => { facts.logs++; }, error: () => { facts.logs++; }, warn: () => { facts.logs++; } },
  };
  const emitted = unlockScript(config);
  const script = /<script>([\s\S]*?)<\/script>/u.exec(emitted)![1]!;
  runInNewContext(script, globals);
  const submit = async () => { await form.listeners.get("submit")!({ preventDefault() { facts.prevented++; } }); };
  const status = () => form.nodes.find(node => node.id === "mandate-share-unlock-status")!;
  return { config, emitted, form, password, button, challenge, unrelated, facts, posted, pageEvents, submit, status };
}

test("derives the correct 100,000-iteration proof only on submit and posts no raw password or extra fields", async () => {
  const f = fixture();
  assert.equal(f.facts.imports, 0); assert.equal(f.facts.derivations, 0); assert.equal(f.facts.requests, 0);
  assert.equal(f.password.disabled, false); assert.equal(f.button.disabled, false); assert.equal(f.password.name, "");
  const value = "SYNTHETIC π PASSWORD 🫖"; f.password.value = value;
  await f.submit();
  const expected = pbkdf2Sync(value, Buffer.from(parameters.salt, "base64url"), parameters.iterations, 32, "sha256").toString("base64url");
  assert.equal(f.facts.derivations, 1); assert.equal(f.posted.length, 1);
  assert.deepEqual(f.posted[0]!.entries, { challenge: challengeValue, proof: expected });
  assert.match(f.posted[0]!.entries.proof!, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(f.posted[0]!.passwordValue, ""); assert.equal(f.posted[0]!.passwordName, ""); assert.equal(f.posted[0]!.method, "post");
  assert.equal(f.password.disabled, true); assert.equal(f.button.disabled, true);
  assert.equal(f.facts.requests + f.facts.storage + f.facts.logs, 0);
});

test("native validation and the UTF-8 password limit prevent unnecessary derivation", async () => {
  const f = fixture(); await f.submit();
  assert.equal(f.form.validityChecks, 1); assert.equal(f.facts.imports, 0);
  f.password.value = "🫖".repeat(300); await f.submit();
  assert.equal(f.facts.imports, 0); assert.match(f.status().textContent, /too long/); assert.equal(f.button.disabled, false);
  f.password.value = "SYNTHETIC"; f.form.valid = false; await f.submit();
  assert.equal(f.facts.imports, 0); assert.equal(f.posted.length, 0);
});

test("import, derivation and submission failures restore a retryable form without a leftover proof", async () => {
  for (const failOnce of ["import", "derive", "submit"] as const) {
    const f = fixture({ failOnce, parameters: { ...parameters, iterations: 1_000 } }); f.password.value = "SYNTHETIC RETRY";
    await f.submit();
    assert.equal(f.posted.length, 0); assert.equal(f.form.querySelectorAll('input[name="proof"]').length, 0);
    assert.equal(f.password.value, "SYNTHETIC RETRY"); assert.equal(f.password.name, "");
    assert.equal(f.password.disabled, false); assert.equal(f.button.disabled, false); assert.equal(f.unrelated.disabled, false);
    assert.equal(f.form.getAttribute("aria-busy"), null); assert.match(f.status().textContent, /Please try again/);
    await f.submit(); assert.equal(f.posted.length, 1); assert.deepEqual(Object.keys(f.posted[0]!.entries).sort(), ["challenge", "proof"]);
    assert.equal(f.facts.requests + f.facts.storage + f.facts.logs, 0);
  }
});

test("double submit starts one derivation and bfcache return clears the old proof and enables a fresh attempt", async () => {
  const f = fixture(); f.password.value = "SYNTHETIC DOUBLE CLICK";
  const first = f.submit(); const second = f.submit();
  assert.equal(f.button.disabled, true); assert.equal(f.password.disabled, true); assert.match(f.status().textContent, /Unlocking/);
  await Promise.all([first, second]);
  assert.equal(f.facts.derivations, 1); assert.equal(f.posted.length, 1); assert.equal(f.facts.prevented, 2);
  f.pageEvents.get("pageshow")!({ persisted: true });
  assert.equal(f.password.value, ""); assert.equal(f.form.querySelectorAll('input[name="proof"]').length, 0);
  assert.equal(f.button.disabled, false); assert.equal(f.password.disabled, false); assert.equal(f.status().hidden, true);
});

test("unsupported crypto, insecure transports and unexpected actions have explanatory UX and never submit plaintext", async () => {
  for (const options of [
    { missingCrypto: true }, { secure: false }, { url: "http://fixture.example/brief" },
    { action: "https://other.example/brief" }, { action: "/another-page" },
  ]) {
    const f = fixture(options); assert.equal(f.password.disabled, true); assert.equal(f.button.disabled, true);
    assert.match(f.status().textContent, /current browser over HTTPS/); assert.equal(f.password.name, "");
    f.password.value = "SYNTHETIC UNSUPPORTED"; await f.submit();
    assert.equal(f.facts.imports, 0); assert.equal(f.posted.length, 0); assert.equal(f.facts.prevented, 1);
  }
  const local = fixture({ url: "http://127.0.0.1:43210/brief", parameters: { ...parameters, iterations: 1_000 } });
  local.password.value = "SYNTHETIC LOOPBACK"; await local.submit(); assert.equal(local.posted.length, 1);
});

test("an action changed during derivation cannot receive the proof", async () => {
  const f = fixture(); f.password.value = "SYNTHETIC ACTION CHANGE";
  const pending = f.submit(); f.form.setAttribute("action", "https://other.example/brief"); await pending;
  assert.equal(f.posted.length, 0); assert.equal(f.form.querySelectorAll('input[name="proof"]').length, 0);
  assert.equal(f.password.value, "SYNTHETIC ACTION CHANGE"); assert.equal(f.button.disabled, false);
});

test("emits only public parameters with a small inline payload and an explicit no-JavaScript explanation", () => {
  const record = { ...parameters, verifier: "SYNTHETIC VERIFIER MUST STAY SERVER SIDE" };
  const emitted = unlockScript(record);
  assert.match(emitted, /<noscript><p>Enable JavaScript/); assert(!emitted.includes(record.verifier));
  assert(!/<script[^>]+src=/u.test(emitted)); assert(!emitted.includes("localStorage"));
  assert(Buffer.byteLength(emitted) < 4_096); assert(gzipSync(emitted).byteLength < 1_800);
  for (const bad of [{ salt: "</script>", iterations: 100_000 }, { ...parameters, iterations: 999 }, { ...parameters, iterations: 1_000_001 }, { ...parameters, iterations: NaN }]) {
    assert.throws(() => unlockScript(bad), /Invalid browser unlock parameters/);
  }
});
