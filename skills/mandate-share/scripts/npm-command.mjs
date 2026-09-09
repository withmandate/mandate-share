import { lstat, realpath } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';

/** Invoke npm's JavaScript entry with this Node, including on Windows where .cmd needs a shell. */
export async function npmCommand(env = process.env) {
  const nodeDirectory = dirname(process.execPath);
  const candidates = [join(nodeDirectory, 'node_modules/npm/bin/npm-cli.js'), join(nodeDirectory, '../lib/node_modules/npm/bin/npm-cli.js')];
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    if (process.platform === 'win32') candidates.push(join(directory, 'node_modules/npm/bin/npm-cli.js'));
    else {
      try { const path = await realpath(join(directory, 'npm')); if (path.endsWith('/npm-cli.js')) candidates.push(path); } catch {}
    }
  }
  for (const path of candidates) {
    try { if ((await lstat(path)).isFile()) return [process.execPath, path]; } catch {}
  }
  throw new Error('Could not find npm. Install Node.js 22.20 or newer with npm, then retry.');
}
