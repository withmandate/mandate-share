#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, 'skills/mandate-share/runtime');
const tests = [];
for (const directory of [join(runtime, 'tests'), join(root, 'tests')]) {
  for (const name of (await readdir(directory)).sort()) if (name.endsWith('.test.ts')) tests.push(join(directory, name));
}
const child = spawn(process.execPath, ['--import', pathToFileURL(join(runtime, 'node_modules/tsx/dist/loader.mjs')).href, '--test', ...process.argv.slice(2), ...tests], {
  cwd: root, stdio: 'inherit', env: { ...process.env, TSX_TSCONFIG_PATH: join(runtime, 'tsconfig.json') },
});
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('close', code => { process.exitCode = code ?? 1; });
