#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  if ((Number(process.versions.node.split('.')[0]) < 22 || (Number(process.versions.node.split('.')[0]) === 22 && Number(process.versions.node.split('.')[1]) < 20))) throw new Error('Mandate Share needs Node.js 22.20 or newer.');
  const installed = dirname(await realpath(fileURLToPath(import.meta.url)));
  const recordPath = join(installed, 'installation.json');
  if (!(await lstat(recordPath)).isFile()) throw new Error('Command installation record must be an ordinary file.');
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  if (record.schema !== 1 || record.owner !== 'mandate-share' || typeof record.skillPath !== 'string' || !isAbsolute(record.skillPath)) throw new Error('Command installation is incomplete. Ask your agent to run Mandate Share command setup again.');
  const skill = await realpath(record.skillPath);
  const script = join(skill, 'scripts', 'run.mjs');
  if (!(await lstat(script)).isFile() || !(await lstat(join(skill, 'SKILL.md'))).isFile()) throw new Error('The selected Mandate Share skill is missing. Reinstall that skill, then run command setup again.');
  const metadata = JSON.parse(await readFile(join(skill, 'runtime', 'package.json'), 'utf8'));
  if (metadata.name !== 'mandate-share-runtime') throw new Error('The command points to an unexpected skill. Run command setup again.');
  const child = spawn(process.execPath, [script, ...process.argv.slice(2)], { stdio: 'inherit' });
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  child.once('error', () => { console.error('Mandate Share could not start. Run command setup again.'); process.exitCode = 1; });
  child.once('exit', (code, signal) => {
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
    process.exitCode = code ?? (signal ? 1 : 0);
  });
} catch (error) {
  console.error(error?.code === 'ENOENT' ? 'The selected Mandate Share skill is unavailable. Reinstall it, then run command setup again.' : error instanceof Error ? error.message : 'Mandate Share command failed.');
  process.exitCode = 1;
}
