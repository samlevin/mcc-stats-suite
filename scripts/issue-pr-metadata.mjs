import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { discover, paginate, REPOSITORY } from './issue-triage.mjs';

const PAGE = 'pageInfo { hasNextPage endCursor }';

export function metadataGraphql(query, variables, run = execFileSync) {
  let output;
  try {
    output = run('gh', ['api', 'graphql', '--input', '-'], {
      input: JSON.stringify({ query, variables }),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (!error.stdout) throw error;
    output = error.stdout;
  }
  const result = JSON.parse(output);
  if (result.errors?.length) {
    const missingReference =
      query.includes('issueOrPullRequest(number:') &&
      result.errors.every(
        (error) =>
          error.type === 'NOT_FOUND' &&
          error.path?.join('.') === 'repository.issueOrPullRequest',
      ) &&
      result.data?.repository?.issueOrPullRequest === null;
    if (!missingReference)
      throw new Error('GitHub GraphQL request returned errors');
  }
  return result.data;
}

export function linkedIssues(body, repository = REPOSITORY) {
  const text = (body ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '')
    .replace(/(`+)[\s\S]*?\1(?!`)/g, '')
    .replace(/^(?: {4}|\t).*$/gm, '')
    .replace(/^.*\bparent\s+(?:issue|epic)\b.*$/gim, '');
  const numbers = new Set();
  const references =
    /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)\b|([\w.-]+\/[\w.-]+)#([1-9]\d*)\b|(?<![\w/#])#([1-9]\d*)\b/g;
  for (const match of text.matchAll(references)) {
    const target = match[1] ?? match[3] ?? repository;
    const number = Number(match[2] ?? match[4] ?? match[5]);
    if (
      target.toLowerCase() === repository.toLowerCase() &&
      Number.isSafeInteger(number)
    )
      numbers.add(number);
  }
  return [...numbers];
}

export async function readMetadata(api, id) {
  const labels = await paginate(async (cursor) => {
    const data = await api(
      `query($id: ID!, $cursor: String) { node(id: $id) {
        ... on Issue { labels(first: 100, after: $cursor) { nodes { id } ${PAGE} } }
        ... on PullRequest { labels(first: 100, after: $cursor) { nodes { id } ${PAGE} } }
      } }`,
      { id, cursor },
    );
    return data.node?.labels;
  });
  const projects = await paginate(async (cursor) => {
    const data = await api(
      `query($id: ID!, $cursor: String) { node(id: $id) {
        ... on Issue { projectItems(first: 100, after: $cursor, includeArchived: false) {
          nodes { project { id closed } } ${PAGE}
        } }
        ... on PullRequest { projectItems(first: 100, after: $cursor, includeArchived: false) {
          nodes { project { id closed } } ${PAGE}
        } }
      } }`,
      { id, cursor },
    );
    return data.node?.projectItems;
  });
  return {
    labels: labels.map((label) => label.id),
    projects: projects
      .filter((item) => item.project && !item.project.closed)
      .map((item) => item.project.id),
  };
}

async function readProjectStatus(api, id, context) {
  const items = await paginate(async (cursor) => {
    const data = await api(
      `query($id: ID!, $cursor: String) { node(id: $id) {
        ... on Issue { projectItems(first: 100, after: $cursor, includeArchived: false) {
          nodes { id project { id } fieldValues(first: 100) { nodes {
            ... on ProjectV2ItemFieldSingleSelectValue { optionId field {
              ... on ProjectV2SingleSelectField { id }
            } }
          } } } ${PAGE}
        } }
      } }`,
      { id, cursor },
    );
    return data.node?.projectItems;
  });
  const item = items.find((value) => value.project?.id === context.projectId);
  if (!item) return null;
  const statusField = context.fields.Status;
  const statusValue = item.fieldValues.nodes.find(
    (value) => value.field?.id === statusField.id,
  );
  return {
    itemId: item.id,
    status: statusField.options.find(
      (option) => option.id === statusValue?.optionId,
    )?.name,
  };
}

async function linkedIssueReviewPlan(api, issues) {
  const openIssues = issues.filter((issue) => issue.state === 'OPEN');
  if (!openIssues.length) return { context: null, updates: [] };
  const context = await discover(api);
  const reviewOption = context.fields.Status.options.find(
    (option) => option.name === 'In review',
  );
  if (!reviewOption) throw new Error('Missing project status In review');
  const updates = [];
  for (const issue of openIssues) {
    const projectItem = await readProjectStatus(api, issue.id, context);
    if (
      projectItem &&
      projectItem.status !== 'In review' &&
      projectItem.status !== 'Done'
    )
      updates.push({ itemId: projectItem.itemId, optionId: reviewOption.id });
  }
  return { context, updates };
}

async function applyLinkedIssueReviewPlan(api, plan) {
  if (!plan.context) return;
  for (const update of plan.updates)
    await api(
      `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
        updateProjectV2ItemFieldValue(input: {projectId: $project, itemId: $item,
          fieldId: $field, value: {singleSelectOptionId: $option}}) { projectV2Item { id } }
      }`,
      {
        project: plan.context.projectId,
        item: update.itemId,
        field: plan.context.fields.Status.id,
        option: update.optionId,
      },
    );
}

export async function copyMetadata({
  api,
  number,
  dryRun = true,
  log = console.log,
}) {
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error('A positive pull request number is required');
  const [owner, name] = REPOSITORY.split('/');
  const variables = { owner, name, number };
  const data = await api(
    `query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) { pullRequest(number: $number) {
        id body state isDraft milestone { id }
      } }
    }`,
    variables,
  );
  const pr = data.repository?.pullRequest;
  if (!pr) throw new Error('Pull request not found');
  if (pr.state !== 'OPEN') return;
  const numbers = linkedIssues(pr.body);
  if (!numbers.length) return;
  const issues = [];
  for (const issueNumber of numbers) {
    const result = await api(
      `query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) { issueOrPullRequest(number: $number) {
          __typename ... on Issue { id state milestone { id } }
        } }
      }`,
      { owner, name, number: issueNumber },
    );
    const linked = result.repository?.issueOrPullRequest;
    const issue = linked?.__typename === 'Issue' ? linked : null;
    // References to PRs or missing issues do not supply metadata.
    if (issue)
      issues.push({ ...issue, ...(await readMetadata(api, issue.id)) });
  }
  if (!issues.length) return;
  const current = await readMetadata(api, pr.id);
  const labels = [...new Set(issues.flatMap((issue) => issue.labels))].filter(
    (id) => !current.labels.includes(id),
  );
  const projects = [
    ...new Set(issues.flatMap((issue) => issue.projects)),
  ].filter((id) => !current.projects.includes(id));
  const milestones = [
    ...new Set(issues.map((issue) => issue.milestone?.id).filter(Boolean)),
  ];
  if (milestones.length > 1)
    log(
      'Linked issues have conflicting milestones; leaving the PR milestone unchanged.',
    );
  const milestone =
    !pr.milestone && milestones.length === 1 ? milestones[0] : null;
  log(
    `PR #${number}: ${labels.length} labels, ${projects.length} projects, ${milestone ? 1 : 0} milestone to copy${dryRun ? ' (dry run)' : ''}.`,
  );
  const reviewPlan = pr.isDraft
    ? { context: null, updates: [] }
    : await linkedIssueReviewPlan(api, issues);
  log(
    `${reviewPlan.updates.length} linked issues to move to In review${dryRun ? ' (dry run)' : ''}.`,
  );
  if (dryRun) return;
  // A description edit during discovery must not apply stale issue metadata.
  const fresh = await api(
    `query($id: ID!) { node(id: $id) { ... on PullRequest { body state isDraft milestone { id } } } }`,
    { id: pr.id },
  );
  if (
    fresh.node?.body !== pr.body ||
    fresh.node.state !== 'OPEN' ||
    fresh.node.isDraft !== pr.isDraft
  )
    throw new Error(
      'Pull request changed during discovery; rerun reconciliation',
    );
  if (labels.length)
    await api(
      `mutation($id: ID!, $labels: [ID!]!) { addLabelsToLabelable(input: {labelableId: $id, labelIds: $labels}) { clientMutationId } }`,
      { id: pr.id, labels },
    );
  if (milestone && !fresh.node.milestone)
    await api(
      `mutation($id: ID!, $milestone: ID!) { updatePullRequest(input: {pullRequestId: $id, milestoneId: $milestone}) { clientMutationId } }`,
      { id: pr.id, milestone },
    );
  for (const project of projects)
    await api(
      `mutation($project: ID!, $id: ID!) { addProjectV2ItemById(input: {projectId: $project, contentId: $id}) { item { id } } }`,
      { project, id: pr.id },
    );
  await applyLinkedIssueReviewPlan(api, reviewPlan);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.env.GITHUB_ACTIONS === 'true') {
      if (!process.env.MCC_PROJECT_TOKEN)
        throw new Error('MCC_PROJECT_TOKEN is required for Projects access.');
      if (process.env.GITHUB_REPOSITORY !== REPOSITORY)
        throw new Error('Unexpected repository');
      process.env.GH_TOKEN = process.env.MCC_PROJECT_TOKEN;
    }
    const mode = process.env.DRY_RUN ?? 'true';
    if (!['true', 'false'].includes(mode))
      throw new Error('DRY_RUN must be true or false');
    await copyMetadata({
      api: metadataGraphql,
      number: Number(process.env.PR_NUMBER),
      dryRun: mode === 'true',
    });
  } catch (error) {
    console.error(
      error.code || error.status
        ? 'GitHub API request failed; check authentication and Projects permissions.'
        : error.message,
    );
    process.exitCode = 1;
  }
}
