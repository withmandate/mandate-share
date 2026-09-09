import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareLocalInstall } from '../scripts/prepare-local-install.mjs';

const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'share local staging '))); roots.push(root);
  const source = join(root, 'developed checkout'), temporaryDirectory = join(root, 'stages');
  await mkdir(join(source, 'scripts'), { recursive: true });
  await mkdir(join(source, 'skills/mandate-share/runtime'), { recursive: true });
  await mkdir(temporaryDirectory);
  const files = ['README.md', 'scripts/public-files.json', 'skills/mandate-share/SKILL.md', 'skills/mandate-share/runtime/cli.ts'];
  await writeFile(join(source, 'scripts/public-files.json'), JSON.stringify({ schema: 1, files, historicalFiles: ['old-program.ts'] }));
  await writeFile(join(source, 'README.md'), 'Current working README\n');
  await writeFile(join(source, 'skills/mandate-share/SKILL.md'), '---\nname: mandate-share\ndescription: Synthetic installation fixture\n---\n');
  await writeFile(join(source, 'skills/mandate-share/runtime/cli.ts'), 'console.log("current working source");\n');
  return { root, source, temporaryDirectory, files };
}
async function tree(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await tree(root, path)); else files.push(path);
  }
  return files.sort();
}

test('stages exactly declared current files from a developed checkout without dependencies, Git data, or stray files', async () => {
  const f = await fixture();
  await mkdir(join(f.source, 'skills/mandate-share/runtime/node_modules/dependency'), { recursive: true });
  await writeFile(join(f.source, 'skills/mandate-share/runtime/node_modules/dependency/index.js'), 'DEPENDENCY MUST NOT BE INSTALLED WITH SKILL');
  await mkdir(join(f.source, '.git')); await writeFile(join(f.source, '.git/config'), 'LOCAL GIT CONFIG');
  await writeFile(join(f.source, 'skills/mandate-share/private-notes.md'), 'PRIVATE STRAY NOTE');
  await writeFile(join(f.source, 'old-program.ts'), 'HISTORICAL SOURCE IS NOT CURRENT');
  await symlink(join(f.source, 'README.md'), join(f.source, 'undeclared-link'));
  const before = await tree(f.source);
  const staged = await prepareLocalInstall(f.source, { temporaryDirectory: f.temporaryDirectory });
  assert.equal(staged.originalSource, f.source); assert.equal(staged.files, f.files.length);
  assert.match(staged.sourceDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(await tree(staged.sourcePath), [...f.files].sort());
  for (const file of f.files) assert.deepEqual(await readFile(join(staged.sourcePath, file)), await readFile(join(f.source, file)));
  assert.deepEqual(await tree(f.source), before);
  await writeFile(join(f.source, 'README.md'), 'Latest uncommitted README\n');
  const updated = await prepareLocalInstall(f.source, { temporaryDirectory: f.temporaryDirectory });
  assert.notEqual(updated.sourceDigest, staged.sourceDigest);
  assert.equal(await readFile(join(updated.sourcePath, 'README.md'), 'utf8'), 'Latest uncommitted README\n');
});

test('rejects missing declared files, private content, invalid paths and duplicate declarations without leaving a stage', async () => {
  const cases = ['missing', 'private', 'traversal', 'duplicate', 'dependency'] as const;
  for (const kind of cases) {
    const f = await fixture();
    if (kind === 'missing') await rm(join(f.source, 'README.md'));
    if (kind === 'private') await writeFile(join(f.source, 'README.md'), '/' + ['Users', 'synthetic-person', 'private-note'].join('/'));
    if (['traversal', 'duplicate', 'dependency'].includes(kind)) {
      const path = kind === 'traversal' ? '../outside.txt' : kind === 'duplicate' ? 'README.md' : 'skills/mandate-share/runtime/node_modules/package.json';
      await writeFile(join(f.source, 'scripts/public-files.json'), JSON.stringify({ schema: 1, files: [...f.files, path] }));
    }
    await assert.rejects(prepareLocalInstall(f.source, { temporaryDirectory: f.temporaryDirectory }));
    assert.deepEqual(await readdir(f.temporaryDirectory), []);
  }
});

test('rejects a symlinked declared file, parent directory, or allowlist instead of following it', async () => {
  for (const kind of ['file', 'directory', 'allowlist'] as const) {
    const f = await fixture();
    const path = kind === 'file' ? join(f.source, 'README.md') : kind === 'directory' ? join(f.source, 'skills/mandate-share/runtime') : join(f.source, 'scripts/public-files.json');
    const outside = join(f.root, `outside-${kind}`);
    if (kind === 'directory') {
      await mkdir(outside); await writeFile(join(outside, 'cli.ts'), 'OUTSIDE CODE');
      await rm(path, { recursive: true });
    } else { await writeFile(outside, await readFile(path)); await rm(path); }
    await symlink(outside, path);
    await assert.rejects(prepareLocalInstall(f.source, { temporaryDirectory: f.temporaryDirectory }), /symlinks/);
    assert.deepEqual(await readdir(f.temporaryDirectory), []);
  }
});
