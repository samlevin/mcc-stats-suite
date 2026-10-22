import { CliHelp, cliError, defineCli, parseCli } from './cli.cjs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const REPOSITORY = 'samlevin/mcc-stats-suite';
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'none'].map(
  (value) => `severity: ${value}`,
);
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const SIZES = ['XS', 'S', 'M', 'L'];
const PAGE = 'pageInfo { hasNextPage endCursor }';
const EMPTY = { nodes: [], pageInfo: { hasNextPage: false } };
const VALUES = `nodes {
  ... on ProjectV2ItemFieldSingleSelectValue { optionId field {
    ... on ProjectV2SingleSelectField { id }
  } }
} ${PAGE}`;
// One project item with the first page of its field values and issue labels,
// so reading an item costs one request unless a connection overflows.
const ITEM = `id type project { id } fieldValues(first: 50) { ${VALUES} } content {
  __typename ... on Issue { id number state repository { nameWithOwner }
    labels(first: 50) { nodes { name } ${PAGE} } }
}`;

export function eligible(item) {
  const severity = item.labels.filter((label) => label.startsWith('severity:'));
  return (
    item.type === 'ISSUE' &&
    item.content?.__typename === 'Issue' &&
    item.content.repository.nameWithOwner === REPOSITORY &&
    item.content.state === 'OPEN' &&
    (item.fields.Status === undefined || item.fields.Status === 'Inbox') &&
    PRIORITIES.includes(item.fields.Priority) &&
    severity.length === 1 &&
    SEVERITIES.includes(severity[0]) &&
    SIZES.includes(item.fields.Size)
  );
}

// `first` is a first page that arrived nested in another query; fetchPage then
// runs only for the pages after it.
export async function paginate(fetchPage, first) {
  const nodes = [];
  let cursor = null;
  const seen = new Set();
  let connection = first ?? (await fetchPage(cursor));
  while (true) {
    if (!connection) throw new Error('Missing GraphQL connection');
    nodes.push(...connection.nodes.filter(Boolean));
    if (!connection.pageInfo.hasNextPage) return nodes;
    cursor = connection.pageInfo.endCursor;
    if (!cursor || seen.has(cursor))
      throw new Error('Pagination cursor did not advance');
    seen.add(cursor);
    connection = await fetchPage(cursor);
  }
}

// Every tracker script reports GitHub failures through GitHubError and
// failureMessage, so logs carry GitHub's own error type and message but never
// a token, request headers, or gh stderr.
const MAX_DETAIL = 300;
const MAX_ERRORS = 5;
const TOKEN_PATTERN = /\b(?:gh[opsru]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/g;
const TOKEN_VARIABLES = ['GH_TOKEN', 'GITHUB_TOKEN', 'MCC_PROJECT_TOKEN'];
const RATE_LIMIT_TYPES = new Set([
  'RATE_LIMITED',
  'RATE_LIMIT',
  'GRAPHQL_RATE_LIMIT',
]);
const ACCESS_TYPES = new Set([
  'FORBIDDEN',
  'INSUFFICIENT_SCOPES',
  'UNAUTHORIZED',
  'UNAUTHENTICATED',
]);
const ACCESS_HINT =
  'Check that the token is valid and has issue and Projects access.';

export function redact(text, env = process.env) {
  let result = String(text);
  for (const name of TOKEN_VARIABLES) {
    const token = env[name];
    if (token && token.length >= 8) result = result.split(token).join('***');
  }
  return result.replace(TOKEN_PATTERN, '***');
}

export class GitHubError extends Error {
  constructor(message, details = {}) {
    super(redact(message));
    this.name = 'GitHubError';
    Object.assign(this, details);
  }
}

// Splits `gh api --include` output into the status, lowercased headers, and
// body. Output without a status line is treated as a bare body.
export function parseResponse(output) {
  const raw = String(output ?? '');
  const headers = {};
  let status;
  let text = raw;
  const statusLine = /^HTTP\/\S+ (\d{3})/.exec(raw);
  if (statusLine) {
    status = Number(statusLine[1]);
    const end = /\r?\n\r?\n/.exec(raw);
    text = end ? raw.slice(end.index + end[0].length) : '';
    const head = end ? raw.slice(0, end.index) : raw;
    for (const line of head.split(/\r?\n/).slice(1)) {
      const colon = line.indexOf(':');
      if (colon > 0)
        headers[line.slice(0, colon).trim().toLowerCase()] = line
          .slice(colon + 1)
          .trim();
    }
  }
  let body;
  try {
    body = text.trim() ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status, headers, body, text };
}

function clean(value) {
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}...` : text;
}

function sentence(text) {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function errorDetail(error) {
  const kind = error?.type ?? error?.code;
  const message = typeof error?.message === 'string' ? error.message : '';
  return [kind, message]
    .filter((part) => part !== undefined && part !== '')
    .map(clean)
    .join(': ');
}

function resetHint(headers, secondary) {
  const retryAfter = headers['retry-after'];
  if (retryAfter !== undefined && /^\d+$/.test(retryAfter))
    return `retry after ${Number(retryAfter)} seconds`;
  const reset = Number(headers['x-ratelimit-reset']);
  if (
    Number.isSafeInteger(reset) &&
    reset > 0 &&
    (headers['x-ratelimit-remaining'] === '0' || !secondary)
  )
    return `the limit resets at ${new Date(reset * 1000).toISOString()}`;
  return 'GitHub did not say when it resets';
}

// Builds the error for a GitHub response that failed or carried errors.
export function githubError(api, { status, headers = {}, body, text = '' }) {
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  const types = errors.map((error) =>
    String(error?.type ?? error?.code ?? '').toUpperCase(),
  );
  const texts = [body?.message, ...errors.map((error) => error?.message)]
    .filter((text) => typeof text === 'string')
    .join(' ');
  const failedStatus = status >= 400 ? status : undefined;
  const parts = [];
  const head = [
    failedStatus && `HTTP ${failedStatus}`,
    typeof body?.message === 'string' && clean(body.message),
  ]
    .filter(Boolean)
    .join(': ');
  if (head) parts.push(head);
  for (const error of errors.slice(0, MAX_ERRORS)) {
    const detail = errorDetail(error);
    if (detail) parts.push(detail);
  }
  if (errors.length > MAX_ERRORS)
    parts.push(`${errors.length - MAX_ERRORS} more errors`);
  // A body that is not JSON is never echoed; it may not come from GitHub.
  if (body === null && text.trim()) parts.push('the response was not JSON');
  if (!parts.length) parts.push('GitHub returned no error details');
  const secondary = /secondary rate limit|abuse detection/i.test(texts);
  const rateLimited =
    status === 429 ||
    secondary ||
    types.some((type) => RATE_LIMIT_TYPES.has(type)) ||
    /\brate limit/i.test(texts) ||
    (status === 403 && headers['x-ratelimit-remaining'] === '0');
  const accessDenied =
    !rateLimited &&
    (status === 401 ||
      status === 403 ||
      types.some((type) => ACCESS_TYPES.has(type)));
  const notFound =
    status === 404 ||
    (errors.length > 0 && types.every((type) => type === 'NOT_FOUND'));
  let message = `GitHub ${api} request failed: ${sentence(parts.join('; '))}`;
  if (rateLimited)
    message += ` ${secondary ? 'Secondary rate limit' : 'Rate limit'} reached; ${resetHint(headers, secondary)}.`;
  else if (accessDenied) message += ` ${ACCESS_HINT}`;
  return new GitHubError(message, {
    httpStatus: failedStatus,
    kind: rateLimited
      ? 'rate-limit'
      : accessDenied
        ? 'access'
        : notFound
          ? 'not-found'
          : 'other',
  });
}

// Runs `gh api --include` so a failure carries its HTTP status and rate-limit
// headers. gh writes the response to stdout even when it exits non-zero; its
// stderr is never read.
export function ghRequest(api, args, { input, run = execFileSync } = {}) {
  try {
    const output = run('gh', ['api', '--include', ...args], {
      encoding: 'utf8',
      ...(input === undefined
        ? { stdio: ['ignore', 'pipe', 'pipe'] }
        : { input, stdio: ['pipe', 'pipe', 'pipe'] }),
    });
    return { ...parseResponse(output), failed: false };
  } catch (cause) {
    if (cause?.stdout) return { ...parseResponse(cause.stdout), failed: true };
    const reason =
      cause?.code === 'ENOENT'
        ? 'gh is not installed or not on PATH'
        : `gh exited${cause?.status == null ? '' : ` with status ${cause.status}`} without a GitHub response`;
    throw new GitHubError(
      `GitHub ${api} request failed: ${reason}. Check that gh is authenticated and GitHub is reachable.`,
      { kind: 'other' },
    );
  }
}

// `tolerated` lets a caller accept a response whose errors it expects.
export function ghGraphql(
  query,
  variables,
  run = execFileSync,
  tolerated = () => false,
) {
  const response = ghRequest('GraphQL', ['graphql', '--input', '-'], {
    input: JSON.stringify({ query, variables }),
    run,
  });
  const result = response.body;
  if (result?.errors?.length) {
    if (!tolerated(result)) throw githubError('GraphQL', response);
  } else if (
    response.failed ||
    !result ||
    typeof result !== 'object' ||
    !('data' in result)
  )
    throw githubError('GraphQL', response);
  return result.data;
}

// Returns the response body text; errors carry `httpStatus` when GitHub sent one.
export function ghRest(args, run = execFileSync) {
  const response = ghRequest('REST', args, { run });
  if (response.failed) throw githubError('REST', response);
  return response.text;
}

// The only text an entry point prints for a failure.
export function failureMessage(error) {
  if (error instanceof GitHubError) return error.message;
  if (error?.code || error?.status)
    return `GitHub API request failed. ${ACCESS_HINT}`;
  return redact(error?.message ?? error);
}

export async function discover(
  api,
  required = { Status: ['Inbox', 'Ready'], Priority: PRIORITIES, Size: SIZES },
) {
  let projectId;
  const fields = await paginate(async (cursor) => {
    const data = await api(
      `query($cursor: String) { user(login: "samlevin") { projectV2(number: 1) {
        id fields(first: 100, after: $cursor) { nodes {
          ... on ProjectV2SingleSelectField { id name options { id name } }
        } ${PAGE} }
      } } }`,
      { cursor },
    );
    const project = data.user?.projectV2;
    if (!project) throw new Error('MCC delivery project is unavailable');
    projectId = project.id;
    return project.fields;
  });
  const selected = {};
  for (const [name, options] of Object.entries(required)) {
    const matches = fields.filter((field) => field.name === name);
    if (matches.length !== 1)
      throw new Error(`Expected one ${name} single-select field`);
    const field = matches[0];
    for (const option of options) {
      if (field.options.filter((value) => value.name === option).length !== 1)
        throw new Error(`Missing or ambiguous ${name} option ${option}`);
    }
    selected[name] = field;
  }
  return { projectId, fields: selected };
}

// Every project item, each with the first page of its field values and labels.
export async function listItems(api, projectId) {
  return paginate(async (cursor) => {
    const data = await api(
      `query($id: ID!, $cursor: String) { node(id: $id) { ... on ProjectV2 {
        items(first: 100, after: $cursor) { nodes { ${ITEM} } ${PAGE} }
      } } }`,
      { id: projectId, cursor },
    );
    return data.node?.items;
  });
}

// The unarchived project items of one issue, in the same shape as listItems.
export async function issueItems(api, number) {
  const [owner, name] = REPOSITORY.split('/');
  return paginate(async (cursor) => {
    const data = await api(
      `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
        repository(owner: $owner, name: $name) { issue(number: $number) {
          projectItems(first: 20, after: $cursor, includeArchived: false) {
            nodes { ${ITEM} } ${PAGE}
          }
        } }
      }`,
      { owner, name, number, cursor },
    );
    return data.repository?.issue?.projectItems ?? EMPTY;
  });
}

// Turns an item node from listItems, issueItems, or readItem into an item
// with named field values and label names, reading any remaining pages.
export async function completeItem(api, node, context) {
  if (!node?.id || node.project?.id !== context.projectId) return null;
  const values = await paginate(async (cursor) => {
    const data = await api(
      `query($id: ID!, $cursor: String) { node(id: $id) { ... on ProjectV2Item {
        fieldValues(first: 100, after: $cursor) { ${VALUES} }
      } } }`,
      { id: node.id, cursor },
    );
    return data.node?.fieldValues ?? EMPTY;
  }, node.fieldValues);
  const fields = {};
  for (const [name, field] of Object.entries(context.fields)) {
    const value = values.find((value) => value.field?.id === field.id);
    fields[name] = field.options.find(
      (option) => option.id === value?.optionId,
    )?.name;
  }
  const item = { id: node.id, type: node.type, project: node.project, fields };
  if (node.type !== 'ISSUE' || node.content?.__typename !== 'Issue')
    return { ...item, content: node.content, labels: [] };
  const { labels: first, ...content } = node.content;
  const labels = await paginate(async (cursor) => {
    const data = await api(
      `query($id: ID!, $cursor: String) { node(id: $id) { ... on Issue {
        labels(first: 100, after: $cursor) { nodes { name } ${PAGE} }
      } } }`,
      { id: content.id, cursor },
    );
    return data.node?.labels ?? EMPTY;
  }, first);
  return { ...item, content, labels: labels.map((label) => label.name) };
}

export async function readItem(api, id, context) {
  const data = await api(
    `query($id: ID!) { node(id: $id) { ... on ProjectV2Item { ${ITEM} } } }`,
    { id },
  );
  return completeItem(api, data.node, context);
}

export async function updateProjectStatus(api, context, itemId, status) {
  const field = context.fields.Status;
  const options = field.options.filter((option) => option.name === status);
  if (options.length !== 1)
    throw new Error(`Missing or ambiguous Status option ${status}`);
  await api(
    `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
      updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item,
        fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } }
    }`,
    {
      project: context.projectId,
      item: itemId,
      field: field.id,
      option: options[0].id,
    },
  );
}

export async function reconcile({
  api,
  dryRun = true,
  issueNumber,
  log = console.log,
}) {
  if (
    issueNumber !== undefined &&
    (!Number.isSafeInteger(issueNumber) || issueNumber <= 0)
  )
    throw new Error('--issue requires a positive safe integer');
  const context = await discover(api);
  // One issue reads only its own project items; a sweep lists the project.
  const items =
    issueNumber === undefined
      ? await listItems(api, context.projectId)
      : await issueItems(api, issueNumber);
  let candidates = 0;
  let updated = 0;
  for (const listed of items) {
    if (
      listed.type !== 'ISSUE' ||
      listed.content?.repository?.nameWithOwner !== REPOSITORY ||
      (issueNumber !== undefined && listed.content.number !== issueNumber)
    )
      continue;
    const item = await completeItem(api, listed, context);
    if (
      !item ||
      !eligible(item) ||
      (issueNumber !== undefined && item.content.number !== issueNumber)
    )
      continue;
    // Re-read the item's project fields and issue metadata at the write boundary.
    const fresh = await readItem(api, listed.id, context);
    if (
      !fresh ||
      !eligible(fresh) ||
      (issueNumber !== undefined && fresh.content.number !== issueNumber)
    )
      continue;
    candidates++;
    log(
      `${dryRun ? 'DRY_RUN would move' : 'Moving'} issue #${fresh.content.number} ${fresh.fields.Status ?? 'empty Status'} -> Ready`,
    );
    if (dryRun) continue;
    await updateProjectStatus(api, context, fresh.id, 'Ready');
    updated++;
  }
  log(
    `Triage reconciliation: ${candidates} eligible, ${updated} updated; DRY_RUN=${dryRun}`,
  );
  return { candidates, updated };
}

export async function reconcileEpicLabels({
  api,
  dryRun = true,
  issueNumber,
  log = console.log,
}) {
  const forbidden = new Set([
    'bug',
    'enhancement',
    'documentation',
    'question',
    'good first issue',
    'help wanted',
    'duplicate',
    'invalid',
    'wontfix',
  ]);
  const LABELS = `labels(first: 50) { nodes { id name } ${PAGE} }`;
  let epics;
  if (issueNumber === undefined)
    epics = await paginate(async (cursor) => {
      const data = await api(
        `query($cursor: String) { repository(owner: "samlevin", name: "mcc-stats-suite") {
        issues(first: 100, after: $cursor, states: [OPEN, CLOSED], labels: ["epic"]) {
          nodes { id number ${LABELS} } ${PAGE}
        }
      } }`,
        { cursor },
      );
      return data.repository?.issues;
    });
  else {
    const data = await api(
      `query($number: Int!) { repository(owner: "samlevin", name: "mcc-stats-suite") {
      issue(number: $number) { id number ${LABELS} }
    } }`,
      { number: issueNumber },
    );
    epics = data.repository?.issue ? [data.repository.issue] : [];
  }
  for (const epic of epics) {
    if (issueNumber !== undefined && epic.number !== issueNumber) continue;
    const labels = await paginate(async (cursor) => {
      const data = await api(
        `query($id: ID!, $cursor: String) { node(id: $id) { ... on Issue {
        labels(first: 100, after: $cursor) { nodes { id name } ${PAGE} }
      } } }`,
        { id: epic.id, cursor },
      );
      return data.node?.labels;
    }, epic.labels);
    if (!labels.some((label) => label.name === 'epic')) continue;
    const remove = labels.filter(
      (label) => forbidden.has(label.name) || label.name.startsWith('type:'),
    );
    if (!remove.length) continue;
    log(
      `${dryRun ? 'DRY_RUN would remove' : 'Removing'} ${remove.length} conflicting category labels from epic #${epic.number}`,
    );
    if (!dryRun)
      await api(
        `mutation($id: ID!, $labels: [ID!]!) {
      removeLabelsFromLabelable(input: { labelableId: $id, labelIds: $labels }) { clientMutationId }
    }`,
        { id: epic.id, labels: remove.map((label) => label.id) },
      );
  }
}

// A sweep skips when fewer GraphQL points than this remain, leaving the rest
// of the hourly budget to people and agents that share the token's account.
export const SWEEP_FLOOR = 1000;

// The REST rate_limit endpoint reports the GraphQL budget without spending it.
export function graphqlBudget(run = execFileSync) {
  const graphql = JSON.parse(ghRest(['rate_limit'], run))?.resources?.graphql;
  for (const key of ['limit', 'remaining', 'used', 'reset'])
    if (!Number.isSafeInteger(graphql?.[key]))
      throw new Error('GitHub returned no GraphQL rate limit');
  const { limit, remaining, used, reset } = graphql;
  return { limit, remaining, used, reset };
}

// Runs one tracker task between two readings of the GraphQL budget and
// returns the exit code. A sweep skips below SWEEP_FLOOR. A single-issue run
// that hits the rate limit warns and succeeds, because the next scheduled
// sweep repeats its work; every other failure fails the run.
export async function runTracker({
  sweep,
  task,
  budget = graphqlBudget,
  log = console.log,
  warn = (message) => console.log(`::warning::${message}`),
  error = console.error,
}) {
  const read = () => {
    try {
      return budget();
    } catch (cause) {
      warn(`Could not read the GraphQL budget: ${failureMessage(cause)}`);
      return null;
    }
  };
  const before = read();
  if (before)
    log(
      `GraphQL budget before: ${before.remaining} of ${before.limit} points remain; the window resets at ${new Date(before.reset * 1000).toISOString()}.`,
    );
  if (sweep && before && before.remaining < SWEEP_FLOOR) {
    warn(
      `Skipped the sweep: ${before.remaining} GraphQL points remain, below the floor of ${SWEEP_FLOOR}. The next scheduled sweep reconciles.`,
    );
    return 0;
  }
  let status = 0;
  try {
    await task();
  } catch (cause) {
    if (!sweep && cause instanceof GitHubError && cause.kind === 'rate-limit')
      warn(
        `${failureMessage(cause)} The next scheduled sweep reconciles this issue.`,
      );
    else {
      error(failureMessage(cause));
      status = 1;
    }
  }
  const after = read();
  if (before && after)
    log(
      after.reset === before.reset
        ? `GraphQL budget after: ${after.remaining} points remain; ${after.used - before.used} were used during the run, counting every client of this account.`
        : `GraphQL budget after: ${after.remaining} points remain; the window reset during the run.`,
    );
  return status;
}

const CLI = defineCli(
  'Usage: issue-triage.mjs / issue-containers.mjs [--dry-run | --apply] [--issue <number>]',
  ['dry-run', 'apply', 'issue'],
);

export function configuration(env, args) {
  const { options, positionals } = parseCli(args, CLI);
  if (positionals.length)
    throw cliError(
      CLI,
      'Use --dry-run or --apply with optional --issue <positive number>',
    );
  if (options['dry-run'] && options.apply)
    throw cliError(CLI, 'Use --dry-run or --apply once');
  let issueNumber;
  if (options.issue !== undefined) {
    if (
      !/^[1-9]\d*$/.test(options.issue) ||
      !Number.isSafeInteger(Number(options.issue))
    )
      throw cliError(CLI, '--issue requires one positive safe integer');
    issueNumber = Number(options.issue);
  }
  if (env.GITHUB_ACTIONS === 'true' && !env.MCC_PROJECT_TOKEN)
    throw new Error(
      'MCC_PROJECT_TOKEN is required for Projects access; GITHUB_TOKEN cannot access Projects.',
    );
  const setting = env.DRY_RUN ?? 'true';
  if (!['true', 'false'].includes(setting))
    throw new Error('DRY_RUN must be true or false');
  return {
    dryRun:
      options['dry-run'] === true || (!options.apply && setting === 'true'),
    ...(issueNumber === undefined ? {} : { issueNumber }),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const config = configuration(process.env, process.argv.slice(2));
    if (process.env.GITHUB_ACTIONS === 'true')
      process.env.GH_TOKEN = process.env.MCC_PROJECT_TOKEN;
    process.exitCode = await runTracker({
      sweep: config.issueNumber === undefined,
      task: async () => {
        await reconcileEpicLabels({ api: ghGraphql, ...config });
        await reconcile({ api: ghGraphql, ...config });
      },
    });
  } catch (error) {
    if (error instanceof CliHelp) console.log(error.message);
    else {
      console.error(failureMessage(error));
      process.exitCode = 1;
    }
  }
}
