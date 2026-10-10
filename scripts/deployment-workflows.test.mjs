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
  const run = new (Object.getPrototypeOf(async function () {}).constructor)(
    'github',
    'context',
    script,
  );
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
    const invocation = run(
      {
        rest: {
          repos: {
            getEnvironment: async (request) => {
              assert.equal(request.environment_name, 'prod');
              return { data };
            },
          },
        },
      },
      { repo: { owner: 'owner', repo: 'repo' } },
    );
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
  assert.equal(
    delivery.jobs.prod.name,
    'Approve production: ${{ inputs.application }}',
  );
  assert.match(deployment.jobs.deploy.name, /Approve production:/);
});

test('approval prompt creates or updates its bot comment and skips commits without a merged PR', async () => {
  const script = delivery.jobs['approval-prompt'].steps[0].with.script;
  const run = new (Object.getPrototypeOf(async function () {}).constructor)(
    'github',
    'context',
    'core',
    'process',
    script,
  );
  const sha = 'a'.repeat(40);
  const pull = {
    number: 38,
    merged_at: 'merged',
    merge_commit_sha: sha,
    base: { repo: { full_name: 'owner/repo' } },
  };
  for (const scenario of [
    'create',
    'update',
    'no-pr',
    'unmerged',
    'other-sha',
    'other-repo',
  ]) {
    const calls = [];
    let summary;
    const associated =
      scenario === 'no-pr'
        ? []
        : [
            {
              ...pull,
              ...(scenario === 'unmerged' ? { merged_at: null } : {}),
              ...(scenario === 'other-sha'
                ? { merge_commit_sha: 'b'.repeat(40) }
                : {}),
              ...(scenario === 'other-repo'
                ? { base: { repo: { full_name: 'fork/repo' } } }
                : {}),
            },
          ];
    const listPulls = Symbol('pulls');
    const listComments = Symbol('comments');
    await run(
      {
        rest: {
          repos: { listPullRequestsAssociatedWithCommit: listPulls },
          issues: {
            listComments,
            createComment: async (request) => calls.push(['create', request]),
            updateComment: async (request) => calls.push(['update', request]),
          },
        },
        paginate: async (method, request) => {
          assert.equal(request.owner, 'owner');
          assert.equal(request.repo, 'repo');
          if (method === listPulls) {
            assert.equal(request.commit_sha, sha);
            return associated;
          }
          assert.equal(method, listComments);
          assert.equal(request.issue_number, 38);
          calls.push(['list']);
          return [
            {
              id: 1,
              user: { login: 'human' },
              body: '<!-- production-approval:match-to-csv -->',
            },
            {
              id: 2,
              user: { login: 'github-actions[bot]' },
              body: '<!-- production-approval:admin -->',
            },
            ...(scenario === 'update'
              ? [
                  {
                    id: 3,
                    user: { login: 'github-actions[bot]' },
                    body: '<!-- production-approval:match-to-csv -->old',
                  },
                ]
              : []),
          ];
        },
      },
      {
        repo: { owner: 'owner', repo: 'repo' },
        serverUrl: 'https://github.com',
        runId: 123,
      },
      {
        summary: {
          addRaw: (body) => {
            summary = body;
            return { write: async () => {} };
          },
        },
        info: () => {},
      },
      { env: { APPLICATION: 'match-to-csv', TARGET_SHA: sha } },
    );
    assert.match(summary, /@owner/);
    assert.match(summary, /`match-to-csv` at `aaaaaaa`/);
    assert.match(
      summary,
      /https:\/\/github.com\/owner\/repo\/actions\/runs\/123/,
    );
    if (scenario === 'create' || scenario === 'update') {
      assert.equal(calls.length, 2);
      assert.equal(calls[1][0], scenario);
      assert.equal(calls[1][1].body, summary);
      assert.equal(
        calls[1][1][scenario === 'create' ? 'issue_number' : 'comment_id'],
        scenario === 'create' ? 38 : 3,
      );
    } else assert.deepEqual(calls, []);
  }
});
