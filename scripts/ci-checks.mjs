import { spawn } from 'node:child_process';
import { appendFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// `build` already type-checks every source and test file, so CI skips the
// separate `typecheck` task that local `npm run check` keeps.
const jobTasks = {
  static: ['build', 'ci:test'],
  // Only this job needs Docker: it synthesizes and verifies the ARM64 bundles.
  bundle: ['ci:synth', 'verify:bundle'],
};

// GitHub automation scripts never feed a build or deployment, so their tests
// run only when the repository scope selects them, not on every full gate.
export const automationTests = [
  'scripts/issue-triage.test.mjs',
  'scripts/issue-pr-metadata.test.mjs',
  'scripts/issue-pr-status.test.mjs',
  'scripts/issue-project-membership.test.mjs',
  'scripts/branch-name.test.mjs',
  'scripts/agent-policy.test.mjs',
];

const automationLintTargets = [
  'scripts/ci-scope.mjs',
  'scripts/issue-triage.mjs',
  'scripts/issue-containers.mjs',
  'scripts/issue-pr-metadata.mjs',
  'scripts/issue-pr-status.mjs',
  'scripts/issue-project-membership.mjs',
  'scripts/branch-name.mjs',
  'scripts/agent-policy.mjs',
  ...automationTests,
];

// Every other scripts/*.test.mjs belongs to the full gate. Listing the
// directory keeps new build and deployment tests in it without editing here.
export function buildTests(
  directory = fileURLToPath(new URL('.', import.meta.url)),
) {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => `scripts/${name}`)
    .filter((path) => !automationTests.includes(path))
    .sort();
}

export function workspaceArguments(mode, job = 'static') {
  return [
    'turbo',
    'run',
    ...jobTasks[job],
    '--concurrency=4',
    '--summarize',
    ...(mode === 'affected' ? ['--affected'] : []),
  ];
}

export function checks({ full, repository, mode, job = 'static' }) {
  if (job === 'bundle')
    return full ? [['npx', workspaceArguments(mode, 'bundle')]] : [];
  const commands = [['npm', ['run', 'format:check']]];
  if (full)
    commands.push(
      ['npx', ['eslint', '.', '--max-warnings', '0']],
      ['npm', ['run', 'release:check']],
      ['node', ['--test', ...buildTests()]],
      ['npx', workspaceArguments(mode)],
    );
  // The full gate's `eslint .` lints every file. Otherwise lint Markdown, which
  // Prettier ignores, plus the automation scripts in the repository scope.
  else
    commands.push([
      'npx',
      [
        'eslint',
        ...(repository ? automationLintTargets : []),
        '**/*.md',
        '--max-warnings',
        '0',
      ],
    ]);
  if (repository) {
    // Generated agent definitions must match their sources under .agents/.
    commands.push(['npm', ['run', 'agents:check']]);
    commands.push(['node', ['--test', ...automationTests]]);
  }
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
  const { CI_BASE: base, CI_HEAD: head } = process.env;
  if (!/^[0-9a-f]{40}$/.test(base ?? '') || !/^[0-9a-f]{40}$/.test(head ?? ''))
    throw new Error('Expected committed CI base/head');
  if (
    ![process.env.CI_FULL, process.env.CI_REPOSITORY].every((value) =>
      ['true', 'false'].includes(value),
    )
  )
    throw new Error('Expected explicit baseline scope flags');
  const full = process.env.CI_FULL === 'true';
  const repository = process.env.CI_REPOSITORY === 'true';
  // The scope job diffs once and decides the mode with the baseline classifier.
  const mode = process.env.CI_MODE;
  if (!['affected', 'all'].includes(mode))
    throw new Error('Expected an explicit workspace mode');
  process.env.TURBO_SCM_BASE = base;
  process.env.TURBO_SCM_HEAD = head;
  const job = process.env.CI_JOB ?? 'static';
  if (!(job in jobTasks)) throw new Error('Expected a known CI job');
  console.log(`Workspace validation (${job}): ${full ? mode : 'none'}`);
  if (full && job === 'static') {
    // Lint reads shared declarations. Build them once before concurrent readers.
    if ((await runCommand('npm', ['run', 'build:shared'])) !== 0)
      throw new Error('Shared build failed');
  }
  await runChecks(checks({ full, repository, mode, job }));
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Workspace validation (${job}): ${full ? mode : 'none'}; all selected checks passed.\n`,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
