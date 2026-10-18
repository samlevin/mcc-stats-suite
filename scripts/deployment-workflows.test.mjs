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
const orchestration = workflow('delivery-deploy');
const delivery = workflow('_delivery-promote-application');
const deployment = workflow('_delivery-deploy-environment');
const selection = orchestration.jobs['select-applications'];

test('only successful trusted main push CI qualifies stable delivery', () => {
  assert.deepEqual(orchestration.on.workflow_run, {
    workflows: [ci.name],
    types: ['completed'],
    branches: ['main'],
  });
  assert.equal(ci.name, 'CI: checks');
  for (const event of ['push', 'pull_request', 'workflow_dispatch']) {
    for (const conclusion of ['success', 'failure', 'cancelled', 'skipped']) {
      for (const head_branch of ['main', 'other']) {
        for (const repository of ['owner/repo', 'fork/repo']) {
          const allowed = evaluate(selection.if, {
            github: {
              repository: 'owner/repo',
              event: {
                workflow_run: {
                  event,
                  conclusion,
                  head_branch,
                  head_repository: { full_name: repository },
                },
              },
            },
          });
          assert.equal(
            allowed,
            event === 'push' &&
              conclusion === 'success' &&
              head_branch === 'main' &&
              repository === 'owner/repo',
          );
        }
      }
    }
  }
  assert.ok(
    !Object.values(ci.jobs).some((job) => job.uses?.includes('deploy')),
  );
  assert.ok(!orchestration.on.pull_request);
});

test('artifact belongs to qualifying CI run and deployment uses that CI SHA', () => {
  const download = selection.steps.find((step) =>
    step.uses?.startsWith('actions/download-artifact'),
  );
  assert.equal(download.with['run-id'], '${{ github.event.workflow_run.id }}');
  assert.equal(
    download.with.name,
    'deploy-applications-${{ github.event.workflow_run.id }}',
  );
  assert.equal(
    selection.outputs.sha,
    '${{ github.event.workflow_run.head_sha }}',
  );
  assert.equal(
    orchestration.jobs.deliver.with.sha,
    '${{ needs.select-applications.outputs.sha }}',
  );
  for (const job of [
    delivery.jobs['deploy-dev'],
    delivery.jobs['deploy-prod'],
  ]) {
    assert.equal(job.with.sha, '${{ inputs.sha }}');
    assert.equal(job.with.application, '${{ inputs.application }}');
  }
  const checkout = deployment.jobs.deploy.steps.find(
    (step) => step.uses?.split('@')[0] === 'actions/checkout',
  );
  assert.ok(checkout, 'deployment must check out the qualifying CI revision');
  assert.match(checkout.uses, /^actions\/checkout@[a-f0-9]{40}$/);
  assert.equal(checkout.with.ref, '${{ inputs.sha }}');
});

test('each application promotes only after its own successful dev verification', () => {
  assert.equal(orchestration.jobs.deliver.strategy['fail-fast'], false);
  assert.equal(
    orchestration.jobs.deliver.uses,
    './.github/workflows/_delivery-promote-application.yml',
  );
  assert.equal(delivery.jobs['deploy-prod'].needs, 'deploy-dev');
  for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
    assert.equal(
      evaluate(delivery.jobs['deploy-prod'].if, {
        needs: { 'deploy-dev': { result } },
      }),
      result === 'success',
    );
  }
  assert.equal(delivery.jobs['deploy-dev'].with.environment, 'dev');
  assert.equal(delivery.jobs['deploy-prod'].with.environment, 'prod');
  for (const applications of ['[]', '["admin"]']) {
    assert.equal(
      evaluate(orchestration.jobs.deliver.if, {
        needs: { 'select-applications': { outputs: { applications } } },
      }),
      applications !== '[]',
    );
  }
  const finish = deployment.jobs.deploy.steps.find(
    (step) => step.name === 'Finish deployment record',
  );
  assert.match(
    finish.env.DEPLOYMENT_STATE,
    /steps.deploy.outcome == 'success' && steps.verify.outcome == 'success'/,
  );
});

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

test('selection rejects shared packages and unknown applications and accepts no affected apps', () => {
  const script = selection.steps.find((step) => step.id === 'selection').run;
  const body = script.match(/node -e '([\s\S]*)'/)[1];
  const run = new Function('require', 'process', body);
  for (const [applications, allowed] of [
    [[], true],
    [['admin'], true],
    [['contracts'], false],
    [['unknown'], false],
    [{}, false],
  ]) {
    let output;
    const invocation = () =>
      run(
        () => ({
          readFileSync: () => JSON.stringify(applications),
          appendFileSync: (_path, value) => {
            output = value;
          },
        }),
        { env: { GITHUB_OUTPUT: 'output' } },
      );
    if (allowed) {
      invocation();
      assert.equal(output, `applications=${JSON.stringify(applications)}\n`);
    } else assert.throws(invocation, /Invalid affected application list/);
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

test('approval summary uses the qualified application and SHA without comment permissions', () => {
  const prompt = delivery.jobs['request-prod-approval'];
  assert.equal(prompt.needs, 'deploy-dev');
  assert.equal(prompt.if, delivery.jobs['deploy-prod'].if);
  assert.equal(prompt.environment, undefined);
  assert.deepEqual(prompt.permissions, {
    actions: 'read',
    contents: 'read',
  });
  assert.deepEqual(orchestration.jobs.deliver.permissions, {
    actions: 'read',
    contents: 'read',
    deployments: 'write',
    'id-token': 'write',
  });
  assert.deepEqual(prompt.steps[0].env, {
    APPLICATION: '${{ inputs.application }}',
    TARGET_SHA: '${{ inputs.sha }}',
  });
  assert.equal(prompt.steps[0].with['github-token'], undefined);
  assert.equal(delivery.permissions.issues, undefined);
  assert.equal(delivery.permissions['pull-requests'], undefined);
});

test('delivery job names show the application, environment, and approval wait', () => {
  const format = (template, ...args) =>
    template.replace(/\{(\d+)\}/g, (_, index) => args[index]);
  const name = (job, values) =>
    job.name.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, inner) =>
      evaluate(inner, { format, ...values }),
    );
  assert.equal(
    name(orchestration.jobs.deliver, { matrix: { application: 'admin' } }),
    'Deliver admin',
  );
  assert.equal(delivery.jobs['deploy-dev'].name, 'Deploy to dev');
  assert.equal(delivery.jobs['deploy-prod'].name, 'Deploy to prod');
  for (const [environment, expected] of [
    ['dev', 'Deploy match-to-csv to dev'],
    ['prod', 'Deploy match-to-csv to prod (waits for approval)'],
  ]) {
    assert.equal(
      name(deployment.jobs.deploy, {
        inputs: { application: 'match-to-csv', environment },
      }),
      expected,
    );
  }
  assert.equal(
    name(workflow('delivery-rollback').jobs['rollback-prod'], {
      inputs: { application: 'player' },
    }),
    'Roll back player in prod',
  );
});

test('approval summary lists reviewers without calling pull request or comment APIs', async () => {
  const script = delivery.jobs['request-prod-approval'].steps[0].with.script;
  const sha = 'a'.repeat(40);
  for (const scenario of [
    'valid',
    'invalid-protection',
    'bypass',
    'environment-error',
    'summary-error',
  ]) {
    const calls = [];
    const warnings = [];
    let summary;
    await runScript(script, {
      github: new Proxy(
        {
          rest: {
            repos: new Proxy(
              {
                getEnvironment: async (request) => {
                  calls.push(request);
                  if (scenario === 'environment-error')
                    throw new Error('environment unavailable');
                  return {
                    data: {
                      can_admins_bypass: scenario === 'bypass',
                      protection_rules: [
                        {
                          type: 'required_reviewers',
                          reviewers:
                            scenario === 'invalid-protection'
                              ? []
                              : [
                                  {
                                    type: 'User',
                                    reviewer: { login: 'approver' },
                                  },
                                  {
                                    type: 'Team',
                                    reviewer: { slug: 'release-team' },
                                  },
                                ],
                        },
                      ],
                    },
                  };
                },
              },
              {
                get(target, key) {
                  assert.equal(
                    key,
                    'getEnvironment',
                    'only environment lookup is allowed',
                  );
                  return target[key];
                },
              },
            ),
          },
        },
        {
          get(target, key) {
            assert.equal(key, 'rest', 'pagination is not allowed');
            return new Proxy(target.rest, {
              get(rest, resource) {
                assert.equal(resource, 'repos', 'comment APIs are not allowed');
                return rest[resource];
              },
            });
          },
        },
      ),
      context: {
        repo: { owner: 'owner', repo: 'repo' },
        serverUrl: 'https://github.com',
        runId: 123,
      },
      core: {
        summary: {
          addRaw: (body) => {
            summary = body;
            return {
              write: async () => {
                if (scenario === 'summary-error')
                  throw new Error('summary unavailable');
              },
            };
          },
        },
        warning: (message) => warnings.push(message),
      },
      process: { env: { APPLICATION: 'match-to-csv', TARGET_SHA: sha } },
    });
    assert.deepEqual(calls, [
      { owner: 'owner', repo: 'repo', environment_name: 'prod' },
    ]);
    if (
      ['invalid-protection', 'bypass', 'environment-error'].includes(scenario)
    ) {
      assert.equal(summary, undefined);
      assert.equal(warnings.length, 1);
      assert.match(
        warnings[0],
        scenario === 'environment-error'
          ? /Could not prepare production approval summary: environment unavailable/
          : /Production protection is invalid/,
      );
      continue;
    }
    assert.match(summary, /@approver @owner\/release-team/);
    assert.match(summary, /`match-to-csv` at `aaaaaaa`/);
    assert.match(
      summary,
      /https:\/\/github.com\/owner\/repo\/actions\/runs\/123/,
    );
    assert.match(summary, /Once the production job is waiting/);
    assert.doesNotMatch(summary, /production-approval|<!--/);
    assert.deepEqual(
      warnings,
      scenario === 'summary-error'
        ? ['Could not write production approval summary: summary unavailable']
        : [],
    );
  }
});

// Runs the real step body under GitHub's default `bash -e` with stub `aws` and
// `dig` commands, so the parameter, rule set, identity, and MX gates are
// exercised rather than matched as text.
function runPrerequisites(stub) {
  const step = deployment.jobs.deploy.steps.find(
    (candidate) => candidate.name === 'Verify match-to-csv prerequisites',
  );
  assert.equal(step.if, "inputs.application == 'match-to-csv'");
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

test('one deployment selector publishes the application selection after the required gate', () => {
  const select = ci.jobs['select-applications'];
  const gate = ci.jobs['require-scoped-checks'];
  const save = select.steps.find(
    (step) => step.name === 'Save application selection',
  );
  const uploads = Object.values(ci.jobs).flatMap((job) =>
    job.steps.filter((step) =>
      step.uses?.startsWith('actions/upload-artifact'),
    ),
  );
  assert.equal(uploads.length, 1);
  assert.equal(select.needs, 'require-scoped-checks');
  // A skipped gate upstream of require-scoped-checks must not suppress the
  // selection.
  const selectIf = select.if.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  assert.match(
    selectIf,
    /^!cancelled\(\) && needs\.require-scoped-checks\.result == 'success'/,
  );
  assert.match(
    save.env.APPLICATIONS,
    /needs\.require-scoped-checks\.outputs\.applications \|\| '\[\]'/,
  );
  assert.equal(
    gate.outputs.applications,
    '${{ needs.check-workspaces.outputs.applications }}',
  );
  assert.match(gate.steps[0].run, /INFRASTRUCTURE_RESULT/);
  assert.match(gate.steps[0].run, /APPLICATIONS_RESULT/);
  for (const event_name of ['push', 'pull_request']) {
    for (const result of ['success', 'failure', 'skipped']) {
      const values = {
        cancelled: () => false,
        github: { event_name, ref: 'refs/heads/main' },
        needs: { 'require-scoped-checks': { result } },
      };
      assert.equal(
        evaluate(selectIf, values),
        event_name === 'push' && result === 'success',
      );
    }
  }
  assert.match(save.run, /printf '%s\\n'/);
  assert.match(save.run, /deploy-selection\/applications\.json/);
  assert.equal(
    uploads[0].with.name,
    'deploy-applications-${{ github.run_id }}',
  );
  assert.equal(
    uploads[0].with.path,
    '${{ runner.temp }}/deploy-selection/applications.json',
  );
  assert.equal(
    evaluate(orchestration.jobs.deliver.if, {
      needs: { 'select-applications': { outputs: { applications: '[]' } } },
    }),
    false,
  );
});

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
    'delivery-deploy.yml',
    'delivery-rollback.yml',
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
  assert.deepEqual(delivery.jobs['deploy-dev'].secrets, {
    DEV_AWS_ACCOUNT_ID: '${{ secrets.DEV_AWS_ACCOUNT_ID }}',
  });
  assert.deepEqual(delivery.jobs['deploy-prod'].secrets, {
    PROD_AWS_ACCOUNT_ID: '${{ secrets.PROD_AWS_ACCOUNT_ID }}',
  });
  assert.deepEqual(orchestration.jobs.deliver.secrets, {
    DEV_AWS_ACCOUNT_ID: '${{ secrets.DEV_AWS_ACCOUNT_ID }}',
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
