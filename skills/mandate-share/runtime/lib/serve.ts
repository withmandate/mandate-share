import { constants, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { join, sep } from "node:path";
import { gateAccessRequest, getAccessContext, MAX_PASSWORD_FORM_BYTES, normalizedRequestPath, readAccessManifest } from "./access.ts";
import { VERSION, type StoreContext } from "./context.ts";
import { isHomepageCurrent, readPagePolicies } from "./privacy.ts";
import { slugFormatError } from "./slug.ts";

export const PREVIEW_HEALTH_PATH = "/.well-known/mandate-share";
export const previewRegistryPath = (store: StoreContext): string => join(store.stateDir, "preview.json");
/** Changes across source-cache upgrades even when the semantic package version stays the same. */
export function previewRuntimeId(store: StoreContext): string {
  const hash = createHash("sha256").update(store.runtimeRoot).update("\0");
  for (const file of ["serve.ts", "access-core.ts", "access.ts", "privacy-core.ts", "privacy.ts", "context.ts"]) {
    hash.update(file).update(readFileSync(join(store.runtimeRoot, "lib", file))).update("\0");
  }
  return hash.digest("hex");
}
const NOINDEX = "noindex, nofollow";
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".mdx": "text/markdown; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};
const FALLBACK_404 = "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>Page not found</title><body><h1>Page not found</h1><p>Build the selected store, then open a page from its preview link.</p></body></html>";

export interface ServerOptions {
  store: StoreContext;
}

function ordinaryStateDirectory(store: StoreContext): void {
  mkdirSync(store.stateDir, { recursive: true, mode: 0o700 });
  if (!lstatSync(store.stateDir).isDirectory()) throw new Error("preview state must be an ordinary directory");
}

class RequestBodyError extends Error { constructor(readonly status: number) { super("invalid request body"); } }

/** Bound the body before constructing a Web Request; never buffer an unbounded incoming stream. */
function readRequestBody(request: IncomingMessage): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolveBody, reject) => {
    const declared = request.headers["content-length"];
    if (declared && Number(declared) > MAX_PASSWORD_FORM_BYTES) { request.pause(); reject(new RequestBodyError(413)); return; }
    const chunks: Buffer[] = []; let bytes = 0;
    const timer = setTimeout(() => finish(new RequestBodyError(408)), 5_000);
    const finish = (error?: Error) => {
      clearTimeout(timer); request.off("data", data); request.off("end", end); request.off("error", failed); request.off("aborted", aborted);
      if (error) { request.pause(); reject(error); } else resolveBody(new Uint8Array(Buffer.concat(chunks, bytes)));
    };
    const data = (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_PASSWORD_FORM_BYTES) finish(new RequestBodyError(413)); else chunks.push(chunk); };
    const end = () => finish(); const failed = () => finish(new RequestBodyError(400)); const aborted = () => finish(new RequestBodyError(400));
    request.on("data", data); request.once("end", end); request.once("error", failed); request.once("aborted", aborted);
  });
}

/** Starts only on loopback; port zero lets the OS choose an available port. */
export async function startServer(port: number = 0, options: ServerOptions) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("preview port must be between 0 and 65535");
  const store = options.store;
  const runtimeId = previewRuntimeId(store);
  ordinaryStateDirectory(store);
  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
      return new Response("loopback host required", { status: 403, headers: { "cache-control": "no-store", "x-robots-tag": NOINDEX } });
    }
    if (url.pathname === PREVIEW_HEALTH_PATH) {
      if (req.method !== "GET" && req.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
      return new Response(req.method === "HEAD" ? null : JSON.stringify({ id: store.id, version: VERSION, runtimeId }), {
        headers: { "content-type": "application/json", "cache-control": "no-store", "x-robots-tag": NOINDEX },
      });
    }
    try {
      const manifest = await readAccessManifest(store.root);
      const context = await getAccessContext(store);
      return await gateAccessRequest(req, manifest, (request) => serveAsset(request, store), context, { policy: await readPagePolicies(store) });
    } catch {
      return new Response("preview could not read the selected store; run mandate-share check", {
        status: 503, headers: { "cache-control": "no-store", "x-robots-tag": NOINDEX },
      });
    }
  };
  const http = createServer({ requestTimeout: 10_000, headersTimeout: 10_000 }, async (incoming, outgoing) => {
    const abort = new AbortController();
    incoming.once("aborted", () => abort.abort());
    outgoing.once("close", () => { if (!outgoing.writableFinished) abort.abort(); });
    try {
      const host = incoming.headers.host ?? "";
      if (!/^(?:127\.0\.0\.1|localhost)(?::[0-9]{1,5})?$/.test(host)) {
        outgoing.writeHead(403, { "cache-control": "no-store", "x-robots-tag": NOINDEX, connection: "close" });
        outgoing.end("loopback host required"); return;
      }
      if (!incoming.url?.startsWith("/")) { outgoing.writeHead(400, { "x-robots-tag": NOINDEX }); outgoing.end(); return; }
      const headers = new Headers();
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
      const body = incoming.method === "GET" || incoming.method === "HEAD" ? undefined : await readRequestBody(incoming);
      const request = new Request(`http://${host}${incoming.url.replace(/^\/{2,}/, "/")}`, { method: incoming.method, headers, body, signal: abort.signal });
      const response = await handle(request);
      if (abort.signal.aborted || outgoing.destroyed) { await response.body?.cancel(); return; }
      outgoing.statusCode = response.status;
      response.headers.forEach((value, name) => { if (name !== "set-cookie") outgoing.setHeader(name, value); });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) outgoing.setHeader("set-cookie", cookies);
      // Loopback previews are never search-indexable, even when a published page opts in.
      outgoing.setHeader("x-robots-tag", NOINDEX);
      if (incoming.method === "HEAD" || !response.body) { await response.body?.cancel(); outgoing.end(); return; }
      const reader = response.body.getReader();
      try {
        while (!abort.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!outgoing.write(value)) await new Promise<void>((resolveDrain) => { outgoing.once("drain", resolveDrain); outgoing.once("close", resolveDrain); });
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      outgoing.end();
    } catch (error) {
      if (outgoing.destroyed) return;
      const status = error instanceof RequestBodyError ? error.status : 500;
      if (!outgoing.headersSent) outgoing.writeHead(status, { "cache-control": "no-store", "x-robots-tag": NOINDEX, connection: "close" });
      outgoing.end(status === 413 ? "request body too large" : status === 408 ? "request timed out" : "preview request failed");
    }
  });
  http.setTimeout(10_000);
  await new Promise<void>((resolveListen, reject) => {
    http.once("error", reject);
    http.listen(port, "127.0.0.1", () => { http.off("error", reject); resolveListen(); });
  });
  const address = http.address();
  if (!address || typeof address === "string") { http.close(); throw new Error("preview did not receive a loopback port"); }
  const server = { hostname: "127.0.0.1", port: address.port, stop(force = false): void { http.close(); if (force) http.closeAllConnections(); } };
  const path = previewRegistryPath(store);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ id: store.id, version: VERSION, runtimeId, port: server.port, pid: process.pid })}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    server.stop(true);
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
  // A replacement preview owns the registry once it is listening. Retire this
  // server itself; never infer ownership of another process from a saved PID.
  const retirement = setInterval(() => {
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.size > 2048) return;
      const current = JSON.parse(readFileSync(path, "utf8"));
      if (current.id !== store.id || typeof current.version !== "string" || !/^[a-f0-9]{64}$/.test(current.runtimeId) ||
          !Number.isInteger(current.port) || current.port < 1 || current.port > 65535 || !Number.isInteger(current.pid) || current.pid < 1) return;
      if (current.port !== server.port || current.pid !== process.pid || current.runtimeId !== runtimeId) server.stop(true);
    } catch { /* A missing or damaged registry does not authorize process cleanup. */ }
  }, 1000);
  retirement.unref();
  http.once("close", () => clearInterval(retirement));
  return server;
}

export async function findReviewServer(store: StoreContext): Promise<string | undefined> {
  try {
    const path = previewRegistryPath(store);
    const info = await lstat(path);
    if (!info.isFile() || info.size > 2048) return undefined;
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value.id !== store.id || value.version !== VERSION || value.runtimeId !== previewRuntimeId(store) || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) return undefined;
    const origin = `http://127.0.0.1:${value.port}`;
    const response = await fetch(`${origin}${PREVIEW_HEALTH_PATH}`, { signal: AbortSignal.timeout(500), redirect: "error" });
    if (!response.ok || !response.headers.get("content-type")?.startsWith("application/json")) return undefined;
    const body = await response.text();
    if (body.length > 2048) return undefined;
    const health = JSON.parse(body);
    return health.id === store.id && health.version === VERSION && health.runtimeId === value.runtimeId ? origin : undefined;
  } catch {
    return undefined;
  }
}

const starts = new Map<string, Promise<string>>();
const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function ensurePreview(store: StoreContext): Promise<string> {
  ordinaryStateDirectory(store);
  const lockPath = join(store.stateDir, "preview-start.lock");
  const deadline = Date.now() + 15_000;
  let ownsLock = false;
  while (Date.now() < deadline) {
    const existing = await findReviewServer(store);
    if (existing) return existing;
    try {
      await mkdir(lockPath, { mode: 0o700 });
      ownsLock = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      const info = await lstat(lockPath).catch(() => undefined);
      if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error("invalid preview startup lock");
      if (info && Date.now() - info.mtimeMs > 30_000) await rm(lockPath, { recursive: true });
      else await delay(150);
    }
  }
  if (!ownsLock) throw new Error("another command is starting this store's preview; retry shortly");
  try {
    const existing = await findReviewServer(store);
    if (existing) return existing;
    const child = spawn(process.execPath, ["--import", pathToFileURL(join(store.runtimeRoot, "node_modules/tsx/dist/loader.mjs")).href, join(store.runtimeRoot, "cli.ts"), "serve", "--store-root", store.root, "--port", "0"], {
      detached: true,
      env: { ...process.env, TSX_TSCONFIG_PATH: join(store.runtimeRoot, "tsconfig.json") },
      stdio: "ignore",
    });
    let failed = false;
    child.once("error", () => { failed = true; });
    child.once("exit", () => { failed = true; });
    child.unref();
    for (let attempt = 0; attempt < 50 && !failed; attempt++) {
      await delay(100);
      const origin = await findReviewServer(store);
      if (origin) return origin;
    }
    if (!failed) child.kill("SIGTERM");
    throw new Error("could not start the selected store's preview; run mandate-share serve for its startup error");
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

/** Reuses a preview only after its health endpoint identifies this exact store and runtime version. */
export async function ensureReviewServer(slug: string, store: StoreContext): Promise<string> {
  const formatError = slug ? slugFormatError(slug) : null;
  if (formatError) throw new Error(formatError);
  const key = `${store.id}:${store.root}`;
  let startup = starts.get(key);
  if (!startup) {
    startup = ensurePreview(store);
    starts.set(key, startup);
  }
  try {
    return `${await startup}/${slug}`;
  } finally {
    if (starts.get(key) === startup) starts.delete(key);
  }
}

async function readAsset(root: string, filename: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
  try {
    if (!(await lstat(root)).isDirectory()) return undefined;
    const rootPath = await realpath(root);
    const path = join(root, filename);
    const actual = await realpath(path);
    if (!actual.startsWith(`${rootPath}${sep}`)) return undefined;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile()) return undefined;
      return new Uint8Array(await handle.readFile());
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException)?.code ?? "")) return undefined;
    throw error;
  }
}

type CurrentSource = { bytes?: Uint8Array<ArrayBuffer>; invalid?: true };

async function currentSource(directory: string, filename: string): Promise<CurrentSource> {
  try {
    if (!(await lstat(directory)).isDirectory() || !(await lstat(join(directory, filename))).isFile()) return { invalid: true };
    const bytes = await readAsset(directory, filename);
    return bytes === undefined ? { invalid: true } : { bytes };
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? {} : { invalid: true };
  }
}

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => Buffer.from(left).equals(right);

/** A failed rebuild must not expose output belonging to a removed or replaced source. */
async function boundArtifact(store: StoreContext, filename: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const slug = filename.replace(/\.(?:html|mdx)$/u, "");
  try {
    const before = await lstat(store.outDir);
    if (!before.isDirectory()) return undefined;
    const [mdx, raw] = await Promise.all([
      currentSource(join(store.root, "digests"), `${slug}.mdx`),
      currentSource(join(store.root, "raw"), `${slug}.html`),
    ]);
    if (mdx.invalid || raw.invalid || Number(mdx.bytes !== undefined) + Number(raw.bytes !== undefined) !== 1) return undefined;
    let bytes: Uint8Array<ArrayBuffer> | undefined;
    if (raw.bytes !== undefined) {
      if (!filename.endsWith(".html")) return undefined;
      const html = await readAsset(store.outDir, filename);
      if (html === undefined || !sameBytes(html, raw.bytes)) return undefined;
      bytes = html;
    } else {
      const [html, source] = await Promise.all([
        readAsset(store.outDir, `${slug}.html`),
        readAsset(store.outDir, `${slug}.mdx`),
      ]);
      if (html === undefined || source === undefined || !sameBytes(source, mdx.bytes!)) return undefined;
      bytes = filename.endsWith(".mdx") ? source : html;
    }
    // A build replaces the entire directory. Do not mix companions across that swap.
    const after = await lstat(store.outDir);
    if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) return undefined;
    return bytes;
  } catch {
    return undefined;
  }
}

async function serveAsset(req: Request, store: StoreContext): Promise<Response> {
  const root = store.outDir;
  if (req.method !== "GET" && req.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD", "cache-control": "no-store" } });
  const path = normalizedRequestPath(new URL(req.url).pathname);
  if (path === undefined) return new Response("invalid path", { status: 400, headers: { "cache-control": "no-store" } });
  let filename = path === "/" ? "index.html" : path.slice(1).replace(/\/$/u, "");
  if (/^[a-z0-9][a-z0-9-]*$/u.test(filename)) filename += ".html";
  const valid = /^[a-z0-9][a-z0-9-]*\.(?:html|mdx|css|json|svg|txt)$/u.test(filename);
  const artifact = /\.(?:html|mdx)$/u.test(filename) && !["index.html", "404.html"].includes(filename);
  const homepageCurrent = filename !== "index.html" || await isHomepageCurrent(store);
  const bytes = !valid || !homepageCurrent ? undefined : artifact ? await boundArtifact(store, filename) : await readAsset(root, filename);
  if (bytes === undefined) {
    return new Response(req.method === "HEAD" ? null : (await readAsset(root, "404.html")) ?? FALLBACK_404, {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": NOINDEX, "cache-control": "no-store" },
    });
  }
  return new Response(req.method === "HEAD" ? null : bytes, {
    headers: { "content-type": TYPES[filename.slice(filename.lastIndexOf("."))], "x-robots-tag": NOINDEX, "cache-control": "no-store" },
  });
}
