import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isApplicationPath } from './ci-scope.mjs';

export function workspaceMode(paths, event) {
  // Root configuration, infrastructure and unknown paths require every workspace.
  return event === 'pull_request' &&
    paths.length > 0 &&
    paths.every(isApplicationPath)
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

export function checks({ full, repository, mode }) {
  const commands = [['npm', ['run', 'format:check']]];
  if (full)
    commands.push(
      ['npx', ['eslint', '.', '--max-warnings', '0']],
      ['npm', ['run', 'release:check']],
      [
        'node',
        [
          '--test',
          'scripts/issue-triage.test.mjs',
          'scripts/issue-pr-metadata.test.mjs',
          'scripts/issue-pr-status.test.mjs',
          'scripts/ci-checks.test.mjs',
          'scripts/publish-packages.test.mjs',
          'scripts/deployment-workflows.test.mjs',
        ],
      ],
      ['npx', workspaceArguments(mode)],
    );
  else if (repository)
    commands.push(
      [
        'npx',
        [
          'eslint',
          'scripts/ci-scope.mjs',
          'scripts/issue-triage.mjs',
          'scripts/issue-containers.mjs',
          'scripts/issue-triage.test.mjs',
          '--max-warnings',
          '0',
        ],
      ],
      ['node', ['--test', 'scripts/issue-triage.test.mjs']],
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
  const diffBase =
    event === 'pull_request'
      ? execFileSync('git', ['merge-base', base, head], {
          encoding: 'utf8',
        }).trim()
      : base;
  const paths = execFileSync(
    'git',
    ['diff', '--name-only', '--no-renames', '-z', diffBase, head],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
  const mode = workspaceMode(paths, event);
  process.env.TURBO_SCM_BASE = diffBase;
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
