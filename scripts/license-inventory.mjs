#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packages = new Map();
async function scan(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.name.startsWith('@')) { await scan(path); continue; }
    let value;
    try { value = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')); } catch { continue; }
    const files = await readdir(path);
    packages.set(`${value.name}@${value.version}`, {
      name: value.name, version: value.version,
      license: typeof value.license === 'string' ? value.license : value.license?.type ?? value.licenses?.map(item => typeof item === 'string' ? item : item.type).join(' OR ') ?? 'UNDECLARED',
      notices: files.filter(name => /^(?:licen[sc]e|notice|copying|copyright)(?:[.-]|$)/i.test(name)).sort(),
    });
    await scan(join(path, 'node_modules'));
  }
}
await scan(join(root, 'skills/mandate-share/runtime/node_modules'));
if (!packages.size) throw new Error('Install the locked runtime dependencies before generating their inventory.');
console.log(JSON.stringify({ schema: 1, basis: 'Installed packages restored from runtime/package-lock.json; platform-specific optional packages vary by host.', packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)) }, null, 2));
