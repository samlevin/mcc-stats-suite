import assert from 'node:assert/strict';
import test from 'node:test';
import { addToProject } from './issue-project-membership.mjs';
import { evaluate, workflow } from './workflow-test-helpers.mjs';

// A mocked GitHub that keeps one project item per content node, as
// addProjectV2ItemById does.
function github({
  issues = { 7: 'I_7' },
  project = { id: 'P_1', closed: false },
  items = new Map(),
} = {}) {
  const reads = [];
  const writes = [];
  const api = async (query, variables) => {
    if (query.startsWith('mutation')) {
      assert.match(query, /addProjectV2ItemById/);
      writes.push(variables);
      assert.equal(variables.project, project.id);
      if (!items.has(variables.content))
        items.set(variables.content, `item-${items.size + 1}`);
      return {
        addProjectV2ItemById: { item: { id: items.get(variables.content) } },
      };
    }
    reads.push({ query, variables });
    assert.deepEqual(variables, {
      owner: 'samlevin',
      name: 'mcc-stats-suite',
      number: variables.number,
    });
    assert.match(query, /user\(login: "samlevin"\) \{ projectV2\(number: 1\)/);
    assert.match(query, /issue\(number: \$number\)/);
    assert.doesNotMatch(query, /pullRequest/);
    const id = issues[variables.number];
    return {
      repository: { issue: id ? { id } : null },
      user: { projectV2: project },
    };
  };
  return { api, reads, writes, items, log: () => {} };
}

test('adds a new issue to the project', async () => {
  const f = github();
  assert.equal(
    await addToProject({ ...f, kind: 'issue', number: 7, dryRun: false }),
    'item-1',
  );
  assert.deepEqual(f.writes, [{ project: 'P_1', content: 'I_7' }]);
});

test('pull request input fails before any API call, including dry runs', async () => {
  for (const dryRun of [true, false]) {
    const f = github();
    await assert.rejects(
      addToProject({ ...f, kind: 'pull_request', number: 9, dryRun }),
      /CONTENT_TYPE must be issue/,
    );
    assert.deepEqual(f.reads, []);
    assert.deepEqual(f.writes, []);
  }
});

test('an item already in the project is returned without a duplicate', async () => {
  const f = github({ items: new Map([['I_7', 'existing']]) });
  for (let run = 0; run < 2; run++)
    assert.equal(
      await addToProject({ ...f, kind: 'issue', number: 7, dryRun: false }),
      'existing',
    );
  assert.equal(f.items.size, 1);
});

test('dry runs read but never write', async () => {
  const f = github();
  assert.equal(await addToProject({ ...f, kind: 'issue', number: 7 }), null);
  assert.equal(f.reads.length, 1);
  assert.deepEqual(f.writes, []);
});

test('invalid input, missing content, and an unavailable project fail before writing', async () => {
  const cases = [
    [{ kind: 'discussion', number: 7 }, /CONTENT_TYPE/],
    [{ kind: 'constructor', number: 7 }, /CONTENT_TYPE/],
    [{ kind: undefined, number: 7 }, /CONTENT_TYPE/],
    [{ kind: 'issue', number: 0 }, /positive/],
    [{ kind: 'issue', number: Number.NaN }, /positive/],
    [{ kind: 'issue', number: 8 }, /Issue #8 not found/],
  ];
  for (const [options, error] of cases) {
    const f = github();
    await assert.rejects(
      addToProject({ ...f, ...options, dryRun: false }),
      error,
    );
    assert.deepEqual(f.writes, []);
  }
  for (const project of [null, { id: 'P_1', closed: true }]) {
    const f = github({ project });
    await assert.rejects(
      addToProject({ ...f, kind: 'issue', number: 7, dryRun: false }),
      /project is unavailable/,
    );
    assert.deepEqual(f.writes, []);
  }
});

test('a mutation without an item fails', async () => {
  const f = github();
  const api = async (query, variables) =>
    query.startsWith('mutation')
      ? { addProjectV2ItemById: null }
      : f.api(query, variables);
  await assert.rejects(
    addToProject({ ...f, api, kind: 'issue', number: 7, dryRun: false }),
    /no project item/,
  );
});

test('the workflow adds only opened issues with default-branch code', () => {
  const definition = workflow('tracker-project-membership');
  assert.deepEqual(definition.on, {
    issues: { types: ['opened'] },
  });
  assert.equal(definition.name, 'Tracker: add issues to the project');
  assert.equal(
    definition['run-name'],
    'Add issue #${{ github.event.issue.number }} to MCC delivery',
  );
  assert.deepEqual(definition.permissions, { contents: 'read' });
  const jobs = Object.values(definition.jobs);
  assert.equal(jobs.length, 1);
  const [job] = jobs;
  assert.equal(job.if, "github.repository == 'samlevin/mcc-stats-suite'");
  const checkout = job.steps.find((step) =>
    step.uses?.startsWith('actions/checkout@'),
  );
  assert.deepEqual(checkout.with, {
    ref: '${{ github.event.repository.default_branch }}',
    'persist-credentials': false,
    'sparse-checkout': 'scripts',
  });
  const run = job.steps.find((step) => step.run);
  assert.equal(run.run, 'node scripts/issue-project-membership.mjs');
  assert.equal(run.env.DRY_RUN, 'false');
  assert.equal(run.env.MCC_PROJECT_TOKEN, '${{ secrets.MCC_PROJECT_TOKEN }}');
  assert.equal(run.env.CONTENT_TYPE, 'issue');
  assert.equal(
    evaluate(run.env.CONTENT_NUMBER.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), {
      github: { event: { issue: { number: 7 } } },
    }),
    7,
  );
});
