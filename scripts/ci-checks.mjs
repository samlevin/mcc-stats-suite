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
  'scripts/issue-containers.test.mjs',
  'scripts/issue-pr-metadata.test.mjs',
  'scripts/issue-pr-status.test.mjs',
  'scripts/issue-project-membership.test.mjs',
  'scripts/branch-name.test.mjs',
  'scripts/agent-policy.test.mjs',
  'scripts/delivery-queue.test.mjs',
];

// Full-gate tests that also check files in the repository scope.
const sharedBuildTests = [
  'scripts/cli.test.mjs',
  'scripts/workflow-timeouts.test.mjs',
  'scripts/workflow-node-version.test.mjs',
  'scripts/workflow-checkout-credentials.test.mjs',
  'scripts/workflow-pull-request-target.test.mjs',
];

const automationLintTargets = [
  'scripts/ci-scope.mjs',
  'scripts/cli.cjs',
  'scripts/cli.test.mjs',
  'scripts/issue-triage.mjs',
  'scripts/issue-containers.mjs',
  'scripts/issue-pr-metadata.mjs',
  'scripts/issue-pr-status.mjs',
  'scripts/issue-project-membership.mjs',
  'scripts/branch-name.mjs',
  'scripts/agent-policy.mjs',
  'scripts/delivery-queue.mjs',
  ...automationTests,
  'scripts/workflow-node-version.test.mjs',
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
    // In GitHub Actions Turbo prints its own `::group::` per task by default.
    // Groups do not nest, so stream prefixed lines and keep the whole Turbo
    // output inside the one group `runChecks` opens for this command.
    '--log-order=stream',
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
    // CLI compatibility covers automation and build consumers, and the
    // workflow timeout, Node version, checkout credentials, and
    // pull_request_target tests cover the workflows in this scope. The full gate already runs all of them, so add
    // them here only for repository-only changes.
    commands.push([
      'node',
      ['--test', ...automationTests, ...(!full ? sharedBuildTests : [])],
    ]);
  }
  return commands;
}

// Every Turbo run under `runChecks` inherits these, including the one inside
// `npm run build:shared`. Streamed output keeps Turbo from opening its own
// `::group::` per task inside the check's group.
export function turboEnvironment(base, head) {
  return {
    TURBO_SCM_BASE: base,
    TURBO_SCM_HEAD: head,
    TURBO_LOG_ORDER: 'stream',
  };
}

function commandLine(command, args) {
  return [command, ...args].join(' ');
}

// Checks run in parallel, so each one's output is buffered and printed in its
// own log group when that check ends. A `Started` line outside any group marks
// each check's start, so a timed-out or cancelled run still shows which checks
// were running. Every check settles before the gate fails, so a failure cannot
// leave a successful deployment gate, and the error names each failed command
// with its exit code.
export async function runChecks(
  commands,
  run = runCommand,
  write = (text) => process.stdout.write(text),
) {
  const results = await Promise.all(
    commands.map(async ([command, args]) => {
      const line = commandLine(command, args);
      write(`Started ${line}\n`);
      const { code, output } = await run(command, args);
      write(`::group::${line}\n`);
      if (output) write(output.endsWith('\n') ? output : `${output}\n`);
      write('::endgroup::\n');
      return { line, code };
    }),
  );
  const failed = results.filter(({ code }) => code !== 0);
  if (failed.length > 0)
    throw new Error(
      [
        `${failed.length} of ${results.length} CI checks failed:`,
        ...failed.map(({ line, code }) => `  ${line} (exit code ${code})`),
      ].join('\n'),
    );
}

// Collects stdout and stderr together in the order they arrive.
function runCommand(command, args) {
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolve({ code, output: Buffer.concat(chunks).toString() });
    };
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    child.on('error', (error) => {
      chunks.push(Buffer.from(`${error.stack ?? error}\n`));
      finish(1);
    });
    child.on('close', (code) => finish(code ?? 1));
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
  Object.assign(process.env, turboEnvironment(base, head));
  const job = process.env.CI_JOB ?? 'static';
  if (!(job in jobTasks)) throw new Error('Expected a known CI job');
  console.log(`Workspace validation (${job}): ${full ? mode : 'none'}`);
  if (full && job === 'static') {
    // Lint reads shared declarations. Build them once before concurrent readers.
    await runChecks([['npm', ['run', 'build:shared']]]);
  }
  await runChecks(checks({ full, repository, mode, job }));
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Workspace validation (${job}): ${full ? mode : 'none'}; all selected checks passed.\n`,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  try {
    await main();
  } catch (error) {
    // End the log with the failure summary instead of a stack trace.
    console.error(error.message);
    process.exitCode = 1;
  }
