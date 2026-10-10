import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

const workflow = (name) =>
  parse(
    readFileSync(
      new URL(`../.github/workflows/${name}.yml`, import.meta.url),
      'utf8',
    ),
  );
const ci = workflow('ci');
const orchestration = workflow('deploy-dev');
const delivery = workflow('_deliver-aws-application');
const deployment = workflow('_deploy-aws-application');

// Execute the workflow's actual expression with GitHub's documented result values.
const evaluate = (expression, values) =>
  Function(
    ...Object.keys(values),
    `return (${expression});`,
  )(...Object.values(values));

const runScript = (script, globals) =>
  new (Object.getPrototypeOf(async function () {}).constructor)(
    ...Object.keys(globals),
    script,
  )(...Object.values(globals));

test('only successful trusted main push CI qualifies stable delivery', () => {
  assert.deepEqual(orchestration.on.workflow_run, {
    workflows: ['ci'],
    types: ['completed'],
    branches: ['main'],
  });
  for (const event of ['push', 'pull_request', 'workflow_dispatch']) {
    for (const conclusion of ['success', 'failure', 'cancelled', 'skipped']) {
      for (const head_branch of ['main', 'other']) {
        for (const repository of ['owner/repo', 'fork/repo']) {
          const allowed = evaluate(orchestration.jobs.qualify.if, {
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
  const download = orchestration.jobs.qualify.steps.find((step) =>
    step.uses?.startsWith('actions/download-artifact'),
  );
  assert.equal(download.with['run-id'], '${{ github.event.workflow_run.id }}');
  assert.equal(
    download.with.name,
    'deploy-applications-${{ github.event.workflow_run.id }}',
  );
  assert.equal(
    orchestration.jobs.qualify.outputs.sha,
    '${{ github.event.workflow_run.head_sha }}',
  );
  assert.equal(
    orchestration.jobs.deploy.with.sha,
    '${{ needs.qualify.outputs.sha }}',
  );
  for (const job of [delivery.jobs.dev, delivery.jobs.prod]) {
    assert.equal(job.with.sha, '${{ inputs.sha }}');
    assert.equal(job.with.application, '${{ inputs.application }}');
  }
  const checkout = deployment.jobs.deploy.steps.find(
    (step) => step.uses === 'actions/checkout@v4',
  );
  assert.equal(checkout.with.ref, '${{ inputs.sha }}');
});

test('each application promotes only after its own successful dev verification', () => {
  assert.equal(orchestration.jobs.deploy.strategy['fail-fast'], false);
  assert.equal(
    orchestration.jobs.deploy.uses,
    './.github/workflows/_deliver-aws-application.yml',
  );
  assert.equal(delivery.jobs.prod.needs, 'dev');
  for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
    assert.equal(
      evaluate(delivery.jobs.prod.if, { needs: { dev: { result } } }),
      result === 'success',
    );
  }
  assert.equal(delivery.jobs.dev.with.environment, 'dev');
  assert.equal(delivery.jobs.prod.with.environment, 'prod');
  assert.equal(
    evaluate(orchestration.jobs.deploy.if, {
      needs: { qualify: { outputs: { applications: '[]' } } },
    }),
    false,
  );
  const finish = deployment.jobs.deploy.steps.find(
    (step) => step.name === 'Finish deployment record',
  );
  assert.match(
    finish.env.DEPLOYMENT_STATE,
    /steps.deploy.outcome == 'success' && steps.verify.outcome == 'success'/,
  );
});

test('production requires reviewers and disabled bypass before protected job', async () => {
  const guard = deployment.jobs['qualify-production'];
  assert.equal(guard.if, "inputs.environment == 'prod'");
  assert.equal(deployment.jobs.deploy.needs, 'qualify-production');
  assert.match(
    deployment.jobs.deploy.if,
    /needs.qualify-production.result == 'success'/,
  );
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
  const script = orchestration.jobs.qualify.steps.find(
    (step) => step.id === 'selection',
  ).run;
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

test('package publication runs separately after trusted CI at the validated SHA', () => {
  const publication = workflow('publish-packages');
  assert.deepEqual(publication.on.workflow_run, orchestration.on.workflow_run);
  assert.equal(
    publication.jobs['publish-packages'].if,
    orchestration.jobs.qualify.if,
  );
  assert.equal(
    publication.jobs['publish-packages'].steps[0].with.ref,
    '${{ github.event.workflow_run.head_sha }}',
  );
});

test('approval prompt uses the qualified application and SHA with comment permissions', () => {
  const prompt = delivery.jobs['approval-prompt'];
  assert.equal(prompt.needs, 'dev');
  assert.equal(prompt.if, delivery.jobs.prod.if);
  assert.equal(prompt.environment, undefined);
  assert.deepEqual(prompt.permissions, {
    actions: 'read',
    contents: 'read',
    'pull-requests': 'read',
    issues: 'write',
  });
  assert.equal(orchestration.jobs.deploy.permissions.issues, 'write');
  assert.equal(orchestration.jobs.deploy.permissions['pull-requests'], 'read');
  assert.deepEqual(prompt.steps[0].env, {
    APPLICATION: '${{ inputs.application }}',
    TARGET_SHA: '${{ inputs.sha }}',
  });
  assert.equal(prompt.steps[0].with['github-token'], undefined);
  assert.equal(delivery.jobs.prod.name, undefined);
  assert.equal(delivery.permissions.issues, undefined);
  assert.equal(delivery.permissions['pull-requests'], undefined);
  assert.match(deployment.jobs.deploy.name, /Approve production:/);
});

test('approval prompt notifies configured reviewers per run and tolerates API failures', async () => {
  const script = delivery.jobs['approval-prompt'].steps[0].with.script;
  const sha = 'a'.repeat(40);
  const marker = '<!-- production-approval:match-to-csv:run:123 -->';
  for (const scenario of [
    'create',
    'update',
    'new-run',
    'no-pr',
    'unmerged',
    'other-sha',
    'invalid-protection',
    'bypass',
    'environment-error',
    'pulls-error',
    'list-error',
    'create-error',
    'update-error',
    'summary-error',
  ]) {
    const calls = [];
    const warnings = [];
    let summary;
    const listPulls = Symbol('pulls');
    const listComments = Symbol('comments');
    await runScript(script, {
      github: {
        rest: {
          repos: {
            listPullRequestsAssociatedWithCommit: listPulls,
            getEnvironment: async (request) => {
              assert.equal(request.environment_name, 'prod');
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
                              { type: 'User', reviewer: { login: 'approver' } },
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
          issues: {
            listComments,
            createComment: async (request) => {
              if (scenario === 'create-error')
                throw new Error('comment locked');
              calls.push(['create', request]);
            },
            updateComment: async (request) => {
              if (scenario === 'update-error')
                throw new Error('write forbidden');
              calls.push(['update', request]);
            },
          },
        },
        paginate: async (method, request) => {
          assert.equal(request.owner, 'owner');
          assert.equal(request.repo, 'repo');
          if (method === listPulls) {
            if (scenario === 'pulls-error')
              throw new Error('pull lookup failed');
            assert.equal(request.commit_sha, sha);
            return scenario === 'no-pr'
              ? []
              : [
                  {
                    number: 38,
                    merged_at: scenario === 'unmerged' ? null : 'merged',
                    merge_commit_sha:
                      scenario === 'other-sha' ? 'b'.repeat(40) : sha,
                  },
                ];
          }
          assert.equal(method, listComments);
          assert.equal(request.issue_number, 38);
          if (scenario === 'list-error')
            throw new Error('comments unavailable');
          return [
            { user: null, body: marker },
            { user: { login: 'github-actions[bot]' } },
            { user: { login: 'human' }, body: marker },
            {
              user: { login: 'github-actions[bot]' },
              body: '<!-- production-approval:admin:run:123 -->',
            },
            {
              user: { login: 'github-actions[bot]' },
              body: '<!-- production-approval:match-to-csv:run:122 -->',
            },
            ...(scenario === 'update' || scenario === 'update-error'
              ? [
                  {
                    id: 3,
                    user: { login: 'github-actions[bot]' },
                    body: `${marker}old`,
                  },
                ]
              : []),
          ];
        },
      },
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
        info: () => {},
        warning: (message) => warnings.push(message),
      },
      process: { env: { APPLICATION: 'match-to-csv', TARGET_SHA: sha } },
    });
    if (
      ['invalid-protection', 'bypass', 'environment-error'].includes(scenario)
    ) {
      assert.equal(summary, undefined);
      assert.equal(warnings.length, 1);
      assert.deepEqual(calls, []);
      continue;
    }
    assert.match(summary, /@approver @owner\/release-team/);
    assert.match(summary, /`match-to-csv` at `aaaaaaa`/);
    assert.match(
      summary,
      /https:\/\/github.com\/owner\/repo\/actions\/runs\/123/,
    );
    assert.match(summary, /Once the production job is waiting/);
    if (scenario === 'summary-error') {
      assert.equal(warnings.length, 1);
      assert.equal(calls.length, 1);
      assert.equal(calls[0][0], 'create');
      assert.equal(calls[0][1].body, summary);
    } else if (scenario.endsWith('-error')) {
      assert.equal(warnings.length, 1);
      assert.deepEqual(calls, []);
    } else if (['create', 'update', 'new-run'].includes(scenario)) {
      assert.equal(warnings.length, 0);
      assert.equal(calls.length, 1);
      const operation = scenario === 'update' ? 'update' : 'create';
      assert.equal(calls[0][0], operation);
      assert.equal(calls[0][1].body, summary);
      assert.equal(
        calls[0][1][operation === 'create' ? 'issue_number' : 'comment_id'],
        operation === 'create' ? 38 : 3,
      );
    } else {
      assert.equal(warnings.length, 0);
      assert.deepEqual(calls, []);
    }
  }
});

test('match-to-csv deploys only after the receipt rule handover check', () => {
  const steps = deployment.jobs.deploy.steps.map((step) => step.name);
  const guard = deployment.jobs.deploy.steps.find(
    (step) => step.name === 'Verify receipt rule handover',
  );
  // The guard ships with the qualified workflow revision, not the deployed one,
  // and compares the deployed template with the synthesized one.
  assert.ok(
    guard.run.includes(
      'node .cache-workflow/scripts/receipt-rule-handover.mjs',
    ),
  );
  assert.ok(guard.run.includes('cdk.out/${STACK_NAME}.template.json'));
  assert.ok(guard.run.includes('set -o pipefail'));
  // Only a missing stack skips the guard; any other read failure stops the deploy.
  assert.ok(guard.run.includes('*"does not exist"*'));
  assert.equal(guard.if, "inputs.application == 'match-to-csv'");
  const position = steps.indexOf('Verify receipt rule handover');
  assert.ok(position > steps.indexOf('Synthesize'));
  assert.ok(
    position < steps.indexOf('Create exact-revision deployment record'),
  );
  assert.ok(position < steps.indexOf('Deploy'));
});

test('match-to-csv prerequisites verify the SES identity and MX record', () => {
  const prerequisites = deployment.jobs.deploy.steps.find(
    (step) => step.name === 'Verify match-to-csv prerequisites',
  );
  assert.equal(prerequisites.if, "inputs.application == 'match-to-csv'");
  assert.ok(prerequisites.run.includes('describe-active-receipt-rule-set'));
  assert.ok(prerequisites.run.includes('describe-receipt-rule'));
  assert.ok(prerequisites.run.includes('get-identity-verification-attributes'));
  assert.ok(prerequisites.run.includes('dig +short MX'));
  assert.equal(deployment.jobs.deploy.env.MCC_EMAIL_DOMAIN, undefined);
});
