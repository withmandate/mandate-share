#!/usr/bin/env node
import { npmCommand } from './npm-command.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const installedSkill = resolve(dirname(scriptPath), '..');
const RUNTIME_TOP = new Set(['package.json', 'package-lock.json', 'cli.ts', 'tsconfig.json']);
const SOURCE_TYPES = { lib: /\.(?:ts|tsx)$/, components: /\.tsx$/, styles: /\.css$/ };
const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const inside = (parent, child) => child === parent || child.startsWith(parent + sep);
const absent = error => error?.code === 'ENOENT';

async function physicalPath(input) {
  let current = resolve(input);
  const tail = [];
  for (;;) {
    try { return join(await realpath(current), ...tail); }
    catch (error) {
      if (!absent(error)) throw error;
      if (current === dirname(current)) throw new Error('Cannot resolve runtime cache path.');
      tail.unshift(basename(current));
      current = dirname(current);
    }
  }
}

/** Copy only program source; tests, dependencies, user content, and dotfiles are excluded. */
export async function runtimeSources(root) {
  const files = [];
  for (const name of [...RUNTIME_TOP].sort()) {
    const info = await lstat(join(root, name));
    if (!info.isFile()) throw new Error(`Installed runtime needs an ordinary ${name}; reinstall the skill.`);
    files.push(name);
  }
  for (const [folder, extension] of Object.entries(SOURCE_TYPES)) {
    const directory = join(root, folder);
    if (!(await lstat(directory)).isDirectory()) throw new Error(`Installed runtime needs ${folder}/; reinstall the skill.`);
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (!item.isFile() || !extension.test(item.name) || item.name.startsWith('.')) {
        throw new Error(`Unexpected runtime source in ${folder}/; reinstall the skill.`);
      }
      files.push(`${folder}/${item.name}`);
    }
  }
  return files.sort();
}

async function sourceDigest(root, files) {
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update('\0').update(await readFile(join(root, file))).update('\0');
  return hash.digest('hex');
}


async function validateCacheRoot(input, runtimeRoot, configRoot) {
  const cache = await physicalPath(input);
  const skill = await physicalPath(resolve(runtimeRoot, '..'));
  const config = await physicalPath(configRoot);
  if ([dirname(cache), await physicalPath(homedir())].includes(cache)) throw new Error('Choose a dedicated Mandate Share cache directory.');
  for (const reserved of [skill, config]) {
    if (inside(reserved, cache) || inside(cache, reserved)) throw new Error('Runtime cache must be separate from the installed skill and store configuration.');
  }
  for (let parent = cache; ; parent = dirname(parent)) {
    try { await lstat(join(parent, 'store.json')); throw new Error('Runtime cache cannot be inside a user store. Choose a separate MANDATE_SHARE_CACHE.'); }
    catch (error) { if (!absent(error)) throw error; }
    if (parent === dirname(parent)) break;
  }
  return cache;
}

async function ready(path, digest, files) {
  try {
    if (!(await lstat(path)).isDirectory()) return false;
    const marker = JSON.parse(await readFile(join(path, '.runtime-ready.json'), 'utf8'));
    if (marker.schema !== 1 || marker.sourceDigest !== digest) return false;
    if (!(await lstat(join(path, 'node_modules'))).isDirectory()) return false;
    const metadata = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
    for (const name of Object.keys({ ...metadata.dependencies, ...metadata.devDependencies })) {
      if (!(await lstat(join(path, 'node_modules', name, 'package.json'))).isFile()) return false;
    }
    return await sourceDigest(path, files) === digest;
  } catch { return false; }
}

function installDependencies(stage, cache, npm) {
  return new Promise((resolveInstall, reject) => {
    const child = spawn(npm[0], [...npm.slice(1), 'ci', '--no-audit', '--no-fund'], {
      cwd: stage,
      env: { ...process.env, npm_config_cache: join(cache, 'packages') },
      // Runtime results remain parseable JSON on stdout, including the first launch.
      stdio: ['ignore', process.stderr, process.stderr],
    });
    child.once('error', () => reject(new Error('Could not launch npm. Install Node.js 22.20 or newer with npm, then retry.')));
    child.once('exit', code => code === 0 ? resolveInstall() : reject(new Error('Locked dependency installation failed. Check the network and npm installation, then retry; the incomplete cache was not activated.')));
  });
}

/** Exported for isolated bootstrap tests; the command line always uses its own installed runtime. */
export async function bootstrapRuntime(options = {}) {
  if ((Number(process.versions.node.split('.')[0]) < 22 || (Number(process.versions.node.split('.')[0]) === 22 && Number(process.versions.node.split('.')[1]) < 20))) throw new Error('Mandate Share requires Node.js 22.20 or newer.');
  const runtime = options.runtimeRoot ?? join(installedSkill, 'runtime');
  const npm = options.npm ? [options.npm] : await npmCommand();
  const version = process.versions.node;
  const files = await runtimeSources(runtime);
  const source = await sourceDigest(runtime, files);
  const metadata = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(metadata.version ?? '')) throw new Error('Installed runtime version is invalid; reinstall the skill.');
  const cache = await validateCacheRoot(options.cacheRoot ?? process.env.MANDATE_SHARE_CACHE ?? join(homedir(), '.cache', 'mandate-share'), runtime,
    options.configRoot ?? process.env.MANDATE_SHARE_HOME ?? join(homedir(), '.config', 'mandate-share'));
  const key = `${metadata.version}-${createHash('sha256').update(`bootstrap-v2-node\0${process.platform}\0${process.arch}\0${version}\0${source}`).digest('hex').slice(0, 24)}`;
  const target = join(cache, 'runtimes', key);
  if (await ready(target, source, files)) return target;
  await mkdir(join(cache, 'runtimes'), { recursive: true, mode: 0o700 });
  const lock = `${target}.lock`;
  let ownsLock = false;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await ready(target, source, files)) return target;
    try {
      await mkdir(lock, { mode: 0o700 });
      ownsLock = true;
      await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await delay(150);
    }
  }
  if (!ownsLock) throw new Error(`Runtime setup is still locked at ${lock}. If its owner process has exited, remove that lock directory and retry.`);
  const stage = `${target}.stage-${randomUUID()}`;
  try {
    if (await ready(target, source, files)) return target;
    try {
      await lstat(target);
      throw new Error(`Runtime cache is incomplete or changed at ${target}. Remove that cache directory and retry; keep user stores intact.`);
    } catch (error) { if (!absent(error)) throw error; }
    await mkdir(stage, { mode: 0o700 });
    for (const file of files) {
      const destination = join(stage, file);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(join(runtime, file), destination);
      await chmod(destination, 0o600);
    }
    if (await sourceDigest(stage, files) !== source) throw new Error('Installed skill changed during runtime setup. Retry after its update finishes.');
    await (options.install ?? installDependencies)(stage, cache, npm);
    if (await sourceDigest(stage, files) !== source) throw new Error('Runtime source changed during dependency installation. Reinstall the skill or retry after its update finishes.');
    await mkdir(join(stage, 'node_modules'), { recursive: true });
    await writeFile(join(stage, '.runtime-ready.json'), `${JSON.stringify({ schema: 1, sourceDigest: source, runtimeVersion: metadata.version, nodeVersion: version })}\n`, { mode: 0o600 });
    await rename(stage, target);
    return target;
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

async function main() {
  const runtime = await bootstrapRuntime();
  const child = spawn(process.execPath, ['--import', pathToFileURL(join(runtime, 'node_modules/tsx/dist/loader.mjs')).href, join(runtime, 'cli.ts'), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, MANDATE_SHARE_INSTALLED_SKILL: await realpath(installedSkill), TSX_TSCONFIG_PATH: join(runtime, 'tsconfig.json') } });
  child.once('error', () => { console.error('Could not launch the cached Node runtime. Run setup again, then retry.'); process.exitCode = 1; });
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  child.once('exit', (code, signal) => {
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

if (process.argv[1] && pathToFileURL(await realpath(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Mandate Share bootstrap failed.'); process.exitCode = 1; });
}
