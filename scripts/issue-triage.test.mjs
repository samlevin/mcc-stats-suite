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
  graphqlBudget,
  paginate,
  readItem,
  reconcile,
  reconcileEpicLabels,
  redact,
  REPOSITORY,
  runTracker,
  SWEEP_FLOOR,
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

const budget = (remaining, overrides = {}) => ({
  limit: 5000,
  remaining,
  used: 5000 - remaining,
  reset: RESET,
  ...overrides,
});

// Installs a stand-in for gh that answers every GraphQL and REST call with a
// rate limit and leaks the token on stderr. The free REST rate_limit endpoint
// answers with a healthy GraphQL budget.
function fakeGh(t) {
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
  writeFileSync(
    join(directory, 'budget.txt'),
    httpResponse(200, {}, { resources: { graphql: budget(4000) } }),
  );
  writeFileSync(
    join(directory, 'gh'),
    [
      '#!/bin/sh',
      'cat > /dev/null',
      'case "$*" in',
      '  *graphql*) cat "$FAKE_GH_DIR/graphql.txt" ;;',
      '  *rate_limit*) cat "$FAKE_GH_DIR/budget.txt"; exit 0 ;;',
      '  *) cat "$FAKE_GH_DIR/rest.txt" ;;',
      'esac',
      'echo "gh: stderr-marker $GH_TOKEN" >&2',
      'exit 1',
      '',
    ].join('\n'),
  );
  chmodSync(join(directory, 'gh'), 0o755);
  return (script, args, env = {}) =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL(script, import.meta.url)), ...args],
      {
        encoding: 'utf8',
        env: {
          PATH: `${directory}:${process.env.PATH}`,
          FAKE_GH_DIR: directory,
          GH_TOKEN: 'fake-token-value-188',
          PR_NUMBER: '10',
          DRY_RUN: 'true',
          ...env,
        },
      },
    );
}

const budgetLines = (stdout) =>
  stdout
    .split('\n')
    .filter(Boolean)
    .every((line) => line.startsWith('GraphQL budget '));

test('sweeps and PR scripts exit non-zero with the shared rate-limit message', (t) => {
  const run = fakeGh(t);
  const scripts = [
    ['issue-triage.mjs', ['--dry-run'], {}, 'GraphQL'],
    ['issue-containers.mjs', ['--dry-run'], {}, 'GraphQL'],
    ['issue-project-membership.mjs', [], { SWEEP: 'true' }, 'GraphQL'],
    ['issue-pr-metadata.mjs', [], {}, 'GraphQL'],
    ['issue-pr-status.mjs', [], {}, 'GraphQL'],
    ['branch-name.mjs', ['188'], {}, 'REST'],
  ];
  for (const [script, args, env, api] of scripts) {
    const result = run(script, args, env);
    assert.equal(result.status, 1, script);
    assert.ok(budgetLines(result.stdout), `${script}: ${result.stdout}`);
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

test('single-issue tracker runs warn and succeed when rate-limited', (t) => {
  const run = fakeGh(t);
  for (const [script, args, env] of [
    ['issue-triage.mjs', ['--dry-run', '--issue', '5'], {}],
    ['issue-containers.mjs', ['--dry-run', '--issue', '5'], {}],
    [
      'issue-project-membership.mjs',
      [],
      { CONTENT_TYPE: 'issue', CONTENT_NUMBER: '5' },
    ],
  ]) {
    const result = run(script, args, env);
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
    assert.equal(result.stderr, '', script);
    assert.ok(
      result.stdout.includes(
        `::warning::GitHub GraphQL request failed: RATE_LIMITED: API rate limit already exceeded for user ID 1. Rate limit reached; the limit resets at ${RESET_AT}. The next scheduled sweep reconciles this issue.\n`,
      ),
      script,
    );
    assert.match(result.stdout, /^GraphQL budget before: 4000 of 5000/);
    assert.ok(!result.stdout.includes('fake-token-value-188'), script);
  }
});

function tracker(readings, task, sweep) {
  const out = { logs: [], warnings: [], errors: [], ran: false };
  const queue = [...readings];
  const promise = runTracker({
    sweep,
    task: async () => {
      out.ran = true;
      await task();
    },
    budget: () => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    log: (line) => out.logs.push(line),
    warn: (line) => out.warnings.push(line),
    error: (line) => out.errors.push(line),
  });
  return promise.then((status) => ({ ...out, status }));
}

const rateLimited = () =>
  new GitHubError('GitHub GraphQL request failed: RATE_LIMITED.', {
    kind: 'rate-limit',
  });

test('a run logs the GraphQL points used between its two budget readings', async () => {
  const result = await tracker(
    [budget(4800), budget(4786)],
    async () => {},
    true,
  );
  assert.equal(result.status, 0);
  assert.deepEqual(result.logs, [
    `GraphQL budget before: 4800 of 5000 points remain; the window resets at ${RESET_AT}.`,
    'GraphQL budget after: 4786 points remain; 14 were used during the run, counting every client of this account.',
  ]);
  const reset = await tracker(
    [budget(1200), budget(4990, { reset: RESET + 3600 })],
    async () => {},
    true,
  );
  assert.equal(
    reset.logs[1],
    'GraphQL budget after: 4990 points remain; the window reset during the run.',
  );
});

test('a sweep below the floor skips with a warning; a single-issue run still runs', async () => {
  const skipped = await tracker(
    [budget(SWEEP_FLOOR - 1)],
    async () => {},
    true,
  );
  assert.equal(skipped.status, 0);
  assert.equal(skipped.ran, false);
  assert.deepEqual(skipped.warnings, [
    `Skipped the sweep: ${SWEEP_FLOOR - 1} GraphQL points remain, below the floor of ${SWEEP_FLOOR}. The next scheduled sweep reconciles.`,
  ]);
  const atFloor = await tracker(
    [budget(SWEEP_FLOOR), budget(SWEEP_FLOOR)],
    async () => {},
    true,
  );
  assert.equal(atFloor.ran, true);
  const event = await tracker([budget(10), budget(5)], async () => {}, false);
  assert.equal(event.ran, true);
  assert.deepEqual(event.warnings, []);
});

test('only a single-issue run tolerates a rate limit; other failures fail the run', async () => {
  const event = await tracker(
    [budget(10), budget(0)],
    async () => {
      throw rateLimited();
    },
    false,
  );
  assert.equal(event.status, 0);
  assert.deepEqual(event.errors, []);
  assert.deepEqual(event.warnings, [
    'GitHub GraphQL request failed: RATE_LIMITED. The next scheduled sweep reconciles this issue.',
  ]);
  const sweep = await tracker(
    [budget(4000), budget(0)],
    async () => {
      throw rateLimited();
    },
    true,
  );
  assert.equal(sweep.status, 1);
  assert.deepEqual(sweep.errors, [
    'GitHub GraphQL request failed: RATE_LIMITED.',
  ]);
  for (const failure of [
    new GitHubError('GitHub GraphQL request failed: HTTP 502.', {
      kind: 'other',
    }),
    new Error('Issue hierarchy cycle'),
    Object.assign(new Error('rate limit text'), { kind: 'rate-limit' }),
  ]) {
    const result = await tracker(
      [budget(4000), budget(4000)],
      async () => {
        throw failure;
      },
      false,
    );
    assert.equal(result.status, 1, failure.message);
    assert.equal(result.errors.length, 1, failure.message);
  }
});

test('an unreadable budget warns and the run continues without a floor', async () => {
  const result = await tracker(
    [new Error('no budget'), new Error('no budget')],
    async () => {},
    true,
  );
  assert.equal(result.status, 0);
  assert.equal(result.ran, true);
  assert.deepEqual(result.logs, []);
  assert.deepEqual(result.warnings, [
    'Could not read the GraphQL budget: no budget',
    'Could not read the GraphQL budget: no budget',
  ]);
});

test('the budget comes from the REST rate_limit endpoint', () => {
  const calls = [];
  const respond = (body) => (command, args) => {
    calls.push([command, ...args]);
    return httpResponse(200, {}, body);
  };
  assert.deepEqual(
    graphqlBudget(
      respond({
        resources: {
          core: budget(1),
          graphql: { ...budget(4321), extra: true },
        },
      }),
    ),
    budget(4321),
  );
  assert.deepEqual(calls, [['gh', 'api', '--include', 'rate_limit']]);
  for (const body of [
    {},
    { resources: { graphql: { ...budget(1), remaining: '1' } } },
  ])
    assert.throws(() => graphqlBudget(respond(body)), /no GraphQL rate limit/);
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

test('an empty Status qualifies like Inbox', () => {
  const base = issue();
  assert.equal(
    eligible(issue({ fields: { ...base.fields, Status: 'Inbox' } })),
    true,
  );
  assert.equal(
    eligible(issue({ fields: { ...base.fields, Status: undefined } })),
    true,
  );
  assert.equal(
    eligible(issue({ fields: { ...base.fields, Status: 'Ready' } })),
    false,
  );
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
    ...['Ready', 'In progress', 'In review', 'Done'].map((Status) => ({
      fields: { ...base.fields, Status },
    })),
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

// A mocked MCC delivery project. Listing and single-issue reads return each
// item with the first page of its field values and labels nested; issue #1's
// item overflows both, so its remaining pages come from follow-up reads.
function mockApi({
  race,
  multipleSeverity = false,
  additionalIssue = false,
} = {}) {
  const state = {
    mutations: [],
    queries: [],
    readItems: [],
    status: 'Inbox',
    otherStatus: 'Inbox',
    lastFields: {},
  };
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
  const values = (fields) =>
    Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => ({
        field: { id: `field-${name}` },
        optionId: `option-${value}`,
      }));
  const extraLabels = () =>
    multipleSeverity || state.extraSeverity ? [{ name: 'severity: high' }] : [];
  const node = (id, fields) => {
    const second = id === 'item-2';
    fields ??= {
      Status: second ? state.otherStatus : state.status,
      Priority: 'P2',
      Size: 'L',
    };
    state.lastFields[id] = fields;
    const content = {
      __typename: 'Issue',
      id: second ? 'issue-2' : 'issue',
      number: second || state.renumbered ? 2 : 1,
      state: state.closed ? 'CLOSED' : 'OPEN',
      repository: {
        nameWithOwner: state.foreign ? 'other/repo' : REPOSITORY,
      },
      labels: second
        ? connection([{ name: 'severity: none' }])
        : connection([{ name: 'severity: none' }], true),
    };
    return {
      id,
      type: 'ISSUE',
      project: { id: 'project' },
      fieldValues: second
        ? connection(values(fields))
        : connection(values(fields).slice(0, 1), true),
      content,
    };
  };
  const listed = () => (additionalIssue ? ['item', 'item-2'] : ['item']);
  const api = async (query, variables) => {
    const page = variables.cursor ? 1 : 0;
    if (query.startsWith('mutation')) {
      assert.match(query, /updateProjectV2ItemFieldValue/);
      state.mutations.push(variables);
      if (variables.item === 'item-2') state.otherStatus = 'Ready';
      else state.status = 'Ready';
      return {
        updateProjectV2ItemFieldValue: {
          projectV2Item: { id: variables.item },
        },
      };
    }
    if (query.includes('projectV2(number: 1)')) {
      state.queries.push(`definitions-${page}`);
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
    if (query.includes('items(first: 100')) {
      state.queries.push(`items-${page}`);
      return {
        node: {
          items: page
            ? connection(listed().map((id) => node(id)))
            : connection(
                [
                  { id: 'pr', type: 'PULL_REQUEST', content: {} },
                  { id: 'draft', type: 'DRAFT_ISSUE', content: null },
                  {
                    ...node('other'),
                    content: {
                      __typename: 'Issue',
                      repository: { nameWithOwner: 'other/repo' },
                    },
                  },
                ],
                true,
              ),
        },
      };
    }
    if (query.includes('projectItems(first: 20')) {
      state.queries.push(`issue-items-${variables.number}`);
      assert.match(query, /includeArchived: false/);
      const id = { 1: 'item', 2: 'item-2' }[variables.number];
      if (!id || !listed().includes(id)) return { repository: { issue: null } };
      // The same issue in another project is never read or written.
      const own = node(id);
      const elsewhere = { ...own, id: 'elsewhere', project: { id: 'x' } };
      return {
        repository: {
          issue: { projectItems: connection([elsewhere, own]) },
        },
      };
    }
    if (query.includes('fieldValues(first: 100, after: $cursor)')) {
      state.queries.push(`values-${variables.id}`);
      return {
        node: {
          fieldValues: connection(
            values(state.lastFields[variables.id]).slice(1),
          ),
        },
      };
    }
    if (query.includes('labels(first: 100, after: $cursor)')) {
      state.queries.push(`labels-${variables.id}`);
      return { node: { labels: connection(extraLabels()) } };
    }
    if (query.includes('... on ProjectV2Item {')) {
      state.queries.push(`read-${variables.id}`);
      state.readItems.push(variables.id);
      const fields = {
        Status: variables.id === 'item-2' ? state.otherStatus : state.status,
        Priority: 'P2',
        Size: 'L',
      };
      if (race) race(fields, state);
      return { node: node(variables.id, fields) };
    }
    throw new Error(`Unexpected mock query ${query}`);
  };
  return { api, state, definitions };
}

test('discovery and item reads take nested pages first, then read only overflowing connections', async () => {
  const { api, state } = mockApi({ multipleSeverity: true });
  const context = await discover(api);
  assert.equal(context.fields.Size.id, 'field-Size');
  const item = await readItem(api, 'item', context);
  assert.equal(item.fields.Size, 'L');
  assert.equal(item.fields.Status, 'Inbox');
  assert.deepEqual(item.labels, ['severity: none', 'severity: high']);
  assert.equal(item.content.labels, undefined);
  assert.equal(eligible(item), false);
  assert.deepEqual(state.queries, [
    'definitions-0',
    'definitions-1',
    'read-item',
    'values-item',
    'labels-issue',
  ]);
});

test('a sweep reads the project in pages with nested metadata and re-reads only candidates', async () => {
  const { api, state } = mockApi({ additionalIssue: true });
  assert.deepEqual(await reconcile({ api, log: () => {} }), {
    candidates: 2,
    updated: 0,
  });
  // Issue #2 fits in its nested pages; issue #1 overflows both connections.
  assert.deepEqual(state.queries, [
    'definitions-0',
    'definitions-1',
    'items-0',
    'items-1',
    'values-item',
    'labels-issue',
    'read-item',
    'values-item',
    'labels-issue',
    'read-item-2',
  ]);
});

test('a sweep at the current project size costs a few calls, not two per item', async () => {
  const calls = [];
  const items = Array.from({ length: 251 }, (_, index) => ({
    id: `item-${index}`,
    type: 'ISSUE',
    project: { id: 'project' },
    fieldValues: {
      nodes: [{ field: { id: 'field-Status' }, optionId: 'option-Done' }],
      pageInfo: { hasNextPage: false },
    },
    content: {
      __typename: 'Issue',
      id: `issue-${index}`,
      number: index + 1,
      state: 'OPEN',
      repository: { nameWithOwner: REPOSITORY },
      labels: { nodes: [], pageInfo: { hasNextPage: false } },
    },
  }));
  const api = async (query, variables) => {
    calls.push(query);
    if (query.includes('projectV2(number: 1)'))
      return {
        user: {
          projectV2: {
            id: 'project',
            fields: {
              nodes: Object.entries({
                Status: ['Inbox', 'Ready', 'Done'],
                Priority: ['P0', 'P1', 'P2', 'P3'],
                Size: ['XS', 'S', 'M', 'L'],
              }).map(([name, options]) => ({
                id: `field-${name}`,
                name,
                options: options.map((name) => ({
                  id: `option-${name}`,
                  name,
                })),
              })),
              pageInfo: { hasNextPage: false },
            },
          },
        },
      };
    assert.match(query, /items\(first: 100/);
    const start = Number(variables.cursor ?? 0);
    const end = start + 100;
    return {
      node: {
        items: {
          nodes: items.slice(start, end),
          pageInfo: {
            hasNextPage: end < items.length,
            endCursor: String(end),
          },
        },
      },
    };
  };
  assert.deepEqual(await reconcile({ api, log: () => {} }), {
    candidates: 0,
    updated: 0,
  });
  assert.equal(calls.length, 4);
});

test('dry-run discovers every item page and never mutates; apply is idempotent', async () => {
  const { api, state } = mockApi();
  assert.deepEqual(await reconcile({ api, log: () => {} }), {
    candidates: 1,
    updated: 0,
  });
  assert.equal(state.mutations.length, 0);
  assert.ok(state.queries.includes('items-1'));
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
    assert.deepEqual(state.readItems, ['item']);
    assert.equal(state.mutations.length, 0);
  }
});

test('an issue with no Status value moves to Ready', async () => {
  const { api, state } = mockApi();
  state.status = undefined;
  const logs = [];
  assert.deepEqual(
    await reconcile({
      api,
      issueNumber: 1,
      dryRun: false,
      log: (line) => logs.push(line),
    }),
    { candidates: 1, updated: 1 },
  );
  assert.match(logs[0], /issue #1 empty Status -> Ready/);
  assert.equal(state.status, 'Ready');
  assert.equal(state.mutations.length, 1);
});

test('issue filter reads only that issue and leaves another eligible issue untouched', async () => {
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
    assert.deepEqual(state.readItems, [selectedId]);
    // The project is never listed for one issue.
    assert.ok(!state.queries.some((query) => query.startsWith('items-')));
    assert.ok(state.queries.includes(`issue-items-${issueNumber}`));
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

test('an issue outside the project reads no item metadata and performs no writes', async () => {
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

test('pagination continues from a nested first page', async () => {
  const cursors = [];
  assert.deepEqual(
    await paginate(
      async (cursor) => {
        cursors.push(cursor);
        return { nodes: [3], pageInfo: { hasNextPage: false } };
      },
      { nodes: [1, 2], pageInfo: { hasNextPage: true, endCursor: 'two' } },
    ),
    [1, 2, 3],
  );
  assert.deepEqual(cursors, ['two']);
  assert.deepEqual(
    await paginate(
      () => assert.fail('a complete nested page needs no request'),
      { nodes: [1], pageInfo: { hasNextPage: false } },
    ),
    [1],
  );
});

// Epics with their nested first label page. Epic #7 carries standard and type
// labels; #9 overflows its first page, and its conflicting label comes later.
function epicApi() {
  const calls = [];
  const writes = [];
  const connection = (nodes, next = false) => ({
    nodes,
    pageInfo: { hasNextPage: next, endCursor: next ? 'next' : null },
  });
  const labels = {
    E7: connection([
      { id: 'L_epic', name: 'epic' },
      { id: 'L_bug', name: 'bug' },
      { id: 'L_type', name: 'type: feature' },
      { id: 'L_severity', name: 'severity: none' },
    ]),
    E8: connection([
      { id: 'L_epic', name: 'epic' },
      { id: 'L_area', name: 'area: repository' },
    ]),
    E9: connection([{ id: 'L_epic', name: 'epic' }], true),
  };
  const epics = [
    { id: 'E7', number: 7 },
    { id: 'E8', number: 8 },
    { id: 'E9', number: 9 },
  ];
  const api = async (query, variables) => {
    calls.push(query);
    if (query.startsWith('mutation')) {
      assert.match(query, /removeLabelsFromLabelable/);
      writes.push(variables);
      return {};
    }
    if (query.includes('labels: ["epic"]'))
      return {
        repository: {
          issues: connection(
            epics.map((epic) => ({ ...epic, labels: labels[epic.id] })),
          ),
        },
      };
    if (query.includes('issue(number: $number)')) {
      const epic = epics.find((epic) => epic.number === variables.number);
      return {
        repository: {
          issue: epic
            ? { ...epic, labels: labels[epic.id] }
            : {
                id: 'I_1',
                number: 1,
                labels: connection([{ id: 'L_bug', name: 'bug' }]),
              },
        },
      };
    }
    assert.match(query, /labels\(first: 100, after: \$cursor\)/);
    assert.equal(variables.id, 'E9');
    return {
      node: {
        labels: connection([{ id: 'L_docs', name: 'documentation' }]),
      },
    };
  };
  return { api, calls, writes };
}

test('epic label reconciliation removes standard and type labels from epics only', async () => {
  const github = epicApi();
  const logs = [];
  await reconcileEpicLabels({
    api: github.api,
    dryRun: false,
    log: (line) => logs.push(line),
  });
  assert.deepEqual(github.writes, [
    { id: 'E7', labels: ['L_bug', 'L_type'] },
    { id: 'E9', labels: ['L_docs'] },
  ]);
  assert.deepEqual(logs, [
    'Removing 2 conflicting category labels from epic #7',
    'Removing 1 conflicting category labels from epic #9',
  ]);
  // One listing plus one follow-up page for the epic that overflowed.
  assert.equal(github.calls.length - github.writes.length, 2);
  const dry = epicApi();
  await reconcileEpicLabels({ api: dry.api, log: () => {} });
  assert.deepEqual(dry.writes, []);
});

test('epic label reconciliation for one issue reads only that issue', async () => {
  const github = epicApi();
  await reconcileEpicLabels({
    api: github.api,
    dryRun: false,
    issueNumber: 7,
    log: () => {},
  });
  assert.deepEqual(github.writes, [{ id: 'E7', labels: ['L_bug', 'L_type'] }]);
  assert.equal(github.calls.length, 2);
  assert.ok(!github.calls.some((query) => query.includes('labels: ["epic"]')));
  // A non-epic issue keeps its labels.
  const plain = epicApi();
  await reconcileEpicLabels({
    api: plain.api,
    dryRun: false,
    issueNumber: 1,
    log: () => {},
  });
  assert.deepEqual(plain.writes, []);
  assert.equal(plain.calls.length, 1);
});
