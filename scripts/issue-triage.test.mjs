import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  configuration,
  discover,
  eligible,
  failureMessage,
  ghGraphql,
  GitHubError,
  ghRest,
  paginate,
  readItem,
  reconcile,
  redact,
  REPOSITORY,
} from './issue-triage.mjs';

// `gh api --include` output: a status line, CRLF headers, a blank line, the body.
function httpResponse(status, headers, body) {
  const lines = Object.entries(headers).map(
    ([name, value]) => `${name}: ${value}\r\n`,
  );
  return `HTTP/2.0 ${status} Status\n${lines.join('')}\r\n${
    typeof body === 'string' ? body : JSON.stringify(body)
  }`;
}

// gh exits non-zero on an HTTP or GraphQL error and writes the response to stdout.
function ghFails(stdout, overrides = {}) {
  return () => {
    throw Object.assign(new Error('Command failed: gh api'), {
      status: 1,
      stderr: 'gh: stderr-marker',
      stdout,
      ...overrides,
    });
  };
}

const RESET = 1792126278;
const RESET_AT = new Date(RESET * 1000).toISOString();
const ACCESS =
  'Check that the token is valid and has issue and Projects access.';
const exhausted = {
  'X-Ratelimit-Limit': '5000',
  'X-Ratelimit-Remaining': '0',
  'X-Ratelimit-Reset': String(RESET),
};

test('GraphQL errors report each type or code with its message', () => {
  assert.throws(
    () =>
      ghGraphql(
        'query { viewer { login } }',
        {},
        ghFails(
          httpResponse(
            200,
            {},
            {
              errors: [
                { type: 'INTERNAL', message: 'Something\n  went wrong' },
                { code: 'undefinedField', message: 'Field x is unknown' },
                { message: 'Parse error on "}"' },
              ],
            },
          ),
        ),
      ),
    {
      name: 'GitHubError',
      kind: 'other',
      message:
        'GitHub GraphQL request failed: INTERNAL: Something went wrong; undefinedField: Field x is unknown; Parse error on "}".',
    },
  );
});

test('rate limits are named as rate limits with the reset time GitHub reports', () => {
  const cases = [
    [
      'GraphQL RATE_LIMITED',
      () =>
        ghGraphql(
          'query { viewer { login } }',
          {},
          ghFails(
            httpResponse(200, exhausted, {
              errors: [
                {
                  type: 'RATE_LIMITED',
                  message: 'API rate limit already exceeded for user ID 1.',
                },
              ],
            }),
          ),
        ),
      {
        httpStatus: undefined,
        message: `GitHub GraphQL request failed: RATE_LIMITED: API rate limit already exceeded for user ID 1. Rate limit reached; the limit resets at ${RESET_AT}.`,
      },
    ],
    [
      'REST 403 primary limit',
      () =>
        ghRest(
          ['repos/example/issues/1'],
          ghFails(
            httpResponse(403, exhausted, {
              message: 'API rate limit exceeded for user ID 1.',
              documentation_url: 'https://docs.github.com/rest',
            }),
          ),
        ),
      {
        httpStatus: 403,
        message: `GitHub REST request failed: HTTP 403: API rate limit exceeded for user ID 1. Rate limit reached; the limit resets at ${RESET_AT}.`,
      },
    ],
    [
      'REST 403 secondary limit with Retry-After',
      () =>
        ghRest(
          ['repos/example/issues/1'],
          ghFails(
            httpResponse(
              403,
              {
                ...exhausted,
                'X-Ratelimit-Remaining': '4000',
                'Retry-After': '60',
              },
              {
                message:
                  'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
              },
            ),
          ),
        ),
      {
        httpStatus: 403,
        message:
          'GitHub REST request failed: HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. Secondary rate limit reached; retry after 60 seconds.',
      },
    ],
    [
      'REST 429 without a reset GitHub stands behind',
      () =>
        ghRest(
          ['repos/example/issues/1'],
          ghFails(
            httpResponse(
              429,
              { ...exhausted, 'X-Ratelimit-Remaining': '10' },
              { message: 'You have exceeded a secondary rate limit.' },
            ),
          ),
        ),
      {
        httpStatus: 429,
        message:
          'GitHub REST request failed: HTTP 429: You have exceeded a secondary rate limit. Secondary rate limit reached; GitHub did not say when it resets.',
      },
    ],
    [
      'GraphQL RATE_LIMITED without headers',
      () =>
        ghGraphql(
          'query { viewer { login } }',
          {},
          ghFails(
            JSON.stringify({
              errors: [{ type: 'RATE_LIMITED', message: 'Limit exceeded' }],
            }),
          ),
        ),
      {
        message:
          'GitHub GraphQL request failed: RATE_LIMITED: Limit exceeded. Rate limit reached; GitHub did not say when it resets.',
      },
    ],
  ];
  for (const [name, call, expected] of cases)
    assert.throws(call, { kind: 'rate-limit', ...expected }, name);
});

test('authentication and permission failures point at the token and Projects access', () => {
  const cases = [
    [
      () =>
        ghGraphql(
          'query { viewer { login } }',
          {},
          ghFails(
            httpResponse(
              401,
              {},
              {
                message: 'Bad credentials',
                documentation_url: 'https://docs.github.com/rest',
                status: '401',
              },
            ),
          ),
        ),
      `GitHub GraphQL request failed: HTTP 401: Bad credentials. ${ACCESS}`,
    ],
    [
      () =>
        ghGraphql(
          'query { viewer { login } }',
          {},
          ghFails(
            httpResponse(
              200,
              {},
              {
                errors: [
                  {
                    type: 'INSUFFICIENT_SCOPES',
                    message:
                      "Your token has not been granted the required scopes to execute this query. The 'id' field requires one of the following scopes: ['read:project'].",
                  },
                ],
              },
            ),
          ),
        ),
      `GitHub GraphQL request failed: INSUFFICIENT_SCOPES: Your token has not been granted the required scopes to execute this query. The 'id' field requires one of the following scopes: ['read:project']. ${ACCESS}`,
    ],
    [
      () =>
        ghRest(
          ['repos/example/issues/1'],
          ghFails(
            httpResponse(
              403,
              {},
              { message: 'Resource not accessible by personal access token' },
            ),
          ),
        ),
      `GitHub REST request failed: HTTP 403: Resource not accessible by personal access token. ${ACCESS}`,
    ],
  ];
  for (const [call, message] of cases)
    assert.throws(call, { kind: 'access', message });
});

test('not-found and other failures keep GitHub details without stderr or raw bodies', () => {
  assert.throws(
    () =>
      ghRest(
        ['repos/example/issues/9'],
        ghFails(httpResponse(404, {}, { message: 'Not Found' })),
      ),
    {
      kind: 'not-found',
      httpStatus: 404,
      message: 'GitHub REST request failed: HTTP 404: Not Found.',
    },
  );
  // Only metadataGraphql tolerates NOT_FOUND.
  assert.throws(
    () =>
      ghGraphql(
        'query { repository { issueOrPullRequest(number: 9) { id } } }',
        {},
        ghFails(
          httpResponse(
            200,
            {},
            {
              data: { repository: { issueOrPullRequest: null } },
              errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }],
            },
          ),
        ),
      ),
    {
      kind: 'not-found',
      message: 'GitHub GraphQL request failed: NOT_FOUND: Could not resolve.',
    },
  );
  assert.throws(
    () =>
      ghRest(
        ['repos/example/issues/9'],
        ghFails(httpResponse(502, {}, '<html>proxy body</html>')),
      ),
    {
      kind: 'other',
      httpStatus: 502,
      message:
        'GitHub REST request failed: HTTP 502; the response was not JSON.',
    },
  );
  assert.throws(
    () =>
      ghGraphql('query { viewer { login } }', {}, ghFails('', { status: 4 })),
    {
      kind: 'other',
      message:
        'GitHub GraphQL request failed: gh exited with status 4 without a GitHub response. Check that gh is authenticated and GitHub is reachable.',
    },
  );
  assert.throws(
    () =>
      ghRest(
        ['repos/example/issues/9'],
        ghFails(undefined, { status: undefined, code: 'ENOENT' }),
      ),
    {
      message:
        'GitHub REST request failed: gh is not installed or not on PATH. Check that gh is authenticated and GitHub is reachable.',
    },
  );
  for (const run of [
    ghFails(httpResponse(404, {}, { message: 'Not Found' })),
    ghFails(''),
  ])
    assert.throws(
      () => ghRest(['repos/example/issues/9'], run),
      (error) =>
        !error.message.includes('stderr-marker') && error.cause === undefined,
    );
});

test('messages redact tokens from GitHub text and the environment', () => {
  const pattern = ['ghp', 'a1'.repeat(18)].join('_');
  const fineGrained = ['github', 'pat', 'b2'.repeat(20)].join('_');
  assert.equal(
    redact(`one ${pattern} two ${fineGrained} three secret-value-188`, {
      GH_TOKEN: 'secret-value-188',
    }),
    'one *** two *** three ***',
  );
  assert.throws(
    () =>
      ghRest(
        ['user'],
        ghFails(
          httpResponse(401, {}, { message: `Bad credentials for ${pattern}` }),
        ),
      ),
    (error) =>
      error.message ===
      `GitHub REST request failed: HTTP 401: Bad credentials for ***. ${ACCESS}`,
  );
});

test('successful responses parse past gh headers and keep the request shape', () => {
  const calls = [];
  const record = (output) => (command, args, options) => {
    calls.push({ command, args, options });
    return output;
  };
  assert.deepEqual(
    ghGraphql(
      'query { viewer { login } }',
      { a: 1 },
      record(
        httpResponse(200, exhausted, { data: { viewer: { login: 'x' } } }),
      ),
    ),
    { viewer: { login: 'x' } },
  );
  assert.deepEqual(
    ghGraphql('query { ok }', {}, record('{"data":{"ok":true}}')),
    { ok: true },
  );
  assert.equal(
    ghRest(
      ['repos/example/issues/1'],
      record(httpResponse(200, {}, '{"n":1}')),
    ),
    '{"n":1}',
  );
  assert.deepEqual(
    calls.map(({ command, args }) => [command, ...args]),
    [
      ['gh', 'api', '--include', 'graphql', '--input', '-'],
      ['gh', 'api', '--include', 'graphql', '--input', '-'],
      ['gh', 'api', '--include', 'repos/example/issues/1'],
    ],
  );
  assert.equal(
    calls[0].options.input,
    JSON.stringify({
      query: 'query { viewer { login } }',
      variables: { a: 1 },
    }),
  );
  assert.deepEqual(calls[2].options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.throws(
    () => ghGraphql('query { ok }', {}, record(httpResponse(200, {}, 'oops'))),
    { message: 'GitHub GraphQL request failed: the response was not JSON.' },
  );
});

test('entry-point messages never print raw subprocess errors', () => {
  const github = new GitHubError('GitHub REST request failed: HTTP 404.');
  assert.equal(failureMessage(github), 'GitHub REST request failed: HTTP 404.');
  assert.equal(
    failureMessage(
      Object.assign(new Error('Command failed: gh\nstderr-marker'), {
        status: 1,
      }),
    ),
    `GitHub API request failed. ${ACCESS}`,
  );
  assert.equal(
    failureMessage(new Error('DRY_RUN must be true or false')),
    'DRY_RUN must be true or false',
  );
});

test('every GitHub script exits non-zero with the shared rate-limit message', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mcc-fake-gh-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    join(directory, 'graphql.txt'),
    httpResponse(200, exhausted, {
      errors: [
        {
          type: 'RATE_LIMITED',
          message: 'API rate limit already exceeded for user ID 1.',
        },
      ],
    }),
  );
  writeFileSync(
    join(directory, 'rest.txt'),
    httpResponse(403, exhausted, {
      message: 'API rate limit exceeded for user ID 1.',
    }),
  );
  // Stands in for gh: answers every call with a rate limit and leaks the token on stderr.
  writeFileSync(
    join(directory, 'gh'),
    [
      '#!/bin/sh',
      'cat > /dev/null',
      'case "$*" in',
      '  *graphql*) cat "$FAKE_GH_DIR/graphql.txt" ;;',
      '  *) cat "$FAKE_GH_DIR/rest.txt" ;;',
      'esac',
      'echo "gh: stderr-marker $GH_TOKEN" >&2',
      'exit 1',
      '',
    ].join('\n'),
  );
  chmodSync(join(directory, 'gh'), 0o755);
  const token = 'fake-token-value-188';
  const scripts = [
    ['issue-triage.mjs', ['--dry-run'], 'GraphQL'],
    ['issue-containers.mjs', ['--dry-run'], 'GraphQL'],
    ['issue-pr-metadata.mjs', [], 'GraphQL'],
    ['issue-pr-status.mjs', [], 'GraphQL'],
    ['branch-name.mjs', ['188'], 'REST'],
  ];
  for (const [script, args, api] of scripts) {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL(script, import.meta.url)), ...args],
      {
        encoding: 'utf8',
        env: {
          PATH: `${directory}:${process.env.PATH}`,
          FAKE_GH_DIR: directory,
          GH_TOKEN: token,
          PR_NUMBER: '10',
          DRY_RUN: 'true',
        },
      },
    );
    assert.equal(result.status, 1, script);
    assert.equal(result.stdout, '', script);
    const detail =
      api === 'GraphQL'
        ? 'RATE_LIMITED: API rate limit already exceeded for user ID 1.'
        : 'HTTP 403: API rate limit exceeded for user ID 1.';
    assert.equal(
      result.stderr,
      `GitHub ${api} request failed: ${detail} Rate limit reached; the limit resets at ${RESET_AT}.\n`,
      script,
    );
  }
});

function issue(overrides = {}) {
  return {
    id: 'item',
    type: 'ISSUE',
    content: {
      id: 'issue',
      __typename: 'Issue',
      number: 1,
      state: 'OPEN',
      repository: { nameWithOwner: REPOSITORY },
    },
    labels: ['severity: none'],
    fields: { Status: 'Inbox', Priority: 'P2', Size: 'M' },
    ...overrides,
  };
}

test('the exact metadata predicate includes all supported priorities, severities and sizes', () => {
  for (const Priority of ['P0', 'P1', 'P2', 'P3']) {
    for (const Size of ['XS', 'S', 'M', 'L']) {
      for (const severity of ['critical', 'high', 'medium', 'low', 'none']) {
        assert.equal(
          eligible(
            issue({
              fields: { Status: 'Inbox', Priority, Size },
              labels: [`severity: ${severity}`, 'type: epic'],
            }),
          ),
          true,
        );
      }
    }
  }
  // Neither acceptance text nor type, area, and package labels are predicate requirements.
  assert.equal(eligible(issue()), true);
});

test('reject PRs, drafts, other repositories, closed issues, invalid metadata and later states', () => {
  const base = issue();
  const cases = [
    { type: 'PULL_REQUEST' },
    { type: 'DRAFT_ISSUE', content: null },
    { content: { ...base.content, __typename: 'PullRequest' } },
    {
      content: {
        ...base.content,
        repository: { nameWithOwner: 'other/repository' },
      },
    },
    { content: { ...base.content, state: 'CLOSED' } },
    ...['Ready', 'In progress', 'In review', 'Done', undefined].map(
      (Status) => ({ fields: { ...base.fields, Status } }),
    ),
    ...['P4', undefined].map((Priority) => ({
      fields: { ...base.fields, Priority },
    })),
    ...['XL', undefined].map((Size) => ({ fields: { ...base.fields, Size } })),
    ...[
      [],
      ['severity: unknown'],
      ['severity: none', 'severity: high'],
      ['severity: none', 'severity:unknown'],
    ].map((labels) => ({ labels })),
  ];
  for (const value of cases)
    assert.equal(eligible(issue(value)), false, JSON.stringify(value));
});

test('pagination keeps every page, skips deleted nodes, and rejects broken cursors', async () => {
  const cursors = [];
  assert.deepEqual(
    await paginate(async (cursor) => {
      cursors.push(cursor);
      return cursor === null
        ? {
            nodes: [1, null],
            pageInfo: { hasNextPage: true, endCursor: 'next' },
          }
        : { nodes: [2], pageInfo: { hasNextPage: false } };
    }),
    [1, 2],
  );
  assert.deepEqual(cursors, [null, 'next']);
  await assert.rejects(
    paginate(async () => ({
      nodes: [],
      pageInfo: { hasNextPage: true, endCursor: 'stuck' },
    })),
    /did not advance/,
  );
  await assert.rejects(
    paginate(async () => null),
    /Missing GraphQL connection/,
  );
});

function mockApi({
  race,
  multipleSeverity = false,
  additionalIssue = false,
} = {}) {
  const state = {
    mutations: [],
    reads: 0,
    pages: new Set(),
    status: 'Inbox',
    otherStatus: 'Inbox',
    readItems: [],
  };
  const second = issue({
    id: 'item-2',
    content: { ...issue().content, id: 'issue-2', number: 2 },
  });
  const definitions = Object.entries({
    Status: ['Inbox', 'Ready', 'In progress'],
    Priority: ['P0', 'P1', 'P2', 'P3'],
    Size: ['XS', 'S', 'M', 'L'],
  }).map(([name, options]) => ({
    id: `field-${name}`,
    name,
    options: options.map((name) => ({ id: `option-${name}`, name })),
  }));
  const connection = (nodes, next = false) => ({
    nodes,
    pageInfo: { hasNextPage: next, endCursor: next ? 'next' : null },
  });
  const api = async (query, variables) => {
    const page = variables.cursor ? 1 : 0;
    if (query.includes('projectV2(number: 1)')) {
      state.pages.add(`definitions-${page}`);
      return {
        user: {
          projectV2: {
            id: 'project',
            fields: page
              ? connection(definitions.slice(1))
              : connection(definitions.slice(0, 1), true),
          },
        },
      };
    }
    if (query.includes('items(first:')) {
      state.pages.add(`items-${page}`);
      return {
        node: {
          items: page
            ? connection(additionalIssue ? [issue(), second] : [issue()])
            : connection(
                [
                  { id: 'pr', type: 'PULL_REQUEST' },
                  { id: 'draft', type: 'DRAFT_ISSUE' },
                  {
                    ...issue(),
                    id: 'other',
                    content: { repository: { nameWithOwner: 'other/repo' } },
                  },
                ],
                true,
              ),
        },
      };
    }
    if (query.includes('fieldValues(first:')) {
      if (!page) {
        state.reads++;
        state.readItems.push(variables.id);
      }
      state.pages.add(`values-${page}`);
      const fields = {
        Status: variables.id === 'item-2' ? state.otherStatus : state.status,
        Priority: 'P2',
        Size: 'L',
      };
      if (state.reads >= 2 && race) race(fields, state);
      const values = Object.entries(fields).map(([name, value]) => ({
        field: { id: `field-${name}` },
        optionId: `option-${value}`,
      }));
      return {
        node: {
          ...(variables.id === 'item-2' ? second : issue()),
          project: { id: 'project' },
          fieldValues: page
            ? connection(values.slice(1))
            : connection(values.slice(0, 1), true),
        },
      };
    }
    if (query.includes('labels(first:')) {
      state.pages.add(`labels-${page}`);
      const content = {
        ...(variables.id === 'issue-2' ? second.content : issue().content),
      };
      if (state.renumbered) content.number = 2;
      if (state.closed) content.state = 'CLOSED';
      if (state.foreign) content.repository = { nameWithOwner: 'other/repo' };
      return {
        node: {
          ...content,
          labels: page
            ? connection(
                multipleSeverity || state.extraSeverity
                  ? [{ name: 'severity: high' }]
                  : [],
              )
            : connection([{ name: 'severity: none' }], true),
        },
      };
    }
    if (query.includes('updateProjectV2ItemFieldValue')) {
      state.mutations.push(variables);
      if (variables.item === 'item-2') state.otherStatus = 'Ready';
      else state.status = 'Ready';
      return {
        updateProjectV2ItemFieldValue: {
          projectV2Item: { id: variables.item },
        },
      };
    }
    throw new Error('Unexpected mock query');
  };
  return { api, state, definitions };
}

test('discovery and item reads paginate definitions, field values and labels', async () => {
  const { api, state } = mockApi({ multipleSeverity: true });
  const context = await discover(api);
  assert.equal(context.fields.Size.id, 'field-Size');
  const item = await readItem(api, 'item', context);
  assert.equal(item.fields.Size, 'L');
  assert.deepEqual(item.labels, ['severity: none', 'severity: high']);
  assert.equal(eligible(item), false);
  assert.deepEqual([...state.pages].sort(), [
    'definitions-0',
    'definitions-1',
    'labels-0',
    'labels-1',
    'values-0',
    'values-1',
  ]);
});

test('dry-run discovers every item page and never mutates; apply is idempotent', async () => {
  const { api, state } = mockApi();
  assert.deepEqual(await reconcile({ api, log: () => {} }), {
    candidates: 1,
    updated: 0,
  });
  assert.equal(state.mutations.length, 0);
  assert.ok(state.pages.has('items-1'));
  assert.deepEqual(await reconcile({ api, dryRun: false, log: () => {} }), {
    candidates: 1,
    updated: 1,
  });
  assert.deepEqual(state.mutations, [
    {
      project: 'project',
      item: 'item',
      field: 'field-Status',
      option: 'option-Ready',
    },
  ]);
  assert.deepEqual(await reconcile({ api, dryRun: false, log: () => {} }), {
    candidates: 0,
    updated: 0,
  });
  assert.equal(state.mutations.length, 1);
});

test('re-read rejects eligibility changes at the mutation boundary', async () => {
  for (const race of [
    (fields) => {
      fields.Status = 'In progress';
    },
    (fields) => {
      fields.Priority = 'invalid';
    },
    (fields) => {
      fields.Size = undefined;
    },
    (_fields, state) => {
      state.extraSeverity = true;
    },
    (_fields, state) => {
      state.closed = true;
    },
    (_fields, state) => {
      state.foreign = true;
    },
  ]) {
    const { api, state } = mockApi({ race });
    assert.deepEqual(await reconcile({ api, dryRun: false, log: () => {} }), {
      candidates: 0,
      updated: 0,
    });
    assert.equal(state.reads, 2);
    assert.equal(state.mutations.length, 0);
  }
});

test('issue filter limits dry-run and apply to the requested issue and leaves another eligible issue untouched', async () => {
  for (const issueNumber of [1, 2]) {
    const { api, state } = mockApi({ additionalIssue: true });
    const logs = [];
    assert.deepEqual(
      await reconcile({ api, issueNumber, log: (line) => logs.push(line) }),
      { candidates: 1, updated: 0 },
    );
    assert.equal(state.mutations.length, 0);
    assert.equal(state.status, 'Inbox');
    assert.equal(state.otherStatus, 'Inbox');
    assert.match(logs[0], new RegExp(`issue #${issueNumber} Inbox -> Ready`));
    const selectedId = issueNumber === 1 ? 'item' : 'item-2';
    assert.deepEqual(state.readItems, [selectedId, selectedId]);
    assert.deepEqual(
      await reconcile({ api, issueNumber, dryRun: false, log: () => {} }),
      { candidates: 1, updated: 1 },
    );
    assert.deepEqual(
      state.mutations.map((mutation) => mutation.item),
      [selectedId],
    );
    assert.equal(issueNumber === 1 ? state.otherStatus : state.status, 'Inbox');
    assert.deepEqual(
      await reconcile({ api, issueNumber, dryRun: false, log: () => {} }),
      { candidates: 0, updated: 0 },
    );
    assert.ok(state.readItems.every((id) => id === selectedId));
    // Project-wide reconciliation still processes the remaining eligible issue.
    assert.deepEqual(await reconcile({ api, dryRun: false, log: () => {} }), {
      candidates: 1,
      updated: 1,
    });
    assert.equal(state.status, 'Ready');
    assert.equal(state.otherStatus, 'Ready');
  }
});

test('a missing issue filter match reads no individual issue metadata and performs no writes', async () => {
  const { api, state } = mockApi({ additionalIssue: true });
  assert.deepEqual(
    await reconcile({ api, issueNumber: 3, dryRun: false, log: () => {} }),
    { candidates: 0, updated: 0 },
  );
  assert.deepEqual(state.readItems, []);
  assert.deepEqual(state.mutations, []);
});

test('issue filter is rechecked against fresh issue metadata before mutation', async () => {
  const { api, state } = mockApi({
    race: (_fields, state) => {
      state.renumbered = true;
    },
  });
  assert.deepEqual(
    await reconcile({ api, issueNumber: 1, dryRun: false, log: () => {} }),
    { candidates: 0, updated: 0 },
  );
  assert.deepEqual(state.mutations, []);
});

test('deleted project items and moved project membership cannot mutate', async () => {
  for (const node of [null, { ...issue(), project: { id: 'other-project' } }]) {
    assert.equal(
      await readItem(async () => ({ node }), 'item', { projectId: 'project' }),
      null,
    );
  }
});

test('discovery fails closed for missing or ambiguous field options', async () => {
  const { api, definitions } = mockApi();
  definitions[0].options = definitions[0].options.filter(
    (option) => option.name !== 'Ready',
  );
  await assert.rejects(discover(api), /Status option Ready/);
  definitions[1].name = 'Status';
  await assert.rejects(discover(api), /Expected one Status/);
});

test('workflow requires its own project token and local defaults remain read-only', () => {
  assert.throws(
    () =>
      configuration(
        { GITHUB_ACTIONS: 'true', GITHUB_TOKEN: 'repository-only' },
        [],
      ),
    /MCC_PROJECT_TOKEN is required/,
  );
  assert.deepEqual(configuration({}, []), { dryRun: true });
  assert.deepEqual(configuration({ DRY_RUN: 'false' }, ['--dry-run']), {
    dryRun: true,
  });
  assert.deepEqual(configuration({}, ['--apply']), { dryRun: false });
  assert.throws(
    () => configuration({ DRY_RUN: 'yes' }, []),
    /must be true or false/,
  );
  assert.throws(
    () => configuration({}, ['--apply', '--dry-run']),
    /Use --dry-run or --apply/,
  );
});

test('parser accepts an optional positive issue number in either flag order and preserves dry-run defaults', () => {
  assert.deepEqual(configuration({}, ['--issue', '42']), {
    dryRun: true,
    issueNumber: 42,
  });
  assert.deepEqual(configuration({}, ['--issue', '42', '--dry-run']), {
    dryRun: true,
    issueNumber: 42,
  });
  assert.deepEqual(
    configuration({ DRY_RUN: 'false' }, ['--dry-run', '--issue', '42']),
    { dryRun: true, issueNumber: 42 },
  );
  assert.deepEqual(configuration({}, ['--apply', '--issue', '42']), {
    dryRun: false,
    issueNumber: 42,
  });
  assert.deepEqual(configuration({}, ['--issue', '42', '--apply']), {
    dryRun: false,
    issueNumber: 42,
  });
  assert.deepEqual(
    configuration({}, ['--issue', String(Number.MAX_SAFE_INTEGER)]),
    { dryRun: true, issueNumber: Number.MAX_SAFE_INTEGER },
  );
});

test('parser rejects malformed, missing, unsafe, repeated, or conflicting arguments', () => {
  for (const args of [
    ['--issue'],
    ['--issue', '--apply'],
    ['--issue', '0'],
    ['--issue', '-1'],
    ['--issue', '1.5'],
    ['--issue', '1e2'],
    ['--issue', ' 1'],
    ['--issue', '01'],
    ['--issue', 'NaN'],
    ['--issue', 'Infinity'],
    ['--issue', '9007199254740992'],
    ['--issue', '1', '--issue', '2'],
    ['--unknown'],
    ['1'],
    ['--apply', '--apply'],
    ['--dry-run', '--dry-run'],
    ['--apply', '--dry-run', '--issue', '1'],
    ['--issue', '1', '2'],
  ])
    assert.throws(
      () => configuration({}, args),
      /Use --dry-run or --apply|--issue requires|Unknown option|given more than once/,
    );
});

test('invalid programmatic issue filters fail before any API access', async () => {
  for (const issueNumber of [
    0,
    -1,
    1.5,
    '1',
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    await assert.rejects(
      reconcile({
        api: () => {
          assert.fail('API access with invalid issue filter');
        },
        issueNumber,
      }),
      /positive safe integer/,
    );
  }
});

test('catalog has unique names, supported severities, and all directly affected workspace labels', () => {
  const catalog = JSON.parse(
    readFileSync(new URL('../.github/labels.json', import.meta.url), 'utf8'),
  );
  assert.equal(catalog.repository, REPOSITORY);
  assert.equal(
    new Set(catalog.labels.map((label) => label.name)).size,
    catalog.labels.length,
  );
  assert.deepEqual(
    catalog.labels
      .filter((label) => label.name.startsWith('severity:'))
      .map((label) => label.name)
      .sort(),
    ['critical', 'high', 'low', 'medium', 'none'].map(
      (name) => `severity: ${name}`,
    ),
  );
  assert.deepEqual(
    catalog.labels
      .filter((label) => label.name.startsWith('package:'))
      .map((label) => label.name)
      .sort(),
    [
      'admin',
      'cdk-config',
      'contracts',
      'data-pipeline',
      'match-to-csv',
      'ocr-quality',
      'player',
      'recipients',
      'roster',
    ].map((name) => `package: ${name}`),
  );
  for (const label of catalog.labels) {
    assert.match(label.color, /^[a-f0-9]{6}$/);
    assert.ok(label.description.length > 0);
  }
});
