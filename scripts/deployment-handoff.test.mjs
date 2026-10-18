import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runScript, workflow, evaluate } from './workflow-test-helpers.mjs';

const dev = workflow('delivery-deploy');
const prod = workflow('delivery-promote');
const qualify = prod.jobs['qualify-applications'];
const sha = 'a'.repeat(40);
const repo = { owner: 'owner', repo: 'repo' };
const runUrl = 'https://github.com/owner/repo/actions/runs/20';
const source = { ciRunId: 10, ciRunAttempt: 2, sha };
const run = (path, event, extra) => ({
  path: `.github/workflows/${path}.yml`,
  event,
  head_branch: 'main',
  repository: { full_name: 'owner/repo' },
  head_repository: { full_name: 'owner/repo' },
  status: 'completed',
  conclusion: 'success',
  ...extra,
});
const devRun = run('delivery-deploy', 'workflow_run', {
  id: 20,
  workflow_id: 200,
  run_attempt: 3,
  head_sha: 'b'.repeat(40),
});
const ciRun = run('ci-checks', 'push', {
  id: 10,
  run_attempt: 2,
  head_sha: sha,
});
const context = {
  repo,
  serverUrl: 'https://github.com',
  payload: { workflow_run: devRun },
};

const validateSource = async ({
  metadata = source,
  dev = devRun,
  ci = ciRun,
} = {}) => {
  const outputs = {};
  await runScript(
    qualify.steps.find((step) => step.id === 'source').with.script,
    {
      require: () => ({ readFileSync: () => JSON.stringify(metadata) }),
      context,
      github: {
        rest: {
          actions: {
            getWorkflowRun: async (request) => {
              assert.deepEqual(
                { owner: request.owner, repo: request.repo },
                repo,
              );
              assert.ok([20, 10].includes(request.run_id));
              return { data: request.run_id === 20 ? dev : ci };
            },
          },
        },
      },
      core: {
        setOutput: (name, value) => {
          outputs[name] = value;
        },
      },
    },
  );
  return outputs;
};

test('handoff downloads artifacts only from the triggering dev attempt and validated CI run', () => {
  assert.deepEqual(prod.on.workflow_run, {
    workflows: [dev.name],
    types: ['completed'],
    branches: ['main'],
  });
  const downloads = qualify.steps.filter((step) =>
    step.uses?.startsWith('actions/download-artifact'),
  );
  assert.equal(
    downloads[0].with.name,
    'dev-source-${{ github.event.workflow_run.id }}-${{ github.event.workflow_run.run_attempt }}',
  );
  assert.equal(
    downloads[0].with['run-id'],
    '${{ github.event.workflow_run.id }}',
  );
  assert.equal(
    downloads[1].with.name,
    'deploy-applications-${{ steps.source.outputs.ci-run-id }}',
  );
  assert.equal(
    downloads[1].with['run-id'],
    '${{ steps.source.outputs.ci-run-id }}',
  );
  assert.equal(
    dev.jobs['select-applications'].steps.at(-1).with.name,
    'dev-source-${{ github.run_id }}-${{ github.run_attempt }}',
  );
  assert.deepEqual(prod.permissions, {
    actions: 'read',
    contents: 'read',
    deployments: 'read',
  });
  assert.deepEqual(dev.permissions, { actions: 'read', contents: 'read' });
  assert.equal(prod.on.workflow_dispatch, undefined);
});

test('prod trigger allows partial matrix failure and rejects untrusted or cancelled runs', () => {
  for (const event of ['workflow_run', 'push', 'pull_request'])
    for (const conclusion of [
      'success',
      'failure',
      'cancelled',
      'skipped',
      null,
    ])
      for (const head_branch of ['main', 'other'])
        for (const repository of ['owner/repo', 'fork/repo']) {
          assert.equal(
            evaluate(qualify.if, {
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
            }),
            event === 'workflow_run' &&
              ['success', 'failure'].includes(conclusion) &&
              head_branch === 'main' &&
              repository === 'owner/repo',
          );
        }
});

test('source validation recovers the immutable CI SHA when workflow main has advanced', async () => {
  assert.deepEqual(await validateSource(), { 'ci-run-id': 10, sha });
  assert.deepEqual(
    await validateSource({ dev: { ...devRun, conclusion: 'failure' } }),
    { 'ci-run-id': 10, sha },
  );
});

for (const [field, value] of [
  ['path', '.github/workflows/other.yml'],
  ['event', 'pull_request'],
  ['head_branch', 'other'],
  ['repository', { full_name: 'fork/repo' }],
  ['head_repository', { full_name: 'fork/repo' }],
  ['status', 'in_progress'],
  ['conclusion', 'cancelled'],
  ['conclusion', 'skipped'],
  ['workflow_id', 999],
  ['run_attempt', 4],
]) {
  test(`dev source rejects invalid ${field} ${JSON.stringify(value)}`, async () => {
    await assert.rejects(
      validateSource({ dev: { ...devRun, [field]: value } }),
      /Untrusted dev/,
    );
  });
}
for (const [field, value] of [
  ['path', '.github/workflows/other.yml'],
  ['event', 'pull_request'],
  ['head_branch', 'other'],
  ['repository', { full_name: 'fork/repo' }],
  ['head_repository', { full_name: 'fork/repo' }],
  ['status', 'in_progress'],
  ['conclusion', 'failure'],
  ['conclusion', 'cancelled'],
  ['conclusion', 'skipped'],
  ['run_attempt', 3],
  ['head_sha', 'c'.repeat(40)],
]) {
  test(`CI source rejects invalid ${field} ${JSON.stringify(value)}`, async () => {
    await assert.rejects(
      validateSource({ ci: { ...ciRun, [field]: value } }),
      /Untrusted CI/,
    );
  });
}
for (const [field, value] of [
  ['ciRunId', '10'],
  ['ciRunId', 0],
  ['ciRunAttempt', -1],
  ['ciRunAttempt', null],
  ['sha', 'main'],
  ['sha', 'a'.repeat(7)],
]) {
  test(`source metadata rejects invalid ${field} ${value}`, async () => {
    await assert.rejects(
      validateSource({ metadata: { ...source, [field]: value } }),
      /Invalid dev source/,
    );
  });
}

const job = (name, conclusion = 'success') => ({
  name,
  status: 'completed',
  conclusion,
});
const devJob = (app, conclusion) =>
  job(`Deploy ${app} to dev / Deploy ${app} to dev`, conclusion);
const deployment = (app) => ({
  id: app === 'admin' ? 1 : 2,
  sha,
  task: `deploy:${app}`,
  environment: 'dev',
  payload: {
    application: app,
    operation: 'continuous-delivery',
    source: 'main',
    workflowRun: runUrl,
  },
});
const qualifyApps = async ({
  applications = ['admin', 'match-to-csv'],
  jobs = [
    job('Select applications from CI'),
    devJob('admin'),
    devJob('match-to-csv'),
  ],
  deployments = [deployment('admin'), deployment('match-to-csv')],
  statuses = [{ id: 1, state: 'success', log_url: runUrl }],
} = {}) => {
  const outputs = {};
  const requests = [];
  await runScript(
    qualify.steps.find((step) => step.id === 'qualification').with.script,
    {
      require: () => ({ readFileSync: () => JSON.stringify(applications) }),
      context,
      process: { env: { TARGET_SHA: sha } },
      github: {
        rest: {
          actions: { listJobsForWorkflowRunAttempt: 'jobs' },
          repos: {
            listDeployments: 'deployments',
            listDeploymentStatuses: 'statuses',
          },
        },
        paginate: async (method, request) => {
          requests.push([method, request]);
          if (method === 'jobs') {
            assert.equal(request.run_id, 20);
            assert.equal(request.attempt_number, 3);
            return jobs;
          }
          if (method === 'deployments') {
            assert.equal(request.sha, sha);
            assert.equal(request.environment, 'dev');
            return deployments.filter((item) => item.task === request.task);
          }
          assert.equal(method, 'statuses');
          return statuses;
        },
      },
      core: {
        setOutput: (name, value) => {
          outputs[name] = JSON.parse(value);
        },
        summary: { addRaw: () => ({ write: async () => {} }) },
      },
    },
  );
  return { ...outputs, requests };
};

test('each application qualifies only its own completed successful dev job', async () => {
  assert.deepEqual((await qualifyApps()).applications, [
    'admin',
    'match-to-csv',
  ]);
  for (const conclusion of ['failure', 'cancelled', 'skipped', null]) {
    const { applications } = await qualifyApps({
      jobs: [
        job('Select applications from CI'),
        devJob('admin', conclusion),
        devJob('match-to-csv'),
      ],
    });
    assert.deepEqual(applications, ['match-to-csv']);
  }
  for (const extra of [
    [],
    [devJob('admin'), devJob('admin')],
    [{ ...devJob('admin'), status: 'in_progress' }],
  ]) {
    assert.deepEqual(
      (
        await qualifyApps({
          applications: ['admin'],
          jobs: [job('Select applications from CI'), ...extra],
        })
      ).applications,
      [],
    );
  }
  for (const conclusion of ['failure', 'cancelled', 'skipped']) {
    await assert.rejects(
      qualifyApps({ jobs: [job('Select applications from CI', conclusion)] }),
      /Dev selection did not succeed/,
    );
  }
  assert.deepEqual((await qualifyApps({ applications: [] })).applications, []);
  assert.deepEqual(
    (await qualifyApps({ applications: ['admin'] })).applications,
    ['admin'],
  );
  for (const applications of [
    {},
    ['unknown'],
    ['contracts'],
    ['admin', 'admin'],
  ]) {
    await assert.rejects(
      qualifyApps({ applications }),
      /Invalid affected application/,
    );
  }
});

test('qualification requires the exact application, SHA, run, environment, and successful deployment status', async () => {
  const original = deployment('admin');
  for (const changed of [
    { sha: 'c'.repeat(40) },
    { environment: 'prod' },
    { task: 'deploy:match-to-csv' },
    ...Object.entries({
      application: 'match-to-csv',
      operation: 'rollback',
      source: 'other',
      workflowRun: `${runUrl}1`,
    }).map(([key, value]) => ({
      payload: { ...original.payload, [key]: value },
    })),
  ]) {
    assert.deepEqual(
      (
        await qualifyApps({
          applications: ['admin'],
          deployments: [{ ...original, ...changed }],
        })
      ).applications,
      [],
    );
  }
  assert.deepEqual((await qualifyApps({ deployments: [] })).applications, []);
  for (const statuses of [
    [],
    [{ id: 1, state: 'failure', log_url: runUrl }],
    [{ id: 1, state: 'success', log_url: 'other' }],
    [
      { id: 1, state: 'success', log_url: runUrl },
      { id: 2, state: 'failure', log_url: runUrl },
    ],
  ]) {
    assert.deepEqual((await qualifyApps({ statuses })).applications, []);
  }
});

test('dev source artifact records the triggering CI run, attempt, and full SHA', () => {
  const step = dev.jobs['select-applications'].steps.find(
    (step) => step.id === 'selection',
  );
  assert.deepEqual(step.env, {
    SOURCE_RUN_ID: '${{ github.event.workflow_run.id }}',
    SOURCE_RUN_ATTEMPT: '${{ github.event.workflow_run.run_attempt }}',
    TARGET_SHA: '${{ github.event.workflow_run.head_sha }}',
  });
  const execute = new Function(
    'require',
    'process',
    step.run.match(/node -e '([\s\S]*)'/)[1],
  );
  let metadata;
  const fs = {
    readFileSync: () => '["match-to-csv"]',
    appendFileSync: () => {},
    writeFileSync: (path, value) => {
      assert.equal(path, 'selection/source.json');
      metadata = JSON.parse(value);
    },
  };
  execute(() => fs, {
    env: { SOURCE_RUN_ID: '10', SOURCE_RUN_ATTEMPT: '2', TARGET_SHA: sha },
  });
  assert.deepEqual(metadata, source);
  assert.throws(
    () => execute(() => fs, { env: { TARGET_SHA: 'main' } }),
    /Invalid CI commit SHA/,
  );
});

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
