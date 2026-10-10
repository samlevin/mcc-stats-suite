import { spawn } from 'node:child_process';
import { appendFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { changedPaths, diffBase, repositoryFiles } from './ci-scope.mjs';

export function workspaceMode(paths, event) {
  // Root configuration, infrastructure and unknown paths require every workspace.
  return event === 'pull_request' &&
    paths.length > 0 &&
    paths.every((path) =>
      /^(applications\/(admin|data-pipeline|match-to-csv|ocr-quality|player)|packages\/(contracts|cdk-config))\//.test(
        path,
      ),
    )
    ? 'affected'
    : 'all';
}

export function workspaceArguments(mode) {
  return [
    'turbo',
    'run',
    'build',
    'typecheck',
    'ci:test',
    'ci:synth',
    'verify:bundle',
    '--concurrency=4',
    '--summarize',
    ...(mode === 'affected' ? ['--affected'] : []),
  ];
}

// Single sources: the full list is the scripts directory, the repository list comes from the
// classifier's allowlist, so a new script needs no edit here.
export const fullTests = () =>
  readdirSync(new URL('./', import.meta.url))
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => `scripts/${name}`);
export const repositoryTests = () =>
  [...repositoryFiles].filter((file) => file.endsWith('.test.mjs')).sort();
export const repositoryTargets = () =>
  [...repositoryFiles].filter((file) => file.endsWith('.mjs')).sort();

export function checks({ full, repository, mode }) {
  const commands = [['npm', ['run', 'format:check']]];
  if (full)
    commands.push(
      ['npx', ['eslint', '.', '--max-warnings', '0']],
      ['npm', ['run', 'release:check']],
      ['node', ['--test', ...fullTests()]],
      ['npm', ['run', 'tofu:fmt:check']],
      ['npx', workspaceArguments(mode)],
    );
  else if (repository)
    commands.push(
      ['npx', ['eslint', ...repositoryTargets(), '--max-warnings', '0']],
      ['node', ['--test', ...repositoryTests()]],
    );
  return commands;
}

export async function runChecks(commands, run = runCommand) {
  // Await every result so a failure cannot leave a successful deployment gate.
  const results = await Promise.all(
    commands.map(([command, args]) => run(command, args)),
  );
  if (results.some((code) => code !== 0))
    throw new Error('One or more CI checks failed');
}

function runCommand(command, args) {
  console.log(`Starting ${command} ${args.join(' ')}`);
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', (error) => {
      console.error(error);
      resolve(1);
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function main() {
  const { CI_BASE: base, CI_HEAD: head, CI_EVENT: event } = process.env;
  if (
    !/^[0-9a-f]{40}$/.test(base ?? '') ||
    !/^[0-9a-f]{40}$/.test(head ?? '') ||
    !['pull_request', 'push'].includes(event)
  )
    throw new Error('Expected committed CI base/head and event');
  if (
    ![process.env.CI_FULL, process.env.CI_REPOSITORY].every((value) =>
      ['true', 'false'].includes(value),
    )
  )
    throw new Error('Expected explicit baseline scope flags');
  const full = process.env.CI_FULL === 'true';
  const repository = process.env.CI_REPOSITORY === 'true';
  const paths = changedPaths(base, head, event);
  const mode = workspaceMode(paths, event);
  process.env.TURBO_SCM_BASE = diffBase(base, head, event);
  process.env.TURBO_SCM_HEAD = head;
  console.log(`Workspace validation: ${full ? mode : 'none'}`);
  if (full) {
    // Lint reads shared declarations. Build them once before concurrent readers.
    if ((await runCommand('npm', ['run', 'build:shared'])) !== 0)
      throw new Error('Shared build failed');
  }
  await runChecks(checks({ full, repository, mode }));
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Workspace validation: ${full ? mode : 'none'}; all selected checks passed.\n`,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
