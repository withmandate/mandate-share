import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmCommand } from '../skills/mandate-share/scripts/npm-command.mjs';
import { commandInstallation, installCommand } from '../skills/mandate-share/scripts/install-command.mjs';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'share launcher '))); roots.push(root);
 const skill = join(root, 'installed skill'); const home = join(root, 'home');
 await mkdir(join(skill, 'runtime'), { recursive: true }); await mkdir(home);
 await cp(resolve(dirname(fileURLToPath(import.meta.url)), '../skills/mandate-share/scripts/launcher'), join(skill, 'scripts/launcher'), { recursive: true });
 await writeFile(join(skill, 'SKILL.md'), '---\nname: mandate-share\n---\nSynthetic launcher fixture\n');
 await writeFile(join(skill, 'runtime/package.json'), JSON.stringify({ name: 'mandate-share-runtime' }));
 await writeFile(join(skill, 'scripts/run.mjs'), 'console.log(JSON.stringify({source:"first",args:process.argv.slice(2)}));\n');
 const toolBin = join(root, 'tool-bin'); await mkdir(toolBin);
 const npm = await npmCommand(process.env);
 await symlink(process.execPath, join(toolBin, 'node')); await symlink(npm[1], join(toolBin, 'npm'));
 const inheritedPath = (process.env.PATH ?? '').split(delimiter).filter(folder => folder && !existsSync(join(folder, 'mandate-share')) && !existsSync(join(folder, 'mandate-share.cmd')));
 const env = { ...process.env, PATH: [toolBin, ...inheritedPath].join(delimiter), HOME: home, SHELL: '/bin/zsh', npm_config_cache: join(root, 'npm-cache') };
 return { root, skill, home, env, options: { skillPath: skill, home, env, agents: ['codex', 'claude-code'] } };
}

test('installs a copied npm launcher, works in a fresh shell, and follows a replaced skill without touching external files', async () => {
 const f = await fixture();
 await writeFile(join(f.home, '.zprofile'), '# Existing profile\n');
 await writeFile(join(f.root, 'private-page.mdx'), 'UNCHANGED PAGE');
 const installed = await installCommand(f.options);
 assert.deepEqual((await commandInstallation({ prefix: installed.prefix })).agents, ['codex', 'claude-code']);
 assert.equal(installed.path.restartShell, true);
 assert.equal((await realpath(join(installed.prefix, 'lib/node_modules/mandate-share-command'))), join(installed.prefix, 'lib/node_modules/mandate-share-command'));
 const first = spawnSync('/bin/zsh', ['-lc', 'mandate-share status'], { env: f.env, encoding: 'utf8', cwd: f.root });
 assert.equal(first.status, 0, first.stderr);
 assert.deepEqual(JSON.parse(first.stdout.trim()), { source: 'first', args: ['status'] });
 await writeFile(join(f.skill, 'scripts/run.mjs'), 'console.log(JSON.stringify({source:"updated",args:process.argv.slice(2)}));\n');
 const next = spawnSync(installed.command, ['status'], { env: f.env, encoding: 'utf8', cwd: f.root });
 assert.equal(next.status, 0, next.stderr); assert.equal(JSON.parse(next.stdout).source, 'updated');
 assert.equal(await readFile(join(f.root, 'private-page.mdx'), 'utf8'), 'UNCHANGED PAGE');
 const repeated = await installCommand(f.options); assert.equal(repeated.updated, true);
 for (const name of ['.zprofile', '.zshrc']) assert.equal((await readFile(join(f.home, name), 'utf8')).split('# >>> mandate-share command >>>').length, 2);
 assert.ok((await readFile(join(f.home, '.zprofile'), 'utf8')).startsWith('# Existing profile'));
 await rm(f.skill, { recursive: true });
 const missing = spawnSync(installed.command, ['status'], { env: f.env, encoding: 'utf8' });
 assert.equal(missing.status, 1); assert.match(missing.stderr, /Reinstall/);
});

test('refuses an unrelated existing command without modifying it or shell configuration', async () => {
 const f = await fixture(); const other = join(f.root, 'other-bin'); await mkdir(other);
 const command = join(other, 'mandate-share'); await writeFile(command, '#!/bin/sh\necho EXISTING\n'); await chmod(command, 0o755);
 await assert.rejects(installCommand({ ...f.options, env: { ...f.env, PATH: `${other}:${f.env.PATH}` } }), /different mandate-share command/);
 assert.equal(await readFile(command, 'utf8'), '#!/bin/sh\necho EXISTING\n');
 await assert.rejects(readFile(join(f.home, '.zprofile')), { code: 'ENOENT' });
});

test('requires explicit selection to switch skill copies, refuses store prefixes and shell symlinks', async () => {
 const f = await fixture(); const installed = await installCommand({ ...f.options, noPath: true });
 const second = join(f.root, 'second-skill'); await cp(f.skill, second, { recursive: true });
 await assert.rejects(installCommand({ ...f.options, skillPath: second, noPath: true }), /another installed skill/);
 const switched = await installCommand({ ...f.options, skillPath: second, noPath: true, useThisSkill: true }); assert.equal(switched.skillPath, second);
 const store = join(f.root, 'store'); await mkdir(store); await writeFile(join(store, 'store.json'), '{}');
 await assert.rejects(installCommand({ ...f.options, prefix: join(store, 'command'), noPath: true }), /pages store/);
 const external = join(f.root, 'external-rc'); await writeFile(external, 'UNCHANGED RC'); await symlink(external, join(f.home, '.zshrc'));
 await assert.rejects(installCommand({ ...f.options, skillPath: second }), /ordinary file/);
 assert.equal(await readFile(external, 'utf8'), 'UNCHANGED RC');
 assert.ok(installed.command.endsWith('/bin/mandate-share'));
});


test('Bash login setup preserves the existing startup file and environment at each precedence level', async () => {
 const precedence = ['.bash_profile', '.bash_login', '.profile'];
 for (let chosen = 0; chosen < precedence.length; chosen++) {
  const f = await fixture();
  const env = { ...f.env, SHELL: '/bin/bash' };
  delete (env as Record<string, string | undefined>).MANDATE_SHARE_FIXTURE_STARTUP;
  for (let index = chosen; index < precedence.length; index++) {
   await writeFile(join(f.home, precedence[index]!), `export MANDATE_SHARE_FIXTURE_STARTUP=fixture-${index}\n`);
  }
  const startupCheck = `test "$MANDATE_SHARE_FIXTURE_STARTUP" = fixture-${chosen}`;
  const before = spawnSync('/bin/bash', ['-lc', startupCheck], { env, encoding: 'utf8', cwd: f.root });
  assert.equal(before.status, 0, before.stderr);
  const installed = await installCommand({ ...f.options, env });
  assert.deepEqual(installed.path.shellFiles, [join(f.home, '.bashrc'), join(f.home, precedence[chosen]!)]);
  const after = spawnSync('/bin/bash', ['-lc', `${startupCheck} && mandate-share status`], { env, encoding: 'utf8', cwd: f.root });
  assert.equal(after.status, 0, after.stderr);
  assert.deepEqual(JSON.parse(after.stdout.trim()), { source: 'first', args: ['status'] });
  for (let index = 0; index < chosen; index++) await assert.rejects(readFile(join(f.home, precedence[index]!)), { code: 'ENOENT' });
  for (let index = chosen + 1; index < precedence.length; index++) assert.equal(await readFile(join(f.home, precedence[index]!), 'utf8'), `export MANDATE_SHARE_FIXTURE_STARTUP=fixture-${index}\n`);
  assert.ok((await readFile(join(f.home, precedence[chosen]!), 'utf8')).startsWith(`export MANDATE_SHARE_FIXTURE_STARTUP=fixture-${chosen}\n`));
 }
});
