#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { npmCommand } from '../skills/mandate-share/scripts/npm-command.mjs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = await realpath(await mkdtemp(join(tmpdir(), 'mandate-share installation ')));
const project = join(fixture, 'consumer project');
const source = join(fixture, 'release source');
const storeRoot = join(fixture, 'external store');
const isolatedHome = join(fixture, 'isolated home');
const commandPrefix = join(fixture, 'user command');
const toolBin = join(fixture, 'tool-bin');
await mkdir(toolBin);
const npm = await npmCommand(process.env);
await symlink(process.execPath, join(toolBin, 'node'));
await symlink(npm[1], join(toolBin, 'npm'));
await symlink(join(dirname(npm[1]), 'npx-cli.js'), join(toolBin, 'npx'));
const inheritedPath = (process.env.PATH ?? '').split(delimiter).filter(folder => folder && !existsSync(join(folder, 'mandate-share')) && !existsSync(join(folder, 'mandate-share.cmd')));
const env = { ...process.env, PATH: [toolBin, ...inheritedPath].join(delimiter), HOME: isolatedHome, CODEX_HOME: join(isolatedHome, '.codex'), CLAUDE_CONFIG_DIR: join(isolatedHome, '.claude'), XDG_CONFIG_HOME: join(isolatedHome, '.config'), MANDATE_SHARE_HOME: join(fixture, 'config'), MANDATE_SHARE_CACHE: join(fixture, 'runtime cache'), npm_config_cache: join(fixture, 'npm cache'), DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' };
const previews = new Map();
const facts = [];

function command(program, args, { cwd = project, input } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(program, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? done({ stdout, stderr }) : reject(new Error(`${program} failed (${code}): ${stderr}`)));
    child.stdin.end(input);
  });
}
async function directories(path) {
  const result = [];
  for (const item of await readdir(path, { withFileTypes: true })) {
    if (!item.isDirectory() || item.name === 'node_modules' || item.name === '.git') continue;
    const child = join(path, item.name);
    if (item.name === 'mandate-share') result.push(child);
    result.push(...await directories(child));
  }
  return result;
}
async function setTreeReadOnly(path, readOnly) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await setTreeReadOnly(child, readOnly);
    else await chmod(child, readOnly ? 0o444 : 0o644);
  }
  await chmod(path, readOnly ? 0o555 : 0o755);
}
async function browserForm(html, password) {
  const challenge = /name="challenge" value="([^"]+)"/.exec(html)?.[1];
  const params = /^2\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(challenge ?? '');
  if (!params) throw new Error('No native-browser password challenge.');
  const salt = Uint8Array.from(atob(params[2].replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations:Number(params[1])},key,256));
  const proof = btoa(String.fromCharCode(...bits)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
  return new URLSearchParams({proof,challenge});
}

async function fingerprint(path) { return createHash('sha256').update(await readFile(path)).digest('hex'); }
async function recordPreview() {
  const registry = JSON.parse(await readFile(join(storeRoot, '.mandate-share', 'preview.json'), 'utf8'));
  previews.set(registry.pid, registry);
  return registry;
}
async function stopPreviews() {
  for (const [pid, registry] of previews) {
    try {
      const response = await fetch(`http://127.0.0.1:${registry.port}/.well-known/mandate-share`, { signal: AbortSignal.timeout(300) });
      const health = await response.json();
      if (health.id === registry.id && health.runtimeId === registry.runtimeId && Number.isInteger(pid) && pid > 1) process.kill(pid, 'SIGTERM');
    } catch {}
  }
}
try {
  await mkdir(project, { recursive: true });
  await mkdir(isolatedHome, { recursive: true });
  const allowlist = JSON.parse(await readFile(join(root, 'scripts/public-files.json'), 'utf8'));
  for (const file of allowlist.files.filter(path => path.startsWith('skills/mandate-share/'))) {
    const output = join(source, file);
    await mkdir(dirname(output), { recursive: true });
    await cp(join(root, file), output);
  }
  const installArgs = ['--yes', '--package', 'skills@1.5.25', 'skills', 'add', source, '--skill', 'mandate-share', '--agent', 'codex', 'claude-code', '--copy', '--yes'];
  await command('npx', installArgs);
  const installed = (await directories(project)).filter(path => path.includes(`${join('.agents', 'skills')}`) || path.includes(`${join('.claude', 'skills')}`));
  assert(installed.some(path => path.includes('.agents')), 'Codex project skill was not installed');
  assert(installed.some(path => path.includes('.claude')), 'Claude Code project skill was not installed');
  for (const path of installed) assert((await lstat(join(path, 'runtime', 'lib', 'build.ts'))).isFile(), 'Installer omitted runtime support');
  assert.deepEqual((await readdir(project)).filter(name => name.startsWith('.')).sort(), ['.agents', '.claude'], 'Project install created an unselected harness directory');
  const globalInstallArgs = [...installArgs, '--global'];
  await command('npx', globalInstallArgs);
  const globalInstalled = (await directories(isolatedHome)).filter(path => path.includes(`${join('skills', 'mandate-share')}`));
  const primary = join(isolatedHome, '.agents/skills/mandate-share');
  assert(globalInstalled.includes(primary), 'Codex global skill missing');
  assert(globalInstalled.includes(join(isolatedHome, '.claude/skills/mandate-share')), 'Claude Code global skill missing');
  for (const path of globalInstalled) assert(['.agents', '.codex', '.claude'].includes(path.slice(isolatedHome.length + 1).split('/')[0]), 'Global install created an unselected harness directory');
  const commandInstaller = join(primary, 'scripts/install-command.mjs');
  const launcherResult = JSON.parse((await command('node', [commandInstaller, '--prefix', commandPrefix, '--no-path', '--agents', 'codex,claude-code', '--scope', 'global', '--source', source])).stdout);
  const runner = join(primary, 'scripts', 'run.mjs');
  const launcher = launcherResult.command;
  env.PATH = `${dirname(launcher)}${delimiter}${env.PATH}`;
  const execute = async (...args) => JSON.parse((await command('mandate-share', args)).stdout);
  await setTreeReadOnly(primary, true);
  let state;
  try {
    await execute('store', 'add', 'fixture', '--path', storeRoot, '--default');
    state = (await execute('status')).data.store;
  } finally { await setTreeReadOnly(primary, false); }
  assert(!state.runtimeRoot.startsWith(primary), 'Runtime did not use an external cache');
  await execute('check', join(primary, 'examples', 'sample-brief.mdx'));
  const sample = join(primary, 'examples', 'sample-page.html');
  const imported = await execute('import', sample, '--slug', 'fixture-page');
  const firstPreview = await recordPreview();
  assert.equal((await fetch(imported.data.reviewUrl)).status, 403, 'An imported page without a password must remain private');
  await execute('sharing', 'fixture-page', '--unlisted');
  const firstBody = await (await fetch(imported.data.reviewUrl)).arrayBuffer();
  assert.deepEqual(Buffer.from(firstBody), await readFile(sample), 'Raw import changed original bytes');
  await command(launcher, ['protect', 'fixture-page', '--password-stdin'], { input: 'SYNTHETIC INSTALL FIXTURE PASSWORD\n' });
  await recordPreview();
  assert.equal((await fetch(imported.data.reviewUrl)).status, 401);
  await command(launcher, ['password', '--default', '--stdin'], { input: 'SYNTHETIC DEFAULT FIXTURE PASSWORD\n' });
  // The fixture destination is written locally; it is never published or authenticated.
  await execute('setup', '--account-id', '0'.repeat(32), '--worker', 'synthetic-install-fixture', '--workers-dev');
  const component = join(storeRoot, 'components', 'InstallFixture.tsx');
  await writeFile(component, 'export const meta={name:"InstallFixture",description:"Synthetic fixture",whenToUse:"Installation proof",props:[],example:"<InstallFixture />"}; export default function InstallFixture(){return <p>EXTERNAL COMPONENT FIXTURE</p>}\n');
  const mdx = join(storeRoot, 'digests', 'authored-fixture.mdx');
  await writeFile(mdx, '---\ntitle: "Synthetic installation proof"\nsample: true\nunlisted: true\n---\n\n<InstallFixture />\n');
  await execute('build');
  const preserved = ['raw/fixture-page.html', 'raw/manifest.json', 'digests/authored-fixture.mdx', 'components/InstallFixture.tsx', 'access/manifest.json', '.mandate-share/passwords.json', 'access/sharing.json', '.mandate-share/access-signing-key', '.mandate-share/publisher.json', 'store.json'];
  const before = await Promise.all(preserved.map(file => fingerprint(join(storeRoot, file))));
  await command('npx', globalInstallArgs);
  for (let index = 0; index < preserved.length; index++) assert.equal(await fingerprint(join(storeRoot, preserved[index])), before[index], `Reinstall changed ${preserved[index]}`);
  await execute('build');
  // Same declared version, changed source: update must choose a different cache and preview runtime.
  const contextFile = join(source, 'skills', 'mandate-share', 'runtime', 'lib', 'context.ts');
  await writeFile(contextFile, `${await readFile(contextFile, 'utf8')}\n// Synthetic update fixture.\n`);
  await command('npx', globalInstallArgs);
  const updatedState = (await execute('status')).data.store;
  assert.notEqual(updatedState.runtimeRoot, state.runtimeRoot, 'Source update reused the previous runtime cache');
  const updatedPreview = await execute('preview', 'authored-fixture');
  const secondPreview = await recordPreview();
  assert.notEqual(secondPreview.runtimeId, firstPreview.runtimeId, 'Preview reused an older runtime');
  assert.equal((await fetch(updatedPreview.data.reviewUrl)).status, 401, 'New authored pages should use the saved private default');
  const unlocked = await fetch(updatedPreview.data.reviewUrl, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: await browserForm(await (await fetch(updatedPreview.data.reviewUrl)).text(), 'SYNTHETIC DEFAULT FIXTURE PASSWORD') });
  assert.equal(unlocked.status, 303);
  const cookie = unlocked.headers.get('set-cookie').split(';', 1)[0];
  assert((await (await fetch(updatedPreview.data.reviewUrl, { headers: { cookie } })).text()).includes('EXTERNAL COMPONENT FIXTURE'));
  assert.deepEqual((await directories(isolatedHome)).filter(path => path.includes(`${join('skills', 'mandate-share')}`)).sort(), globalInstalled.sort(), 'Targeted reinstall expanded installed harnesses');
  const commandChoices = JSON.parse((await command('node', [commandInstaller, '--status', '--prefix', commandPrefix])).stdout);
  assert.deepEqual(commandChoices.agents, ['codex', 'claude-code']);
  assert.equal(commandChoices.source, source);
  assert.equal(commandChoices.scope, 'global');
  for (let index = 0; index < preserved.length; index++) assert.equal(await fingerprint(join(storeRoot, preserved[index])), before[index], `Update changed ${preserved[index]}`);
  facts.push('standard skills@1.5.25 copied only Codex and Claude Code project and isolated global installations', 'npm installed a copied stable launcher with saved agent/source/scope choices', 'first bootstrap restored frozen dependencies outside a read-only installed skill', 'CLI stdout parsed as JSON on first launch', 'new import denied HTTP access until explicit password-free link consent; raw HTML then preserved original bytes', 'password and selected-store default stayed private', 'targeted reinstall preserved all populated external store files without adding agent harnesses', 'same-version source update selected a new runtime cache and preview', 'external authored MDX and custom component rendered after update');
  console.log(JSON.stringify({ ok: true, installer: 'skills@1.5.25', globalInstall: 'isolated temporary home only', livePublisher: false, agentExecutionClaimed: false, checks: facts, fixtureRetained: false }, null, 2));
} finally {
  await stopPreviews();
  await rm(fixture, { recursive: true, force: true });
}
