import { MAX_SLUG_LENGTH, slugFormatError } from "./slug.ts";
import { pageSlugForPath, robotsForPath, type PagePolicyManifest } from "./privacy-core.ts";
import { unlockScript } from "./unlock-client.ts";

export const ACCESS_COOKIE_PREFIX = "mandate_share_access_";
export const ACCESS_COOKIE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_PBKDF2_ITERATIONS = 100_000;
export const MAX_PBKDF2_ITERATIONS = 1_000_000;
export const MAX_PASSWORD_BYTES = 1_024;
export const MAX_PASSWORD_FORM_BYTES = 16_384;
export const MAX_PROTECTED_SLUG_LENGTH = MAX_SLUG_LENGTH;
export const PASSWORD_VERIFIER_DOMAIN = "mandate-share:password-verifier:v2\0";

export interface AccessEntryV2 {
  version: 2;
  algorithm: "pbkdf2-sha256-client";
  iterations: number;
  salt: string;
  verifier: string;
}

export type AccessEntry = AccessEntryV2;
export interface PasswordProofParameters { salt: string; iterations: number }

export type AccessManifest = Record<string, AccessEntry>;

export interface PasswordEntryOptions {
  iterations?: number;
  salt?: Uint8Array;
}

/** Private server input. Never put this context in assets, manifests, or health responses. */
export interface AccessContext {
  storeId: string;
  /** Canonical base64 encoding of a separately generated 32-byte random secret. */
  signingKey: string;
}

export interface GateOptions {
  now?: number;
  /** Primarily useful to exercise a stalled stream without a five-second test. */
  bodyTimeoutMs?: number;
  policy?: PagePolicyManifest;
  /** Server-only attempt control. Local previews have no public login endpoint. */
  checkPasswordAttempt?: (entry: AccessEntry) => Promise<boolean>;
}

export type PasswordDirective =
  | { kind: "preserve" }
  | { kind: "remove" }
  | { kind: "set"; password: string };

const encoder = new TextEncoder();
const proofVerifierDomain = encoder.encode(PASSWORD_VERIFIER_DOMAIN);

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid base64url value");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytesToBase64Url(bytes) !== value) throw new Error("noncanonical base64url value");
  return bytes;
}

export function validatePasswordEntry(entry: unknown, slug = "password"): asserts entry is AccessEntry {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`access/manifest.json entry "${slug}" must be an object`);
  }
  const candidate = entry as Partial<AccessEntry>;
  const allowedKeys = new Set(["version", "algorithm", "iterations", "salt", "verifier"]);
  const extraKeys = Object.keys(candidate).filter((key) => !allowedKeys.has(key));
  if (extraKeys.length > 0) {
    throw new Error(`access/manifest.json entry "${slug}" has unsupported key "${extraKeys[0]}"`);
  }
  if (candidate.version !== 2) throw new Error(`access/manifest.json entry "${slug}" has unsupported version`);
  if (candidate.algorithm !== "pbkdf2-sha256-client") {
    throw new Error(`access/manifest.json entry "${slug}" has unsupported algorithm`);
  }
  if (!Number.isInteger(candidate.iterations) || (candidate.iterations ?? 0) < 1_000 || (candidate.iterations ?? 0) > MAX_PBKDF2_ITERATIONS) {
    throw new Error(`access/manifest.json entry "${slug}" has invalid iterations`);
  }
  try {
    const size = base64UrlToBytes(candidate.salt ?? "").byteLength;
    if (size < 16 || size > 64) throw new Error("invalid salt size");
  } catch {
    throw new Error(`access/manifest.json entry "${slug}" has invalid salt`);
  }
  try {
    if (base64UrlToBytes(candidate.verifier ?? "").byteLength !== 32) throw new Error("wrong verifier size");
  } catch {
    throw new Error(`access/manifest.json entry "${slug}" has invalid verifier`);
  }
}

export function validateAccessManifest(manifest: unknown, existingSlugs?: Set<string>): asserts manifest is AccessManifest {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("access/manifest.json must be an object keyed by slug");
  }
  const entries = Object.entries(manifest);
  for (const [slug, entry] of entries) {
    const formatError = slugFormatError(slug);
    if (formatError) throw new Error(`access/manifest.json: ${formatError}`);
    validatePasswordEntry(entry, slug);
    if (existingSlugs && !existingSlugs.has(slug)) {
      throw new Error(`access/manifest.json protects missing page "${slug}"`);
    }
  }
}

async function passwordBits(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(salt), iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

function assertPassword(password: string): void {
  if (!password) throw new Error("password cannot be empty");
  if (encoder.encode(password).byteLength > MAX_PASSWORD_BYTES) throw new Error("password is too long");
}

async function proofVerifier(proof: Uint8Array): Promise<Uint8Array> {
  const input = new Uint8Array(proofVerifierDomain.byteLength + proof.byteLength);
  input.set(proofVerifierDomain);
  input.set(proof, proofVerifierDomain.byteLength);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
}

function equalBytes(actual: Uint8Array, expected: Uint8Array): boolean {
  if (actual.byteLength !== expected.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < actual.byteLength; index++) difference |= actual[index] ^ expected[index];
  return difference === 0;
}

/** Password-equivalent client input. Never persist it or include it in a prompt or asset. */
export async function derivePasswordProof(password: string, parameters: PasswordProofParameters): Promise<string> {
  assertPassword(password);
  if (!Number.isInteger(parameters.iterations) || parameters.iterations < 1_000 || parameters.iterations > MAX_PBKDF2_ITERATIONS) throw new Error("invalid PBKDF2 iterations");
  const salt = base64UrlToBytes(parameters.salt);
  if (salt.byteLength < 16 || salt.byteLength > 64) throw new Error("invalid PBKDF2 salt");
  return bytesToBase64Url(await passwordBits(password, salt, parameters.iterations));
}

/** Public parameter binding for stale forms; this is not a nonce or replay defense. */
export function passwordChallenge(entry: AccessEntry): string {
  if (entry.version !== 2) throw new Error("client password challenges require a version 2 record");
  return `2.${entry.iterations}.${entry.salt}`;
}

export async function createPasswordEntry(password: string, options: PasswordEntryOptions = {}): Promise<AccessEntryV2> {
  assertPassword(password);
  const iterations = options.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < 1_000 || iterations > MAX_PBKDF2_ITERATIONS) {
    throw new Error(`PBKDF2 iterations must be between 1000 and ${MAX_PBKDF2_ITERATIONS}`);
  }
  const salt = options.salt ? new Uint8Array(options.salt) : crypto.getRandomValues(new Uint8Array(16));
  if (salt.byteLength < 16 || salt.byteLength > 64) throw new Error("password salt must be between 16 and 64 bytes");
  const verifier = await proofVerifier(await passwordBits(password, salt, iterations));
  return {
    version: 2,
    algorithm: "pbkdf2-sha256-client",
    iterations,
    salt: bytesToBase64Url(salt),
    verifier: bytesToBase64Url(verifier),
  };
}

export async function verifyPassword(password: string, entry: AccessEntry): Promise<boolean> {
  try {
    if (!password || encoder.encode(password).byteLength > MAX_PASSWORD_BYTES) return false;
    validatePasswordEntry(entry, "request");
    const derived = await passwordBits(password, base64UrlToBytes(entry.salt), entry.iterations);
    const actual = await proofVerifier(derived);
    const expected = base64UrlToBytes(entry.verifier);
    return equalBytes(actual, expected);
  } catch {
    return false;
  }
}

function parsePasswordProof(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) return undefined;
  try {
    const bytes = base64UrlToBytes(value);
    return bytes.byteLength === 32 ? bytes : undefined;
  } catch { return undefined; }
}

async function verifyPasswordProof(proof: Uint8Array, entry: AccessEntryV2): Promise<boolean> {
  try {
    validatePasswordEntry(entry, "request");
    return equalBytes(await proofVerifier(proof), base64UrlToBytes(entry.verifier));
  } catch { return false; }
}

function signingKeyBytes(context: AccessContext): Uint8Array<ArrayBuffer> {
  if (!context || !/^[a-zA-Z0-9_-]{1,128}$/u.test(context.storeId)) throw new Error("invalid access store identity");
  if (typeof context.signingKey !== "string" || !/^[A-Za-z0-9+/]{43}=$/u.test(context.signingKey)) {
    throw new Error("invalid access signing key");
  }
  const binary = atob(context.signingKey);
  if (binary.length !== 32 || btoa(binary) !== context.signingKey) throw new Error("invalid access signing key");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmacKey(context: AccessContext): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", signingKeyBytes(context), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function cookiePayload(slug: string, entry: AccessEntry, context: AccessContext, expires: number): Uint8Array<ArrayBuffer> {
  // Include the entire verifier record so every password replacement revokes old cookies.
  return encoder.encode(JSON.stringify([1, context.storeId, slug, entry.version, entry.algorithm, entry.iterations, entry.salt, entry.verifier, expires]));
}

export async function accessCookieValue(slug: string, entry: AccessEntry, context: AccessContext, now: number = Date.now()): Promise<string> {
  validatePasswordEntry(entry, slug);
  const expires = Math.floor(now / 1_000) + ACCESS_COOKIE_TTL_SECONDS;
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(context), cookiePayload(slug, entry, context, expires));
  return `${expires}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export async function verifyAccessCookie(value: string, slug: string, entry: AccessEntry, context: AccessContext, now: number = Date.now()): Promise<boolean> {
  try {
    validatePasswordEntry(entry, slug);
    const match = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/u.exec(value);
    if (!match) return false;
    const expires = Number(match[1]);
    const seconds = Math.floor(now / 1_000);
    if (!Number.isSafeInteger(expires) || expires <= seconds || expires > seconds + ACCESS_COOKIE_TTL_SECONDS) return false;
    return await crypto.subtle.verify("HMAC", await hmacKey(context), base64UrlToBytes(match[2]), cookiePayload(slug, entry, context, expires));
  } catch {
    return false;
  }
}

/** The caller must load a default from the selected store; there is no ambient default. */
export function resolvePasswordDirective(password: string | true | undefined, remove: boolean, defaultPassword?: string): PasswordDirective {
  if (password !== undefined && remove) throw new Error("pass at most one of --password / --no-password");
  if (remove) return { kind: "remove" };
  if (password === undefined) return { kind: "preserve" };
  const resolved = password === true ? defaultPassword : password;
  if (!resolved) throw new Error(password === true ? "the selected store has no default password" : "password cannot be empty");
  if (encoder.encode(resolved).byteLength > MAX_PASSWORD_BYTES) throw new Error("password is too long");
  return { kind: "set", password: resolved };
}

export function protectedRoutePatterns(slugs: Iterable<string>): string[] {
  const unique = [...new Set(slugs)].sort();
  for (const slug of unique) {
    const formatError = slugFormatError(slug);
    if (formatError) throw new Error(`protected route: ${formatError}`);
  }
  return unique.map((slug) => `/${slug}*`);
}

/** Use one decoding policy in the Worker and local server; ambiguous paths fail closed. */
export function normalizedRequestPath(pathname: string): string | undefined {
  try {
    if (/%(?:2f|5c)/iu.test(pathname)) return undefined;
    const decoded = decodeURIComponent(pathname);
    if (!decoded.startsWith("/") || /[%\\\x00-\x1f\x7f]/u.test(decoded) || decoded.includes("//")) return undefined;
    if (decoded.split("/").some((part) => part === "." || part === "..")) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}

function slugForPath(pathname: string, manifest: AccessManifest): string | undefined {
  // Cloudflare can normalize trailing slashes. Gate the complete page subtree as well.
  const match = /^\/([a-z0-9][a-z0-9-]*)(?:\/.*|\.(?:html|mdx)(?:\/.*)?)?$/u.exec(pathname);
  return match && Object.hasOwn(manifest, match[1]) ? match[1] : undefined;
}

export function accessCookieName(slug: string, context: AccessContext): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(context.storeId) || slugFormatError(slug)) throw new Error("invalid cookie scope");
  return `${ACCESS_COOKIE_PREFIX}${context.storeId}_${slug}`;
}

function cookieFromRequest(request: Request, slug: string, context: AccessContext): string | undefined {
  const cookie = request.headers.get("cookie");
  if (!cookie || cookie.length > 32_768) return undefined;
  const expectedName = accessCookieName(slug, context);
  const matches = cookie.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${expectedName}=`));
  // Reject duplicate cookie names rather than relying on differing parser precedence.
  return matches.length === 1 ? matches[0].slice(expectedName.length + 1) : undefined;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function promptPage(pathname: string, incorrect: boolean, entry: AccessEntry, nonce: string, notice?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<link rel="icon" href="data:,">
<title>Password required</title>
<style nonce="${nonce}">
:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: Canvas; color: CanvasText; }
main { width: min(24rem, calc(100vw - 2rem)); }
h1 { font-size: 1.35rem; margin: 0 0 .5rem; }
p { line-height: 1.5; color: color-mix(in srgb, CanvasText 68%, transparent); }
form { display: grid; gap: .75rem; margin-top: 1.5rem; }
label { font-size: .85rem; font-weight: 650; }
input, button { box-sizing: border-box; width: 100%; min-height: 2.75rem; border-radius: .55rem; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); font: inherit; }
input { padding: .65rem .75rem; background: Canvas; color: CanvasText; }
button { border-color: CanvasText; background: CanvasText; color: Canvas; font-weight: 700; cursor: pointer; }
.error { color: #c33; font-weight: 650; }
</style>
</head>
<body>
<main>
<h1>Password required</h1>
<p>This page has a shared password lock.</p>
${incorrect ? '<p class="error" role="alert">Incorrect password.</p>' : ""}
${notice ? `<p class="error" role="alert">${escapeHtml(notice)}</p>` : ""}
<form id="mandate-share-unlock" method="post" action="${escapeHtml(pathname)}">
<input type="hidden" name="challenge" value="${escapeHtml(passwordChallenge(entry))}">
<label for="password">Password</label>
<input id="password" disabled type="password" required autocomplete="current-password" autofocus>
<button type="submit" disabled>Open page</button>
</form>
${unlockScript({ salt: entry.salt, iterations: entry.iterations }, nonce)}
</main>
</body>
</html>`;
}

function promptResponse(pathname: string, incorrect: boolean, entry: AccessEntry, headOnly = false, retry?: { status: 429 | 503; message: string }): Response {
  const nonce = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const body = headOnly ? null : promptPage(pathname, incorrect, entry, nonce, retry?.message);
  return new Response(body, {
    status: retry?.status ?? 401,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      "x-frame-options": "DENY",
      ...(retry ? { "retry-after": "60" } : {}),
    },
  });
}

function protectedAssetResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  headers.set("x-robots-tag", "noindex, nofollow");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function readRequestBodyWithin(request: Request, maximumBytes: number, timeoutMs: number): Promise<{ body: string } | { status: 400 | 408 | 413 }> {
  if (!request.body) return { body: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
  try {
    for (;;) {
      const result = await Promise.race([reader.read(), deadline]);
      if (result === "timeout") return { status: 408 };
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) return { status: 413 };
      chunks.push(result.value);
    }
  } catch {
    return { status: 400 };
  } finally {
    clearTimeout(timer!);
    // Do not await a client-controlled cancellation hook after deciding to reject the request.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: new TextDecoder().decode(body) };
}

async function gatedResponse(
  request: Request,
  manifest: AccessManifest,
  fetchAsset: (request: Request) => Promise<Response>,
  context: AccessContext,
  options: GateOptions = {},
): Promise<Response> {
  const url = new URL(request.url);
  const pathname = normalizedRequestPath(url.pathname);
  if (pathname === undefined) {
    return new Response("invalid path", {
      status: 400,
      headers: { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
    });
  }
  const pageSlug = pageSlugForPath(pathname);
  const policy = pageSlug && options.policy && Object.hasOwn(options.policy, pageSlug) ? options.policy[pageSlug] : undefined;
  if (options.policy && pageSlug && !policy) return new Response("page not found", { status: 404, headers: { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
  if (policy?.visibility === "private" && !Object.hasOwn(manifest, pageSlug!)) {
    return new Response(request.method === "HEAD" ? null : "This private page needs a password before it can be shared.", { status: 403, headers: { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
  }
  const slug = slugForPath(pathname, manifest);
  if (!slug) {
    const response = await fetchAsset(request);
    const headers = new Headers(response.headers);
    headers.set("x-robots-tag", robotsForPath(pathname, policy, response.status));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  const entry = manifest[slug];
  const now = options.now ?? Date.now();

  if (request.method === "GET" || request.method === "HEAD") {
    const cookie = cookieFromRequest(request, slug, context);
    if (cookie && (await verifyAccessCookie(cookie, slug, entry, context, now))) {
      return protectedAssetResponse(await fetchAsset(request));
    }
    return promptResponse(url.pathname, false, entry, request.method === "HEAD");
  }

  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD, POST", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    return new Response("expected a password form", { status: 415, headers: { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return new Response("cross-origin form rejected", { status: 403, headers: { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
  if (options.checkPasswordAttempt) {
    try {
      if (!(await options.checkPasswordAttempt(entry))) return promptResponse(url.pathname, false, entry, false, { status: 429, message: "Too many password attempts. Wait a minute, then try again." });
    } catch {
      return promptResponse(url.pathname, false, entry, false, { status: 503, message: "Password checks are temporarily unavailable. Try again in a minute." });
    }
  }
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_PASSWORD_FORM_BYTES)) {
    return new Response("request too large", { status: 413, headers: { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
  }
  const body = await readRequestBodyWithin(request, MAX_PASSWORD_FORM_BYTES, options.bodyTimeoutMs ?? 5_000);
  if ("status" in body) {
    return new Response(body.status === 413 ? "request too large" : "password form could not be read", { status: body.status, headers: { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
  }
  const fields = new URLSearchParams(body.body);
  const proofs = fields.getAll("proof"), challenges = fields.getAll("challenge");
  const proof = proofs.length === 1 ? parsePasswordProof(proofs[0]) : undefined;
  if (!proof || challenges.length !== 1 || challenges[0] !== passwordChallenge(entry) || [...fields.keys()].some(key => key !== "proof" && key !== "challenge")) {
    return new Response("invalid or stale password proof", { status: 400, headers: { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
  }
  if (!(await verifyPasswordProof(proof, entry))) return promptResponse(url.pathname, true, entry);

  const value = await accessCookieValue(slug, entry, context, now);
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return new Response(null, {
    status: 303,
    headers: {
      location: `${url.pathname}${url.search}`,
      "cache-control": "no-store",
      "set-cookie": `${accessCookieName(slug, context)}=${value}; Path=/; Max-Age=${ACCESS_COOKIE_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure}`,
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

export async function gateAccessRequest(
  request: Request,
  manifest: AccessManifest,
  fetchAsset: (request: Request) => Promise<Response>,
  context: AccessContext,
  options: GateOptions = {},
): Promise<Response> {
  const response = await gatedResponse(request, manifest, fetchAsset, context, options);
  const headers = new Headers(response.headers);
  // no-referrer turns native form Origin into null in Chromium, breaking the origin guard.
  headers.set("referrer-policy", "same-origin");
  headers.set("x-content-type-options", "nosniff");
  // Apply only to this publishing hostname; never opt the user's other subdomains in.
  if (new URL(request.url).protocol === "https:") headers.set("strict-transport-security", "max-age=31536000");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
