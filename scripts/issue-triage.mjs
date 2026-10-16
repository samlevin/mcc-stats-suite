import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const REPOSITORY = 'samlevin/mcc-stats-suite';
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'none'].map(
  (value) => `severity: ${value}`,
);
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const SIZES = ['XS', 'S', 'M', 'L'];
const PAGE = 'pageInfo { hasNextPage endCursor }';
const CONTENT = `id type project { id } content {
  __typename ... on Issue { id number state repository { nameWithOwner } }
}`;

export function eligible(item) {
  const severity = item.labels.filter((label) => label.startsWith('severity:'));
  return (
    item.type === 'ISSUE' &&
    item.content?.__typename === 'Issue' &&
    item.content.repository.nameWithOwner === REPOSITORY &&
    item.content.state === 'OPEN' &&
    item.fields.Status === 'Inbox' &&
    PRIORITIES.includes(item.fields.Priority) &&
    severity.length === 1 &&
    SEVERITIES.includes(severity[0]) &&
    SIZES.includes(item.fields.Size)
  );
}

export async function paginate(fetchPage) {
  const nodes = [];
  let cursor = null;
  const seen = new Set();
  while (true) {
    const connection = await fetchPage(cursor);
    if (!connection) throw new Error('Missing GraphQL connection');
    nodes.push(...connection.nodes.filter(Boolean));
    if (!connection.pageInfo.hasNextPage) return nodes;
    cursor = connection.pageInfo.endCursor;
    if (!cursor || seen.has(cursor))
      throw new Error('Pagination cursor did not advance');
    seen.add(cursor);
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

export async function listItems(api, projectId) {
  return paginate(async (cursor) => {
    const data = await api(
      `query($id: ID!, $cursor: String) { node(id: $id) { ... on ProjectV2 {
        items(first: 100, after: $cursor) { nodes { ${CONTENT} } ${PAGE} }
      } } }`,
      { id: projectId, cursor },
    );
    return data.node?.items;
  });
}

export async function readItem(api, id, context) {
  let item;
  const values = await paginate(async (cursor) => {
    const data = await api(
      `query($id: ID!, $cursor: String) { node(id: $id) { ... on ProjectV2Item {
        ${CONTENT} fieldValues(first: 100, after: $cursor) { nodes {
          ... on ProjectV2ItemFieldSingleSelectValue { optionId field {
            ... on ProjectV2SingleSelectField { id }
          } }
        } ${PAGE} }
      } } }`,
      { id, cursor },
    );
    item = data.node;
    return item?.fieldValues ?? { nodes: [], pageInfo: { hasNextPage: false } };
  });
  if (!item?.id || item.project?.id !== context.projectId) return null;
  item.fields = {};
  for (const [name, field] of Object.entries(context.fields)) {
    const value = values.find((value) => value.field?.id === field.id);
    item.fields[name] = field.options.find(
      (option) => option.id === value?.optionId,
    )?.name;
  }
  item.labels = [];
  if (item.type !== 'ISSUE' || item.content?.__typename !== 'Issue')
    return item;
  let issue;
  item.labels = await paginate(async (cursor) => {
    const data = await api(
      `query($id: ID!, $cursor: String) { node(id: $id) { ... on Issue {
        id number state __typename repository { nameWithOwner }
        labels(first: 100, after: $cursor) { nodes { name } ${PAGE} }
      } } }`,
      { id: item.content.id, cursor },
    );
    issue = data.node;
    return issue?.labels ?? { nodes: [], pageInfo: { hasNextPage: false } };
  });
  item.labels = item.labels.map((label) => label.name);
  item.content = issue;
  return item;
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
  const items = await listItems(api, context.projectId);
  let candidates = 0;
  let updated = 0;
  for (const listed of items) {
    if (
      listed.type !== 'ISSUE' ||
      listed.content?.repository.nameWithOwner !== REPOSITORY ||
      (issueNumber !== undefined && listed.content.number !== issueNumber)
    )
      continue;
    const item = await readItem(api, listed.id, context);
    if (
      !item ||
      !eligible(item) ||
      (issueNumber !== undefined && item.content.number !== issueNumber)
    )
      continue;
    // Resolve current options and re-read both issue and project metadata at the write boundary.
    const freshContext = await discover(api);
    const fresh = await readItem(api, listed.id, freshContext);
    if (
      !fresh ||
      !eligible(fresh) ||
      (issueNumber !== undefined && fresh.content.number !== issueNumber)
    )
      continue;
    candidates++;
    log(
      `${dryRun ? 'DRY_RUN would move' : 'Moving'} issue #${fresh.content.number} Inbox -> Ready`,
    );
    if (dryRun) continue;
    await updateProjectStatus(api, freshContext, fresh.id, 'Ready');
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
  const epics = await paginate(async (cursor) => {
    const data = await api(
      `query($cursor: String) { repository(owner: "samlevin", name: "mcc-stats-suite") {
      issues(first: 100, after: $cursor, states: [OPEN, CLOSED], labels: ["epic"]) {
        nodes { id number } ${PAGE}
      }
    } }`,
      { cursor },
    );
    return data.repository?.issues;
  });
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
    });
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

export function configuration(env, args) {
  if (env.GITHUB_ACTIONS === 'true' && !env.MCC_PROJECT_TOKEN)
    throw new Error(
      'MCC_PROJECT_TOKEN is required for Projects access; GITHUB_TOKEN cannot access Projects.',
    );
  let mode;
  let issueNumber;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--dry-run' || arg === '--apply') {
      if (mode) throw new Error('Use --dry-run or --apply once');
      mode = arg;
    } else if (arg === '--issue') {
      const number = args[++index];
      if (
        issueNumber !== undefined ||
        !/^[1-9]\d*$/.test(number ?? '') ||
        !Number.isSafeInteger(Number(number))
      )
        throw new Error('--issue requires one positive safe integer');
      issueNumber = Number(number);
    } else {
      throw new Error(
        'Use --dry-run or --apply with optional --issue <positive number>',
      );
    }
  }
  const setting = env.DRY_RUN ?? 'true';
  if (!['true', 'false'].includes(setting))
    throw new Error('DRY_RUN must be true or false');
  return {
    dryRun: mode === '--dry-run' || (mode !== '--apply' && setting === 'true'),
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
    await reconcileEpicLabels({ api: ghGraphql, ...config });
    await reconcile({ api: ghGraphql, ...config });
  } catch (error) {
    console.error(failureMessage(error));
    process.exitCode = 1;
  }
}
