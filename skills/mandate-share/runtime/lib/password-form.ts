import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { StoreContext } from "./context.ts";
import { DEFAULT_PBKDF2_ITERATIONS, MAX_PASSWORD_BYTES, PASSWORD_VERIFIER_DOMAIN, validatePasswordEntry, type AccessEntryV2 } from "./access.ts";
import { capturePasswordOperation, normalizePasswordTarget, savePasswordOperation, type PasswordSaved, type PasswordTarget } from "./passwords.ts";
import { withLock } from "./store.ts";

export interface PasswordFormOptions { store: StoreContext; target: PasswordTarget; protectNewPages?: boolean; lifetimeMs?: number }
export interface PasswordForm { url: string; completed: Promise<PasswordSaved>; close(): void }
export const PASSWORD_FORM_LIFETIME_MS = 5 * 60_000;
const BODY_LIMIT = 1024;
const escape = (value: string): string => value.replace(/[&<>"']/gu, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

function formHtml(options: PasswordFormOptions, salt: string, nonce: string): string {
  const target = options.target.kind === "page" ? `Page: ${options.target.slug}` : options.target.kind === "default" ? "Default password" : `Password profile: ${options.target.name}`;
  const explanation = options.target.kind === "page"
    ? "Save a new shared password for this page. Publish the page afterward to update its live password."
    : options.target.kind === "default" ? "New private pages use this password. Existing page passwords stay as they are." : "Save this password for future page assignments. Existing page passwords stay as they are.";
  const config = JSON.stringify({ salt, iterations: DEFAULT_PBKDF2_ITERATIONS, maximumBytes: MAX_PASSWORD_BYTES, verifierDomain: PASSWORD_VERIFIER_DOMAIN, nonce });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Set a password · Mandate Share</title>
<style nonce="${nonce}">
:root{color-scheme:light dark;--canvas:#f5f5f1;--surface:#fff;--text:#182324;--muted:#47595a;--line:#738587;--accent:#00645b;--button:#fff}*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--text);font:17px/1.6 system-ui,sans-serif}main{max-width:38rem;margin:8vh auto;padding:2rem;border:1px solid var(--line);border-top:5px solid var(--accent);background:var(--surface)}.eyebrow{font-size:.85rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:0}h1{font:600 2.2rem/1.15 Georgia,serif;letter-spacing:-.03em;margin:.8rem 0 1.6rem}.target{padding:.8rem 0;border-block:1px solid var(--line);overflow-wrap:anywhere}.target strong,.target span,label{display:block}.target span{color:var(--muted)}p{margin:1.2rem 0}label{font-weight:600;margin:1.2rem 0 .4rem}input{width:100%;font:inherit;min-height:3rem;padding:.6rem .8rem;color:var(--text);background:var(--surface);border:1px solid var(--line);border-radius:.2rem}button{font:600 1rem/1.4 system-ui,sans-serif;min-height:3rem;padding:.75rem 1.2rem;margin-top:1.6rem;color:var(--button);background:var(--accent);border:2px solid var(--accent);border-radius:.2rem;cursor:pointer}button:disabled{cursor:wait}input:focus-visible,button:focus-visible{outline:3px solid var(--accent);outline-offset:4px}.note{color:var(--muted);font-size:.94rem}#status{min-height:1.6em;font-weight:600}noscript{display:block;margin:1rem 0}@media(prefers-color-scheme:dark){:root{--canvas:#131d1e;--surface:#1c2829;--text:#f3f7f4;--muted:#c2d1cd;--line:#92a6a1;--accent:#83dbc6;--button:#12332b}}@media(max-width:42rem){main{margin:1rem;padding:1.4rem}h1{font-size:2rem}}@media print{form{display:none}main{margin:0;border:none}}
</style></head><body><main><p class="eyebrow">Mandate Share</p><h1>Set a password</h1><div class="target"><strong>${escape(target)}</strong><span>Store: ${escape(options.store.name)}</span></div><p>${escape(explanation)}</p><form id="password-form"><label for="password">New password</label><input id="password" type="password" autocomplete="new-password" required aria-describedby="privacy-note" disabled><label for="confirmation">Confirm password</label><input id="confirmation" type="password" autocomplete="new-password" required disabled><button type="submit" disabled>Save password</button></form><p id="status" role="status" aria-live="polite"></p><p class="note" id="privacy-note">Your password stays out of chat. Only a password verification record is saved. This form expires in five minutes.</p><noscript>Turn on JavaScript to save your password here, or ask your agent for a command that lets you type it in the terminal without displaying it.</noscript></main>
<script nonce="${nonce}">(()=>{
const config=${config},form=document.getElementById('password-form'),password=document.getElementById('password'),confirmation=document.getElementById('confirmation'),status=document.getElementById('status'),button=form.querySelector('button');
if(!window.crypto||!crypto.subtle){status.textContent='This browser cannot save your password. Ask your agent to open this screen in another browser or help you enter it in the terminal.';return;}
password.disabled=confirmation.disabled=button.disabled=false;
form.addEventListener('submit',async(event)=>{
event.preventDefault();status.textContent='';
if(!password.value){status.textContent='Enter a password.';password.focus();return;}
if(password.value!==confirmation.value){status.textContent='The passwords do not match.';confirmation.focus();return;}
const encoded=new TextEncoder().encode(password.value);
if(encoded.byteLength>config.maximumBytes){encoded.fill(0);status.textContent='Choose a shorter password.';return;}
button.disabled=true;status.textContent='Saving locally…';
try{
const salt=Uint8Array.from(atob(config.salt.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const key=await crypto.subtle.importKey('raw',encoded,'PBKDF2',false,['deriveBits']);encoded.fill(0);
const bits=new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations:config.iterations},key,256));
const domain=new TextEncoder().encode(config.verifierDomain),input=new Uint8Array(domain.length+bits.length);input.set(domain);input.set(bits,domain.length);bits.fill(0);
let hashed;try{hashed=new Uint8Array(await crypto.subtle.digest('SHA-256',input));}finally{input.fill(0);}
const verifier=btoa(String.fromCharCode(...hashed)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');hashed.fill(0);
password.value=confirmation.value='';
const response=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json','X-Mandate-Operation':config.nonce},body:JSON.stringify({verifier}),credentials:'omit',cache:'no-store'});
const result=await response.json();if(!response.ok)throw new Error(result.message||'The password could not be saved. Start a new password operation.');
form.hidden=true;status.textContent=result.publicationRequired?'Saved locally. Publish this page to update its live password. You can close this tab.':'Saved locally. You can close this tab.';
}catch(error){encoded.fill(0);password.value=confirmation.value='';status.textContent=error instanceof Error?error.message:'The password could not be saved. Start a new password operation.';button.disabled=false;}
});
})();</script></body></html>`;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new Error("Invalid form submission.");
  const length = request.headers["content-length"];
  if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > BODY_LIMIT)) throw new Error("Invalid form submission.");
  const chunks: Buffer[] = [];
  let size = 0;
  const timer = setTimeout(() => request.destroy(), 5000);
  try {
    for await (const part of request) {
      const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
      size += bytes.byteLength;
      if (size > BODY_LIMIT) throw new Error("Invalid form submission.");
      chunks.push(bytes);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || typeof parsed.verifier !== "string" || Object.keys(parsed)[0] !== "verifier") throw new Error("Invalid form submission.");
    return parsed;
  } catch { throw new Error("Invalid form submission."); }
  finally { clearTimeout(timer); chunks.forEach(chunk => chunk.fill(0)); }
}

/** An operation-specific loopback server; its completed promise never contains a password or verifier. */
export async function startPasswordForm(input: PasswordFormOptions): Promise<PasswordForm> {
  const target = normalizePasswordTarget(input.target);
  const options = { ...input, target };
  if (input.protectNewPages !== undefined && (target.kind !== "default" || typeof input.protectNewPages !== "boolean")) throw new Error("Only the default password controls automatic protection.");
  const lifetime = input.lifetimeMs ?? PASSWORD_FORM_LIFETIME_MS;
  if (!Number.isFinite(lifetime) || lifetime < 1 || lifetime > PASSWORD_FORM_LIFETIME_MS) throw new Error("Invalid password form lifetime.");
  const snapshot = await capturePasswordOperation(input.store, target);
  const token = randomBytes(32).toString("base64url"), nonce = randomBytes(24).toString("base64url"), salt = randomBytes(16).toString("base64url");
  const pathname = `/password/${token}`;
  let origin = "", state: "pending" | "saving" | "done" = "pending";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveCompleted!: (result: PasswordSaved) => void;
  let rejectCompleted!: (error: Error) => void;
  const completed = new Promise<PasswordSaved>((resolve, reject) => { resolveCompleted = resolve; rejectCompleted = reject; });
  // Allow callers to print/open the URL before attaching their awaited completion handler.
  void completed.catch(() => {});
  function reply(response: ServerResponse, status: number, value: object | string, html = false): void {
    response.writeHead(status, {
      "Content-Type": html ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
      "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "Connection": "close",
    });
    response.end(html ? value as string : JSON.stringify(value));
  }
  const server = createServer(async (request, response) => {
    if (request.headers.host !== new URL(origin).host || request.url !== pathname || request.headers["sec-fetch-site"] === "cross-site") { reply(response, 404, { message: "Not found." }); return; }
    if (state !== "pending") { reply(response, 410, { message: "This password form has already been used. Start a new password operation." }); return; }
    if (request.method === "GET") { reply(response, 200, formHtml(options, salt, nonce), true); return; }
    if (request.method !== "POST") { reply(response, 405, { message: "Use this password form to save." }); return; }
    if (request.headers.origin !== origin || request.headers["x-mandate-operation"] !== nonce) { reply(response, 403, { message: "Invalid password operation." }); return; }
    state = "saving";
    if (timer) clearTimeout(timer);
    const finish = (result: PasswordSaved | Error): void => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true; server.close();
        if (result instanceof Error) rejectCompleted(result); else resolveCompleted(result);
      };
      response.once("finish", done); response.once("close", done);
      if (response.destroyed) done();
    };
    try {
      const body = await readBody(request) as { verifier: string };
      const entry: AccessEntryV2 = { version: 2, algorithm: "pbkdf2-sha256-client", iterations: DEFAULT_PBKDF2_ITERATIONS, salt, verifier: body.verifier };
      validatePasswordEntry(entry);
      const result = await withLock(input.store.stateDir, () => savePasswordOperation(input.store, target, entry, snapshot, { protectNewPages: input.protectNewPages }));
      state = "done";
      if (timer) clearTimeout(timer);
      finish(result);
      reply(response, 200, result);
    } catch {
      state = "done";
      if (timer) clearTimeout(timer);
      const message = "The password save did not complete. Its target may have changed or another operation may be running. Start a new password operation.";
      finish(new Error(message));
      reply(response, 409, { message });
    }
  });
  server.requestTimeout = 6000;
  server.headersTimeout = 6000;
  server.maxHeadersCount = 32;
  server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("Could not open the local password form."); }
  origin = `http://127.0.0.1:${address.port}`;
  function close(): void {
    if (timer) clearTimeout(timer);
    if (state !== "done") { state = "done"; rejectCompleted(new Error("Password entry closed or expired. Start a new password operation.")); }
    server.close(); server.closeAllConnections();
  }
  timer = setTimeout(close, lifetime);
  return { url: `${origin}${pathname}`, completed, close };
}
