import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The script checks addresses with the compiled @mcc/recipients package.
if (!existsSync('packages/recipients/dist/index.js'))
  execFileSync('npm', ['run', 'build:shared', '--silent'], {
    stdio: 'inherit',
  });
const { main, parameterName, parseAllowlist, parseArguments } =
  await import('./sender-allowlist.mjs');

const DEV = '111111111111';
const PROD = '333333333333';
const OTHER = '222222222222';
const ARN = `arn:aws:sts::${DEV}:assumed-role/AWSReservedSSO_Admin/operator`;
const DEV_PARAMETER = '/mcc/dev/match-to-csv/sender-allowlist';
const PROD_PARAMETER = '/mcc/prod/match-to-csv/sender-allowlist';

// An in-memory Parameter Store behind the AWS CLI commands the script runs.
// `parameters` maps a name to `{ type, value, version }`. `beforePut` and
// `afterPut` run another writer's change around the script's write.
function fakeAws({ account = DEV, parameters = {} } = {}) {
  const calls = [];
  const fake = {
    calls,
    parameters: new Map(Object.entries(parameters)),
    profiles: [],
    beforePut: undefined,
    afterPut: undefined,
    readError: undefined,
    putError: undefined,
    factory(profile) {
      fake.profiles.push(profile);
      return (args) => fake.run(args);
    },
    // Another writer's put, as Parameter Store applies it.
    put(name, value) {
      const current = fake.parameters.get(name);
      fake.parameters.set(name, {
        type: current?.type ?? 'StringList',
        value,
        version: (current?.version ?? 0) + 1,
      });
    },
    run(args) {
      calls.push(args);
      const [service, operation] = args;
      const flag = (name) => args[args.indexOf(name) + 1];
      if (service === 'sts' && operation === 'get-caller-identity') {
        return ok(JSON.stringify({ Account: account, Arn: ARN }));
      }
      if (service === 'configure') return ok(`${account}\n`);
      assert.equal(service, 'ssm', args.join(' '));
      if (operation === 'get-parameter') {
        if (fake.readError) return failed(fake.readError);
        const parameter = fake.parameters.get(flag('--name'));
        if (!parameter) {
          return failed(
            'An error occurred (ParameterNotFound) when calling the GetParameter operation: ',
          );
        }
        return ok(
          JSON.stringify({
            Parameter: {
              Name: flag('--name'),
              Type: parameter.type,
              Value: parameter.value,
              Version: parameter.version,
            },
          }),
        );
      }
      assert.equal(operation, 'put-parameter', args.join(' '));
      assert.ok(!args.includes('--value'), 'the value is never an argument');
      fake.beforePut?.();
      if (fake.putError) return failed(fake.putError);
      const input = JSON.parse(flag('--cli-input-json'));
      const current = fake.parameters.get(input.Name);
      if (current && !input.Overwrite) {
        return failed(
          'An error occurred (ParameterAlreadyExists) when calling the PutParameter operation: ',
        );
      }
      const version = (current?.version ?? 0) + 1;
      fake.parameters.set(input.Name, {
        type: input.Type,
        value: input.Value,
        version,
      });
      fake.afterPut?.();
      return ok(JSON.stringify({ Version: version, Tier: 'Standard' }));
    },
    puts: () =>
      calls
        .filter((args) => args[1] === 'put-parameter')
        .map((args) => JSON.parse(args[args.indexOf('--cli-input-json') + 1])),
  };
  return fake;
}

function ok(stdout) {
  return { status: 0, stdout, stderr: '' };
}

function failed(message) {
  return { status: 254, stdout: '', stderr: `\n${message}\n` };
}

const devAllowlist = (value, type = 'StringList', version = 3) => ({
  [DEV_PARAMETER]: { type, value, version },
});

// Runs the script against `aws` and returns its exit status and output.
async function allowlist(argv, { aws = fakeAws(), env, answers = [] } = {}) {
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
    confirm: async (question) => {
      prompts.push(question);
      return answers.shift() ?? '';
    },
  });
  return { status, out, err, prompts, aws };
}

const dev = (...args) => ['--environment', 'dev', ...args];
const prod = (...args) => ['--environment', 'prod', ...args];
const PROD_ENV = { AWS_PROFILE: 'mcc-prod-admin', MCC_PROD_ACCOUNT_ID: PROD };

test('the parameter name and value parsing match process-email', () => {
  assert.equal(parameterName('dev'), DEV_PARAMETER);
  assert.equal(parameterName('prod'), PROD_PARAMETER);
  assert.deepEqual(
    parseAllowlist(' A@Example.test,b@example.test\nc@x.test ,, '),
    ['a@example.test', 'b@example.test', 'c@x.test'],
  );
  assert.deepEqual(parseAllowlist(''), []);
});

test('arguments follow the recipient script', () => {
  assert.deepEqual(
    parseArguments([
      'add',
      'one@example.test',
      '--environment',
      'dev',
      'two@example.test',
      '--yes',
    ]),
    {
      command: 'add',
      operands: ['one@example.test', 'two@example.test'],
      options: { environment: 'dev', yes: true },
    },
  );
  assert.deepEqual(
    parseArguments(['-env', 'prod', '-p', 'mcc-prod-admin', 'list']),
    {
      command: 'list',
      operands: [],
      options: { environment: 'prod', profile: 'mcc-prod-admin' },
    },
  );
  assert.deepEqual(
    parseArguments(dev('remove', '--', '-odd@example.test')).operands,
    ['-odd@example.test'],
  );
});

test('usage errors exit 2 before any AWS call', async () => {
  for (const [argv, message] of [
    [['list'], /--environment is required/],
    [dev(), /Name a command/],
    [dev('delete', 'one@example.test'), /Unknown command delete/],
    [dev('toString'), /Unknown command toString/],
    [dev('list', '--ephemeral', 'sam'), /Unknown option --ephemeral/],
    [dev('list', '--reason', 'x'), /Unknown option --reason/],
    [dev('list', 'one@example.test'), /list takes no address/],
    [dev('list', '--yes'), /list does not accept --yes/],
    [dev('add'), /add takes at least one address/],
    [dev('remove'), /remove takes at least one address/],
    [dev('list', '--environment', 'dev'), /given more than once/],
  ]) {
    const result = await allowlist(argv);
    assert.equal(result.status, 2, argv.join(' '));
    assert.match(result.err, message, argv.join(' '));
    assert.match(result.err, /Usage: npm run sender-allowlist/);
    assert.deepEqual(result.aws.calls, [], argv.join(' '));
  }
  const help = await allowlist(dev('--help'));
  assert.equal(help.status, 0);
  assert.match(help.out, /share the dev allowlist/);
});

test('the account check refuses before any parameter request', async () => {
  for (const [argv, env, message] of [
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
    [
      ['--environment', 'stage', 'list'],
      { AWS_PROFILE: 'admin' },
      /--environment must be dev or prod/,
    ],
  ]) {
    const result = await allowlist(argv, { env });
    assert.equal(result.status, 2, argv.join(' '));
    assert.match(result.err, message, argv.join(' '));
    assert.deepEqual(result.aws.calls, [], argv.join(' '));
  }
});

test('a mismatched account exits 2 without reading or writing the parameter', async () => {
  for (const argv of [
    dev('list'),
    dev('add', 'one@example.test'),
    dev('remove', 'one@example.test'),
  ]) {
    const aws = fakeAws({
      account: OTHER,
      parameters: devAllowlist('one@example.test,two@example.test'),
    });
    const result = await allowlist(argv, { aws });
    assert.equal(result.status, 2, argv.join(' '));
    assert.match(
      result.err,
      new RegExp(
        `Refusing sender-allowlist ${argv[2]}: active account ${OTHER} does not match MCC_DEV_ACCOUNT_ID \\(${DEV}\\)`,
      ),
    );
    assert.deepEqual(aws.calls, [
      ['sts', 'get-caller-identity', '--output', 'json'],
    ]);
  }
});

test('the profile comes from --profile or AWS_PROFILE and sso_account_id fills in the account', async () => {
  const aws = fakeAws({ parameters: devAllowlist('one@example.test') });
  const result = await allowlist(dev('--profile', 'mcc-dev-admin', 'list'), {
    aws,
    env: {},
  });
  assert.equal(result.status, 0, result.err);
  assert.deepEqual(aws.profiles, ['mcc-dev-admin']);
  assert.deepEqual(aws.calls, [
    ['configure', 'get', 'sso_account_id'],
    ['sts', 'get-caller-identity', '--output', 'json'],
    ['ssm', 'get-parameter', '--name', DEV_PARAMETER, '--output', 'json'],
  ]);
  assert.match(result.out, new RegExp(`Using dev in AWS account ${DEV}`));
});

test('list prints the saved addresses, or says that every message is rejected', async () => {
  const listed = await allowlist(dev('list'), {
    aws: fakeAws({
      parameters: devAllowlist('One@example.test, two@example.test'),
    }),
  });
  assert.equal(listed.status, 0, listed.err);
  assert.equal(
    listed.out,
    `Using dev in AWS account ${DEV}\n` +
      `Sender allowlist ${DEV_PARAMETER} (StringList, version 3): 2 addresses\n` +
      'one@example.test\ntwo@example.test\n',
  );

  const missing = await allowlist(dev('list'));
  assert.equal(missing.status, 0, missing.err);
  assert.match(
    missing.out,
    /does not exist\. match-to-csv rejects every message until it lists an address\./,
  );

  const empty = await allowlist(dev('list'), {
    aws: fakeAws({ parameters: devAllowlist(' , ', 'String') }),
  });
  assert.equal(empty.status, 0, empty.err);
  assert.match(empty.out, /\(String, version 3\): 0 addresses\n/);
  assert.match(empty.out, /rejects every message until it lists an address/);
});

test('add creates a missing parameter as a StringList and reads it back', async () => {
  const aws = fakeAws();
  const result = await allowlist(
    dev('add', ' One@Example.test ', 'two@example.test'),
    { aws },
  );
  assert.equal(result.status, 0, result.err);
  assert.deepEqual(aws.puts(), [
    {
      Name: DEV_PARAMETER,
      Type: 'StringList',
      Value: 'one@example.test,two@example.test',
      Overwrite: false,
    },
  ]);
  assert.deepEqual(
    aws.calls.filter((args) => args[1] === 'get-parameter').length,
    2,
    'one read before the write and one after',
  );
  assert.equal(aws.calls.at(-1)[1], 'get-parameter', 'the write is read back');
  assert.deepEqual(aws.parameters.get(DEV_PARAMETER), {
    type: 'StringList',
    value: 'one@example.test,two@example.test',
    version: 1,
  });
  assert.match(
    result.out,
    /Added one@example\.test, two@example\.test\. .* is version 1 with 2 addresses\./,
  );
  assert.deepEqual(result.prompts, [], 'dev writes ask nothing');
});

test('add keeps the existing type and appends to the saved list', async () => {
  const aws = fakeAws({
    parameters: devAllowlist('one@example.test two@example.test', 'String', 7),
  });
  const result = await allowlist(dev('add', 'three@example.test'), { aws });
  assert.equal(result.status, 0, result.err);
  assert.deepEqual(aws.puts(), [
    {
      Name: DEV_PARAMETER,
      Type: 'String',
      Value: 'one@example.test,two@example.test,three@example.test',
      Overwrite: true,
    },
  ]);
  assert.equal(aws.parameters.get(DEV_PARAMETER).version, 8);
});

test('an address that looks like a file or URL argument stays a value', async () => {
  const aws = fakeAws();
  const result = await allowlist(dev('add', 'file://x@example.test'), { aws });
  assert.equal(result.status, 0, result.err);
  assert.equal(aws.puts()[0].Value, 'file://x@example.test');
});

test('remove writes the list without the address and keeps the type', async () => {
  const aws = fakeAws({
    parameters: devAllowlist(
      'one@example.test,Two@example.test,three@example.test',
    ),
  });
  const result = await allowlist(dev('remove', 'two@EXAMPLE.test'), { aws });
  assert.equal(result.status, 0, result.err);
  assert.deepEqual(aws.puts(), [
    {
      Name: DEV_PARAMETER,
      Type: 'StringList',
      Value: 'one@example.test,three@example.test',
      Overwrite: true,
    },
  ]);
  assert.match(result.out, /Removed two@example\.test\. .* with 2 addresses/);
});

test('every refusal exits 1 and writes nothing', async () => {
  for (const [argv, parameters, message] of [
    [
      dev('add', 'not-an-address'),
      devAllowlist('one@example.test'),
      /Refused: INVALID_ADDRESS/,
    ],
    [
      dev('add', 'two@example.test', 'a@b@example.test'),
      devAllowlist('one@example.test'),
      /Refused: INVALID_ADDRESS/,
    ],
    [
      dev('add', 'ONE@example.test'),
      devAllowlist('one@example.test'),
      /Refused: ALREADY_LISTED\. one@example\.test is already on the allowlist/,
    ],
    [
      dev('add', 'two@example.test', 'Two@example.test'),
      devAllowlist('one@example.test'),
      /Refused: ALREADY_LISTED/,
    ],
    [
      dev('remove', 'two@example.test'),
      devAllowlist('one@example.test,three@example.test'),
      /Refused: NOT_LISTED/,
    ],
    [dev('remove', 'one@example.test'), {}, /Refused: NOT_LISTED/],
    [
      dev('remove', 'one@example.test'),
      devAllowlist('one@example.test'),
      /Refused: LAST_ADDRESS/,
    ],
    [
      dev('remove', 'one@example.test', 'two@example.test'),
      devAllowlist('one@example.test,two@example.test'),
      /Refused: LAST_ADDRESS/,
    ],
  ]) {
    const aws = fakeAws({ parameters });
    const before = JSON.stringify([...aws.parameters]);
    const result = await allowlist(argv, { aws });
    assert.equal(result.status, 1, argv.join(' '));
    assert.match(result.err, message, argv.join(' '));
    assert.match(result.err, /Nothing was written/);
    assert.deepEqual(aws.puts(), [], argv.join(' '));
    assert.equal(JSON.stringify([...aws.parameters]), before);
  }
});

test('the script never deletes the parameter', async () => {
  const aws = fakeAws({
    parameters: devAllowlist('one@example.test,two@example.test'),
  });
  for (const argv of [
    dev('list'),
    dev('add', 'three@example.test'),
    dev('remove', 'one@example.test'),
    dev('remove', 'two@example.test'),
    dev('remove', 'three@example.test'),
  ]) {
    await allowlist(argv, { aws });
  }
  assert.deepEqual(
    aws.calls.filter((args) => args[0] === 'ssm').map((args) => args[1]),
    [
      'get-parameter',
      'get-parameter',
      'put-parameter',
      'get-parameter',
      'get-parameter',
      'put-parameter',
      'get-parameter',
      'get-parameter',
      'put-parameter',
      'get-parameter',
      'get-parameter',
    ],
  );
  assert.equal(aws.parameters.get(DEV_PARAMETER).value, 'three@example.test');
  assert.doesNotMatch(
    readFileSync('scripts/sender-allowlist.mjs', 'utf8'),
    /delete-parameter/,
  );
});

test('writes against prod ask for confirmation unless --yes is given', async () => {
  const aws = fakeAws({
    account: PROD,
    parameters: {
      [PROD_PARAMETER]: {
        type: 'StringList',
        value: 'one@example.test,two@example.test',
        version: 4,
      },
    },
  });

  const declined = await allowlist(prod('add', 'three@example.test'), {
    aws,
    env: PROD_ENV,
    answers: ['no'],
  });
  assert.equal(declined.status, 1);
  assert.match(declined.err, /Cancelled; nothing was written/);
  assert.match(
    declined.out,
    /Change to the prod sender allowlist \/mcc\/prod\/match-to-csv\/sender-allowlist \(StringList, version 4\):\n {2}add {4}three@example\.test\n {2}result 3 addresses\n/,
  );
  assert.deepEqual(declined.prompts, [
    'Type yes to write this change to prod: ',
  ]);
  assert.deepEqual(aws.puts(), []);

  const closed = await allowlist(prod('remove', 'two@example.test'), {
    aws,
    env: PROD_ENV,
  });
  assert.equal(closed.status, 1, 'closed input counts as no');
  assert.deepEqual(aws.puts(), []);

  const accepted = await allowlist(prod('add', 'three@example.test'), {
    aws,
    env: PROD_ENV,
    answers: ['yes'],
  });
  assert.equal(accepted.status, 0, accepted.err);
  assert.equal(accepted.prompts.length, 1);
  assert.equal(aws.puts().length, 1);

  const forced = await allowlist(prod('remove', 'one@example.test', '--yes'), {
    aws,
    env: PROD_ENV,
  });
  assert.equal(forced.status, 0, forced.err);
  assert.deepEqual(forced.prompts, []);
  assert.deepEqual(aws.parameters.get(PROD_PARAMETER), {
    type: 'StringList',
    value: 'two@example.test,three@example.test',
    version: 6,
  });

  const devWrite = await allowlist(dev('add', 'two@example.test'));
  assert.equal(devWrite.status, 0, devWrite.err);
  assert.deepEqual(devWrite.prompts, []);
});

test('a read-back that differs from the intended list exits 2', async () => {
  // Another writer saves right after the script's write.
  const after = fakeAws({
    parameters: devAllowlist('one@example.test,two@example.test'),
  });
  after.afterPut = () => {
    after.afterPut = undefined;
    after.put(DEV_PARAMETER, 'one@example.test');
  };
  const overwritten = await allowlist(dev('add', 'three@example.test'), {
    aws: after,
  });
  assert.equal(overwritten.status, 2);
  assert.match(
    overwritten.err,
    /READ_BACK_MISMATCH: \/mcc\/dev\/match-to-csv\/sender-allowlist does not hold the intended list/,
  );
  assert.match(
    overwritten.err,
    /intended StringList, version 4: one@example\.test, two@example\.test, three@example\.test\n {2}saved {4}StringList, version 5: one@example\.test\n/,
  );
  assert.doesNotMatch(overwritten.out, /Added/);

  // Another writer saved between the script's read and its write, so the
  // script's whole-list write replaced that change.
  const before = fakeAws({
    parameters: devAllowlist('one@example.test,two@example.test'),
  });
  before.beforePut = () => {
    before.beforePut = undefined;
    before.put(DEV_PARAMETER, 'one@example.test,two@example.test,x@y.test');
  };
  const lost = await allowlist(dev('add', 'three@example.test'), {
    aws: before,
  });
  assert.equal(lost.status, 2);
  assert.match(lost.err, /READ_BACK_MISMATCH/);
  assert.match(lost.err, /Run list, then repeat the change/);

  // The parameter disappeared after the write.
  const gone = fakeAws({ parameters: devAllowlist('one@example.test') });
  gone.afterPut = () => gone.parameters.delete(DEV_PARAMETER);
  const missing = await allowlist(dev('add', 'two@example.test'), {
    aws: gone,
  });
  assert.equal(missing.status, 2);
  assert.match(missing.err, /saved {4}no parameter/);
});

test('AWS errors and unsupported types exit 2 without a write', async () => {
  const denied = fakeAws({ parameters: devAllowlist('one@example.test') });
  denied.readError =
    'An error occurred (AccessDeniedException) when calling the GetParameter operation';
  const unreadable = await allowlist(dev('add', 'two@example.test'), {
    aws: denied,
  });
  assert.equal(unreadable.status, 2);
  assert.match(unreadable.err, /AccessDeniedException/);
  assert.match(unreadable.err, /Unable to read \/mcc\/dev\//);
  assert.deepEqual(denied.puts(), []);

  const secure = fakeAws({
    parameters: devAllowlist('ciphertext', 'SecureString'),
  });
  for (const argv of [dev('list'), dev('add', 'two@example.test')]) {
    const result = await allowlist(argv, { aws: secure });
    assert.equal(result.status, 2, argv.join(' '));
    assert.match(
      result.err,
      /UNSUPPORTED_TYPE: .* is a SecureString parameter/,
    );
  }
  assert.deepEqual(secure.puts(), []);

  const throttled = fakeAws({ parameters: devAllowlist('one@example.test') });
  throttled.putError =
    'An error occurred (ThrottlingException) when calling the PutParameter operation';
  const unwritten = await allowlist(dev('add', 'two@example.test'), {
    aws: throttled,
  });
  assert.equal(unwritten.status, 2);
  assert.match(unwritten.err, /ThrottlingException/);
  assert.match(unwritten.err, /Run list to see the saved allowlist/);

  // Another writer created the parameter between the read and the create.
  const raced = fakeAws();
  raced.beforePut = () => raced.put(DEV_PARAMETER, 'x@y.test');
  const created = await allowlist(dev('add', 'one@example.test'), {
    aws: raced,
  });
  assert.equal(created.status, 2);
  assert.match(created.err, /ParameterAlreadyExists/);
  assert.equal(raced.parameters.get(DEV_PARAMETER).value, 'x@y.test');
});

test('the script reads and writes no file', () => {
  assert.doesNotMatch(
    readFileSync('scripts/sender-allowlist.mjs', 'utf8'),
    /from 'node:fs|require\('(node:)?fs/,
  );
  // Under Node's permission model without --allow-fs-write, any file write
  // throws. Run every command against an in-memory parameter.
  const harness = `
    import { main } from ${JSON.stringify(new URL('./sender-allowlist.mjs', import.meta.url).href)};
    let parameter;
    const aws = (args) => {
      if (args[0] === 'sts') return { status: 0, stdout: JSON.stringify({ Account: '${DEV}', Arn: 'arn' }) };
      if (args[1] === 'get-parameter') {
        return parameter
          ? { status: 0, stdout: JSON.stringify({ Parameter: parameter }) }
          : { status: 254, stdout: '', stderr: 'ParameterNotFound' };
      }
      const input = JSON.parse(args[args.indexOf('--cli-input-json') + 1]);
      parameter = { Type: input.Type, Value: input.Value, Version: (parameter?.Version ?? 0) + 1 };
      return { status: 0, stdout: JSON.stringify({ Version: parameter.Version }) };
    };
    const dependencies = {
      env: { AWS_PROFILE: 'mcc-dev-admin', MCC_DEV_ACCOUNT_ID: '${DEV}' },
      stdout: () => {}, stderr: (text) => process.stderr.write(text),
      awsCli: () => aws, confirm: async () => 'yes',
    };
    for (const argv of [['add', 'one@example.test', 'two@example.test'], ['remove', 'two@example.test'], ['list']]) {
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
