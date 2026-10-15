import fs from 'node:fs';
import path from 'node:path';

/**
 * Throws when a path is inside a Git working tree, so real screenshots,
 * captures, and gamertag mappings cannot land where `git add` would pick them
 * up. The path need not exist yet; its nearest existing ancestor is resolved
 * through symlinks.
 */
export function assertOutsideRepository(target: string): void {
  let current = path.resolve(target);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  current = fs.realpathSync(current);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) {
      throw new Error(
        `${target} is inside the Git working tree ${current}; use a directory outside every repository`,
      );
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
