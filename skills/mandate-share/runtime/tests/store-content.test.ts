import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, mkdir, writeFile, symlink, link, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { contextForRoot, assertSourceFiles } from "../lib/store.ts";
import { buildAll } from "../lib/build.ts";
import { importPage, removePage } from "../lib/content.ts";
import { readManifest } from "../lib/raw.ts";
import type { StoreContext } from "../lib/context.ts";

const roots: string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function store():Promise<StoreContext>{
 const root=await realpath(await mkdtemp(join(tmpdir(),"mandate-share-content-")));roots.push(root);
 for(const dir of ["digests","raw","access","components"])await mkdir(join(root,dir));
 await writeFile(join(root,"store.json"),JSON.stringify({schema:1,id:randomUUID()}));
 return contextForRoot(root);
}
const mdx='---\ntitle: "Fixture report"\ndate: "2026-09-08"\ntopic: guide\nsample: true\nunlisted: true\n---\n\n# Example\n\n<Callout>**Only synthetic data.**</Callout>\n';

test("separate stores build the same slug, keep raw bytes, embed MDX and preserve previous output on failure",async()=>{
 const a=await store(),b=await store();
 const raw='<!doctype html>\r\n<html><head><meta charset="utf-8"><title>Example</title></head><body>café → A</body></html>\r\n';
 const input=join(a.root,"input.html");await writeFile(input,raw);
 await importPage(a,input,{slug:"same"});
 await writeFile(join(b.root,"digests/same.mdx"),mdx);
 const first=await buildAll(a),second=await buildAll(b);
 assert.strictEqual((first.pages).length, 1);assert.strictEqual((second.pages).length, 1);
 assert.strictEqual(await readFile(join(a.outDir,"same.html"),"utf8"), raw);
 assert.strictEqual(await readFile(join(b.outDir,"same.mdx"),"utf8"), mdx);
 const output=await readFile(join(b.outDir,"same.html"),"utf8");
 assert.ok((output).includes('type="text/mdx"'));assert.ok((output).includes("Fixture report"));assert.ok(!(output).includes("café"));
 assert.ok(!(await readFile(join(a.outDir,"index.html"),"utf8")).includes('href="/same"'));
 await writeFile(join(b.root,"digests/broken.mdx"),"<MissingWidget />");
 await assert.rejects(buildAll(b));
 assert.strictEqual(await readFile(join(b.outDir,"same.html"),"utf8"), output);
 assert.strictEqual(await readFile(input,"utf8"), raw);
});

test("store extensions resolve runtime React without node_modules, compile examples, and reject collisions",async()=>{
 const s=await store();
 const extension=`import {createElement} from 'react'; export default function LocalNote(){return createElement('aside',null,'Private extension example');} export const meta={name:'LocalNote',description:'A local note',whenToUse:'For a local notice',props:[],example:'<LocalNote />'};`;
 await writeFile(join(s.root,"components/LocalNote.tsx"),extension);
 await writeFile(join(s.root,"digests/example.mdx"),mdx+'\n<LocalNote />\n');
 await buildAll(s);
 assert.ok((await readFile(join(s.outDir,"example.html"),"utf8")).includes("Private extension example"));
 assert.ok((await readFile(join(s.stateDir,"COMPONENTS.md"),"utf8")).includes("LocalNote"));
 assert.strictEqual(await readFile(join(s.root,"components/LocalNote.tsx"),"utf8"), extension);
 await writeFile(join(s.root,"components/Callout.tsx"),extension.replaceAll('LocalNote','Callout'));
 await assert.rejects(buildAll(s), (error) => error instanceof Error && error.message.includes("collision"));
});

test("malformed manifest, source symlinks and source marker escape fail before builds",async()=>{
 const s=await store();
 await writeFile(join(s.root,"raw/manifest.json"),'{"bad":{"title":42}}');
 await assert.rejects(readManifest(s.root), (error) => error instanceof Error && error.message.includes("manifest"));
 await rm(join(s.root,"raw/manifest.json"));
 await symlink(join(s.root,"store.json"),join(s.root,"digests/escape.mdx"));
 await assert.rejects(assertSourceFiles(s.root), (error) => error instanceof Error && error.message.includes("regular files"));
 await rm(join(s.root,"digests/escape.mdx"));
 const marker=await readFile(join(s.root,"store.json"));await writeFile(join(s.root,"other.json"),marker);await rm(join(s.root,"store.json"));await symlink(join(s.root,"other.json"),join(s.root,"store.json"));
 await assert.rejects(contextForRoot(s.root), (error) => error instanceof Error && error.message.includes("symlink"));
});

test("raw update retains listing, removal removes source and access state, failed MDX import adds no source",async()=>{
 const s=await store();const input=join(s.root,"input.html");
 await writeFile(input,'<html><head><meta charset="utf-8"><title>First</title></head><body>first</body></html>');
 await importPage(s,input,{slug:"report",listed:true});
 await writeFile(input,'<html><head><meta charset="utf-8"><title>Second</title></head><body>second</body></html>');
 await importPage(s,input,{slug:"report"});assert.strictEqual((await readManifest(s.root)).report.unlisted, false);assert.strictEqual((await readManifest(s.root)).report.title, "First");
 await removePage(s,"report");assert.strictEqual(existsSync(join(s.root,"raw/report.html")), false);assert.deepStrictEqual(await readManifest(s.root), {});
 const bad=join(s.root,"bad.mdx");await writeFile(bad,"<UnknownThing />");await assert.rejects(importPage(s,bad,{slug:"bad"}));assert.strictEqual(existsSync(join(s.root,"digests/bad.mdx")), false);
});

test("import replaces hardlinked sources without modifying another store",async()=>{
 const a=await store(),b=await store();
 const old='<html><head><meta charset="utf-8"></head><body>original</body></html>';
 const fresh='<html><head><meta charset="utf-8"></head><body>replacement</body></html>';
 await writeFile(join(a.root,"raw/same.html"),old);await link(join(a.root,"raw/same.html"),join(b.root,"raw/same.html"));
 const input=join(a.root,"input.html");await writeFile(input,fresh);await importPage(a,input,{slug:"same"});
 assert.strictEqual(await readFile(join(a.root,"raw/same.html"),"utf8"), fresh);assert.strictEqual(await readFile(join(b.root,"raw/same.html"),"utf8"), old);
});

test("generated catalog and component caches cannot follow links outside the store",async()=>{
 const s=await store();const outside=join(s.root,"outside.txt");await writeFile(outside,"keep");
 await symlink(outside,join(s.stateDir,"COMPONENTS.md"));await assert.rejects(buildAll(s), (error) => error instanceof Error && error.message.includes("regular file"));assert.strictEqual(await readFile(outside,"utf8"), "keep");
 await rm(join(s.stateDir,"COMPONENTS.md"));
 const external=join(s.root,"outside-cache");await mkdir(external);await symlink(external,join(s.stateDir,"components"));
 await writeFile(join(s.root,"components/Extra.tsx"),`export default function Extra(){return <aside>Example</aside>};export const meta={name:'Extra',description:'Example',whenToUse:'Example',props:[],example:'<Extra />'};`);
 await assert.rejects(buildAll(s), (error) => error instanceof Error && error.message.includes("ordinary directory"));assert.deepStrictEqual(await readdir(external), []);
});
