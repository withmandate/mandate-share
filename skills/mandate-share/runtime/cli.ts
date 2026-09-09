#!/usr/bin/env node
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { addStore, assertSourceFiles, listStores, resolveStore, useStore, withLock } from "./lib/store.ts";
import { VERSION, type StoreContext } from "./lib/context.ts";
import { buildAll, checkMdx } from "./lib/build.ts";
import { assertSlug, importPage, pageSlugs, removePage } from "./lib/content.ts";
import { readAccessManifest } from "./lib/access.ts";
import { createPasswordEntry } from "./lib/access-core.ts";
import { readPagePolicies, setPageSharing } from "./lib/privacy.ts";
import { readPasswordSettings, setPasswordProfile, assignPageProfile, setPagePasswordEntry, rotateProfilePages, resolvePasswordTarget, normalizeProfileName } from "./lib/passwords.ts";
import { startPasswordForm } from "./lib/password-form.ts";
import { ensureReviewServer, startServer } from "./lib/serve.ts";
import { readSecret } from "./lib/secret-input.ts";
import { prepareRelease, publishRelease, setupPublisher } from "./lib/publisher.ts";
import { inspectOnboarding, loginOnboarding, applyOnboarding, inspectAdoption, applyAdoption } from "./lib/onboarding.ts";
import { validatePublisherConfig } from "./lib/cloudflare.ts";

const HELP = `Mandate Share ${VERSION}

Ask your agent to create, protect and publish a page. New pages are private.

setup [--path FOLDER] [--login] [--account-id ID] [--confirm DIGEST]
setup --adopt --account-id ID --worker NAME (--domain HOST | --workers-dev)
setup --adopt --confirm DIGEST
password --default | password PAGE_OR_URL | password --profile NAME
password PAGE --use-profile NAME | password --list
password --rotate-profile NAME PAGE [PAGE ...]
Add --terminal for hidden input, or --stdin for an agent's protected input.
sharing PAGE (--private | --unlisted | --public) [--indexable | --no-index]
preview [PAGE] | status | list | build | check FILE
import FILE [--slug NAME] [--title TITLE] | remove PAGE
plan | publish --confirm DIGEST
store add NAME --path FOLDER [--default] | store list | store use NAME

Select a named store with --store NAME. setup resumes Cloudflare configuration.
Password forms are local. Saving changes does not update an already live page.
Private pages need a password before publication. Public listing and search are opt-in.
Publishing uploads the reviewed store inventory; plan uploads nothing.`;

type Flags = Record<string, string | true>;
function parse(argv: string[]) {
  const flags: Flags = {}, words: string[] = [];
  const values = new Set(["store", "store-root", "path", "slug", "title", "summary", "port", "account-id", "worker", "subdomain", "domain", "confirm", "profile", "use-profile", "rotate-profile"]);
  const booleans = new Set(["default", "listed", "unlisted", "public", "private", "indexable", "no-index", "password", "password-stdin", "no-password", "default-password", "stdin", "terminal", "workers-dev", "login", "list", "adopt"]);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) { words.push(token); continue; }
    const key = token.slice(2);
    if (Object.hasOwn(flags, key)) throw new Error("An option was repeated.");
    if (values.has(key)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("A required option value is missing.");
      flags[key] = value;
    } else if (booleans.has(key)) flags[key] = true;
    else throw new Error("Unknown option. Run help. Password values cannot be supplied as command arguments.");
  }
  return { flags, words };
}
const string = (flags: Flags, key: string): string | undefined => typeof flags[key] === "string" ? flags[key] : undefined;
function requireString(flags: Flags, key: string): string { const value = string(flags, key); if (!value) throw new Error(`--${key} is required.`); return value; }
function emit(command: string, data: unknown) { console.log(JSON.stringify({ ok: true, command, data }, null, 2)); }
function openBrowser(url: string) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
  child.on("error", () => {}); child.unref();
}
async function setupStore(flags: Flags): Promise<StoreContext | undefined> {
  const path = string(flags, "path");
  if (!path) {
    const stores = await listStores();
    if (!stores.length && !flags.store && !flags["store-root"]) return undefined;
    return resolveStore(string(flags, "store"), string(flags, "store-root"));
  }
  if (flags["store-root"]) throw new Error("Choose --path or --store-root, not both.");
  const name = string(flags, "store") ?? "personal";
  const previous = (await listStores()).find(store => store.name === name);
  if (previous) {
    if (previous.root !== await realpath(resolve(path))) throw new Error("That store already uses another folder. Choose a different store name.");
    return previous;
  }
  if (flags.confirm) throw new Error("Confirmation requires an existing selected store. Select the store that prepared this review.");
  return addStore(name, resolve(path));
}
async function passwordCommand(initialStore: StoreContext, flags: Flags, words: string[]) {
  const defaultTarget = flags.default === true, profile = string(flags, "profile") === undefined ? undefined : normalizeProfileName(requireString(flags, "profile")), useProfile = string(flags, "use-profile"), rotate = string(flags, "rotate-profile");
  if (flags.terminal && flags.stdin) throw new Error("Choose browser entry (no input flag), --terminal, or --stdin.");
  if ([defaultTarget, !!profile, !!useProfile, !!rotate, flags.list === true].filter(Boolean).length > 1) throw new Error("Choose one password action.");
  if (flags.list) {
    if (words.length || flags.stdin || flags.terminal) throw new Error("password --list takes no page or input options.");
    const settings = await readPasswordSettings(initialStore);
    return { store: initialStore.name, profiles: Object.keys(settings.profiles).sort(), protectNewPages: settings.protectNewPages };
  }
  if (rotate) {
    if (!words.length || flags.stdin || flags.terminal) throw new Error("Name the existing pages to update from the saved profile.");
    const pages = [...new Set(words)]; pages.forEach(assertSlug);
    const result = await withLock(initialStore.stateDir, async () => { await rotateProfilePages(initialStore, rotate, pages); await buildAll(initialStore); return { profile: rotate, pages }; });
    return { ...result, liveChangesRequirePublication: true };
  }
  if (words.length > (defaultTarget || profile ? 0 : 1) || (!defaultTarget && !profile && words.length !== 1)) throw new Error("Use password --default, password --profile NAME, or password PAGE_OR_URL.");
  let store = initialStore, slug: string | undefined;
  if (words.length) {
    if (/^https?:\/\//i.test(words[0]!)) {
      const resolved = await resolvePasswordTarget(words[0]!, await listStores());
      if ((flags.store || flags["store-root"]) && resolved.store.id !== store.id) throw new Error("Page URL belongs to another selected store.");
      store = resolved.store; slug = resolved.slug;
    } else { slug = words[0]!; assertSlug(slug); }
    if (!(await pageSlugs(store)).includes(slug!)) throw new Error("No page at that slug.");
  }
  if (useProfile) {
    if (!slug || flags.stdin || flags.terminal) throw new Error("Use a saved profile with one page and no input options.");
    await withLock(store.stateDir, async () => { await assignPageProfile(store, slug!, useProfile); await buildAll(store); });
    return { store: store.name, slug, profile: useProfile, saved: true, liveChangesRequirePublication: true };
  }
  const target = defaultTarget || profile === "default" ? { kind: "default" as const } : profile ? { kind: "profile" as const, name: profile } : { kind: "page" as const, slug: slug! };
  if (flags.stdin || flags.terminal) {
    const entry = await createPasswordEntry(await readSecret(flags.stdin === true));
    await withLock(store.stateDir, async () => {
      if (slug) await setPagePasswordEntry(store, slug, entry);
      else await setPasswordProfile(store, profile ?? "default", entry, defaultTarget || profile === "default" ? { protectNewPages: true } : {});
      await buildAll(store);
    });
    return { store: store.name, target, saved: true, liveChangesRequirePublication: !!slug };
  }
  const form = await startPasswordForm({ store, target, ...(defaultTarget || profile === "default" ? { protectNewPages: true } : {}) });
  emit("password entry", { store: store.name, target, url: form.url, next: "Type and confirm your password in the browser, then choose Save password. The agent should leave the password fields, clipboard and request body unread." });
  openBrowser(form.url);
  const stop = () => { form.close(); process.exitCode = 130; };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try { const result = await form.completed; await withLock(store.stateDir, () => buildAll(store)); return result; }
  finally { form.close(); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || ["help", "--help", "-h"].includes(argv[0]!)) { console.log(HELP); return; }
  if (["version", "--version"].includes(argv[0]!)) { console.log(VERSION); return; }
  const { flags, words } = parse(argv), command = words.shift();
  const allowed: Record<string, string[]> = {
    store: ["path", "default"], status: [], list: [], build: [], check: [], import: ["slug", "listed", "unlisted", "title", "summary"], remove: [],
    sharing: ["private", "unlisted", "public", "indexable", "no-index"], password: ["default", "profile", "use-profile", "rotate-profile", "list", "terminal", "stdin"],
    protect: ["password", "password-stdin", "default-password", "no-password"], "default-password": ["stdin"],
    preview: [], serve: ["port"], setup: ["path", "account-id", "worker", "subdomain", "workers-dev", "domain", "login", "confirm", "adopt"], plan: [], publish: ["confirm"],
  };
  if (!command || !Object.hasOwn(allowed, command) || Object.keys(flags).some(key => !["store", "store-root", ...allowed[command]!].includes(key))) throw new Error("An option does not apply to this command. Run help.");
  if (command === "store") {
    const action = words.shift();
    if (Object.keys(flags).some(key => !(action === "add" ? ["path", "default"] : []).includes(key))) throw new Error("An option does not apply to this store command.");
    if (action === "list" && !words.length) { emit("store list", await listStores()); return; }
    if (action === "use" && words.length === 1) { await useStore(words[0]!); emit("store use", { name: words[0] }); return; }
    if (action === "add" && words.length === 1) { emit("store add", await addStore(words[0]!, resolve(requireString(flags, "path")), flags.default === true)); return; }
    throw new Error("Use store add NAME --path PATH, store list, or store use NAME.");
  }
  const counts: Record<string, [number, number]> = { status: [0, 0], list: [0, 0], build: [0, 0], check: [1, 1], import: [1, 1], remove: [1, 1], sharing: [1, 1], password: [0, Infinity], protect: [1, 1], "default-password": [0, 0], preview: [0, 1], serve: [0, 0], setup: [0, 0], plan: [0, 0], publish: [0, 0] };
  const count = counts[command];
  if (!count || words.length < count[0] || words.length > count[1]) throw new Error("Invalid command arguments. Run help; password values belong in private input.");
  if (command === "setup" && flags.confirm && !/^[a-f0-9]{64}$/u.test(requireString(flags, "confirm"))) throw new Error("Confirmation must be the exact digest from the saved review.");
  if (command === "setup") {
    let localConfig;
    if (flags.confirm && (flags.login || flags.worker || flags.subdomain || flags["account-id"] || flags.domain || flags["workers-dev"])) throw new Error("Apply a setup digest without changing its proposed target.");
    if (flags.adopt && (flags.login || flags.subdomain || (!flags.confirm && !flags["workers-dev"] && !flags.domain))) throw new Error("Adoption needs an explicit account, Worker and domain or workers.dev destination, or a saved confirmation digest.");
    if (flags["workers-dev"] || flags.domain) {
      if (flags.login || flags.subdomain || (flags.domain && flags["workers-dev"])) throw new Error("Choose guided setup or one explicit local destination.");
      requireString(flags, "account-id"); requireString(flags, "worker");
      localConfig = validatePublisherConfig({ accountId: requireString(flags, "account-id"), worker: requireString(flags, "worker"), ...(flags["workers-dev"] ? { workersDev: true } : {}), ...(flags.domain ? { hostname: string(flags, "domain") } : {}) });
    }
    const store = await setupStore(flags);
    if (!store && flags.confirm) throw new Error("Confirmation requires an existing selected store. Select the store that prepared this review.");
    if (!store) { emit("setup", { status: "choose-folder", suggestedPath: join(homedir(), "Documents", "share-pages"), next: "Agree on a dedicated pages folder, then run setup --path FOLDER. Pages start private." }); return; }
    const options = {};
    if (flags.adopt) {
      const result = await withLock(store.stateDir, () => flags.confirm ? applyAdoption(store, requireString(flags, "confirm"), options) : inspectAdoption(store, localConfig!, options));
      emit("setup", { ...result, store: { name: store.name, path: store.root } }); return;
    }
    // An explicit destination can be configured locally without a provider mutation.
    if (flags["workers-dev"] || flags.domain) {
      if (flags.login || flags.subdomain) throw new Error("Use guided setup or explicit local destination settings.");
      const config = await withLock(store.stateDir, () => setupPublisher(store, localConfig!));
      emit("setup", { status: "configured-locally", config, liveVerified: false }); return;
    }
    if (flags.login) await loginOnboarding(store, options);
    const result = flags.confirm ? await applyOnboarding(store, requireString(flags, "confirm"), options) : await inspectOnboarding(store, { accountId: string(flags, "account-id"), worker: string(flags, "worker"), subdomain: string(flags, "subdomain") }, options);
    emit("setup", { ...result, store: { name: store.name, path: store.root } }); return;
  }
  let store: StoreContext;
  if (command === "password" && words.length === 1 && /^https?:\/\//i.test(words[0]!) && !flags.store && !flags["store-root"]) store = (await resolvePasswordTarget(words[0]!, await listStores())).store;
  else store = await resolveStore(string(flags, "store"), string(flags, "store-root"));
  await assertSourceFiles(store.root);
  if (command === "password") { emit(command, await passwordCommand(store, flags, words)); return; }
  if (command === "default-password") { if (!flags.stdin) throw new Error("Use password --default to enter it in your browser, or add --stdin to supply protected input."); emit(command, await passwordCommand(store, { default: true, stdin: true }, [])); return; }
  if (command === "serve") {
    const port = Number(string(flags, "port") ?? 0);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Port must be 0-65535.");
    if (!existsSync(join(store.outDir, "index.html"))) await withLock(store.stateDir, () => buildAll(store));
    await startServer(port, { store }); return;
  }
  const result = await withLock(store.stateDir, async () => {
    switch (command) {
      case "status": { const settings = await readPasswordSettings(store); return { version: VERSION, store, slugs: await pageSlugs(store), profiles: Object.keys(settings.profiles).sort(), protectNewPages: settings.protectNewPages, publisherConfigured: existsSync(join(store.stateDir, "publisher.json")) }; }
      case "list": return (await buildAll(store)).pages;
      case "check": await checkMdx(resolve(words[0]!), store); return { valid: true };
      case "build": return buildAll(store);
      case "import": { const page = await importPage(store, words[0]!, { slug: string(flags, "slug"), listed: flags.listed === true, unlisted: flags.unlisted === true, title: string(flags, "title"), summary: string(flags, "summary") }); await buildAll(store); return { ...page, reviewUrl: await ensureReviewServer(page.slug, store), sharing: (await readPagePolicies(store))[page.slug] }; }
      case "remove": await removePage(store, words[0]!); await buildAll(store); return { removed: words[0], liveRemovalRequiresPublication: true };
      case "sharing": {
        const choices = ["private", "unlisted", "public"].filter(key => flags[key] === true);
        if (choices.length !== 1 || (flags.indexable && flags["no-index"])) throw new Error("Choose one sharing state and at most one search preference.");
        const visibility = choices[0] as "private" | "unlisted" | "public";
        await setPageSharing(store, words[0]!, { visibility, ...(flags.indexable ? { indexable: true } : flags["no-index"] ? { indexable: false } : {}) });
        await buildAll(store); return { slug: words[0], sharing: (await readPagePolicies(store))[words[0]!], liveChangesRequirePublication: true };
      }
      case "protect": {
        const slug = words[0]!; assertSlug(slug);
        if (!(await pageSlugs(store)).includes(slug)) throw new Error("No page at that slug.");
        if (["password", "password-stdin", "no-password", "default-password"].filter(key => flags[key] === true).length !== 1) throw new Error("Choose one password action.");
        if (flags["no-password"]) await setPageSharing(store, slug, { visibility: "unlisted" });
        else if (flags["default-password"]) await assignPageProfile(store, slug, "default");
        else await setPagePasswordEntry(store, slug, await createPasswordEntry(await readSecret(flags["password-stdin"] === true)));
        await buildAll(store); return { slug, protected: Object.hasOwn(await readAccessManifest(store.root), slug), reviewUrl: await ensureReviewServer(slug, store), liveChangesRequirePublication: true };
      }
      case "preview": { const slug = words[0] ?? ""; if (slug) { assertSlug(slug); if (!(await pageSlugs(store)).includes(slug)) throw new Error("No page at that slug."); } await buildAll(store); return { reviewUrl: await ensureReviewServer(slug, store) }; }
      case "plan": return prepareRelease(store);
      case "publish": return publishRelease(store, requireString(flags, "confirm"));
      default: throw new Error("Unknown command.");
    }
  });
  emit(command, result);
}
main().catch(error => { console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Operation failed." })); process.exitCode = 1; });
