import { unlockBody } from "./unlock-helpers.ts";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile, symlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");const scratch:string[]=[];
afterEach(async()=>{for(const dir of scratch.splice(0)){for(const name of ["one","two"]){try{const p=JSON.parse(await readFile(join(dir,name,".mandate-share/preview.json"),"utf8"));if(p.pid)process.kill(p.pid,"SIGTERM");}catch{}}await rm(dir,{recursive:true,force:true});}});
async function fixture(){const base=await realpath(await mkdtemp(join(tmpdir(),"mandate-share-cli-")));scratch.push(base);await mkdir(join(base,"unrelated"));return{base,env:{...process.env,TSX_TSCONFIG_PATH:join(root,"tsconfig.json"),MANDATE_SHARE_HOME:join(base,"config"),MANDATE_SHARE_CACHE:join(base,"cache")}};}
async function run(f: Awaited<ReturnType<typeof fixture>>, args: string[], input?: string) {
 const child = spawn(process.execPath, ["--import", pathToFileURL(join(root, "node_modules/tsx/dist/loader.mjs")).href, join(root, "cli.ts"), ...args], { env: f.env, cwd: join(f.base, "unrelated"), stdio: ["pipe", "pipe", "pipe"] });
 let stdout = "", stderr = "";
 child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
 child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
 child.stdin.end(input);
 const code = await new Promise<number | null>((resolveRun, reject) => { child.once("error", reject); child.once("close", resolveRun); });
 return { stdout, stderr, code, json: stdout.trim().startsWith("{") ? JSON.parse(stdout) : null };
}

test("real CLI creates separate stores, shares same slug, protects source variants, rejects another cookie and updates",async()=>{
 const f=await fixture();
 for(const name of ["one","two"]){const result=await run(f,["store","add",name,"--path",join(f.base,name)]);assert.strictEqual(result.code, 0);}
 const source=join(f.base,"sample.mdx");await writeFile(source,'---\ntitle: "Synthetic CLI sample"\nunlisted: true\nsample: true\n---\n\n<Callout>sample body</Callout>\n');
 const urls:string[]=[];
 for(const name of ["one","two"]){const imported=await run(f,["import",source,"--slug","same","--store",name]);assert.strictEqual(imported.code, 0);urls.push(imported.json.data.reviewUrl);const protectedPage=await run(f,["protect","same","--password-stdin","--store",name],"fixture password\n");assert.strictEqual(protectedPage.code, 0);assert.ok(!(protectedPage.stdout+protectedPage.stderr).includes("fixture password"));}
 assert.notStrictEqual(urls[0], urls[1]);
 const locked=await fetch(urls[0]!);assert.strictEqual(locked.status, 401);assert.ok(!(await locked.text()).includes("sample body"));
 const denied=await fetch(urls[0]+".mdx");assert.strictEqual(denied.status, 401);
 const wrong=await fetch(urls[0]!,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:await unlockBody(await (await fetch(urls[0]!)).text(),"wrong"),redirect:"manual"});assert.strictEqual(wrong.status, 401);
 const accepted=await fetch(urls[0]!,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:await unlockBody(await (await fetch(urls[0]!)).text(),"fixture password"),redirect:"manual"});assert.strictEqual(accepted.status, 303);
 const cookie=accepted.headers.get("set-cookie")!.split(";")[0]!;
 assert.strictEqual((await fetch(urls[0]+".mdx",{headers:{cookie}})).status, 200);assert.strictEqual((await fetch(urls[1]!,{headers:{cookie}})).status, 401);
 assert.strictEqual((await run(f,["protect","same","--password-stdin","--store","one"],"new fixture password\n")).code, 0);
 assert.strictEqual((await fetch(urls[0]!,{headers:{cookie}})).status, 401);
 const unprotected=await run(f,["protect","same","--no-password","--store","one"]);assert.strictEqual(unprotected.code, 0);assert.strictEqual((await fetch(urls[0]!)).status, 200);
 assert.strictEqual((await run(f,["remove","same","--store","one"])).code, 0);assert.strictEqual((await fetch(urls[0]!)).status, 404);assert.strictEqual((await fetch(urls[1]!)).status, 401);
 assert.deepStrictEqual(await readdir(join(f.base,"unrelated")), []);
});

test("CLI rejects overlapping roots, duplicate target binding, password argv and irrelevant flags",async()=>{
 const f=await fixture();for(const name of ["one","two"])assert.strictEqual((await run(f,["store","add",name,"--path",join(f.base,name)])).code, 0);
 assert.strictEqual((await run(f,["store","add","nested","--path",join(f.base,"one/child")])).code, 1);
 assert.strictEqual((await run(f,["store","add","unsafe","--path",f.env.MANDATE_SHARE_HOME])).code, 1);
 const target=["--account-id","c".repeat(32),"--worker","example-share","--workers-dev"];
 assert.strictEqual((await run(f,["setup",...target,"--store","one"])).code, 0);
 assert.strictEqual((await run(f,["setup",...target,"--store","two"])).code, 1);
 const result=await run(f,["protect","missing","--password","never print this password"]);assert.strictEqual(result.code, 1);assert.ok(!(result.stdout+result.stderr).includes("never print this password"));
 assert.strictEqual((await run(f,["build","--listed"])).code, 1);
});

test("explicit roots obey registry isolation and unsafe defaults/ignore files fail without external writes",async()=>{
 const f=await fixture();assert.strictEqual((await run(f,["store","add","one","--path",join(f.base,"one")])).code, 0);
 const nested=join(f.base,"one/nested");await mkdir(nested);await writeFile(join(nested,"store.json"),JSON.stringify({schema:1,id:randomUUID()}));
 assert.strictEqual((await run(f,["status","--store-root",nested])).code, 1);
 const long=await run(f,["default-password","--stdin","--store","one"],'x'.repeat(1500));assert.strictEqual(long.code, 1);assert.strictEqual(existsSync(join(f.base,"one/.mandate-share/default-password")), false);
 const outside=join(f.base,"outside-ignore");await writeFile(outside,"keep");const next=join(f.base,"two");await mkdir(next);await symlink(outside,join(next,".gitignore"));
 assert.strictEqual((await run(f,["store","add","two","--path",next])).code, 1);assert.strictEqual(await readFile(outside,"utf8"), "keep");assert.strictEqual(existsSync(join(next,"store.json")), false);
});

test("concurrent real CLI setup cannot bind two stores to the same destination",async()=>{
 const f=await fixture();for(const name of ["one","two"])assert.strictEqual((await run(f,["store","add",name,"--path",join(f.base,name)])).code, 0);
 const target=["--account-id","d".repeat(32),"--worker","same-destination","--workers-dev"];
 const results=await Promise.all([run(f,["setup",...target,"--store","one"]),run(f,["setup",...target,"--store","two"])]);
 assert.strictEqual((results.filter(r=>r.code===0)).length, 1);assert.strictEqual((results.filter(r=>r.code!==0)).length, 1);
});

test("malformed adoption options cannot create a store or touch the provider", async () => {
 const digest = "a".repeat(64);
 const target = ["--account-id", "b".repeat(32), "--worker", "existing-site", "--domain", "share.example.com"];
 const cases = [
  ["--adopt"], ["--adopt", "--account-id", "b".repeat(32)], ["--adopt", "--login"], ["--adopt", "--subdomain", "account-label"],
  ["--adopt", "--confirm", "invalid-digest"], ["--adopt", "--confirm", digest],
  ["--adopt", "--confirm", digest, ...target], ["--adopt", ...target, "--workers-dev"],
  ["--adopt", ...target, "--adopt"], ["--adopt", "--domain"],
 ];
 for (const flags of cases) {
  const f = await fixture(), store = join(f.base, "one");
  const result = await run(f, ["setup", "--path", store, ...flags]);
  assert.equal(result.code, 1, `${flags.join(" ")}: ${result.stdout}`);
  assert.equal(existsSync(store), false, `${flags.join(" ")} created a store`);
  assert.equal(existsSync(f.env.MANDATE_SHARE_HOME), false, `${flags.join(" ")} changed the registry`);
  assert.deepEqual(await readdir(join(f.base, "unrelated")), []);
 }
 const f = await fixture();
 const missingStore = await run(f, ["setup", "--adopt", "--confirm", digest]);
 assert.equal(missingStore.code, 1);
 assert.match(missingStore.stderr, /existing.*store/i);
});

test("adoption honors the selected store operation lock before provider work", async () => {
 const f = await fixture(), store = join(f.base, "one");
 assert.equal((await run(f, ["store", "add", "one", "--path", store])).code, 0);
 const state = join(store, ".mandate-share"), lock = join(state, "operation.lock");
 await mkdir(lock); await writeFile(join(lock, "owner.json"), "synthetic lock owner\n");
 const registry = await readFile(join(f.env.MANDATE_SHARE_HOME, "config.json"));
 const target = ["--account-id", "b".repeat(32), "--worker", "existing-site", "--domain", "share.example.com"];
 for (const args of [["setup", "--adopt", ...target], ["setup", "--adopt", "--confirm", "a".repeat(64)]]) {
  const result = await run(f, [...args, "--store", "one"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Another operation holds/);
  assert.equal(await readFile(join(lock, "owner.json"), "utf8"), "synthetic lock owner\n");
  for (const path of ["provider-onboarding", "onboarding.json", "publisher.json"]) assert.equal(existsSync(join(state, path)), false);
 }
 assert.deepEqual(await readFile(join(f.env.MANDATE_SHARE_HOME, "config.json")), registry);
 assert.deepEqual(await readdir(join(store, "digests")), []);
});
