#!/usr/bin/env node
import { npmCommand } from './npm-command.mjs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'mandate-share';
const START = '# >>> mandate-share command >>>';
const END = '# <<< mandate-share command <<<';
const absent = error => error?.code === 'ENOENT';
const within = (parent, path) => path === parent || path.startsWith(parent + sep);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

async function ordinaryDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) throw new Error('The command prefix must use ordinary directories, without symbolic links.');
}
async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
async function npmInstall(source, prefix, env) {
  const command = await npmCommand(env);
  return new Promise((done, reject) => {
    const child = spawn(command[0], [...command.slice(1), 'install', '--global', '--prefix', prefix, '--install-links', '--ignore-scripts', '--no-audit', '--no-fund', source], { env, stdio: ['ignore', process.stderr, process.stderr] });
    child.once('error', () => reject(new Error('Could not start npm. Install Node.js 22.20 or newer with npm, then retry.')));
    child.once('close', code => code === 0 ? done() : reject(new Error('Command installation failed. Check that its prefix is writable and retry.')));
  });
}
async function executablePaths(env) {
  const files = [];
  for (const folder of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const suffix of process.platform === 'win32' ? ['', '.cmd', '.ps1', '.exe'] : ['']) {
      const path = resolve(folder, 'mandate-share' + suffix);
      try { await access(path, constants.X_OK); files.push(path); } catch {}
    }
  }
  return [...new Set(files)];
}
async function configurePath(bin, options) {
  const current = (options.env.PATH ?? '').split(delimiter).some(path => resolve(path || '.') === bin);
  if (options.noPath) return { configured: current, changed: false, restartShell: false, binDirectory: bin };
  if (process.platform === 'win32') return { configured: false, changed: false, restartShell: false, binDirectory: bin, action: 'Add this directory to your user PATH in Windows Environment Variables, then open a new terminal.' };
  const shell = basename(options.env.SHELL ?? '');
  let paths = [];
  if (shell === 'zsh') paths = [join(options.home, '.zshrc'), join(options.home, '.zprofile')];
  else if (shell === 'bash') {
    // Bash reads only the first existing login file. Creating .bash_profile
    // would silently suppress settings in an existing .bash_login or .profile.
    let login = join(options.home, '.profile');
    for (const name of ['.bash_profile', '.bash_login', '.profile']) {
      const candidate = join(options.home, name);
      try { await lstat(candidate); login = candidate; break; }
      catch (error) { if (!absent(error)) throw error; }
    }
    paths = [join(options.home, '.bashrc'), login];
  }
  if (!paths.length) return { configured: false, changed: false, restartShell: false, binDirectory: bin, action: 'Add this directory to PATH in your shell configuration, then open a new terminal.' };
  const block = `${START}\nexport PATH=${quote(bin)}:"$PATH"\n${END}`;
  let changed = false;
  for (const path of paths) {
    let source = '';
    try { if (!(await lstat(path)).isFile()) throw new Error('Shell configuration must be an ordinary file; add the reported command directory to PATH yourself.'); source = await readFile(path, 'utf8'); }
    catch (error) { if (!absent(error)) throw error; }
    const hasStart = source.includes(START), hasEnd = source.includes(END);
    if (hasStart !== hasEnd || source.split(START).length > 2 || source.split(END).length > 2) throw new Error('The existing Mandate Share PATH block is malformed. Repair that block before retrying setup.');
    const next = hasStart ? source.slice(0, source.indexOf(START)) + block + source.slice(source.indexOf(END) + END.length) : source.replace(/\n?$/, '\n') + '\n' + block + '\n';
    if (next !== source) {
      const temporary = `${path}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, next, { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
      finally { await rm(temporary, { force: true }); }
      changed = true;
    }
  }
  return { configured: true, changed, restartShell: !current, binDirectory: bin, shellFiles: paths };
}

/** Called explicitly by the agent after the selected harness installation. Never runs as a skill postinstall hook. */
export async function installCommand(options = {}) {
  if ((Number(process.versions.node.split('.')[0]) < 22 || (Number(process.versions.node.split('.')[0]) === 22 && Number(process.versions.node.split('.')[1]) < 20))) throw new Error('Mandate Share needs Node.js 22.20 or newer.');
  const env = options.env ?? process.env;
  const home = await realpath(options.home ?? homedir());
  const requestedSkill = resolve(options.skillPath ?? skillRoot);
  const skill = await realpath(requestedSkill);
  if (!(await lstat(join(skill, 'SKILL.md'))).isFile() || JSON.parse(await readFile(join(skill, 'runtime/package.json'), 'utf8')).name !== 'mandate-share-runtime') throw new Error('Choose an installed mandate-share skill.');
  const prefix = resolve(options.prefix ?? join(home, '.local/share/mandate-share/command'));
  if (!isAbsolute(prefix) || [home, dirname(home), dirname(prefix)].includes(prefix) || within(skill, prefix) || within(prefix, skill)) throw new Error('Choose a dedicated command prefix outside the installed skill.');
  for (let parent = prefix; ; parent = dirname(parent)) {
    try { await lstat(join(parent, 'store.json')); throw new Error('The command prefix cannot live inside a pages store.'); }
    catch (error) { if (!absent(error)) throw error; }
    if (parent === dirname(parent)) break;
  }
  const bin = process.platform === 'win32' ? prefix : join(prefix, 'bin');
  const packageRoot = join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', 'mandate-share-command');
  const recordPath = join(packageRoot, 'installation.json');
  let previous;
  try { if (!(await lstat(recordPath)).isFile()) throw new Error('Existing command ownership record is invalid.'); previous = JSON.parse(await readFile(recordPath, 'utf8')); }
  catch (error) { if (!absent(error)) throw error; }
  if (previous && (previous.schema !== 1 || previous.owner !== OWNER)) throw new Error('This command prefix belongs to another installation.');
  if (previous && previous.skillPath !== requestedSkill && !options.useThisSkill) throw new Error('The command already uses another installed skill. Use --use-this-skill only after choosing this installation as its source.');
  const expected = join(packageRoot, 'mandate-share.mjs');
  const candidates = new Set([...await executablePaths(env), ...['', ...(process.platform === 'win32' ? ['.cmd', '.ps1'] : [])].map(suffix => join(bin, 'mandate-share' + suffix))]);
  for (const candidate of candidates) {
    try {
      await lstat(candidate);
      const actual = await realpath(candidate);
      const owned = previous && (process.platform === 'win32' ? dirname(candidate) === bin : actual === expected);
      if (!owned) throw new Error('A different mandate-share command already exists. Keep it intact; choose which installation should own the command before retrying.');
    } catch (error) { if (!absent(error)) throw error; }
  }
  const agents = options.agents ?? previous?.agents;
  if (!Array.isArray(agents) || !agents.length || agents.length > 16 || new Set(agents).size !== agents.length || agents.some(name => typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,49}$/.test(name))) throw new Error('Choose the intended agent names with --agents codex,claude-code (or the specific agent you use).');
  const scope = options.scope ?? previous?.scope ?? 'global';
  if (!['global', 'project'].includes(scope)) throw new Error('--scope must be global or project.');
  const source = options.source ?? previous?.source ?? 'withmandate/mandate-share';
  if (source !== 'withmandate/mandate-share' && (!isAbsolute(source) || !(await lstat(source)).isDirectory())) throw new Error('--source must be withmandate/mandate-share or an absolute local checkout directory.');
  const projectRoot = scope === 'project' ? await realpath(options.projectRoot ?? previous?.projectRoot ?? process.cwd()) : undefined;
  await ordinaryDirectory(prefix);
  // Refuse a pre-existing unrelated package before npm can replace its files.
  try { if (!(await lstat(packageRoot)).isDirectory() || !previous) throw new Error('An unrecognized command package already occupies this prefix.'); }
  catch (error) { if (!absent(error)) throw error; }
  for (const directory of [bin, join(prefix, 'lib'), join(prefix, 'lib/node_modules'), join(prefix, 'node_modules'), packageRoot]) {
    try { if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) throw new Error('Existing command directories must not be symbolic links.'); }
    catch (error) { if (!absent(error)) throw error; }
  }
  const lock = join(prefix, '.install-command.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error?.code === 'EEXIST') throw new Error('Another command setup is in progress. Retry after it finishes.'); throw error; }
  try {
  await npmInstall(join(skill, 'scripts/launcher'), prefix, env);
  if (!(await lstat(packageRoot)).isDirectory() || await realpath(packageRoot) !== packageRoot) throw new Error('npm linked the launcher instead of copying it. Retry with a current npm release.');
  await atomicJson(recordPath, { schema: 1, owner: OWNER, skillPath: requestedSkill, agents, scope, source, ...(projectRoot ? { projectRoot } : {}) });
  await chmod(join(packageRoot, 'mandate-share.mjs'), 0o755);
  const path = await configurePath(bin, { home, env, noPath: options.noPath });
  return { ok: true, command: join(bin, process.platform === 'win32' ? 'mandate-share.cmd' : 'mandate-share'), skillPath: requestedSkill, agents, scope, source, ...(projectRoot ? { projectRoot } : {}), prefix, updated: !!previous, path };
  } finally { await rm(lock, { recursive: true, force: true }); }
}

/** Read saved installation choices so an agent can repeat the same targeted skills add command. */
export async function commandInstallation(options = {}) {
  const prefix = resolve(options.prefix ?? join(options.home ?? homedir(), '.local/share/mandate-share/command'));
  const packageRoot = join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', 'mandate-share-command');
  const path = join(packageRoot, 'installation.json');
  if (!(await lstat(path)).isFile()) throw new Error('Command installation record must be an ordinary file.');
  const record = JSON.parse(await readFile(path, 'utf8'));
  if (record.schema !== 1 || record.owner !== OWNER) throw new Error('The command installation record is not recognized.');
  return { ...record, prefix, command: join(prefix, process.platform === 'win32' ? 'mandate-share.cmd' : 'bin/mandate-share') };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2), options = {};
  try {
    while (args.length) {
      const arg = args.shift();
      if (['--prefix', '--agents', '--scope', '--source', '--project-root'].includes(arg)) { const value = args.shift(); if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value.`); const key = arg === '--project-root' ? 'projectRoot' : arg.slice(2); options[key] = arg === '--agents' ? value.split(',') : value; }
      else if (arg === '--status') options.status = true;
      else if (arg === '--no-path') options.noPath = true;
      else if (arg === '--use-this-skill') options.useThisSkill = true;
      else throw new Error('Usage: node scripts/install-command.mjs [--prefix DIRECTORY] [--no-path] [--use-this-skill]');
    }
    console.log(JSON.stringify(options.status ? await commandInstallation(options) : await installCommand(options), null, 2));
  } catch (error) { console.error(error instanceof Error ? error.message : 'Command setup failed.'); process.exitCode = 1; }
}
