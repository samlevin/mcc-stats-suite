import { spawn } from 'node:child_process';
import { appendFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// `build` already type-checks every source and test file, so CI skips the
// separate `typecheck` task that local `npm run check` keeps.
const jobTasks = {
  static: ['build', 'ci:test'],
  // The root build tests run as the cached `//#test:scripts` on their own
  // runner, so they do not compete with the workspace tests for CPUs.
  scripts: ['test:scripts'],
  // Only this job needs Docker: it synthesizes and verifies the ARM64 bundles.
  bundle: ['ci:synth', 'verify:bundle'],
};

// The shared CLI also feeds builds, so the full gate tests it as a build test
// and the repository scope adds it for repository-only changes.
const sharedBuildTests = ['scripts/cli.test.mjs'];

const automationLintTargets = [
  'scripts/ci-scope.mjs',
  'scripts/cli.cjs',
  'scripts/cli.test.mjs',
];

// Every scripts/*.test.mjs belongs to the full gate. Listing the directory
// keeps new build and deployment tests in it without editing here.
export function buildTests(
  directory = fileURLToPath(new URL('.', import.meta.url)),
) {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => `scripts/${name}`)
    .sort();
}

export function workspaceArguments(mode, job = 'static', base, head) {
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
    // The root package owns `//#test:scripts`, which runs on every full gate.
    // For workspaces, the explicit range selects the same ones as `--affected`.
    ...(job === 'scripts'
      ? ['--filter=//']
      : mode === 'affected'
        ? [`--filter=...[${base}...${head}]`]
        : []),
  ];
}

export function checks({ full, repository, mode, job = 'static', base, head }) {
  if (job !== 'static')
    return full ? [['npx', workspaceArguments(mode, job, base, head)]] : [];
  const commands = [['npm', ['run', 'format:check']]];
  if (full)
    commands.push(
      ['npx', ['eslint', '.', '--max-warnings', '0']],
      ['npm', ['run', 'release:check']],
      ['npx', workspaceArguments(mode, 'static', base, head)],
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
  if (full || repository)
    // Generated and synced agent files must match the installed
    // @agenticool/agents, and every workflow must pass the shared lint.
    commands.push(
      ['npm', ['run', 'agents:check']],
      ['npm', ['run', 'workflows:lint']],
    );
  if (repository && !full)
    commands.push(['node', ['--test', ...sharedBuildTests]]);
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
  await runChecks(checks({ full, repository, mode, job, base, head }));
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Workspace validation (${job}): ${full ? mode : 'none'}; all selected checks passed.\n`,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  // `npm run test:scripts`, which Turbo caches as `//#test:scripts`.
  if (process.argv[2] === 'build-tests')
    spawn(process.execPath, ['--test', ...buildTests()], {
      stdio: 'inherit',
    }).on('close', (code) => (process.exitCode = code ?? 1));
  else
    try {
      await main();
    } catch (error) {
      // End the log with the failure summary instead of a stack trace.
      console.error(error.message);
      process.exitCode = 1;
    }
