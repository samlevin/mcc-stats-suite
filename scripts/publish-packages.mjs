import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const registry = 'https://npm.pkg.github.com';
const root = resolve(import.meta.dirname, '..');
const sharedPackages = ['packages/contracts', 'packages/cdk-config'];

export function publishSharedPackages(run = execFileSync) {
  for (const workspace of sharedPackages) {
    const { name, version } = JSON.parse(
      readFileSync(resolve(root, workspace, 'package.json'), 'utf8'),
    );
    try {
      run(
        'npm',
        [
          'view',
          `${name}@${version}`,
          'version',
          '--json',
          '--registry',
          registry,
        ],
        { encoding: 'utf8' },
      );
      console.log(`${name}@${version} already published`);
      continue;
    } catch (error) {
      // Authentication and transport errors must never trigger publication.
      let code;
      try {
        code = JSON.parse(error.stdout)?.error?.code;
      } catch {
        throw error;
      }
      if (code !== 'E404') throw error;
    }
    run('npm', ['publish', '--workspace', workspace, '--registry', registry], {
      stdio: 'inherit',
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  publishSharedPackages();
