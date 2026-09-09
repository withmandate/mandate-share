#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimePrefix = 'skills/mandate-share/runtime/';
const forbiddenText = [
  [/\/(?:Users|home)\/[a-z][a-z0-9_-]*(?:\/|\b)/i, 'absolute private home path'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'private key'],
  [/(?:CLOUDFLARE_API_TOKEN|CLOUDFLARE_API_KEY)\s*[:=]\s*["']?[a-z0-9_-]{20,}/i, 'credential value'],
];

function decodeStringLiteral(value) {
  return value.slice(1, -1).replace(/\\(?:u\{([\da-f]+)\}|u([\da-f]{4})|x([\da-f]{2})|(\r\n|[\s\S]))/gi, (_match, point, unicode, hex, other) => {
    if (point || unicode || hex) return String.fromCodePoint(Number.parseInt(point || unicode || hex, 16));
    if (other === '\n' || other === '\r\n' || other === '\r') return '';
    return ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', 0: '\0' })[other] ?? other;
  });
}

/** Read quoted module paths without treating comments, text examples, or regular expressions as imports. */
function staticModuleSpecifiers(source) {
  const paths = [];
  let previous = '', beforePrevious = '';
  const token = value => { beforePrevious = previous; previous = value; };
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (/\s/u.test(character)) { index++; continue; }
    if (source.startsWith('//', index) || (index === 0 && source.startsWith('#!'))) {
      const end = source.indexOf('\n', index); index = end < 0 ? source.length : end + 1; continue;
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2); index = end < 0 ? source.length : end + 2; continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      const start = index++;
      while (index < source.length) {
        if (source[index] === '\\') { index += 2; continue; }
        if (source[index++] === character) break;
      }
      const literal = source.slice(start, index);
      const modulePath = previous === 'from' || previous === 'import' || (previous === '(' && ['import', 'require'].includes(beforePrevious));
      if (modulePath && (character !== '`' || !literal.includes('${'))) paths.push(decodeStringLiteral(literal));
      token('<literal>'); continue;
    }
    if (character === '/' && (!previous || /^(?:[=([{,:;!?]|=>|return|throw|case|yield|await)$/u.test(previous))) {
      index++; let inClass = false;
      while (index < source.length) {
        const next = source[index++];
        if (next === '\\') { index++; continue; }
        if (next === '[') inClass = true;
        else if (next === ']') inClass = false;
        else if (next === '/' && !inClass) break;
        else if (next === '\n') break;
      }
      while (/[a-z]/iu.test(source[index] ?? '')) index++;
      token('<regex>'); continue;
    }
    const identifier = /^[\w$]+/u.exec(source.slice(index));
    if (identifier) { token(identifier[0]); index += identifier[0].length; }
    else if (source.startsWith('=>', index)) { token('=>'); index += 2; }
    else { token(character); index++; }
  }
  return paths;
}

function assertModuleBoundaries(path, source) {
  if (!/\.(?:[cm]?[jt]s|[jt]sx)$/u.test(path)) return;
  for (const specifier of staticModuleSpecifiers(source)) {
    if (!/^(?:\.{1,2})(?:[/\\]|$)/u.test(specifier)) continue;
    let relative;
    try { relative = decodeURIComponent(specifier.split(/[?#]/u, 1)[0]).replaceAll('\\', '/'); }
    catch { throw new Error(`Invalid relative module specifier in ${path}`); }
    const target = posix.normalize(posix.join(posix.dirname(path), relative));
    if (target === '..' || target.startsWith('../')) throw new Error(`Module import escapes the public repository in ${path}`);
  }
}

export function assertPublicFile(path, data, allowed) {
  if (!allowed.has(path)) throw new Error(`Unapproved public file: ${path}`);
  if (data.includes(0)) throw new Error(`Unexpected binary in public source: ${path}`);
  const source = data.toString('utf8');
  if (Buffer.byteLength(source) !== data.byteLength) throw new Error(`Invalid UTF-8 source: ${path}`);
  for (const [pattern, description] of forbiddenText) if (pattern.test(source)) throw new Error(`${description} in ${path}`);
  assertModuleBoundaries(path, source);
  // Real access manifests and destination configuration have no place in the package, even if renamed.
  let json;
  if (path.endsWith('.json')) { try { json = JSON.parse(source); } catch { throw new Error(`Invalid public JSON: ${path}`); } }
  if (json && typeof json === 'object') {
    const objects = [json];
    while (objects.length) {
      const value = objects.pop();
      if (['pbkdf2-sha256', 'pbkdf2-sha256-client'].includes(value.algorithm) && typeof value.verifier === 'string') throw new Error(`Access state in ${path}`);
      if (typeof value.accountId === 'string' || typeof value.signingKey === 'string') throw new Error(`Private publisher state in ${path}`);
      for (const child of Object.values(value)) if (child && typeof child === 'object') objects.push(child);
    }
  }
  if (path.startsWith(`${runtimePrefix}components/`) && !path.endsWith('.tsx')) throw new Error(`Invalid built-in component: ${path}`);
}

async function worktreeFiles(directory, prefix = '') {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.name === '.git' || item.name === 'node_modules') continue;
    const relative = `${prefix}${item.name}`;
    if (item.isSymbolicLink()) throw new Error(`Public source symlink is not supported: ${relative}`);
    if (item.isDirectory()) files.push(...await worktreeFiles(join(directory, item.name), `${relative}/`));
    else if (item.isFile()) files.push(relative);
    else throw new Error(`Unexpected public source entry: ${relative}`);
  }
  return files.sort();
}

function git(root, args, optional = false) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: null, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    if (optional) return Buffer.alloc(0);
    throw new Error(`Git package inspection failed: ${args[0]}`);
  }
  return result.stdout;
}

export async function checkPackage(root = repository, { history = true } = {}) {
  const allowlist = JSON.parse(await readFile(join(root, 'scripts/public-files.json'), 'utf8'));
  if (allowlist.schema !== 1 || !Array.isArray(allowlist.files)) throw new Error('Invalid public-file allowlist.');
  const allowed = new Set(allowlist.files);
  if (allowed.size !== allowlist.files.length || [...allowed].some(path => path.startsWith('/') || path.split('/').includes('..'))) throw new Error('Invalid or duplicated public-file path.');
  const historicalPaths = allowlist.historicalFiles ?? [];
  if (!Array.isArray(historicalPaths) || new Set(historicalPaths).size !== historicalPaths.length || historicalPaths.some(path => typeof path !== 'string' || path.startsWith('/') || path.split('/').includes('..') || allowed.has(path))) throw new Error('Invalid historical public-file allowlist.');
  const historicalAllowed = new Set([...allowed, ...historicalPaths]);
  const files = await worktreeFiles(root);
  const hash = createHash('sha256');
  for (const path of files) {
    const data = await readFile(join(root, path));
    assertPublicFile(path, data, allowed);
    hash.update(path).update('\0').update(data).update('\0');
  }
  const missing = [...allowed].filter(path => !files.includes(path));
  if (missing.length) throw new Error(`Missing public files: ${missing.join(', ')}`);
  let commitsScanned = 0;
  let indexFilesScanned = 0;
  if (history) {
    const index = git(root, ['ls-files', '--stage', '-z']).toString('utf8').split('\0').filter(Boolean);
    for (const row of index) {
      const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(row);
      if (!match || match[1] !== '100644' && match[1] !== '100755' || match[3] !== '0') throw new Error('Unexpected Git index mode or merge conflict.');
      assertPublicFile(match[4], git(root, ['cat-file', 'blob', match[2]]), allowed);
      indexFilesScanned++;
    }
    const commits = git(root, ['rev-list', '--all']).toString('utf8').trim().split('\n').filter(Boolean);
    for (const commit of commits) {
      const rows = git(root, ['ls-tree', '-r', '-z', commit]).toString('utf8').split('\0').filter(Boolean);
      for (const row of rows) {
        const match = /^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
        if (!match || !['100644', '100755'].includes(match[1])) throw new Error('Unexpected historical file mode.');
        assertPublicFile(match[3], git(root, ['cat-file', 'blob', match[2]]), historicalAllowed);
      }
      commitsScanned++;
    }
  }
  return { ok: true, files: files.length, indexFilesScanned, commitsScanned, publicTreeDigest: hash.digest('hex') };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  checkPackage().then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
