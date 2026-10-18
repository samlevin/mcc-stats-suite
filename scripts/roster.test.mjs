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
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { awsCli } from './account-guard.mjs';

// The script folds with the compiled @mcc/roster package.
if (!existsSync('packages/roster/dist/index.js'))
  execFileSync('npm', ['run', 'build:shared', '--silent'], {
    stdio: 'inherit',
  });
const { CHANGE_PAGE_ITEMS, MAX_WRITE_ATTEMPTS, main, parseArguments } =
  await import('./roster.mjs');
const { foldRoster, rosterSha256 } = createRequire(import.meta.url)(
  '../packages/roster/dist/index.js',
);

const DEV = '111111111111';
const PROD = '333333333333';
const OTHER = '222222222222';
const ARN = `arn:aws:sts::${DEV}:assumed-role/AWSReservedSSO_Admin/operator`;
const TABLE = 'mcc-stats-suite-dev-gamertag-roster';
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// An in-memory roster table behind the AWS CLI commands the script runs. It
// evaluates the two conditions spec 1.2 §6.1 uses, so a test can move HEAD
// between a read and a write, or lose a committed write's response.
function fakeAws({ account = DEV, arn = ARN, table = TABLE } = {}) {
  const items = new Map();
  const calls = [];
  const fake = {
    items,
    calls,
    profiles: [],
    beforeTransaction: [],
    ids: 0,
    conditionFailures: 0,
    lostResponses: 0,
    transportFailures: 0,
    factory(profile) {
      fake.profiles.push(profile);
      return (args) => fake.run(args);
    },
    run(args) {
      calls.push(args);
      const [service, operation] = args;
      const flag = (name) => args[args.indexOf(name) + 1];
      if (service === 'sts' && operation === 'get-caller-identity') {
        return ok(JSON.stringify({ Account: account, Arn: arn }));
      }
      if (service === 'configure') return ok(`${DEV}\n`);
      if (service === 'ssm' && operation === 'get-parameter') {
        return flag('--name').endsWith('/roster/table-name')
          ? ok(`${table}\n`)
          : failed('ParameterNotFound');
      }
      assert.equal(service, 'dynamodb');
      if (operation === 'get-item') {
        assert.ok(
          args.includes('--consistent-read'),
          'HEAD read is consistent',
        );
        const key = JSON.parse(flag('--key'));
        const item = items.get(`${key.pk.S}|${key.sk.S}`);
        return ok(item ? JSON.stringify({ Item: item }) : '');
      }
      if (operation === 'query') {
        assert.ok(
          args.includes('--consistent-read'),
          'change reads are consistent',
        );
        assert.equal(
          flag('--key-condition-expression'),
          'pk = :pk AND sk BETWEEN :first AND :last',
        );
        const values = JSON.parse(flag('--expression-attribute-values'));
        const found = [...items.values()]
          .filter(
            (item) =>
              item.pk.S === values[':pk'].S &&
              item.sk.S >= values[':first'].S &&
              item.sk.S <= values[':last'].S,
          )
          .sort((left, right) => (left.sk.S < right.sk.S ? -1 : 1));
        return ok(JSON.stringify(page(args, found)));
      }
      if (operation === 'transact-write-items') {
        fake.beforeTransaction.shift()?.();
        if (fake.conditionFailures > 0) {
          fake.conditionFailures -= 1;
          return failed(
            'An error occurred (TransactionCanceledException) when calling the TransactWriteItems operation: ' +
              'Transaction cancelled, please refer cancellation reasons for specific reasons [None, TransactionConflict]',
          );
        }
        if (fake.transportFailures > 0) {
          fake.transportFailures -= 1;
          return failed('Could not connect to the endpoint URL');
        }
        const puts = JSON.parse(flag('--transact-items')).map(
          (entry) => entry.Put,
        );
        const reasons = puts.map((put) => {
          const existing = items.get(`${put.Item.pk.S}|${put.Item.sk.S}`);
          if (put.ConditionExpression === 'attribute_not_exists(sk)') {
            return existing ? 'ConditionalCheckFailed' : 'None';
          }
          assert.equal(put.ConditionExpression, 'rosterVersion = :version');
          return existing?.rosterVersion.N ===
            put.ExpressionAttributeValues[':version'].N
            ? 'None'
            : 'ConditionalCheckFailed';
        });
        if (reasons.some((reason) => reason !== 'None')) {
          return failed(
            'An error occurred (TransactionCanceledException) when calling the TransactWriteItems operation: ' +
              `Transaction cancelled, please refer cancellation reasons for specific reasons [${reasons.join(', ')}]`,
          );
        }
        for (const put of puts) {
          items.set(`${put.Item.pk.S}|${put.Item.sk.S}`, put.Item);
        }
        if (fake.lostResponses > 0) {
          fake.lostResponses -= 1;
          return failed('Read timeout on endpoint URL');
        }
        return ok('{}');
      }
      throw new Error(`Unexpected AWS call ${args.join(' ')}`);
    },
    transactions: () =>
      calls.filter((args) => args[1] === 'transact-write-items'),
    lastTransaction() {
      const args = fake.transactions().at(-1);
      return JSON.parse(args[args.indexOf('--transact-items') + 1]);
    },
    changes: (pk = 'ROSTER#stable') =>
      [...items.values()]
        .filter((item) => item.pk.S === pk && item.sk.S.startsWith('CHANGE#'))
        .sort((left, right) => (left.sk.S < right.sk.S ? -1 : 1)),
  };
  return fake;
}

// One AWS CLI query response with automatic pagination bounded by
// --max-items: up to that many items after --starting-token, and a NextToken
// when more remain. The token is opaque to the script.
function page(args, found) {
  const flag = (name) =>
    args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const maxItems = Number(flag('--max-items'));
  assert.ok(
    Number.isSafeInteger(maxItems) && maxItems > 0,
    'change reads are paged',
  );
  assert.equal(flag('--page-size'), String(maxItems));
  const start = flag('--starting-token')
    ? Number(Buffer.from(flag('--starting-token'), 'base64').toString())
    : 0;
  const end = start + maxItems;
  const Items = found.slice(start, end);
  return {
    Items,
    Count: Items.length,
    ...(end < found.length
      ? { NextToken: Buffer.from(String(end)).toString('base64') }
      : {}),
  };
}

// A `count`-version change log for one entry in DynamoDB's typed JSON, as the
// script writes it: an add, then deactivate and reactivate in turn, each with
// a reason of the longest allowed length. Returns `{ head, changes }`.
function changeLog(count) {
  const changes = [];
  let roster;
  for (let version = 1; version <= count; version += 1) {
    const change = {
      rosterVersion: version,
      action:
        version === 1 ? 'ADD' : version % 2 === 0 ? 'DEACTIVATE' : 'REACTIVATE',
      gamertagId: 'mbx001-entry',
      gamertag: 'Player01',
    };
    roster = foldRoster([change], roster);
    changes.push({
      pk: { S: 'ROSTER#stable' },
      sk: { S: `CHANGE#${String(version).padStart(10, '0')}` },
      schemaVersion: { S: 'roster-change/v1' },
      namespace: { S: 'stable' },
      rosterVersion: { N: String(version) },
      action: { S: change.action },
      gamertagId: { S: change.gamertagId },
      gamertag: { S: change.gamertag },
      reason: { S: `${version} `.padEnd(256, 'r') },
      actorArn: { S: ARN },
      clientRequestId: { S: crypto.randomUUID() },
      changedAt: { S: '2026-10-18T12:00:00.000Z' },
      rosterSha256: { S: rosterSha256(roster.entries) },
    });
  }
  const head = {
    pk: { S: 'ROSTER#stable' },
    sk: { S: 'HEAD' },
    rosterVersion: { N: String(count) },
    rosterSha256: changes.at(-1).rosterSha256,
    updatedAt: { S: '2026-10-18T12:00:00.000Z' },
  };
  return { head, changes };
}

function ok(stdout) {
  return { status: 0, stdout, stderr: '' };
}

function failed(message) {
  return { status: 254, stdout: '', stderr: `\n${message}\n` };
}

// Runs the script against `aws` and returns its exit status and output.
async function roster(argv, { aws = fakeAws(), env, answers = [] } = {}) {
  let out = '';
  let err = '';
  const prompts = [];
  const status = await main(argv, {
    env: env ?? { AWS_PROFILE: 'mcc-dev-admin', MCC_DEV_ACCOUNT_ID: DEV },
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    awsCli: (profile) => aws.factory(profile),
    uuid: () => crypto.randomUUID(),
    evidenceId: () => `mbx${String((aws.ids += 1)).padStart(3, '0')}-entry`,
    now: () => new Date('2026-10-18T12:00:00.000Z'),
    confirm: async (question) => {
      prompts.push(question);
      return answers.shift() ?? '';
    },
  });
  return { status, out, err, prompts, aws };
}

const dev = (...args) => ['--environment', 'dev', ...args];

test('arguments follow spec 1.2 §4.2', () => {
  assert.deepEqual(
    parseArguments([
      'add',
      'Player01',
      '--environment',
      'dev',
      'Player 02',
      '--reason',
      'joined',
    ]),
    {
      command: 'add',
      operands: ['Player01', 'Player 02'],
      options: { environment: 'dev', reason: 'joined' },
    },
  );
  assert.deepEqual(
    parseArguments(['--environment', 'prod', 'history', '--after', '0']),
    {
      command: 'history',
      operands: [],
      options: { environment: 'prod', after: 0 },
    },
  );
  assert.deepEqual(
    parseArguments(dev('--ephemeral', 'alice', 'list', '--all')).options,
    { environment: 'dev', ephemeral: 'alice', all: true },
  );
});

test('usage errors exit 2 before any AWS call', async () => {
  for (const [argv, message] of [
    [['list'], /--environment is required/],
    [dev(), /Name a command/],
    [dev('remove', 'Player01'), /Unknown command remove/],
    [dev('list', '--file', 'roster.json'), /Unknown option --file/],
    [dev('list', '--reason', 'x'), /list does not accept --reason/],
    [dev('list', '--inactive', '--all'), /cannot be combined/],
    [dev('list', 'Player01'), /list takes no gamertag/],
    [dev('history', '--after', '-1'), /--after must be a roster version/],
    [dev('history', '--after', '1.5'), /--after must be a roster version/],
    [dev('add'), /add takes at least one gamertag/],
    [dev('deactivate', 'Player01', 'Player02'), /takes exactly one gamertag/],
    [dev('reactivate', 'Player01', '--after', '2'), /does not accept --after/],
    [dev('add', 'Player01', '--reason'), /--reason requires a value/],
    [dev('list', '--environment', 'dev'), /given more than once/],
    [dev('history', '--yes'), /history does not accept --yes/],
  ]) {
    const result = await roster(argv);
    assert.equal(result.status, 2, argv.join(' '));
    assert.match(result.err, message, argv.join(' '));
    assert.match(result.err, /Usage: npm run roster/);
    assert.deepEqual(result.aws.calls, [], argv.join(' '));
  }
});

test('the account check refuses before any roster request', async () => {
  for (const [argv, env, message] of [
    [
      ['--environment', 'prod', '--ephemeral', 'alice', 'list'],
      { AWS_PROFILE: 'mcc-prod-admin', MCC_PROD_ACCOUNT_ID: PROD },
      /^Production does not support --ephemeral$/m,
    ],
    [dev('--ephemeral', 'dev', 'list'), undefined, /reserved/],
    [dev('--ephemeral', 'Sam', 'list'), undefined, /Ephemeral names must/],
    [
      dev('list'),
      { AWS_PROFILE: 'mcc-prod-admin', MCC_DEV_ACCOUNT_ID: DEV },
      /AWS_PROFILE=mcc-prod-admin looks like prod, not dev/,
    ],
    [
      dev('list'),
      { MCC_DEV_ACCOUNT_ID: DEV },
      /Export AWS_PROFILE or pass --profile/,
    ],
    [
      dev('list'),
      { AWS_PROFILE: 'mcc-dev-admin', MCC_DEV_ACCOUNT_ID: '12345' },
      /must contain a 12-digit AWS account ID/,
    ],
  ]) {
    const result = await roster(argv, { env });
    assert.equal(result.status, 2, argv.join(' '));
    assert.match(result.err, message, argv.join(' '));
    assert.deepEqual(result.aws.calls, [], argv.join(' '));
  }
});

test('a mismatched account sends no roster request', async () => {
  const aws = fakeAws({ account: OTHER });
  const result = await roster(dev('add', 'Player01', '--yes'), { aws });
  assert.equal(result.status, 2);
  assert.match(
    result.err,
    new RegExp(
      `Refusing roster add: active account ${OTHER} does not match MCC_DEV_ACCOUNT_ID \\(${DEV}\\)`,
    ),
  );
  assert.deepEqual(aws.calls, [
    ['sts', 'get-caller-identity', '--output', 'json'],
  ]);
});

test('the profile comes from --profile or AWS_PROFILE and sso_account_id fills in the account', async () => {
  const aws = fakeAws();
  const result = await roster(dev('--profile', 'mcc-dev-admin', 'list'), {
    aws,
    env: {},
  });
  assert.equal(result.status, 0, result.err);
  assert.deepEqual(aws.profiles, ['mcc-dev-admin']);
  assert.deepEqual(aws.calls.slice(0, 3), [
    ['configure', 'get', 'sso_account_id'],
    ['sts', 'get-caller-identity', '--output', 'json'],
    [
      'ssm',
      'get-parameter',
      '--name',
      '/mcc/dev/roster/table-name',
      '--query',
      'Parameter.Value',
      '--output',
      'text',
    ],
  ]);
  assert.match(result.out, new RegExp(`Using dev in AWS account ${DEV}`));
});

test('a missing table parameter exits 2 without a table request', async () => {
  const aws = fakeAws();
  aws.run = ((run) => (args) =>
    args[0] === 'ssm' ? failed('ParameterNotFound') : run(args))(aws.run);
  const result = await roster(dev('list'), { aws });
  assert.equal(result.status, 2);
  assert.match(
    result.err,
    /Unable to read the roster table name from \/mcc\/dev\/roster\/table-name/,
  );
  assert.ok(!aws.calls.some((args) => args[0] === 'dynamodb'));
});

test('the first add writes change 1 and HEAD under attribute_not_exists', async () => {
  const aws = fakeAws();
  const result = await roster(dev('add', '  Player01 ', '--reason', 'joined'), {
    aws,
  });
  assert.equal(result.status, 0, result.err);
  const [changePut, headPut] = aws.lastTransaction().map((entry) => entry.Put);
  assert.equal(changePut.TableName, TABLE);
  assert.equal(changePut.ConditionExpression, 'attribute_not_exists(sk)');
  assert.equal(headPut.ConditionExpression, 'attribute_not_exists(sk)');
  assert.equal(headPut.ExpressionAttributeValues, undefined);
  const item = changePut.Item;
  assert.deepEqual(
    { pk: item.pk.S, sk: item.sk.S, version: item.rosterVersion.N },
    { pk: 'ROSTER#stable', sk: 'CHANGE#0000000001', version: '1' },
  );
  assert.equal(item.schemaVersion.S, 'roster-change/v1');
  assert.equal(item.namespace.S, 'stable');
  assert.equal(item.action.S, 'ADD');
  assert.equal(item.gamertag.S, 'Player01');
  assert.equal(item.gamertagId.S, 'mbx001-entry');
  assert.equal(item.reason.S, 'joined');
  assert.equal(item.actorArn.S, ARN);
  assert.match(item.clientRequestId.S, UUID);
  assert.equal(item.changedAt.S, '2026-10-18T12:00:00.000Z');
  assert.deepEqual(headPut.Item, {
    pk: { S: 'ROSTER#stable' },
    sk: { S: 'HEAD' },
    rosterVersion: { N: '1' },
    rosterSha256: item.rosterSha256,
    updatedAt: { S: '2026-10-18T12:00:00.000Z' },
  });
  assert.match(
    result.out,
    /Added Player01 \(mbx001-entry\) as roster version 1\./,
  );
});

test('later writes condition HEAD on the version they read', async () => {
  const aws = fakeAws();
  assert.equal(
    (await roster(dev('add', 'Player01', 'Player02'), { aws })).status,
    0,
  );
  const [changePut, headPut] = aws.lastTransaction().map((entry) => entry.Put);
  assert.equal(changePut.Item.sk.S, 'CHANGE#0000000002');
  assert.equal(changePut.Item.reason.NULL, true);
  assert.equal(headPut.ConditionExpression, 'rosterVersion = :version');
  assert.deepEqual(headPut.ExpressionAttributeValues, {
    ':version': { N: '1' },
  });
  // Every add gets its own request ID.
  const ids = aws.changes().map((item) => item.clientRequestId.S);
  assert.equal(new Set(ids).size, 2);

  const result = await roster(
    dev('deactivate', 'player02', '--reason', 'left the league'),
    { aws },
  );
  assert.equal(result.status, 0, result.err);
  const deactivate = aws.changes()[2];
  assert.equal(deactivate.action.S, 'DEACTIVATE');
  assert.equal(deactivate.gamertagId.S, 'mbx002-entry');
  assert.equal(deactivate.gamertag.S, 'Player02');
  assert.equal(
    (await roster(dev('reactivate', 'PLAYER02'), { aws })).status,
    0,
  );
  assert.equal(aws.changes()[3].action.S, 'REACTIVATE');
});

test('an ephemeral roster reads and writes only its own partition', async () => {
  const aws = fakeAws();
  assert.equal(
    (await roster(dev('--ephemeral', 'alice', 'add', 'Player01'), { aws }))
      .status,
    0,
  );
  assert.equal(
    (await roster(dev('--ephemeral', 'alice', 'list'), { aws })).status,
    0,
  );
  const partitions = new Set();
  for (const args of aws.calls.filter((call) => call[0] === 'dynamodb')) {
    for (const value of [
      args[args.indexOf('--key') + 1],
      args[args.indexOf('--expression-attribute-values') + 1],
      args[args.indexOf('--transact-items') + 1],
    ]) {
      for (const match of value?.matchAll(/ROSTER#[^"]*/g) ?? []) {
        partitions.add(match[0]);
      }
    }
  }
  assert.deepEqual([...partitions], ['ROSTER#ephemeral/alice']);
  assert.equal(
    aws.changes('ROSTER#ephemeral/alice')[0].namespace.S,
    'ephemeral/alice',
  );
  assert.deepEqual(aws.changes('ROSTER#stable'), []);
});

test('every checkChange refusal exits 1 and writes nothing', async () => {
  const aws = fakeAws();
  assert.equal(
    (await roster(dev('add', 'Player05', 'Player07'), { aws })).status,
    0,
  );
  assert.equal(
    (await roster(dev('deactivate', 'Player07'), { aws })).status,
    0,
  );
  // Player07's key equals Player 07's; reactivating it would share a key.
  assert.equal((await roster(dev('add', 'Player 07'), { aws })).status, 0);
  const written = aws.transactions().length;

  for (const [argv, code, named] of [
    [dev('add', 'Player-05'), 'INVALID_GAMERTAG'],
    [dev('add', 'Player01', '--reason', 'x'.repeat(257)), 'INVALID_REQUEST'],
    [
      dev('add', 'PLAYER05'),
      'DUPLICATE_GAMERTAG',
      /Player05 \(ACTIVE, mbx001-entry\)/,
    ],
    [dev('add', 'player07'), 'DUPLICATE_GAMERTAG', /Player07 \(INACTIVE/],
    [dev('add', 'PIayer05'), 'KEY_CONFLICT', /Player05 \(ACTIVE/],
    [dev('reactivate', 'Player07'), 'KEY_CONFLICT', /Player 07 \(ACTIVE/],
    [dev('deactivate', 'Player07'), 'ALREADY_INACTIVE'],
    [dev('reactivate', 'Player05'), 'ALREADY_ACTIVE'],
    [dev('deactivate', 'Player09'), 'GAMERTAG_NOT_FOUND'],
  ]) {
    const result = await roster(argv, { aws });
    assert.equal(result.status, 1, argv.join(' '));
    assert.match(result.err, new RegExp(`Refused: ${code}\\.`), argv.join(' '));
    if (named) assert.match(result.err, named, argv.join(' '));
    assert.match(result.err, /Nothing was written/);
  }
  assert.equal(aws.transactions().length, written);
});

test('an add near an active key prints the near-key warning', async () => {
  const aws = fakeAws();
  await roster(dev('add', 'Player05'), { aws });
  const result = await roster(dev('add', 'Player06'), { aws });
  assert.equal(result.status, 0, result.err);
  assert.match(
    result.out,
    /Warning: these active gamertags are one key edit away, so readings between them will not resolve: Player05/,
  );
});

test('add with several gamertags stops at the first refusal', async () => {
  const aws = fakeAws();
  const result = await roster(dev('add', 'Player01', 'player01', 'Player03'), {
    aws,
  });
  assert.equal(result.status, 1);
  assert.deepEqual(
    aws.changes().map((item) => item.gamertag.S),
    ['Player01'],
  );
});

test('a change log that does not reproduce HEAD exits 2 and writes nothing', async () => {
  for (const tamper of [
    (items) => {
      items.get('ROSTER#stable|HEAD').rosterSha256 = { S: '0'.repeat(64) };
    },
    (items) => {
      items.delete('ROSTER#stable|CHANGE#0000000001');
    },
    (items) => {
      items.get('ROSTER#stable|HEAD').rosterVersion = { N: '3' };
    },
    (items) => {
      delete items.get('ROSTER#stable|CHANGE#0000000002').actorArn;
    },
  ]) {
    const aws = fakeAws();
    await roster(dev('add', 'Player01', 'Player02'), { aws });
    tamper(aws.items);
    const written = aws.transactions().length;
    for (const argv of [dev('add', 'Player03'), dev('list'), dev('history')]) {
      const result = await roster(argv, { aws });
      assert.equal(result.status, 2, argv.join(' '));
      assert.match(result.err, /ROSTER_INTEGRITY/);
    }
    assert.equal(aws.transactions().length, written);
  }
});

test('a failed HEAD condition re-reads the roster and retries', async () => {
  const aws = fakeAws();
  await roster(dev('add', 'Player01'), { aws });
  // Another operator commits version 2 between this read and this write.
  const other = fakeAws();
  for (const [key, item] of aws.items) other.items.set(key, item);
  assert.equal(
    (await roster(dev('deactivate', 'Player01'), { aws: other })).status,
    0,
  );
  aws.beforeTransaction.push(() => {
    for (const key of [
      'ROSTER#stable|CHANGE#0000000002',
      'ROSTER#stable|HEAD',
    ]) {
      aws.items.set(key, other.items.get(key));
    }
  });

  const result = await roster(dev('add', 'Player03'), { aws });
  assert.equal(result.status, 0, result.err);
  const [first, second] = aws
    .transactions()
    .slice(1)
    .map((args) => JSON.parse(args[args.indexOf('--transact-items') + 1]));
  assert.equal(first[1].Put.ExpressionAttributeValues[':version'].N, '1');
  assert.equal(second[1].Put.ExpressionAttributeValues[':version'].N, '2');
  assert.equal(
    first[0].Put.Item.clientRequestId.S,
    second[0].Put.Item.clientRequestId.S,
  );
  assert.deepEqual(
    aws.changes().map((item) => [item.action.S, item.gamertag.S]),
    [
      ['ADD', 'Player01'],
      ['DEACTIVATE', 'Player01'],
      ['ADD', 'Player03'],
    ],
  );
});

test(`a HEAD condition that fails ${MAX_WRITE_ATTEMPTS} times is CONCURRENT_CHANGE`, async () => {
  assert.equal(MAX_WRITE_ATTEMPTS, 3);
  const aws = fakeAws();
  aws.conditionFailures = 3;
  const result = await roster(dev('add', 'Player01'), { aws });
  assert.equal(result.status, 1);
  assert.match(result.err, /CONCURRENT_CHANGE/);
  assert.equal(aws.transactions().length, 3);
  assert.deepEqual(aws.changes(), []);

  aws.conditionFailures = 2;
  assert.equal((await roster(dev('add', 'Player01'), { aws })).status, 0);
  assert.equal(aws.transactions().length, 6);
});

test('a retry whose clientRequestId is already in the log writes nothing', async () => {
  const aws = fakeAws();
  // The transaction commits, but its response is lost.
  aws.lostResponses = 1;
  const result = await roster(dev('add', 'Player01'), { aws });
  assert.equal(result.status, 0, result.err);
  assert.equal(aws.transactions().length, 1);
  assert.equal(aws.changes().length, 1);
  assert.match(result.out, /already recorded, so nothing more was written/);
});

test('a transport error retries with the same request, then exits 2', async () => {
  const aws = fakeAws();
  aws.transportFailures = 1;
  assert.equal((await roster(dev('add', 'Player01'), { aws })).status, 0);
  assert.equal(aws.transactions().length, 2);

  aws.transportFailures = 3;
  const result = await roster(dev('add', 'Player02'), { aws });
  assert.equal(result.status, 2);
  assert.match(result.err, /Could not connect to the endpoint URL/);
  assert.match(result.err, /The roster write failed 3 times/);
  assert.equal(aws.transactions().length, 5);
  assert.equal(aws.changes().length, 1);
});

test('writes against prod ask for confirmation unless --yes is given', async () => {
  const env = { AWS_PROFILE: 'mcc-prod-admin', MCC_PROD_ACCOUNT_ID: PROD };
  const prod = (...args) => ['--environment', 'prod', ...args];
  const aws = fakeAws({ account: PROD });

  const declined = await roster(prod('add', 'Player01', '--reason', 'joined'), {
    aws,
    env,
    answers: ['no'],
  });
  assert.equal(declined.status, 1);
  assert.match(declined.err, /Cancelled; nothing was written/);
  assert.match(
    declined.out,
    /Change to the prod roster \(namespace stable, version 0 -> 1\):\n {2}action {4}ADD\n {2}gamertag {2}Player01\n {2}reason {4}joined/,
  );
  assert.deepEqual(declined.prompts, [
    'Type yes to write this change to prod: ',
  ]);
  assert.equal(aws.transactions().length, 0);

  const accepted = await roster(prod('add', 'Player01'), {
    aws,
    env,
    answers: ['yes'],
  });
  assert.equal(accepted.status, 0, accepted.err);
  assert.equal(accepted.prompts.length, 1);
  assert.equal(aws.changes().length, 1);

  const forced = await roster(prod('deactivate', 'Player01', '--yes'), {
    aws,
    env,
  });
  assert.equal(forced.status, 0, forced.err);
  assert.deepEqual(forced.prompts, []);
  assert.equal(aws.changes().length, 2);

  const devWrite = await roster(dev('add', 'Player02'));
  assert.equal(devWrite.status, 0, devWrite.err);
  assert.deepEqual(devWrite.prompts, []);
});

test('list and history print the folded roster and change log', async () => {
  const aws = fakeAws();
  await roster(dev('add', 'zulu', 'Player02', 'alpha'), { aws });
  await roster(dev('deactivate', 'Player02', '--reason', 'left'), { aws });

  const active = await roster(dev('list'), { aws });
  assert.equal(active.status, 0, active.err);
  assert.match(
    active.out,
    /Roster version 4, sha256 [0-9a-f]{64}: 2 active entries/,
  );
  assert.match(
    active.out,
    /\nalpha\tACTIVE\tmbx003-entry\ta1pha\t3\t3\nzulu\tACTIVE\tmbx001-entry\tzu1u\t1\t1\n$/,
  );
  const inactive = await roster(dev('list', '--inactive'), { aws });
  assert.match(inactive.out, /1 inactive entries/);
  assert.match(
    inactive.out,
    /\nPlayer02\tINACTIVE\tmbx002-entry\tp1ayer02\t2\t4\n$/,
  );
  const all = await roster(dev('list', '--all'), { aws });
  assert.deepEqual(
    all.out
      .trim()
      .split('\n')
      .slice(3)
      .map((line) => line.split('\t')[0]),
    ['alpha', 'Player02', 'zulu'],
  );

  const history = await roster(dev('history', '--after', '2'), { aws });
  assert.equal(history.status, 0, history.err);
  const rows = history.out.trim().split('\n').slice(3);
  assert.deepEqual(
    rows.map((line) => line.split('\t')),
    [
      [
        '3',
        '2026-10-18T12:00:00.000Z',
        'ADD',
        'alpha',
        'mbx003-entry',
        ARN,
        '',
      ],
      [
        '4',
        '2026-10-18T12:00:00.000Z',
        'DEACTIVATE',
        'Player02',
        'mbx002-entry',
        ARN,
        'left',
      ],
    ],
  );
  assert.equal(aws.transactions().length, 4);
});

test('a change log longer than one page is read page by page', async () => {
  const aws = fakeAws();
  const { head, changes } = changeLog(CHANGE_PAGE_ITEMS * 2 + 50);
  for (const item of [head, ...changes]) {
    aws.items.set(`${item.pk.S}|${item.sk.S}`, item);
  }
  const result = await roster(dev('history'), { aws });
  assert.equal(result.status, 0, result.err);
  const queries = aws.calls.filter((args) => args[1] === 'query');
  assert.equal(queries.length, 3);
  assert.deepEqual(
    queries.map((args) => args.includes('--starting-token')),
    [false, true, true],
  );
  const rows = result.out.trim().split('\n').slice(3);
  assert.deepEqual(
    rows.map((line) => Number(line.split('\t')[0])),
    changes.map((_, index) => index + 1),
  );
});

// The AWS CLI prints a whole response at once, and spawnSync keeps at most
// 1 MiB of a child's output. This runs the script as a process against an
// `aws` executable that answers as the CLI does: it prints 4-space indented
// JSON and, without --max-items, every page of a query in one response.
test('a change log over 1 MiB is read through the AWS CLI in pages', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcc-roster-'));
  try {
    const log = changeLog(1600);
    const itemsFile = join(directory, 'items.json');
    const callsFile = join(directory, 'calls.jsonl');
    writeFileSync(itemsFile, JSON.stringify(log));
    writeFileSync(callsFile, '');
    writeFileSync(
      join(directory, 'aws'),
      `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.MCC_TEST_AWS_CALLS, JSON.stringify(args) + '\\n');
const flag = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const { head, changes } = JSON.parse(readFileSync(process.env.MCC_TEST_ROSTER_ITEMS, 'utf8'));
const print = (value) => process.stdout.write(JSON.stringify(value, null, 4) + '\\n');
switch (args[0] + ' ' + args[1]) {
  case 'sts get-caller-identity':
    print({ Account: '${DEV}', Arn: '${ARN}' });
    break;
  case 'ssm get-parameter':
    process.stdout.write('${TABLE}\\n');
    break;
  case 'dynamodb get-item':
    print({ Item: head });
    break;
  case 'dynamodb query': {
    const maxItems = Number(flag('--max-items') ?? changes.length);
    const start = flag('--starting-token') ? Number(flag('--starting-token')) : 0;
    const end = start + maxItems;
    const Items = changes.slice(start, end);
    print({ Items, Count: Items.length, ...(end < changes.length ? { NextToken: String(end) } : {}) });
    break;
  }
  case 'dynamodb transact-write-items':
    print({});
    break;
  default:
    process.stderr.write('Unexpected AWS call ' + args.join(' ') + '\\n');
    process.exit(255);
}
`,
    );
    chmodSync(join(directory, 'aws'), 0o755);
    const env = {
      ...process.env,
      PATH: `${directory}${delimiter}${process.env.PATH}`,
      AWS_PROFILE: 'mcc-dev-admin',
      MCC_DEV_ACCOUNT_ID: DEV,
      MCC_TEST_ROSTER_ITEMS: itemsFile,
      MCC_TEST_AWS_CALLS: callsFile,
    };
    const calls = () =>
      readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse);

    // The whole log, as one CLI response, is more than spawnSync keeps.
    const unpaged = awsCli('mcc-dev-admin', ['dynamodb', 'query'], env);
    assert.equal(unpaged.error?.code, 'ENOBUFS');
    writeFileSync(callsFile, '');

    const script = (...argv) =>
      spawnSync(
        process.execPath,
        ['scripts/roster.mjs', '--environment', 'dev', ...argv],
        {
          encoding: 'utf8',
          env,
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          maxBuffer: 64 * 1024 * 1024,
        },
      );

    const history = script('history');
    assert.equal(history.status, 0, history.stderr);
    assert.match(
      history.stdout,
      /Roster version 1600: changes after version 0/,
    );
    assert.equal(history.stdout.trim().split('\n').length, 3 + 1600);
    const queries = calls().filter((args) => args[1] === 'query');
    assert.equal(queries.length, Math.ceil(1600 / CHANGE_PAGE_ITEMS));

    const list = script('list', '--all');
    assert.equal(list.status, 0, list.stderr);
    assert.match(
      list.stdout,
      /\nPlayer01\tINACTIVE\tmbx001-entry\tp1ayer01\t1\t1600\n$/,
    );

    writeFileSync(callsFile, '');
    const write = script('reactivate', 'Player01');
    assert.equal(write.status, 0, write.stderr);
    assert.match(
      write.stdout,
      /Reactivated Player01 \(mbx001-entry\) as roster version 1601\./,
    );
    assert.equal(
      calls().filter((args) => args[1] === 'transact-write-items').length,
      1,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the script reads and writes no file', async () => {
  for (const path of ['scripts/roster.mjs', 'scripts/account-guard.mjs']) {
    assert.doesNotMatch(
      readFileSync(path, 'utf8'),
      /from 'node:fs|require\('(node:)?fs/,
    );
  }
  // Under Node's permission model without --allow-fs-write, any file write
  // throws. Run every command against the fake table and require success.
  const harness = `
    import { main } from ${JSON.stringify(new URL('./roster.mjs', import.meta.url).href)};
    const items = new Map();
    const aws = (args) => {
      const flag = (name) => args[args.indexOf(name) + 1];
      if (args[0] === 'sts') return { status: 0, stdout: JSON.stringify({ Account: '${DEV}', Arn: 'arn' }) };
      if (args[0] === 'ssm') return { status: 0, stdout: 'table' };
      if (args[1] === 'get-item') {
        const item = items.get(JSON.parse(flag('--key')).sk.S);
        return { status: 0, stdout: item ? JSON.stringify({ Item: item }) : '' };
      }
      if (args[1] === 'query') {
        return { status: 0, stdout: JSON.stringify({ Items: [...items.values()].filter((item) => item.sk.S !== 'HEAD').sort((a, b) => (a.sk.S < b.sk.S ? -1 : 1)) }) };
      }
      for (const { Put } of JSON.parse(flag('--transact-items'))) items.set(Put.Item.sk.S, Put.Item);
      return { status: 0, stdout: '{}' };
    };
    const dependencies = {
      env: { AWS_PROFILE: 'mcc-dev-admin', MCC_DEV_ACCOUNT_ID: '${DEV}' },
      stdout: () => {}, stderr: (text) => process.stderr.write(text),
      awsCli: () => aws, uuid: () => crypto.randomUUID(),
      evidenceId: () => crypto.randomUUID(), now: () => new Date(), confirm: async () => 'yes',
    };
    for (const argv of [['add', 'Player01', 'Player02'], ['deactivate', 'Player02'], ['reactivate', 'Player02'], ['list', '--all'], ['history']]) {
      const status = await main(['--environment', 'dev', ...argv], dependencies);
      if (status !== 0) process.exit(10 + status);
    }
  `;
  const result = spawnSync(
    process.execPath,
    ['--permission', '--allow-fs-read=*', '--input-type=module', '-e', harness],
    { encoding: 'utf8', cwd: fileURLToPath(new URL('..', import.meta.url)) },
  );
  assert.equal(result.status, 0, result.stderr);
});
