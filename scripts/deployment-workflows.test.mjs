import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { evaluate, runScript, workflow } from './workflow-test-helpers.mjs';
const ci = workflow('ci-checks');
const release = workflow('release-pr');
const delivery = workflow('_delivery-release-application');
const deployment = workflow('_delivery-deploy-environment');

test('production requires reviewers and disabled bypass before protected job', async () => {
  const guard = deployment.jobs['verify-prod-protection'];
  assert.equal(guard.if, "inputs.environment == 'prod'");
  assert.equal(deployment.jobs.deploy.needs, 'verify-prod-protection');
  for (const environment of ['dev', 'prod']) {
    for (const result of ['success', 'failure', 'skipped']) {
      assert.equal(
        evaluate(
          deployment.jobs.deploy.if.replace(/^\$\{\{\s*|\s*\}\}$/g, ''),
          {
            always: () => true,
            cancelled: () => false,
            inputs: { environment },
            needs: { 'verify-prod-protection': { result } },
          },
        ),
        environment === 'dev' || result === 'success',
      );
    }
  }
  assert.equal(
    deployment.jobs.deploy.environment.name,
    '${{ inputs.environment }}',
  );
  const script = guard.steps[0].with.script;
  for (const [data, allowed] of [
    [{ protection_rules: [], can_admins_bypass: false }, false],
    [
      { protection_rules: [{ type: 'wait_timer' }], can_admins_bypass: false },
      false,
    ],
    [
      {
        protection_rules: [{ type: 'required_reviewers', reviewers: [] }],
        can_admins_bypass: false,
      },
      false,
    ],
    [
      {
        protection_rules: [{ type: 'required_reviewers', reviewers: [{}] }],
        can_admins_bypass: true,
      },
      false,
    ],
    [
      {
        protection_rules: [{ type: 'required_reviewers', reviewers: [{}] }],
        can_admins_bypass: false,
      },
      true,
    ],
  ]) {
    const invocation = runScript(script, {
      github: {
        rest: {
          repos: {
            getEnvironment: async (request) => {
              assert.equal(request.environment_name, 'prod');
              return { data };
            },
          },
        },
      },
      context: { repo: { owner: 'owner', repo: 'repo' } },
    });
    if (allowed) await invocation;
    else await assert.rejects(invocation, /prod requires reviewers/);
  }
});

test('workspaces install locally without a package registry or token', () => {
  const root = new URL('../', import.meta.url);
  assert.equal(existsSync(new URL('.npmrc', root)), false);
  for (const name of ['contracts', 'cdk-config']) {
    const pkg = JSON.parse(
      readFileSync(new URL(`packages/${name}/package.json`, root), 'utf8'),
    );
    assert.equal(pkg.name, `@mcc/${name}`);
    assert.equal(pkg.private, true);
    assert.equal(pkg.publishConfig, undefined);
  }
  const workflows = readdirSync(new URL('.github/workflows/', root)).filter(
    (file) => file.endsWith('.yml'),
  );
  for (const file of workflows) {
    const text = readFileSync(
      new URL(`.github/workflows/${file}`, root),
      'utf8',
    );
    assert.doesNotMatch(text, /npm\.pkg\.github\.com|NODE_AUTH_TOKEN/, file);
    assert.doesNotMatch(text, /^\s*packages:\s*(read|write)\s*$/m, file);
  }
});

// Runs the real step body under GitHub's default `bash -e` with stub `aws` and
// `dig` commands, so the parameter, rule set, identity, and MX gates are
// exercised rather than matched as text.
function runPrerequisites(stub) {
  const step = deployment.jobs.deploy.steps.find(
    (candidate) => candidate.name === 'Verify match-to-csv prerequisites',
  );
  assert.equal(
    step.if,
    "steps.version-guard.outputs.deploy == 'true' && (inputs.application == 'match-to-csv')",
  );
  assert.equal(step.env.DEPLOYMENT_ENVIRONMENT, '${{ inputs.environment }}');
  assert.ok(!step.run.includes('${{'), 'the step reads inputs only from env');
  const directory = mkdtempSync(join(tmpdir(), 'prerequisites-'));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const names = [
    '/cdk-bootstrap/hnb659fds/version',
    '/mcc/dev/match-to-csv/raw-email-bucket-name',
    '/mcc/dev/match-to-csv/evidence-bucket-name',
    '/mcc/dev/match-to-csv/data-key-arn',
    '/mcc/dev/match-to-csv/receipt-rule-set-name',
    '/mcc/dev/match-to-csv/email-domain',
    '/mcc/dev/roster/table-name',
  ].slice(0, stub.parameterCount ?? 7);
  const values = {
    '/mcc/dev/match-to-csv/receipt-rule-set-name': 'mcc-match-to-csv-dev',
    '/mcc/dev/match-to-csv/email-domain': 'mail.example.com',
  };
  writeFileSync(
    join(directory, 'parameters.json'),
    JSON.stringify({
      Parameters: names.map((Name) => ({ Name, Value: values[Name] ?? 'x' })),
    }),
  );
  writeFileSync(
    join(bin, 'aws'),
    [
      '#!/usr/bin/env bash',
      `echo "aws $*" >> "${join(directory, 'calls.log')}"`,
      'case "$1 $2 $4" in',
      `  "ssm get-parameters /mcc/dev/match-to-csv/alarm-email") echo "${stub.alarmEmailCount ?? 0}" ;;`,
      `  "ssm get-parameters "*) cat "${join(directory, 'parameters.json')}" ;;`,
      `  "ses describe-active-receipt-rule-set "*) echo "${stub.active ?? 'mcc-match-to-csv-dev'}" ;;`,
      `  "ses get-identity-verification-attributes "*) echo "${stub.identity ?? 'Success'}" ;;`,
      '  *) echo "unexpected aws $*" >&2; exit 2 ;;',
      'esac',
    ].join('\n'),
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'dig'),
    `#!/usr/bin/env bash\necho "dig $*" >> "${join(directory, 'calls.log')}"\necho "${stub.mx ?? '10 inbound-smtp.us-east-2.amazonaws.com.'}"\n`,
    { mode: 0o755 },
  );
  const githubEnv = join(directory, 'github-env');
  writeFileSync(githubEnv, '');
  const result = spawnSync('bash', ['-e', '-c', step.run], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      DEPLOYMENT_ENVIRONMENT: 'dev',
      AWS_REGION: 'us-east-2',
      GITHUB_ENV: githubEnv,
    },
  });
  const callsLog = join(directory, 'calls.log');
  return {
    ...result,
    githubEnv: readFileSync(githubEnv, 'utf8'),
    calls: existsSync(callsLog)
      ? readFileSync(callsLog, 'utf8').trim().split('\n')
      : [],
  };
}

test('match-to-csv prerequisites pass and mask the published domain', () => {
  const result = runPrerequisites({});
  assert.equal(result.status, 0, result.stderr + result.stdout);
  // Masked before any other use. Nothing exports MCC_EMAIL_DOMAIN, because a
  // release whose stack reads it declares receipt rules the foundation owns.
  assert.equal(result.stdout.split('\n')[0], '::add-mask::mail.example.com');
  assert.equal(result.githubEnv, '');
  assert.equal(deployment.jobs.deploy.env.MCC_EMAIL_DOMAIN, undefined);
  // The step asks for exactly the seven parameters and checks the published
  // domain, not some other value, against SES and DNS.
  assert.deepEqual(result.calls, [
    'aws ssm get-parameters --names /cdk-bootstrap/hnb659fds/version ' +
      '/mcc/dev/match-to-csv/raw-email-bucket-name ' +
      '/mcc/dev/match-to-csv/evidence-bucket-name ' +
      '/mcc/dev/match-to-csv/data-key-arn ' +
      '/mcc/dev/match-to-csv/receipt-rule-set-name ' +
      '/mcc/dev/match-to-csv/email-domain ' +
      '/mcc/dev/roster/table-name --output json',
    'aws ses describe-active-receipt-rule-set --query Metadata.Name --output text',
    'aws ses get-identity-verification-attributes --identities mail.example.com ' +
      '--query VerificationAttributes.*.VerificationStatus | [0] --output text',
    'dig +short MX mail.example.com',
    'aws ssm get-parameters --names /mcc/dev/match-to-csv/alarm-email ' +
      '--query length(Parameters) --output text',
  ]);
  assert.match(
    result.stdout,
    /::notice::\/mcc\/dev\/match-to-csv\/alarm-email is not set/,
  );
});

test('match-to-csv prerequisites export the optional alarm email parameter name', () => {
  const result = runPrerequisites({ alarmEmailCount: 1 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  // Only the parameter name leaves the step. CloudFormation resolves the
  // address itself, so the step never reads the value.
  assert.equal(
    result.githubEnv,
    'MCC_ALARM_EMAIL_PARAMETER=/mcc/dev/match-to-csv/alarm-email\n',
  );
  assert.ok(
    result.calls.every((call) => !call.includes('get-parameter ')),
    'the step never reads the alarm email value',
  );
});

for (const [name, stub, message] of [
  [
    'a foundation parameter is missing',
    { parameterCount: 5 },
    'parameters are missing',
  ],
  [
    'the roster table parameter is missing',
    { parameterCount: 6 },
    'parameters are missing',
  ],
  [
    'another rule set is active',
    { active: 'other' },
    'is not the active rule set',
  ],
  ['no rule set is active', { active: 'None' }, 'is not the active rule set'],
  ['the identity is unverified', { identity: 'Pending' }, 'is not verified'],
  [
    'the MX record targets another Region',
    { mx: '10 inbound-smtp.us-west-2.amazonaws.com.' },
    'MX record',
  ],
]) {
  test(`match-to-csv prerequisites fail when ${name}`, () => {
    const result = runPrerequisites(stub);
    assert.equal(result.status, 1);
    assert.match(result.stdout, new RegExp(`::error::.*${message}`));
    assert.equal(result.githubEnv, '');
  });
}

const repositoryFile = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const triggers = ({ on }) =>
  typeof on === 'string'
    ? [on]
    : Array.isArray(on)
      ? on
      : Object.keys(on ?? {});

// Top-level workflows that reach `target` through local reusable workflow calls.
const topLevelCallers = (target) => {
  const workflows = new Map(
    readdirSync(new URL('../.github/workflows/', import.meta.url))
      .filter((file) => file.endsWith('.yml'))
      .map((file) => [file, workflow(file.slice(0, -'.yml'.length))]),
  );
  const reaches = (file, seen = new Set()) => {
    if (seen.has(file)) return false;
    seen.add(file);
    return Object.values(workflows.get(file)?.jobs ?? {}).some((job) => {
      const called = job.uses?.match(/^\.\/\.github\/workflows\/(.+\.yml)$/);
      return called && (called[1] === target || reaches(called[1], seen));
    });
  };
  return [...workflows]
    .filter(
      ([file, definition]) =>
        !triggers(definition).includes('workflow_call') && reaches(file),
    )
    .map(([file]) => file)
    .sort();
};

const trustedDeployWorkflowPath = () => {
  const variables = repositoryFile(
    'infrastructure/modules/bootstrap/variables.tf',
  );
  const block = variables.match(
    /variable "cdk_deploy_workflow_path" \{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(block, 'bootstrap must declare cdk_deploy_workflow_path');
  const path = block.match(/^\s*default\s*=\s*"([^"]*)"/m)?.[1];
  assert.ok(path, 'cdk_deploy_workflow_path needs a string default');
  return path;
};

// GitHub sets the OIDC `job_workflow_ref` claim to the file that defines the
// job requesting the token, so the CDK entry role must trust the reusable
// workflow that assumes it, and every delivery workflow must reach that file.
test('CDK entry role trusts the reusable workflow every delivery workflow calls', () => {
  const path = trustedDeployWorkflowPath();
  const file = path.match(/^\.github\/workflows\/([^/]+\.yml)$/)?.[1];
  assert.ok(file, `${path} must be a workflow file in .github/workflows/`);
  assert.ok(
    existsSync(new URL(`../${path}`, import.meta.url)),
    `${path} must exist`,
  );
  assert.ok(
    triggers(workflow(file.slice(0, -'.yml'.length))).includes('workflow_call'),
    `${path} must be a reusable workflow`,
  );
  assert.deepEqual(
    workflowFiles()
      .filter(({ text }) => text.includes('-github-cdk-deploy'))
      .map(({ name }) => name),
    [file],
    'only the trusted workflow may assume the CDK entry role',
  );
  assert.deepEqual(topLevelCallers(file), [
    'delivery-rollback.yml',
    'release-pr.yml',
  ]);
  // The bootstrap roots must use the module default, which this test pins.
  for (const environment of ['dev', 'prod']) {
    for (const name of ['main.tf', 'bootstrap.auto.tfvars.example']) {
      assert.doesNotMatch(
        repositoryFile(`infrastructure/${environment}/bootstrap/${name}`),
        /cdk_deploy_workflow_path/,
      );
    }
  }
});

// GitHub holds only these names at repository level. The account IDs and
// domains are secrets because the repository is public and variables print
// unmasked; everything else is derived from them.
const ALLOWED_VARIABLES = [
  'DEV_AWS_REGION',
  'MCC_TURBO_CACHE',
  'PROD_AWS_REGION',
  'RELEASE_PLEASE_APP_ID',
];
const ALLOWED_SECRETS = [
  'DEV_AWS_ACCOUNT_ID',
  'GITHUB_TOKEN',
  'MCC_PROJECT_TOKEN',
  'PROD_AWS_ACCOUNT_ID',
  'RELEASE_PLEASE_APP_PRIVATE_KEY',
];
// Retired names that no workflow or Terrateam step may read again.
const RETIRED_NAMES = [
  'AWS_CDK_DEPLOY_ROLE_ARN',
  'DEV_TERRATEAM_ROLE_ARN',
  'DEV_TOFU_STATE_BUCKET',
  'MCC_GITHUB_OIDC_SUBJECT_REPOSITORY',
  'PROD_TERRATEAM_ROLE_ARN',
  'PROD_TOFU_STATE_BUCKET',
];

const workflowFiles = () => {
  const directory = new URL('../.github/workflows/', import.meta.url);
  return readdirSync(directory)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => ({
      name,
      text: readFileSync(new URL(name, directory), 'utf8'),
    }));
};

const referenced = (text, context) =>
  [
    ...text.matchAll(
      new RegExp(`\\b${context}\\.([A-Za-z_][A-Za-z0-9_]*)`, 'g'),
    ),
  ].map(([, name]) => name);

const expression = (value) => value.replace(/^\$\{\{\s*|\s*\}\}$/g, '');

test('workflows read only the repository account, Region, and release names', () => {
  const files = [
    ...workflowFiles(),
    {
      name: 'turbo-s3-cache',
      text: repositoryFile('.github/actions/turbo-s3-cache/action.yml'),
    },
  ];
  for (const { name, text } of files) {
    for (const variable of referenced(text, 'vars')) {
      assert.ok(
        ALLOWED_VARIABLES.includes(variable),
        `${name} reads vars.${variable}`,
      );
    }
    for (const secret of referenced(text, 'secrets')) {
      assert.ok(
        ALLOWED_SECRETS.includes(secret),
        `${name} reads secrets.${secret}`,
      );
    }
    for (const retired of RETIRED_NAMES) {
      assert.ok(!text.includes(retired), `${name} names ${retired}`);
    }
  }
  for (const job of ['check-workspaces', 'check-bundles']) {
    const cache = ci.jobs[job].steps.find((step) =>
      step.uses?.endsWith('/actions/turbo-s3-cache'),
    );
    assert.equal(
      cache.with['account-id'],
      '${{ secrets.DEV_AWS_ACCOUNT_ID }}',
      job,
    );
    assert.equal(
      cache.with.region,
      "${{ vars.DEV_AWS_REGION || 'us-east-1' }}",
      job,
    );
  }
});

test('deployment selects the account and Region by environment and builds the role ARN', () => {
  const deploy = deployment.jobs.deploy;
  assert.deepEqual(Object.keys(deployment.on.workflow_call.secrets).sort(), [
    'DEV_AWS_ACCOUNT_ID',
    'PROD_AWS_ACCOUNT_ID',
  ]);
  const vars = {
    DEV_AWS_REGION: 'dev-region-1',
    PROD_AWS_REGION: 'prod-region-1',
  };
  const secrets = {
    DEV_AWS_ACCOUNT_ID: '111111111111',
    PROD_AWS_ACCOUNT_ID: '222222222222',
  };
  const resolve = (environment, values = { vars, secrets }) => {
    const inputs = { environment };
    const env = Object.fromEntries(
      ['AWS_REGION', 'MCC_DEV_ACCOUNT_ID', 'MCC_PROD_ACCOUNT_ID'].map(
        (name) => [
          name,
          evaluate(expression(deploy.env[name]), { inputs, ...values }),
        ],
      ),
    );
    const step = (name) =>
      deploy.steps.find((candidate) => candidate.name === name);
    const role = deploy.steps.find(
      (candidate) => candidate.with?.['role-to-assume'],
    ).with['role-to-assume'];
    return {
      env,
      cacheAccount: evaluate(
        expression(step('Start environment Turbo cache').with['account-id']),
        { env },
      ),
      expectedAccount: evaluate(
        expression(step('Verify target account').env.EXPECTED_ACCOUNT),
        { env },
      ),
      role: role.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, inner) =>
        evaluate(inner, { env, inputs }),
      ),
    };
  };
  const dev = resolve('dev');
  assert.deepEqual(dev.env, {
    AWS_REGION: 'dev-region-1',
    MCC_DEV_ACCOUNT_ID: '111111111111',
    MCC_PROD_ACCOUNT_ID: '',
  });
  assert.equal(dev.cacheAccount, '111111111111');
  assert.equal(dev.expectedAccount, '111111111111');
  assert.equal(
    dev.role,
    'arn:aws:iam::111111111111:role/mcc-stats-suite-dev-github-cdk-deploy',
  );
  const prod = resolve('prod');
  assert.deepEqual(prod.env, {
    AWS_REGION: 'prod-region-1',
    MCC_DEV_ACCOUNT_ID: '',
    MCC_PROD_ACCOUNT_ID: '222222222222',
  });
  assert.equal(prod.cacheAccount, '222222222222');
  assert.equal(prod.expectedAccount, '222222222222');
  assert.equal(
    prod.role,
    'arn:aws:iam::222222222222:role/mcc-stats-suite-prod-github-cdk-deploy',
  );
  // A missing prod value never falls back to the dev one.
  const missing = resolve('prod', {
    vars: { DEV_AWS_REGION: 'dev-region-1' },
    secrets: { DEV_AWS_ACCOUNT_ID: '111111111111' },
  });
  assert.equal(missing.env.AWS_REGION, 'us-east-1');
  assert.equal(missing.expectedAccount, '');
});

test('each deployment caller passes only the account secrets it deploys to', () => {
  assert.deepEqual(release.jobs['deliver-applications'].secrets, {
    DEV_AWS_ACCOUNT_ID: '${{ secrets.DEV_AWS_ACCOUNT_ID }}',
    PROD_AWS_ACCOUNT_ID: '${{ secrets.PROD_AWS_ACCOUNT_ID }}',
  });
  assert.deepEqual(delivery.jobs['deploy-dev'].secrets, {
    DEV_AWS_ACCOUNT_ID: '${{ secrets.DEV_AWS_ACCOUNT_ID }}',
  });
  assert.deepEqual(delivery.jobs['deploy-prod'].secrets, {
    PROD_AWS_ACCOUNT_ID: '${{ secrets.PROD_AWS_ACCOUNT_ID }}',
  });
  assert.deepEqual(
    workflow('delivery-rollback').jobs['rollback-prod'].secrets,
    {
      PROD_AWS_ACCOUNT_ID: '${{ secrets.PROD_AWS_ACCOUNT_ID }}',
    },
  );
});

test('no condition, job output, or deployment URL depends on a masked value', () => {
  // Actions masks secrets wherever they appear and drops job outputs that
  // contain one, so a secret, or an account ID derived from one, must stay
  // out of these places.
  const masked = /secrets\.|_ACCOUNT_ID|ROLE_ARN|STATE_BUCKET|EMAIL_DOMAIN/;
  for (const { name, text } of workflowFiles()) {
    const parsed = parse(text);
    const outputs = parsed.on?.workflow_call?.outputs;
    if (outputs) {
      assert.doesNotMatch(JSON.stringify(outputs), masked, name);
    }
    for (const [id, job] of Object.entries(parsed.jobs ?? {})) {
      const where = `${name} ${id}`;
      assert.doesNotMatch(String(job.if ?? ''), masked, `${where} if`);
      assert.doesNotMatch(
        JSON.stringify(job.outputs ?? {}),
        masked,
        `${where} outputs`,
      );
      if (typeof job.environment === 'object') {
        assert.doesNotMatch(
          String(job.environment.url ?? ''),
          masked,
          `${where} environment url`,
        );
      }
      for (const step of job.steps ?? []) {
        assert.doesNotMatch(
          String(step.if ?? ''),
          masked,
          `${where} ${step.name ?? step.uses} if`,
        );
      }
    }
  }
});

test('deployment rejects a missing account secret before any work', () => {
  const step = deployment.jobs.deploy.steps.find(
    (candidate) => candidate.name === 'Validate deployment request',
  );
  const run = (env) =>
    spawnSync('bash', ['-e', '-c', step.run], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        APPLICATION: 'match-to-csv',
        DEPLOYMENT_ENVIRONMENT: 'prod',
        TARGET_SHA: 'a'.repeat(40),
        MCC_DEV_ACCOUNT_ID: '',
        MCC_PROD_ACCOUNT_ID: '',
        OPERATION: 'release',
        GITHUB_REF: 'refs/heads/main',
        ...env,
      },
    });
  assert.equal(run({ MCC_PROD_ACCOUNT_ID: '222222222222' }).status, 0);
  for (const account of ['', '22222222222', 'not-an-account']) {
    const result = run({ MCC_PROD_ACCOUNT_ID: account });
    assert.equal(result.status, 1, account);
    assert.match(result.stdout, /prod account ID repository secret/);
  }
});

test('deployment checks the caller account against the account secret', () => {
  const step = deployment.jobs.deploy.steps.find(
    (candidate) => candidate.name === 'Verify target account',
  );
  assert.equal(
    step.env.EXPECTED_ACCOUNT,
    '${{ env.MCC_DEV_ACCOUNT_ID || env.MCC_PROD_ACCOUNT_ID }}',
  );
  // The secret reaches the shell through the environment, never inline.
  assert.doesNotMatch(step.run, /\$\{\{/);
  const directory = mkdtempSync(join(tmpdir(), 'mcc-account-check-'));
  writeFileSync(
    join(directory, 'aws'),
    '#!/usr/bin/env bash\necho 111111111111\n',
    { mode: 0o755 },
  );
  const run = (expected) =>
    spawnSync('bash', ['-e', '-c', step.run], {
      encoding: 'utf8',
      env: {
        PATH: `${directory}:${process.env.PATH}`,
        EXPECTED_ACCOUNT: expected,
      },
    });
  assert.equal(run('111111111111').status, 0);
  for (const expected of ['222222222222', '']) {
    const result = run(expected);
    assert.equal(result.status, 1, expected);
    assert.match(result.stdout, /wrong account/);
  }
});

// The Terrateam runner applies Python's string.Template to role_arn (once) and
// to every extra_args and cmd element (until the text stops changing). $$ is
// an escape, $NAME and ${NAME} substitute, an undefined name fails the step,
// and any other $ is an invalid placeholder.
const terrateamSubstitute = (text, env, { recursive }) => {
  const result = text.replace(
    /\$(?:(\$)|([_a-zA-Z][_a-zA-Z0-9]*)|\{([_a-zA-Z][_a-zA-Z0-9]*)\}|())/g,
    (match, escaped, named, braced, invalid) => {
      if (escaped) return '$';
      if (invalid !== undefined)
        throw new Error(`invalid placeholder in ${text}`);
      const name = named ?? braced;
      if (!(name in env)) throw new Error(`missing ${name}`);
      return env[name];
    },
  );
  return recursive && result !== text
    ? terrateamSubstitute(result, env, { recursive })
    : result;
};

test('Terrateam builds the role, backend, and OIDC subject from the repository names', () => {
  const config = parse(repositoryFile('.terrateam/config.yml'));
  const names = new Set(
    [
      ...JSON.stringify(config.definitions).matchAll(
        /\$\{?([_a-zA-Z][_a-zA-Z0-9]*)/g,
      ),
    ].map(([, name]) => name),
  );
  assert.deepEqual([...names].sort(), [
    'DEV_AWS_ACCOUNT_ID',
    'DEV_AWS_REGION',
    'DEV_MCC_EMAIL_ALIAS',
    'DEV_MCC_EMAIL_DOMAIN',
    'GITHUB_REPOSITORY',
    'GITHUB_REPOSITORY_ID',
    'GITHUB_REPOSITORY_OWNER',
    'GITHUB_REPOSITORY_OWNER_ID',
    'PROD_AWS_ACCOUNT_ID',
    'PROD_AWS_REGION',
    'PROD_MCC_EMAIL_ALIAS',
    'PROD_MCC_EMAIL_DOMAIN',
  ]);
  const env = {
    DEV_AWS_ACCOUNT_ID: '111111111111',
    PROD_AWS_ACCOUNT_ID: '222222222222',
    DEV_AWS_REGION: 'dev-region-1',
    PROD_AWS_REGION: 'prod-region-1',
    DEV_MCC_EMAIL_DOMAIN: 'dev.example.com',
    PROD_MCC_EMAIL_DOMAIN: 'prod.example.com',
    DEV_MCC_EMAIL_ALIAS: 'dev-alias',
    PROD_MCC_EMAIL_ALIAS: 'prod-alias',
    GITHUB_REPOSITORY_OWNER: 'Owner-1',
    GITHUB_REPOSITORY_OWNER_ID: '123',
    GITHUB_REPOSITORY: 'Owner-1/repo.name',
    GITHUB_REPOSITORY_ID: '456',
  };
  const expected = {
    'infra/foundation-dev': [
      'dev',
      '111111111111',
      'dev-region-1',
      'dev.example.com',
      'dev-alias',
    ],
    'infra/foundation-prod': [
      'prod',
      '222222222222',
      'prod-region-1',
      'prod.example.com',
      'prod-alias',
    ],
  };
  assert.deepEqual(
    config.workflows.map((entry) => entry.environment),
    Object.keys(expected),
  );
  for (const entry of config.workflows) {
    const [environment, account, region, domain, alias] =
      expected[entry.environment];
    assert.equal(entry.tag_query, environment);
    for (const steps of [entry.plan, entry.apply]) {
      const oidc = steps.find((step) => step.type === 'oidc');
      assert.equal(
        terrateamSubstitute(oidc.role_arn, env, { recursive: false }),
        `arn:aws:iam::${account}:role/mcc-stats-suite-${environment}-terrateam`,
      );
      const init = steps.find((step) => step.type === 'init');
      assert.deepEqual(
        init.extra_args.map((arg) =>
          terrateamSubstitute(arg, env, { recursive: true }),
        ),
        [
          '-lockfile=readonly',
          `-backend-config=bucket=mcc-stats-suite-tofu-state-${account}-${region}`,
          `-backend-config=region=${region}`,
        ],
      );
      const outputs = Object.fromEntries(
        steps
          .filter((step) => step.type === 'env')
          .map((step) => {
            const cmd = step.cmd.map((part) =>
              terrateamSubstitute(part, env, { recursive: true }),
            );
            const result = spawnSync(cmd[0], cmd.slice(1), {
              encoding: 'utf8',
              env: { PATH: process.env.PATH },
            });
            assert.equal(result.status, 0, result.stderr);
            return [
              step.name,
              { value: result.stdout.trim(), sensitive: step.sensitive },
            ];
          }),
      );
      assert.deepEqual(outputs, {
        TF_VAR_aws_region: { value: region, sensitive: undefined },
        TF_VAR_email_domain: { value: domain, sensitive: true },
        TF_VAR_email_alias: { value: alias, sensitive: true },
        TF_VAR_github_oidc_subject_repository: {
          value: 'Owner-1@123/repo.name@456',
          sensitive: undefined,
        },
      });
    }
  }
});

test('every OpenTofu root has a self-contained .envrc example and no backend file', () => {
  const editable = {
    bootstrap: [
      'AWS_PROFILE',
      'TF_VAR_github_organization',
      'TF_VAR_github_oidc_subject_repository',
    ],
    foundation: ['AWS_PROFILE', 'TF_VAR_github_oidc_subject_repository'],
    'data-platform': ['AWS_PROFILE'],
    'local-cdk': ['AWS_PROFILE'],
  };
  // Only dev has local CDK deployments.
  const devOnly = new Set(['local-cdk']);
  const exported = (text) => [
    ...new Set(
      [...text.matchAll(/^\s*export ([A-Za-z_][A-Za-z0-9_]*)=/gm)].map(
        ([, name]) => name,
      ),
    ),
  ];
  assert.deepEqual(exported(repositoryFile('.envrc.example')), ['AWS_PROFILE']);
  const bin = mkdtempSync(join(tmpdir(), 'mcc-envrc-'));
  const calls = join(bin, 'calls.log');
  writeFileSync(
    join(bin, 'aws'),
    [
      '#!/usr/bin/env bash',
      `echo "aws $*" >> "${calls}"`,
      'case "$*" in',
      '  "configure get sso_account_id") echo "${STUB_ACCOUNT}" ;;',
      '  "configure get region") echo "${STUB_REGION}" ;;',
      '  "ssm get-parameter --name "*"/email-domain "*)',
      '    [ -n "${STUB_DOMAIN:-}" ] || { echo "ParameterNotFound" >&2; exit 254; }',
      '    echo "${STUB_DOMAIN}" ;;',
      '  "ssm get-parameter --name "*"/email-alias "*)',
      '    [ -n "${STUB_ALIAS:-}" ] || { echo "ParameterNotFound" >&2; exit 254; }',
      '    echo "${STUB_ALIAS}" ;;',
      '  *) echo "unexpected aws $*" >&2; exit 2 ;;',
      'esac',
    ].join('\n'),
    { mode: 0o755 },
  );
  for (const environment of ['dev', 'prod']) {
    for (const [root, names] of Object.entries(editable)) {
      if (environment !== 'dev' && devOnly.has(root)) continue;
      const directory = `infrastructure/${environment}/${root}`;
      const foundation = root === 'foundation';
      const text = repositoryFile(`${directory}/.envrc.example`);
      assert.doesNotMatch(text, /source_up|source_env/, directory);
      assert.deepEqual(
        exported(text),
        [
          ...names,
          'TF_VAR_aws_region',
          'TF_CLI_ARGS_init',
          ...(foundation ? ['TF_VAR_email_domain', 'TF_VAR_email_alias'] : []),
        ],
        directory,
      );
      assert.ok(
        !existsSync(
          new URL(`../${directory}/backend.hcl.example`, import.meta.url),
        ),
        directory,
      );
      const load = (env) => {
        writeFileSync(calls, '');
        // Debian and Ubuntu bash source /etc/bash.bashrc even for -c when
        // stdin is a socket, as spawnSync's default pipes are on Linux, and
        // -u then fails on PS1. Close stdin and skip startup files.
        const result = spawnSync(
          'bash',
          [
            '--norc',
            '-euo',
            'pipefail',
            '-c',
            `source "$1"; printf '%s\\n' "$AWS_PROFILE" "$TF_VAR_aws_region" "$TF_CLI_ARGS_init" "\${TF_VAR_email_domain-<unset>}" "\${TF_VAR_email_alias-<unset>}"`,
            '_',
            new URL(`../${directory}/.envrc.example`, import.meta.url).pathname,
          ],
          {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { PATH: `${bin}:${process.env.PATH}`, ...env },
          },
        );
        return {
          ...result,
          lines: result.stdout.trim().split('\n'),
          calls: readFileSync(calls, 'utf8').trim().split('\n'),
        };
      };
      const profile = {
        STUB_ACCOUNT: '111111111111',
        STUB_REGION: 'us-east-2',
      };
      const parameter = `/mcc/${environment}/match-to-csv/email-domain`;
      const aliasParameter = `/mcc/${environment}/match-to-csv/email-alias`;
      const read = (name) =>
        `aws ssm get-parameter --name ${name} --region us-east-2 --query Parameter.Value --output text`;
      const stored = { STUB_DOMAIN: 'mail.example.com', STUB_ALIAS: 'stored' };
      const fromProfile = load({ ...profile, ...stored });
      assert.equal(fromProfile.status, 0, fromProfile.stderr);
      assert.equal(fromProfile.stderr, '');
      assert.deepEqual(fromProfile.lines, [
        `mcc-${environment}-admin`,
        'us-east-2',
        '-backend-config=bucket=mcc-stats-suite-tofu-state-111111111111-us-east-2 -backend-config=region=us-east-2',
        foundation ? 'mail.example.com' : '<unset>',
        foundation ? 'stored' : '<unset>',
      ]);
      assert.deepEqual(fromProfile.calls, [
        'aws configure get sso_account_id',
        'aws configure get region',
        ...(foundation ? [read(parameter), read(aliasParameter)] : []),
      ]);
      // AWS_REGION wins over the profile, as it does for the AWS CLI.
      const override = load({ ...profile, AWS_REGION: 'eu-west-1' });
      assert.match(override.stdout, /tofu-state-111111111111-eu-west-1 /);
      const unset = load({ STUB_ACCOUNT: '', STUB_REGION: '' });
      assert.equal(unset.status, 0, unset.stderr);
      assert.match(unset.stderr, /Set sso_account_id and region/);
      if (!foundation) continue;
      assert.match(
        text,
        /^# email_domain_override="REPLACE_WITH_VERIFIED_DOMAIN"$/m,
      );
      assert.match(
        text,
        /^# email_alias_override="REPLACE_WITH_EMAIL_ALIAS"$/m,
      );
      // A failed read warns with the parameter and profile, leaves the input
      // unset, and never prints a domain or an alias.
      const unreadable = load(profile);
      assert.equal(unreadable.status, 0, unreadable.stderr);
      assert.deepEqual(unreadable.lines.slice(3), ['<unset>', '<unset>']);
      for (const name of [parameter, aliasParameter]) {
        assert.ok(unreadable.stderr.includes(name), unreadable.stderr);
      }
      assert.ok(
        unreadable.stderr.includes(`mcc-${environment}-admin`),
        unreadable.stderr,
      );
      assert.doesNotMatch(unreadable.stderr, /ParameterNotFound/);
      // Each read is independent: a missing alias leaves the domain set and
      // the warning names only the alias parameter, without either value.
      const aliasMissing = load({
        ...profile,
        STUB_DOMAIN: 'mail.example.com',
      });
      assert.deepEqual(aliasMissing.lines.slice(3), [
        'mail.example.com',
        '<unset>',
      ]);
      assert.ok(aliasMissing.stderr.includes(aliasParameter));
      assert.ok(!aliasMissing.stderr.includes(parameter));
      assert.doesNotMatch(aliasMissing.stderr, /mail\.example\.com/);
      // The one-time overrides win and skip their parameter reads.
      const firstApply = load({
        ...profile,
        ...stored,
        email_domain_override: 'new.example.com',
        email_alias_override: 'new-alias',
      });
      assert.deepEqual(firstApply.lines.slice(3), [
        'new.example.com',
        'new-alias',
      ]);
      assert.ok(!firstApply.calls.some((call) => call.includes(' ssm ')));
      assert.equal(firstApply.stderr, '');
      // The alias override alone still reads the applied domain.
      const aliasOnly = load({
        ...profile,
        ...stored,
        email_alias_override: 'new-alias',
      });
      assert.deepEqual(aliasOnly.lines.slice(3), [
        'mail.example.com',
        'new-alias',
      ]);
      assert.deepEqual(
        aliasOnly.calls.filter((call) => call.includes(' ssm ')),
        [read(parameter)],
      );
      assert.equal(aliasOnly.stderr, '');
    }
    const backend = repositoryFile(
      `infrastructure/${environment}/bootstrap/backend.tf.example`,
    );
    assert.match(
      backend,
      new RegExp(`key += "${environment}/bootstrap/opentofu.tfstate"`),
    );
    assert.match(backend, /encrypt += true/);
    assert.match(backend, /use_lockfile += true/);
    assert.doesNotMatch(backend, /^\s*(bucket|region)\s*=/m);
  }
});

test('a foundation revision file triggers its root and drift reports daily without reconciling', () => {
  const config = parse(repositoryFile('.terrateam/config.yml'));
  for (const environment of ['dev', 'prod']) {
    const root = `infrastructure/${environment}/foundation`;
    assert.ok(
      config.dirs[root].when_modified.file_patterns.includes(
        '${DIR}/external-inputs.revision',
      ),
      root,
    );
    const revision = repositoryFile(`${root}/external-inputs.revision`);
    const entries = revision
      .split('\n')
      .filter((line) => line && !line.startsWith('#'));
    assert.ok(entries.length > 0, root);
    for (const entry of entries) {
      assert.match(entry, /^\d{4}-\d{2}-\d{2} \S/, root);
    }
  }
  assert.equal(config.drift.enabled, true);
  assert.deepEqual(config.drift.schedules, {
    foundation: { tag_query: 'foundation', schedule: 'daily' },
  });
  assert.ok(!JSON.stringify(config.drift).includes('reconcile'));
  assert.deepEqual(config.hooks.plan.post, [{ type: 'drift_create_issue' }]);
});

test('Terrateam evaluates pull requests into main from every branch except the Release Please branch', () => {
  const config = parse(repositoryFile('.terrateam/config.yml'));
  // One combined release pull request uses release-please--branches--main.
  const releasePlease = JSON.parse(
    repositoryFile('release-please-config.json'),
  );
  assert.equal(releasePlease['separate-pull-requests'], false);
  assert.deepEqual(config.destination_branches, [
    {
      branch: 'main',
      source_branches: ['*', '!release-please--branches--main'],
    },
  ]);
});

const sha = 'a'.repeat(40);
const repo = { owner: 'owner', repo: 'repo' };

test('rollback keeps prior prod qualification and the protected shared deployment path', async () => {
  const rollback = workflow('delivery-rollback');
  assert.equal(rollback.on.workflow_run, undefined);
  assert.ok(rollback.on.workflow_dispatch);
  const deploy = rollback.jobs['rollback-prod'];
  assert.equal(deploy.needs, 'qualify-release');
  assert.equal(
    deploy.uses,
    './.github/workflows/_delivery-deploy-environment.yml',
  );
  assert.equal(deploy.with.environment, 'prod');
  assert.equal(deploy.with.sha, '${{ needs.qualify-release.outputs.sha }}');
  const steps = rollback.jobs['qualify-release'].steps;
  assert.ok(steps.some((step) => step.name === 'Require rollback reason'));
  const script = steps.find(
    (step) => step.name === 'Verify prior qualification',
  ).with.script;
  for (const state of ['success', 'failure', 'in_progress', undefined]) {
    const failures = [];
    await runScript(script, {
      context: { repo },
      process: {
        env: {
          APPLICATION: 'match-to-csv',
          OPERATION: 'rollback',
          TARGET_SHA: sha,
        },
      },
      github: {
        rest: {
          repos: {
            listDeployments: 'deployments',
            listDeploymentStatuses: 'statuses',
          },
        },
        paginate: async (method, request) => {
          if (method === 'deployments') {
            assert.equal(request.environment, 'prod');
            assert.equal(request.sha, sha);
            assert.equal(request.task, 'deploy:match-to-csv');
            return [
              { id: 1, sha, task: request.task, created_at: '2026-01-01' },
            ];
          }
          return state ? [{ state, created_at: '2026-01-01' }] : [];
        },
      },
      core: { setFailed: (message) => failures.push(message) },
    });
    assert.equal(failures.length, state === 'success' ? 0 : 1);
  }
});

const selection = release.jobs['update-release-pr'].steps.find(
  (step) => step.id === 'selection',
);
const select = async (outputs) => {
  let applications;
  await runScript(selection.with.script, {
    process: { env: { RELEASE_OUTPUTS: JSON.stringify(outputs) } },
    core: {
      setOutput: (name, value) => {
        assert.equal(name, 'applications');
        applications = JSON.parse(value);
      },
    },
  });
  return applications;
};
const released = (app, version = '1.2.3', commit = sha) => ({
  [`applications/${app}--tag_name`]: `${app}-v${version}`,
  [`applications/${app}--sha`]: commit,
});

test('only application releases from Release Please outputs deploy at their release commits', async () => {
  assert.deepEqual(release.on.push.branches, ['main']);
  assert.equal(release.on.release, undefined);
  assert.equal(release.on.workflow_run, undefined);
  assert.deepEqual(await select({}), []);
  assert.deepEqual(await select({ paths_released: '[]' }), []);
  assert.deepEqual(
    await select({
      paths_released: '["packages/contracts","packages/cdk-config"]',
    }),
    [],
  );
  const outputs = {
    paths_released:
      '["applications/admin","packages/contracts","applications/match-to-csv"]',
    ...released('admin'),
    ...released('match-to-csv', '3.10.0', 'b'.repeat(40)),
  };
  assert.deepEqual(await select(outputs), [
    { application: 'admin', tag: 'admin-v1.2.3', sha },
    {
      application: 'match-to-csv',
      tag: 'match-to-csv-v3.10.0',
      sha: 'b'.repeat(40),
    },
  ]);
  for (const invalid of [
    { ...outputs, paths_released: '{}' },
    {
      ...outputs,
      paths_released: '["applications/admin","applications/admin"]',
    },
    { ...outputs, paths_released: '["applications/unknown"]' },
    { ...outputs, 'applications/admin--tag_name': 'player-v1.2.3' },
    { ...outputs, 'applications/admin--tag_name': 'admin-v1.2.3-rc.1' },
    { ...outputs, 'applications/admin--sha': 'main' },
  ])
    await assert.rejects(select(invalid), /Invalid/);
  const job = release.jobs['deliver-applications'];
  assert.equal(job.strategy['fail-fast'], false);
  assert.equal(
    job.uses,
    './.github/workflows/_delivery-release-application.yml',
  );
  assert.equal(job.with.sha, '${{ matrix.release.sha }}');
  assert.equal(job.with['release-tag'], '${{ matrix.release.tag }}');
  assert.equal(job.with.application, '${{ matrix.release.application }}');
  for (const ref of ['refs/heads/main', 'refs/tags/admin-v1.2.3']) {
    for (const applications of ['[]', '[{"application":"admin"}]']) {
      assert.equal(
        evaluate(job.if, {
          github: { ref },
          needs: { 'update-release-pr': { outputs: { applications } } },
        }),
        ref === 'refs/heads/main' && applications !== '[]',
      );
    }
  }
});

test('each release has its own successful dev dependency before prod approval', () => {
  const dev = delivery.jobs['deploy-dev'];
  const prod = delivery.jobs['deploy-prod'];
  for (const [job, environment] of [
    [dev, 'dev'],
    [prod, 'prod'],
  ]) {
    assert.equal(
      job.uses,
      './.github/workflows/_delivery-deploy-environment.yml',
    );
    assert.deepEqual(job.with, {
      application: '${{ inputs.application }}',
      environment,
      sha: '${{ inputs.sha }}',
      operation: 'release',
      source: '${{ inputs.release-tag }}',
    });
  }
  assert.equal(prod.needs, 'deploy-dev');
  for (const deployed of ['true', 'false', '']) {
    assert.equal(
      evaluate(prod.if, { needs: { 'deploy-dev': { outputs: { deployed } } } }),
      deployed === 'true',
    );
  }
  assert.equal(
    deployment.on.workflow_call.outputs.deployed.value,
    '${{ jobs.deploy.outputs.deployed }}',
  );
  assert.match(
    deployment.jobs.deploy.outputs.deployed,
    /steps.deploy.outcome == 'success' && steps.verify.outcome == 'success'/,
  );
  assert.equal(
    deployment.jobs.deploy.environment.name,
    '${{ inputs.environment }}',
  );
  assert.match(deployment.jobs.deploy.name, /waits for approval/);
});

test('forward and rollback operations hold one application/environment queue through verification', () => {
  assert.equal(deployment.concurrency, undefined);
  assert.deepEqual(deployment.jobs.deploy.concurrency, {
    group: 'deploy-${{ inputs.application }}-${{ inputs.environment }}',
    queue: 'max',
  });
  assert.equal(
    workflow('delivery-rollback').jobs['rollback-prod'].with.operation,
    '${{ inputs.operation }}',
  );
  const steps = deployment.jobs.deploy.steps;
  const guard = steps.findIndex((step) => step.id === 'version-guard');
  assert.ok(
    guard > steps.findIndex((step) => step.name === 'Read release metadata'),
  );
  for (const step of steps.slice(
    guard + 1,
    steps.findIndex((step) => step.name === 'Finish deployment record'),
  )) {
    assert.match(
      step.if,
      /steps.version-guard.outputs.deploy == 'true'/,
      step.name,
    );
  }
  const finish = steps.find((step) => step.name === 'Finish deployment record');
  assert.match(finish.if, /always\(\).*steps.deployment.outputs.result != ''/);
});

const guard = deployment.jobs.deploy.steps.find(
  (step) => step.id === 'version-guard',
);
const record = (id, version, extra = {}) => ({
  id,
  environment: 'prod',
  task: 'deploy:admin',
  payload: {
    application: 'admin',
    release: { application: { version } },
  },
  ...extra,
});
const checkVersion = async ({
  candidate = '2.0.0',
  operation = 'release',
  records = [],
  states = {},
  environment = 'prod',
  tag = `admin-v${candidate}`,
} = {}) => {
  const outputs = {};
  let summary;
  const calls = [];
  await runScript(guard.with.script, {
    process: {
      env: {
        APPLICATION: 'admin',
        DEPLOYMENT_ENVIRONMENT: environment,
        OPERATION: operation,
        RELEASE_TAG: tag,
        RELEASE_METADATA: JSON.stringify({
          application: { name: '@mcc/admin', version: candidate },
        }),
      },
    },
    context: { repo },
    github: {
      rest: {
        repos: {
          listDeployments: 'deployments',
          listDeploymentStatuses: 'statuses',
        },
      },
      paginate: async (method, request) => {
        calls.push([method, request]);
        if (method === 'deployments') {
          assert.equal(request.environment, environment);
          assert.equal(request.task, 'deploy:admin');
          assert.equal(request.sha, undefined);
          assert.equal(request.per_page, 100);
          return records;
        }
        return states[request.deployment_id] ?? [{ id: 1, state: 'success' }];
      },
    },
    core: {
      setOutput: (name, value) => {
        outputs[name] = value;
      },
      summary: {
        addRaw: (value) => {
          summary = value;
          return { write: async () => {} };
        },
      },
    },
  });
  return { outputs, summary, calls };
};

test('forward versions bootstrap, compare numerically, and skip equal or older releases with a summary', async () => {
  for (const [candidate, previous, expected] of [
    ['2.0.0', '1.9.9', 'true'],
    ['1.10.0', '1.9.0', 'true'],
    ['1.2.10', '1.2.9', 'true'],
    ['2.0.0', '2.0.0', 'false'],
    ['1.9.0', '1.10.0', 'false'],
    ['1.9.9', '2.0.0', 'false'],
  ]) {
    const result = await checkVersion({
      candidate,
      records: [record(1, previous)],
    });
    assert.equal(result.outputs.deploy, expected);
    if (expected === 'false')
      assert.match(
        result.summary,
        /Skipped admin-v.*not newer than the latest successful deployment/,
      );
  }
  assert.equal((await checkVersion()).outputs.deploy, 'true');
});

test('guard uses the latest successful exact application and environment deployment, including rollbacks and legacy records', async () => {
  const records = [
    record(1, '9.0.0'),
    record(5, '1.0.0'),
    record(3, '3.0.0'),
    record(7, '8.0.0', { environment: 'dev' }),
    record(8, '8.0.0', { task: 'deploy:player' }),
    record(9, '8.0.0', { payload: { application: 'player' } }),
  ];
  const states = {
    5: [
      { id: 1, state: 'success' },
      { id: 2, state: 'failure' },
    ],
  };
  assert.equal(
    (await checkVersion({ records, states })).outputs.deploy,
    'false',
  );
  // The latest success is a deliberate rollback to 1.0.0; forward 2.0.0 may deploy again.
  assert.equal(
    (await checkVersion({ records: [record(1, '9.0.0'), record(2, '1.0.0')] }))
      .outputs.deploy,
    'true',
  );
  assert.equal(
    (await checkVersion({ records: [record(1, '9.0.0')], states: { 1: [] } }))
      .outputs.deploy,
    'true',
  );
  const dev = record(1, '3.0.0', { environment: 'dev' });
  assert.equal(
    (await checkVersion({ records: [dev], environment: 'dev' })).outputs.deploy,
    'false',
  );
  await assert.rejects(
    checkVersion({ records: [record(1, undefined)] }),
    /Invalid stable release version/,
  );
  await assert.rejects(
    checkVersion({ tag: 'player-v2.0.0' }),
    /does not match/,
  );
  const rollback = await checkVersion({
    operation: 'rollback',
    records: [record(1, '9.0.0')],
  });
  assert.equal(rollback.outputs.deploy, 'true');
  assert.deepEqual(rollback.calls, []);
});

test('deployment records carry release tags and exact commit metadata', async () => {
  const step = deployment.jobs.deploy.steps.find(
    (step) => step.id === 'deployment',
  );
  let created;
  await runScript(step.with.script, {
    process: {
      env: {
        APPLICATION: 'admin',
        DEPLOYMENT_ENVIRONMENT: 'dev',
        DEPLOYMENT_OPERATION: 'release',
        DEPLOYMENT_SOURCE: 'admin-v2.0.0',
        RELEASE_METADATA: JSON.stringify({ application: { version: '2.0.0' } }),
        TARGET_SHA: sha,
      },
    },
    context: { repo, serverUrl: 'https://github.com', runId: 123 },
    github: {
      rest: {
        repos: {
          createDeployment: async (request) => {
            created = request;
            return { data: { id: 1 } };
          },
          createDeploymentStatus: async () => {},
        },
      },
    },
  });
  assert.equal(created.ref, sha);
  assert.equal(created.payload.releaseTag, 'admin-v2.0.0');
  assert.equal(created.payload.release.application.version, '2.0.0');
});

test('rollback resolves the selected release package version after main advances and requires a reason', () => {
  const rollback = workflow('delivery-rollback');
  assert.equal(rollback.on.workflow_dispatch.inputs.reason.required, true);
  const steps = rollback.jobs['qualify-release'].steps;
  const target = steps.find((step) => step.id === 'target');
  const directory = mkdtempSync(join(tmpdir(), 'mcc-rollback-release-'));
  writeFileSync(
    join(directory, 'git'),
    `#!/usr/bin/env bash
case "$1" in
  rev-list) echo ${sha} ;;
  merge-base) exit 0 ;;
  show) test "$2" = '${sha}:applications/admin/package.json' || exit 1; echo '{"version":"1.0.0"}' ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(join(directory, 'npm'), '#!/usr/bin/env bash\nexit 0\n', {
    mode: 0o755,
  });
  const output = join(directory, 'output');
  const result = spawnSync('bash', ['-eo', 'pipefail', '-c', target.run], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      PATH: `${directory}:${process.env.PATH}`,
      APPLICATION: 'admin',
      RELEASE_TAG: 'admin-v1.0.0',
      GITHUB_OUTPUT: output,
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(output, 'utf8'), `sha=${sha}\n`);
  const reason = steps.find((step) => step.name === 'Require rollback reason');
  for (const [value, expected] of [
    ['', 1],
    ['   ', 1],
    ['restore healthy release', 0],
  ]) {
    assert.equal(
      spawnSync('bash', ['-e', '-c', reason.run], { env: { REASON: value } })
        .status,
      expected,
    );
  }
});
