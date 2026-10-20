import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CliHelp, defineCli, parseCli } from './cli.cjs';
import { run as branch } from './branch-name.mjs';
import { configuration } from './issue-triage.mjs';
// Operator CLI modules load the compiled shared packages when imported.
if (
  ['roster', 'recipients'].some(
    (name) =>
      !existsSync(
        new URL(`../packages/${name}/dist/index.js`, import.meta.url),
      ),
  )
)
  execFileSync('npm', ['run', 'build:shared', '--silent'], {
    cwd: new URL('..', import.meta.url),
    stdio: 'pipe',
  });
const { parseArguments: roster, main: rosterMain } =
  await import('./roster.mjs');
const { parseArguments: recipients, main: recipientsMain } =
  await import('./recipients.mjs');

const cli = defineCli('Usage: example [options]', [
  'environment',
  'ephemeral',
  'profile',
  'yes',
]);

test('exact aliases, equals forms, and values preserve their meaning', () => {
  for (const args of [
    ['--environment', 'dev', '--ephemeral', 'alice', '--profile', 'local'],
    ['-env', 'dev', '-e', 'alice', '-p', 'local'],
    ['--environment=dev', '--ephemeral=alice', '--profile=local'],
    ['-env=dev', '-e=alice', '-p=local'],
  ])
    assert.deepEqual(parseCli(args, cli).options, {
      environment: 'dev',
      ephemeral: 'alice',
      profile: 'local',
    });
  assert.deepEqual(
    parseCli(['-p=--ephemeral=x', '--', '-env', 'prod', '--help'], cli),
    {
      options: { profile: '--ephemeral=x' },
      positionals: ['-env', 'prod', '--help'],
      passthrough: [],
    },
  );
  assert.equal(
    parseCli(['-p', 'space = value'], cli).options.profile,
    'space = value',
  );
  assert.throws(() => parseCli(['-p='], cli), /requires a value/);
  assert.equal(
    parseCli(['--reason='], defineCli('Usage: reason', ['reason'])).options
      .reason,
    '',
  );
});

test('known spellings reject duplicates, missing values, grouped flags, and unknowns', () => {
  for (const args of [
    ['-env', 'dev', '--environment=prod'],
    ['--environment', 'dev', '-env=dev'],
    ['-e', 'alice', '--ephemeral', 'bob'],
    ['-y', '--yes'],
    ['--profile'],
    ['-env'],
    ['-env', '-e', 'alice'],
    ['-e', '--'],
    ['-e', '--unknown'],
    ['-environment=dev'],
    ['-envprod'],
    ['-ealice'],
    ['-yp'],
    ['--unknown'],
    ['--yes=false'],
    ['-e='],
    ['-env='],
  ])
    assert.throws(() => parseCli(args, cli), /Usage: example/, args.join(' '));
  assert.throws(
    () => defineCli('Usage: collision', ['actor', 'application']),
    /Duplicate CLI spelling -a/,
  );
  for (const flag of ['-h', '--help'])
    assert.throws(() => parseCli([flag], cli), CliHelp);
});

test('roster and recipients share aliases, operands, conflicts, and effect-free help', async () => {
  for (const [parse, main] of [
    [roster, rosterMain],
    [recipients, recipientsMain],
  ]) {
    const parsed = parse([
      '-env=dev',
      '-e',
      'alice',
      '-p',
      'local',
      'add',
      '-r=--help',
      '-y',
      '--',
      '-env',
    ]);
    assert.deepEqual(parsed, {
      command: 'add',
      operands: ['-env'],
      options: {
        environment: 'dev',
        ephemeral: 'alice',
        profile: 'local',
        reason: '--help',
        yes: true,
      },
    });
    const long = [
      '--environment',
      'dev',
      '--ephemeral',
      'alice',
      '--profile',
      'local',
      'list',
    ];
    assert.deepEqual(
      parse(['-env', 'dev', '-e', 'alice', '-p', 'local', 'list']),
      parse(long),
    );
    const output = [];
    const deps = {
      stdout: (text) => output.push(text),
      stderr: (text) => output.push(text),
      awsCli: () => assert.fail('AWS called'),
      env: {},
    };
    assert.equal(await main(['-h'], deps), 0);
    for (const args of [
      ['-env=dev', '--environment=prod', 'list'],
      ['-env=dev', 'list', '--all', '--inactive'],
      ['-env'],
    ])
      assert.equal(await main(args, deps), 2);
    assert.ok(output.some((text) => text.includes('-env')));
  }
});

test('branch and tracker aliases preserve machine results and dry-run defaults', () => {
  const api = () => '{"title":"Example"}';
  assert.equal(
    branch(['-a=sam', '-l=2', '--', '285'], { api }),
    'sam/285-example-part-2',
  );
  assert.throws(
    () =>
      branch(['--actor=sam', '-a=agent', '285'], {
        api: () => assert.fail('GitHub called'),
      }),
    /more than once/,
  );
  assert.deepEqual(configuration({}, ['-i=42', '-n']), {
    issueNumber: 42,
    dryRun: true,
  });
  assert.deepEqual(configuration({ DRY_RUN: 'false' }, ['-n']), {
    dryRun: true,
  });
  assert.deepEqual(configuration({}, ['--apply', '-i', '42']), {
    issueNumber: 42,
    dryRun: false,
  });
  assert.throws(
    () => configuration({}, ['--apply', '-n']),
    /Use --dry-run or --apply/,
  );
  assert.throws(
    () => configuration({}, ['-i=42', '--issue=43']),
    /more than once/,
  );
});

const node = (script, args, env = {}) =>
  spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { PATH: '/nonexistent', ...env },
  });

test('all root CLI entries help and reject malformed input without subprocesses', () => {
  for (const [script, prefix, invalid, status] of [
    ['cdk-app', ['deploy', 'admin'], ['-env=dev', '--environment=prod'], 1],
    ['roster', [], ['--unknown'], 2],
    ['recipients', [], ['--unknown'], 2],
    ['sender-allowlist', [], ['--unknown'], 2],
    ['branch-name', [], ['285', '-a=sam', '--actor=other'], 1],
    ['release-metadata', [], ['--unknown'], 1],
    ['issue-triage', [], ['--apply', '-n'], 1],
    ['issue-containers', [], ['--apply', '-n'], 1],
    ['agent-policy', ['generate'], ['--unknown'], 1],
  ]) {
    for (const help of ['--help', '-h']) {
      const result = node(`scripts/${script}.mjs`, [...prefix, help], {
        GITHUB_ACTIONS: 'true',
        DRY_RUN: 'invalid',
      });
      assert.equal(result.status, 0, `${script}: ${result.stderr}`);
      assert.match(result.stdout, /Usage:/);
      assert.equal(result.stderr, '');
    }
    const result = node(`scripts/${script}.mjs`, [...prefix, ...invalid]);
    assert.equal(result.status, status, `${script}: ${result.stderr}`);
    assert.match(result.stderr, /Usage:/);
    assert.equal(result.stdout, '');
  }
});

test('release and agent commands preserve JSON output with aliases and equals', () => {
  const release = node('scripts/release-metadata.mjs', ['-a=match-to-csv']);
  assert.equal(release.status, 0, release.stderr);
  assert.equal(
    JSON.parse(release.stdout).application.name,
    '@mcc/match-to-csv',
  );
  const policy = node('scripts/agent-policy.mjs', [
    'resolve',
    '-t=codex',
    '--role=implementer',
    '-m=gpt-6.1-sol',
    '--effort=high',
  ]);
  assert.equal(policy.status, 0, policy.stderr);
  assert.equal(JSON.parse(policy.stdout).spawn.agent_type, 'mcc-implementer');
  for (const args of [
    ['resolve', '--tool=codex', '-t=claude'],
    [
      'resolve',
      '-t=codex',
      '--role=implementer',
      '--capability=implementation',
    ],
  ]) {
    const result = node('scripts/agent-policy.mjs', args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  }
});

test('CDK passthrough remains byte-for-byte in order and guards run before effects', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mcc-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, 'calls');
  const tool = `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.appendFileSync(process.env.CLI_LOG, JSON.stringify({tool:require('node:path').basename(process.argv[1]),args})+'\\n'); if(process.argv[1].endsWith('/aws')) console.log(JSON.stringify({Account:'111111111111',Arn:'test-caller'}));`;
  for (const name of ['aws', 'git', 'npm']) {
    writeFileSync(join(directory, name), tool);
    chmodSync(join(directory, name), 0o755);
  }
  const env = {
    PATH: directory,
    CLI_LOG: log,
    AWS_PROFILE: 'mcc-dev',
    MCC_DEV_ACCOUNT_ID: '111111111111',
  };
  const forwarded = [
    '--verbose',
    '--output=some path',
    '--require-approval',
    'never',
    '--',
    '-env=prod',
    '-e=literal',
  ];
  const result = node(
    'scripts/cdk-app.mjs',
    ['diff', 'admin', '-env=dev', '-e=alice', '-p=mcc-dev', ...forwarded],
    env,
  );
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls[1].tool, 'aws');
  assert.deepEqual(calls.at(-1).args.slice(-forwarded.length), forwarded);
  assert.deepEqual(calls.at(-1).args.slice(0, 8), [
    'run',
    'cdk:diff',
    '--workspace',
    '@mcc/admin',
    '--',
    '-c',
    'environment=dev',
    '-c',
  ]);
  for (const prohibited of [
    ['--hotswap'],
    ['--watch'],
    ['--roleArn=other'],
    ['--toolkit-stack-name=other'],
    ['--changeSetName=other'],
    ['-r', 'other'],
    ['-vm', 'direct'],
    ['--method=change-set'],
    ['-c', 'environment=prod'],
    ['--context=environment=prod'],
    ['-cenvironment=prod'],
    ['--', '--hotswap'],
  ]) {
    writeFileSync(log, '');
    const refused = node(
      'scripts/cdk-app.mjs',
      ['deploy', 'admin', '-env=dev', '-e=alice', ...prohibited],
      env,
    );
    assert.equal(refused.status, 1, prohibited.join(' '));
    assert.equal(readFileSync(log, 'utf8'), '', prohibited.join(' '));
  }
  for (const args of [
    ['deploy', 'admin', '-env=dev'],
    ['destroy', 'admin', '-env=dev'],
    ['diff', 'admin', '-env=prod', '-e=alice'],
    ['diff', 'admin', '-env=dev', '-p=mcc-prod'],
    ['diff', 'admin', '-env=dev', '-e=alice', '--ephemeral=bob'],
  ]) {
    writeFileSync(log, '');
    assert.equal(node('scripts/cdk-app.mjs', args, env).status, 1);
    assert.equal(readFileSync(log, 'utf8'), '');
  }
});
