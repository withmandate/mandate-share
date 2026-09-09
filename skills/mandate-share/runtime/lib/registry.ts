import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ComponentType } from "react";
import type { ComponentMeta, RegistryEntry } from "./types.ts";
import type { StoreContext } from "./context.ts";

const builtinDir = join(dirname(fileURLToPath(import.meta.url)), "..", "components");

async function bindReactImports(code: string): Promise<string> {
  // The bundler retains external import specifiers. Rewrite only parsed module
  // specifiers, never matching arbitrary strings in a user's component.
  const ts = await import("typescript");
  const source = ts.createSourceFile("component.mjs", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  function visit(node: import("typescript").Node): void {
    let specifier: import("typescript").Node | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) specifier = node.arguments[0];
    if (specifier && ts.isStringLiteral(specifier) && /^react(?:\/.*)?$/.test(specifier.text)) {
      replacements.push({ start: specifier.getStart(source), end: specifier.end, value: JSON.stringify(import.meta.resolve(specifier.text)) });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const replacement of replacements.sort((a,b) => b.start-a.start)) code = code.slice(0,replacement.start)+replacement.value+code.slice(replacement.end);
  return code;
}
export async function loadRegistry(store?: StoreContext): Promise<{
  components: Record<string, ComponentType<Record<string, unknown>>>;
  entries: RegistryEntry[];
}> {
  const components: Record<string, ComponentType<Record<string, unknown>>> = {};
  const entries: RegistryEntry[] = [];
  const sources = [{ directory: builtinDir, custom: false }];
  if (store && existsSync(join(store.root, "components"))) sources.push({ directory: join(store.root, "components"), custom: true });
  for (const { directory, custom } of sources) {
    const files = (await readdir(directory, { withFileTypes: true })).filter(f => f.name.endsWith(".tsx") && !f.name.startsWith("_")).sort((a,b) => a.name.localeCompare(b.name));
    for (const item of files) {
      if (!item.isFile()) throw new Error(`Component '${item.name}' must be a regular file.`);
      const file = join(directory, item.name);
      let modulePath = file;
      if (custom) {
        // Resolve shared React from the runtime; user components need no node_modules.
        const { build } = await import("esbuild");
        const result = await build({
          entryPoints: [file], platform: "node", target: "node22", format: "esm", bundle: true, write: false, sourcemap: false, jsx: "automatic", logLevel: "silent",
          plugins: [{ name: "runtime-react", setup(build) {
            build.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: import.meta.resolve(args.path), external: true }));
          } }],
        });
        const code = await bindReactImports(result.outputFiles![0]!.text);
        const hash = createHash("sha256").update(code).digest("hex");
        const cache = join(store!.stateDir, "components");
        await mkdir(cache, { recursive: true, mode: 0o700 });
        if (!(await lstat(cache)).isDirectory() || await realpath(cache) !== cache) throw new Error("Component cache must be an ordinary directory inside the store.");
        modulePath = join(cache, `${hash}.mjs`);
        try { if (!(await lstat(modulePath)).isFile()) throw new Error("Cached component must be an ordinary file."); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const temporary = `${modulePath}.${crypto.randomUUID()}.tmp`;
        await writeFile(temporary, code, { mode: 0o600, flag: "wx" });
        await rename(temporary, modulePath);
      }
      const mod = await import(pathToFileURL(modulePath).href);
      const meta = mod.meta as ComponentMeta | undefined;
      if (typeof mod.default !== "function") throw new Error(`components/${item.name}: missing default component export`);
      if (!meta || meta.name !== basename(item.name, ".tsx")) throw new Error(`components/${item.name}: meta.name must match the filename`);
      for (const key of ["description", "whenToUse", "example"] as const) {
        if (typeof meta[key] !== "string" || !meta[key]) throw new Error(`components/${item.name}: meta.${key} is required`);
      }
      if (!Array.isArray(meta.props)) throw new Error(`components/${item.name}: meta.props must be an array`);
      if (Object.hasOwn(components, meta.name)) throw new Error(`Component name collision: ${meta.name}. Choose a name distinct from built-in components.`);
      components[meta.name] = mod.default;
      entries.push({ meta, component: mod.default, file: `${custom ? "store" : "runtime"}/components/${item.name}` });
    }
  }
  return { components, entries };
}
