import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Keep the allowlist narrow. A new or build-affecting path selects all checks.
export const repositoryFiles = new Set([
  '.github/labels.json',
  '.github/workflows/issue-triage.yml',
  '.github/workflows/labels.yml',
  '.github/workflows/semantic.pr.yaml',
  '.github/workflows/secret-scan.yml',
  '.github/CODEOWNERS',
  'CODEOWNERS',
  'LICENSE',
  '.github/workflows/branch-name.yml',
  'scripts/branch-name.mjs',
  'scripts/branch-name.test.mjs',
  'scripts/issue-triage.mjs',
  'scripts/issue-triage.test.mjs',
  'scripts/issue-containers.mjs',
  'scripts/labels-sync.mjs',
  'scripts/labels-sync.test.mjs',
]);

export function classify(path) {
  if (path.endsWith('.md')) return 'documentation';
  if (
    repositoryFiles.has(path) ||
    /^\.github\/ISSUE_TEMPLATE\/[^/]+\.ya?ml$/.test(path)
  )
    return 'repository';
  return 'full';
}

// A pull request diffs from the merge base; a push diffs from its base.
export function diffBase(base, head, event) {
  return event === 'pull_request'
    ? execFileSync('git', ['merge-base', base, head], {
        encoding: 'utf8',
      }).trim()
    : base;
}

export function changedPaths(base, head, event) {
  return execFileSync(
    'git',
    [
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      diffBase(base, head, event),
      head,
      '--',
    ],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
}

function main() {
  const [base, head, event] = process.argv.slice(2);
  if (
    !/^[0-9a-f]{40}$/.test(base ?? '') ||
    !/^[0-9a-f]{40}$/.test(head ?? '') ||
    !['pull_request', 'push'].includes(event)
  )
    throw new Error('Expected base/head commit SHAs and pull_request or push');
  const scopes = changedPaths(base, head, event).map(classify);
  // Empty/unclassifiable changes never certify the shorter path.
  console.log(`full=${!scopes.length || scopes.includes('full')}`);
  console.log(`repository=${scopes.includes('repository')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
