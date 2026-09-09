#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertPublicFile } from './check-package.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const within = (parent, path) => path === parent || path.startsWith(parent + sep);
const manifestPath = 'scripts/public-files.json';

function declaredPaths(value) {
  if (!value || value.schema !== 1 || !Array.isArray(value.files) || !value.files.length) throw new Error('Invalid public-file allowlist.');
  const files = value.files;
  if (new Set(files).size !== files.length || files.some(path => typeof path !== 'string' || !path || /[\\\0:]/u.test(path) || path.split('/').some(part => !part || ['.', '..', '.git', 'node_modules', '.mandate-share'].includes(part)))) throw new Error('Invalid or duplicated public-file path.');
  if (!files.includes(manifestPath) || !files.includes('skills/mandate-share/SKILL.md')) throw new Error('The public-file allowlist must include itself and the mandate-share skill.');
  return [...files].sort();
}

async function ordinarySource(root, relative) {
  const parts = relative.split('/');
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (!(await lstat(current)).isDirectory()) throw new Error(`Declared source directory must be ordinary, without symlinks: ${relative}`);
  }
  const path = join(root, relative);
  if (!(await lstat(path)).isFile() || await realpath(path) !== path) throw new Error(`Declared source must be an ordinary file, without symlinks: ${relative}`);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Declared source must be an ordinary file: ${relative}`);
    return { bytes: await handle.readFile(), executable: (info.mode & 0o111) !== 0 };
  } finally { await handle.close(); }
}

/** Stage only approved working files; dependency folders and undeclared local files are never traversed. */
export async function prepareLocalInstall(source = repository, options = {}) {
  const originalSource = await realpath(resolve(source));
  if (!(await lstat(originalSource)).isDirectory()) throw new Error('Choose a Mandate Share checkout directory.');
  const manifest = await ordinarySource(originalSource, manifestPath);
  let parsed;
  try { parsed = JSON.parse(manifest.bytes.toString('utf8')); }
  catch { throw new Error('Invalid public-file allowlist JSON.'); }
  const files = declaredPaths(parsed);
  const allowed = new Set(files);
  const snapshot = new Map();
  const hash = createHash('sha256');
  let bytes = 0;
  for (const path of files) {
    const entry = path === manifestPath ? manifest : await ordinarySource(originalSource, path);
    assertPublicFile(path, entry.bytes, allowed);
    snapshot.set(path, entry);
    hash.update(path).update('\0').update(entry.bytes).update('\0');
    bytes += entry.bytes.byteLength;
  }
  const temporaryDirectory = await realpath(options.temporaryDirectory ?? tmpdir());
  if (!(await lstat(temporaryDirectory)).isDirectory() || within(originalSource, temporaryDirectory)) throw new Error('Choose a temporary directory outside the source checkout.');
  const sourcePath = await realpath(await mkdtemp(join(temporaryDirectory, 'mandate-share-local-install-')));
  try {
    for (const [path, entry] of snapshot) {
      const destination = join(sourcePath, path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, entry.bytes, { flag: 'wx', mode: entry.executable ? 0o700 : 0o600 });
    }
    // A concurrent checkout edit must not produce an installation assembled from mixed versions.
    for (const [path, entry] of snapshot) {
      if (!(await ordinarySource(originalSource, path)).bytes.equals(entry.bytes)) throw new Error('The checkout changed during staging. Retry after its edits finish.');
    }
    return { ok: true, sourcePath, originalSource, files: files.length, bytes, sourceDigest: hash.digest('hex') };
  } catch (error) {
    await rm(sourcePath, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || args.some(value => value.startsWith('--'))) throw new Error('Usage: node scripts/prepare-local-install.mjs [CHECKOUT]');
    console.log(JSON.stringify(await prepareLocalInstall(args[0]), null, 2));
  } catch (error) { console.error(error instanceof Error ? error.message : 'Could not prepare the local skill installation.'); process.exitCode = 1; }
}
