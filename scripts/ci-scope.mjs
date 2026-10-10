import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Keep the allowlist narrow. A new or build-affecting path selects all checks.
const repositoryFiles = new Set([
  '.github/labels.json',
  '.github/workflows/issue-triage.yml',
  '.github/workflows/semantic.pr.yaml',
  '.github/workflows/secret-scan.yml',
  '.github/CODEOWNERS',
  'CODEOWNERS',
  'LICENSE',
  'scripts/issue-triage.mjs',
  'scripts/issue-triage.test.mjs',
  'scripts/issue-containers.mjs',
]);

export function classify(path) {
  if (path.endsWith('.md')) return 'documentation';
  if (path.startsWith('infrastructure/') || path === '.terrateam/config.yml')
    return 'infrastructure';
  if (
    repositoryFiles.has(path) ||
    /^\.github\/ISSUE_TEMPLATE\/[^/]+\.ya?ml$/.test(path)
  )
    return 'repository';
  return 'full';
}

export function selectScopes(paths) {
  const scopes = paths.map(classify);
  return {
    full: !scopes.length || scopes.includes('full'),
    repository: scopes.includes('repository'),
    infrastructure: scopes.includes('infrastructure'),
    check: !scopes.length || scopes.some((scope) => scope !== 'infrastructure'),
  };
}

function main() {
  const [base, head, event] = process.argv.slice(2);
  if (
    !/^[0-9a-f]{40}$/.test(base ?? '') ||
    !/^[0-9a-f]{40}$/.test(head ?? '') ||
    !['pull_request', 'push'].includes(event)
  )
    throw new Error('Expected base/head commit SHAs and pull_request or push');
  const diffBase =
    event === 'pull_request'
      ? execFileSync('git', ['merge-base', base, head], {
          encoding: 'utf8',
        }).trim()
      : base;
  const paths = execFileSync(
    'git',
    ['diff', '--name-only', '--no-renames', '-z', diffBase, head, '--'],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
  for (const [scope, selected] of Object.entries(selectScopes(paths)))
    console.log(`${scope}=${selected}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
