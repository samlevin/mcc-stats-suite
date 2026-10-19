import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { reconcileContainers } from './issue-containers.mjs';
import { REPOSITORY } from './issue-triage.mjs';
import { evaluate, workflow } from './workflow-test-helpers.mjs';

const MARKER = 'automation: container-closed';

// A mocked repository and MCC delivery project. Each issue is
// { number, state, parent, repo, marked, status }; sub-issue summaries come
// from the parent links, and mutations change the model.
function github(definitions, { pageSize = 100, markerExists = true } = {}) {
  const issues = new Map(
    definitions.map((issue) => [
      `I_${issue.number}`,
      {
        state: 'OPEN',
        repo: REPOSITORY,
        marked: false,
        status: 'Ready',
        ...issue,
      },
    ]),
  );
  const calls = [];
  const writes = [];
  const id = (number) => `I_${number}`;
  const connection = (nodes, next = false, end = null) => ({
    nodes,
    pageInfo: { hasNextPage: next, endCursor: end },
  });
  const children = (issue) =>
    [...issues.values()].filter((child) => child.parent === issue.number);
  const record = (issue) => ({
    id: id(issue.number),
    number: issue.number,
    state: issue.state,
    repository: { nameWithOwner: issue.repo },
    parent: issue.parent
      ? {
          id: id(issue.parent),
          repository: { nameWithOwner: issues.get(id(issue.parent)).repo },
        }
      : null,
    subIssuesSummary: {
      total: children(issue).length,
      completed: children(issue).filter((child) => child.state === 'CLOSED')
        .length,
    },
  });
  const items = (issue) =>
    connection([
      { id: `other-${issue.number}`, project: { id: 'other' } },
      {
        id: `item-${issue.number}`,
        project: { id: 'project' },
        fieldValueByName: { name: issue.status },
      },
    ]);
  const statusOptions = ['Inbox', 'Ready', 'In progress', 'In review', 'Done'];
  const api = async (query, variables) => {
    if (query.startsWith('mutation')) {
      writes.push({ query, variables });
      const issue = issues.get(variables.id);
      if (query.includes('addLabelsToLabelable')) issue.marked = true;
      else if (query.includes('removeLabelsFromLabelable'))
        issue.marked = false;
      else if (query.includes('closeIssue')) issue.state = 'CLOSED';
      else if (query.includes('reopenIssue')) issue.state = 'OPEN';
      else {
        assert.match(query, /updateProjectV2ItemFieldValue/);
        assert.equal(variables.project, 'project');
        assert.equal(variables.field, 'status');
        const number = Number(variables.item.replace('item-', ''));
        issues.get(id(number)).status = variables.option;
      }
      return {};
    }
    calls.push({ query, variables });
    if (query.includes('projectV2(number: 1)'))
      return {
        user: {
          projectV2: {
            id: 'project',
            fields: connection([
              {
                id: 'status',
                name: 'Status',
                options: statusOptions.map((name) => ({ id: name, name })),
              },
              ...['Priority', 'Size'].map((name) => ({
                id: name,
                name,
                options: ['P0', 'P1', 'P2', 'P3', 'XS', 'S', 'M', 'L'].map(
                  (option) => ({ id: option, name: option }),
                ),
              })),
            ]),
          },
        },
      };
    if (query.includes(`label(name: "${MARKER}")`)) {
      if (!markerExists) return { repository: { label: null } };
      if (!query.includes('issues('))
        return { repository: { label: { id: 'L_marker' } } };
      return {
        repository: {
          label: {
            id: 'L_marker',
            issues: connection(
              [...issues.values()]
                .filter((issue) => issue.marked)
                .map((issue) => ({
                  id: id(issue.number),
                  projectItems: items(issue),
                })),
            ),
          },
        },
      };
    }
    if (query.includes('issues(first: 100')) {
      const listed = [...issues.values()].filter(
        (issue) => issue.repo === REPOSITORY,
      );
      const start = Number(variables.cursor ?? 0);
      const end = start + pageSize;
      return {
        repository: {
          issues: connection(
            listed.slice(start, end).map(record),
            end < listed.length,
            String(end),
          ),
        },
      };
    }
    if (query.includes('issue(number: $number)')) {
      const issue = issues.get(id(variables.number));
      return { repository: { issue: issue ? record(issue) : null } };
    }
    if (query.includes('subIssues(first: 100')) {
      const parent = issues.get(variables.id);
      return {
        node: { subIssues: connection(children(parent).map(record)) },
      };
    }
    const issue = issues.get(variables.id);
    if (query.includes('projectItems(first: 100)'))
      return {
        node: issue && {
          ...record(issue),
          labels: connection(
            issue.marked ? [{ name: 'epic' }, { name: MARKER }] : [],
          ),
          projectItems: items(issue),
        },
      };
    assert.match(query, /node\(id: \$id\) \{ \.\.\. on Issue/);
    return { node: issue ? record(issue) : null };
  };
  const kinds = () =>
    calls.map(({ query }) =>
      query.includes('projectV2(number: 1)')
        ? 'discover'
        : query.includes('label(name:')
          ? 'marker'
          : query.includes('issues(first: 100')
            ? 'list'
            : query.includes('issue(number: $number)')
              ? 'issue'
              : query.includes('subIssues(')
                ? 'children'
                : query.includes('projectItems(first: 100)')
                  ? 'snapshot'
                  : 'ancestor',
    );
  const mutations = () =>
    writes.map(({ query, variables }) => {
      const name = /\{\s*(\w+)\(input/.exec(query)[1];
      return name === 'updateProjectV2ItemFieldValue'
        ? `${name} ${variables.item} ${variables.option}`
        : `${name} ${variables.id}`;
    });
  return { api, issues, calls, kinds, mutations };
}

const quiet = { log: () => {} };

test('a sweep closes finished containers bottom-up in one run and marks them', async () => {
  const mock = github([
    { number: 1 },
    { number: 2, parent: 1 },
    { number: 3, parent: 2, state: 'CLOSED' },
    { number: 4, parent: 2, state: 'CLOSED' },
    { number: 5, parent: 1, state: 'CLOSED' },
  ]);
  const logs = [];
  assert.deepEqual(
    await reconcileContainers({
      api: mock.api,
      dryRun: false,
      log: (line) => logs.push(line),
    }),
    { updated: 2 },
  );
  assert.deepEqual(mock.mutations(), [
    'addLabelsToLabelable I_2',
    'closeIssue I_2',
    'updateProjectV2ItemFieldValue item-2 Done',
    'addLabelsToLabelable I_1',
    'closeIssue I_1',
    'updateProjectV2ItemFieldValue item-1 Done',
  ]);
  assert.deepEqual(logs, [
    'Will close container #2',
    'Will close container #1',
    'Container reconciliation: 2 state changes; DRY_RUN=false',
  ]);
  for (const number of [1, 2]) {
    assert.equal(mock.issues.get(`I_${number}`).state, 'CLOSED');
    assert.equal(mock.issues.get(`I_${number}`).marked, true);
  }
  // The parent decides from a fresh read once its child closed this run.
  assert.deepEqual(mock.kinds(), [
    'list',
    'marker',
    'snapshot',
    'discover',
    'snapshot',
    'snapshot',
  ]);
});

test('a sweep with nothing to change makes no per-container reads', async () => {
  const definitions = [];
  for (let number = 1; number <= 317; number++)
    definitions.push(
      number % 10 === 1
        ? { number }
        : { number, parent: number - (number % 10) + 1 },
    );
  // Containers #1, #11, ... stay open with open children; one finished
  // container is already closed and marked with status Done.
  definitions[0] = { number: 1, state: 'CLOSED', marked: true, status: 'Done' };
  for (let number = 2; number <= 10; number++)
    definitions[number - 1] = { number, parent: 1, state: 'CLOSED' };
  const mock = github(definitions);
  assert.deepEqual(
    await reconcileContainers({ api: mock.api, dryRun: false, ...quiet }),
    { updated: 0 },
  );
  assert.deepEqual(mock.mutations(), []);
  // Discovery finds the project item whose status the closed container keeps.
  assert.deepEqual(mock.kinds(), [
    'list',
    'list',
    'list',
    'list',
    'marker',
    'discover',
  ]);
});

test('reopening a marked container sets Ready and removes the marker', async () => {
  const mock = github([
    { number: 1, state: 'CLOSED', marked: true, status: 'Done' },
    { number: 2, parent: 1, state: 'CLOSED' },
    { number: 3, parent: 1 },
  ]);
  assert.deepEqual(
    await reconcileContainers({ api: mock.api, dryRun: false, ...quiet }),
    { updated: 1 },
  );
  assert.deepEqual(mock.mutations(), [
    'reopenIssue I_1',
    'updateProjectV2ItemFieldValue item-1 Ready',
    'removeLabelsFromLabelable I_1',
  ]);
  assert.equal(mock.issues.get('I_1').state, 'OPEN');
  assert.equal(mock.issues.get('I_1').marked, false);
});

test('manually closed containers and empty issues are left alone', async () => {
  const mock = github([
    { number: 1, state: 'CLOSED' },
    { number: 2, parent: 1 },
    { number: 3 },
  ]);
  assert.deepEqual(
    await reconcileContainers({ api: mock.api, dryRun: false, ...quiet }),
    { updated: 0 },
  );
  assert.deepEqual(mock.mutations(), []);
  assert.equal(mock.issues.get('I_3').state, 'OPEN');
});

test('dry runs log every change and never write', async () => {
  const mock = github([
    { number: 1 },
    { number: 2, parent: 1, state: 'CLOSED' },
    { number: 3, state: 'CLOSED', marked: true, status: 'In review' },
    { number: 4, parent: 3 },
  ]);
  const logs = [];
  assert.deepEqual(
    await reconcileContainers({
      api: mock.api,
      log: (line) => logs.push(line),
    }),
    { updated: 0 },
  );
  assert.deepEqual(mock.mutations(), []);
  assert.deepEqual(logs, [
    'DRY_RUN would close container #1',
    'DRY_RUN would reopen container #3',
    'Container reconciliation: 0 state changes; DRY_RUN=true',
  ]);
});

test('a marked container whose status update was lost is repaired once', async () => {
  const mock = github([
    { number: 1, state: 'CLOSED', marked: true, status: 'In review' },
    { number: 2, parent: 1, state: 'CLOSED' },
    // Open and marked: a person reopened it after the automation closed it.
    { number: 3, marked: true, status: 'In progress' },
    { number: 4, parent: 3 },
  ]);
  assert.deepEqual(
    await reconcileContainers({ api: mock.api, dryRun: false, ...quiet }),
    { updated: 0 },
  );
  assert.deepEqual(mock.mutations(), [
    'updateProjectV2ItemFieldValue item-1 Done',
    'updateProjectV2ItemFieldValue item-3 Ready',
    'removeLabelsFromLabelable I_3',
  ]);
  const again = mock.calls.length;
  await reconcileContainers({ api: mock.api, dryRun: false, ...quiet });
  assert.equal(mock.mutations().length, 3);
  assert.deepEqual(mock.kinds().slice(again), ['list', 'marker', 'discover']);
});

test('a closed child reconciles only its ancestors, never unrelated containers', async () => {
  const mock = github([
    { number: 1 },
    { number: 2, parent: 1 },
    { number: 3, parent: 2, state: 'CLOSED' },
    { number: 4, parent: 2, state: 'CLOSED' },
    // Finished, but outside #4's hierarchy.
    { number: 10 },
    { number: 11, parent: 10, state: 'CLOSED' },
  ]);
  assert.deepEqual(
    await reconcileContainers({
      api: mock.api,
      dryRun: false,
      issueNumber: 4,
      ...quiet,
    }),
    { updated: 2 },
  );
  assert.equal(mock.issues.get('I_2').state, 'CLOSED');
  assert.equal(mock.issues.get('I_1').state, 'CLOSED');
  assert.equal(mock.issues.get('I_10').state, 'OPEN');
  assert.deepEqual(mock.kinds(), [
    'issue',
    'ancestor',
    'ancestor',
    'marker',
    'snapshot',
    'snapshot',
    'discover',
    'snapshot',
    'snapshot',
  ]);
});

test('a container reconciles its subtree and ancestors', async () => {
  const mock = github([
    { number: 1 },
    { number: 2, parent: 1 },
    { number: 3, parent: 2 },
    { number: 4, parent: 3, state: 'CLOSED' },
    { number: 5, parent: 1 },
    { number: 6, parent: 1, repo: 'other/repo' },
    { number: 10 },
    { number: 11, parent: 10, state: 'CLOSED' },
  ]);
  const logs = [];
  await reconcileContainers({
    api: mock.api,
    issueNumber: 2,
    log: (line) => logs.push(line),
  });
  assert.deepEqual(logs, [
    'DRY_RUN would close container #3',
    'Container reconciliation: 0 state changes; DRY_RUN=true',
  ]);
  // #2 and #3 are read for their children, #1 as #2's parent; the leaf #4 and
  // the unrelated #10 are never expanded.
  assert.deepEqual(
    mock.calls
      .filter(({ query }) => query.includes('subIssues('))
      .map(({ variables }) => variables.id)
      .sort(),
    ['I_2', 'I_3'],
  );
  assert.deepEqual(mock.kinds(), [
    'issue',
    'children',
    'children',
    'ancestor',
    'marker',
    'snapshot',
    'snapshot',
    'snapshot',
  ]);
});

test('a hierarchy cycle and a missing marker label fail', async () => {
  const cycle = github([
    { number: 1, parent: 2 },
    { number: 2, parent: 1 },
  ]);
  await assert.rejects(
    reconcileContainers({ api: cycle.api, ...quiet }),
    /Issue hierarchy cycle/,
  );
  await assert.rejects(
    reconcileContainers({ api: cycle.api, issueNumber: 1, ...quiet }),
    /Issue hierarchy cycle/,
  );
  for (const issueNumber of [undefined, 1]) {
    const missing = github([{ number: 1 }], { markerExists: false });
    await assert.rejects(
      reconcileContainers({ api: missing.api, issueNumber, ...quiet }),
      new RegExp(`Missing managed label ${MARKER}`),
    );
  }
  await assert.rejects(
    reconcileContainers({ api: github([]).api, issueNumber: 9, ...quiet }),
    /Requested issue is unavailable/,
  );
});

test('invalid programmatic issue filters fail before any API access', async () => {
  for (const issueNumber of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(
      reconcileContainers({
        api: () => assert.fail('API access with invalid issue filter'),
        issueNumber,
      }),
      /positive safe integer/,
    );
});

// Evaluate a workflow expression such as `${{ a && format('x{0}', b) }}`.
const expression = (value, context) =>
  evaluate(value.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), {
    format: (text, ...args) =>
      text.replace(/\{(\d+)\}/g, (_, index) => args[index]),
    ...context,
  });

test('issue events reconcile one issue; the hourly schedule and manual runs sweep', (t) => {
  const definition = workflow('tracker-issue-states');
  assert.deepEqual(definition.on.issues.types, [
    'opened',
    'reopened',
    'closed',
    'labeled',
    'unlabeled',
  ]);
  for (const name of ['tracker-issue-states', 'tracker-project-membership']) {
    const [minute, hour, ...rest] =
      workflow(name).on.schedule[0].cron.split(' ');
    assert.match(minute, /^\d+$/, name);
    assert.deepEqual([hour, ...rest], ['*', '*', '*', '*'], name);
    assert.equal(workflow(name).on.schedule.length, 1, name);
  }
  const issue = { event_name: 'issues', event: { issue: { number: 7 } } };
  assert.equal(
    expression(definition.concurrency.group, { github: issue }),
    'issue-states-issue-7',
  );
  for (const event_name of ['schedule', 'workflow_dispatch'])
    assert.equal(
      expression(definition.concurrency.group, {
        github: { event_name, event: {} },
      }),
      'issue-states-sweep',
    );
  assert.equal(definition.concurrency['cancel-in-progress'], false);
  const step = definition.jobs['reconcile-issues'].steps.find(
    (step) => step.run,
  );
  assert.equal(expression(step.env.ISSUE_NUMBER, { github: issue }), 7);
  // Run the step with a stand-in for node that records its arguments.
  const directory = mkdtempSync(join(tmpdir(), 'mcc-fake-node-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    join(directory, 'node'),
    '#!/bin/sh\necho "$*" >> "$NODE_LOG"\n',
  );
  chmodSync(join(directory, 'node'), 0o755);
  const run = (issueNumber) => {
    const log = join(directory, `log-${issueNumber || 'sweep'}`);
    const result = spawnSync('bash', ['-e', '-c', step.run], {
      encoding: 'utf8',
      env: {
        PATH: `${directory}:${process.env.PATH}`,
        NODE_LOG: log,
        ISSUE_NUMBER: issueNumber,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return spawnSync('cat', [log], { encoding: 'utf8' }).stdout;
  };
  assert.equal(
    run('7'),
    'scripts/issue-triage.mjs --issue 7\nscripts/issue-containers.mjs --issue 7\n',
  );
  assert.equal(
    run(''),
    'scripts/issue-triage.mjs\nscripts/issue-containers.mjs\n',
  );
});
