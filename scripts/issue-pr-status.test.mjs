import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { closingIssues, moveIssuesToReview } from './issue-pr-status.mjs';
import { REPOSITORY } from './issue-triage.mjs';

test('only closing keyword references supply status targets', () => {
  assert.deepEqual(
    closingIssues(
      `Closes #40. Follow-up to #12, blocked by #30.\nFIXES ${REPOSITORY}#41; resolves https://github.com/${REPOSITORY}/issues/42\nCloses other/repo#9\nParent issue or epic: Closes #8\n<!-- Closes #7 -->\n\`Fixes #6\`\n\`\`\`\nCloses #5\n\`\`\`\n    Closes #4`,
    ),
    [40, 41, 42],
  );
  assert.deepEqual(closingIssues(null), []);
  assert.deepEqual(
    closingIssues(
      'Closes #1, fixes #2, resolved #3; close #4; fix #5; resolve #6',
    ),
    [1, 2, 3, 4, 5, 6],
  );
});

function fixture({
  status = 'In progress',
  freshStatus = status,
  state = 'OPEN',
  freshState = state,
  draft = false,
  prState = 'OPEN',
  member = true,
  changed = false,
  unknown = false,
} = {}) {
  const writes = [];
  const calls = [];
  let reads = 0;
  let prReads = 0;
  const content = (fresh) => ({
    id: 'issue',
    number: 1,
    state: fresh ? freshState : state,
    __typename: 'Issue',
    repository: { nameWithOwner: REPOSITORY },
  });
  const api = async (query, vars) => {
    calls.push({ query, vars });
    if (query.startsWith('mutation')) {
      writes.push(vars);
      return {};
    }
    if (query.includes('pullRequest(number:')) {
      prReads++;
      return {
        repository: {
          pullRequest: {
            body: changed && prReads > 1 ? 'Closes #2' : 'Closes #1. Also #99',
            state: prState,
            isDraft: draft,
          },
        },
      };
    }
    if (query.includes('projectV2(number:'))
      return {
        user: {
          projectV2: {
            id: 'project',
            fields: {
              nodes: [
                {
                  id: 'status',
                  name: 'Status',
                  options: [
                    'In progress',
                    'In review',
                    'Inbox',
                    'Ready',
                    'Done',
                  ].map((name) => ({ id: name, name })),
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      };
    if (query.includes('issueOrPullRequest'))
      return {
        repository: {
          issueOrPullRequest: {
            projectItems: {
              nodes: vars.cursor
                ? member
                  ? [{ id: 'item', project: { id: 'project' } }]
                  : []
                : [{ id: 'unrelated', project: { id: 'other' } }],
              pageInfo: { hasNextPage: !vars.cursor, endCursor: 'next' },
            },
          },
        },
      };
    if (query.includes('fieldValues(')) {
      if (!vars.cursor) reads++;
      return {
        node: {
          id: 'item',
          type: 'ISSUE',
          project: { id: 'project' },
          content: content(reads > 1),
          fieldValues: {
            nodes: vars.cursor
              ? [
                  {
                    field: { id: 'status' },
                    optionId: unknown
                      ? 'unrecognized'
                      : reads > 1
                        ? freshStatus
                        : status,
                  },
                ]
              : [],
            pageInfo: { hasNextPage: !vars.cursor, endCursor: 'next' },
          },
        },
      };
    }
    if (query.includes('labels('))
      return {
        node: {
          ...content(reads > 1),
          labels: { nodes: [], pageInfo: { hasNextPage: false } },
        },
      };
    throw new Error(`Unexpected query ${query}`);
  };
  return { api, writes, calls, log: () => {} };
}

test('only claimed closing issues move, with paginated item and field reads', async () => {
  const f = fixture();
  await moveIssuesToReview({ ...f, number: 10, dryRun: false });
  assert.deepEqual(f.writes, [
    { project: 'project', item: 'item', field: 'status', option: 'In review' },
  ]);
  assert.equal(
    f.calls.filter((c) => c.query.includes('issueOrPullRequest')).length,
    2,
  );
  assert.equal(
    f.calls.filter((c) => c.query.includes('fieldValues(')).length,
    4,
  );
  assert.ok(
    f.calls
      .filter((c) => c.query.includes('issueOrPullRequest'))
      .every((c) => c.vars.number === 1),
  );
});

test('draft, closed, unclaimed, unknown, missing and finished work stays put', async () => {
  for (const options of [
    { draft: true },
    { prState: 'CLOSED' },
    { state: 'CLOSED' },
    { member: false },
    { unknown: true },
    ...['Inbox', 'Ready', 'In review', 'Done', undefined].map((status) => ({
      status: status ?? null,
    })),
  ]) {
    const f = fixture(options);
    await moveIssuesToReview({ ...f, number: 10, dryRun: false });
    assert.deepEqual(f.writes, [], JSON.stringify(options));
  }
});

test('concurrent status or issue changes cannot be overwritten', async () => {
  for (const options of [
    { freshStatus: 'Done' },
    { freshStatus: 'Ready' },
    { freshStatus: null },
    { freshState: 'CLOSED' },
  ]) {
    const f = fixture(options);
    await moveIssuesToReview({ ...f, number: 10, dryRun: false });
    assert.deepEqual(f.writes, []);
  }
});

test('dry runs make no writes and changed PR descriptions abort writes', async () => {
  const f = fixture();
  await moveIssuesToReview({ ...f, number: 10 });
  assert.deepEqual(f.writes, []);
  const changed = fixture({ changed: true });
  await assert.rejects(
    moveIssuesToReview({ ...changed, number: 10, dryRun: false }),
    /changed during discovery/,
  );
  assert.deepEqual(changed.writes, []);
});

test('status events are limited and isolated from metadata reconciliation', () => {
  const status = readFileSync(
    new URL('../.github/workflows/pr-issue-status.yml', import.meta.url),
    'utf8',
  );
  assert.match(status, /types: \[opened, ready_for_review\]/);
  assert.match(
    status,
    /ref: \$\{\{ github.event.repository.default_branch \}\}/,
  );
  const metadata = readFileSync(
    new URL('./issue-pr-metadata.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    metadata,
    /discover\(|updateProjectStatus\(|moveIssuesToReview\(/,
  );
});
