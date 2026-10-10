import { pathToFileURL } from 'node:url';
import {
  linkedIssues,
  metadataGraphql,
  referenceText,
} from './issue-pr-metadata.mjs';
import {
  discover,
  paginate,
  readItem,
  REPOSITORY,
  updateProjectStatus,
} from './issue-triage.mjs';

export function closingIssues(body, repository = REPOSITORY) {
  const references = referenceText(body).matchAll(
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*\b|[\w.-]+\/[\w.-]+#[1-9]\d*\b|#[1-9]\d*\b)/gi,
  );
  return [
    ...new Set(
      [...references].flatMap((match) => linkedIssues(match[1], repository)),
    ),
  ];
}

function eligible(item) {
  return (
    item?.type === 'ISSUE' &&
    item.content?.__typename === 'Issue' &&
    item.content.repository?.nameWithOwner === REPOSITORY &&
    item.content.state === 'OPEN' &&
    item.fields.Status === 'In progress'
  );
}

export async function moveIssuesToReview({
  api,
  number,
  dryRun = true,
  log = console.log,
}) {
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error('A positive pull request number is required');
  const [owner, name] = REPOSITORY.split('/');
  const readPr = async () =>
    (
      await api(
        `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) {
      pullRequest(number: $number) { body state isDraft }
    } }`,
        { owner, name, number },
      )
    ).repository?.pullRequest;
  const pr = await readPr();
  if (!pr) throw new Error('Pull request not found');
  if (pr.state !== 'OPEN' || pr.isDraft) return;
  const numbers = closingIssues(pr.body);
  if (!numbers.length) return;
  const context = await discover(api, { Status: ['In progress', 'In review'] });
  for (const issueNumber of numbers) {
    const items = await paginate(async (cursor) => {
      const data = await api(
        `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $name) { issueOrPullRequest(number: $number) {
            ... on Issue { projectItems(first: 100, after: $cursor, includeArchived: false) {
              nodes { id project { id } } pageInfo { hasNextPage endCursor }
            } }
          } }
        }`,
        { owner, name, number: issueNumber, cursor },
      );
      return (
        data.repository?.issueOrPullRequest?.projectItems ?? {
          nodes: [],
          pageInfo: { hasNextPage: false },
        }
      );
    });
    const item = items.find((item) => item.project?.id === context.projectId);
    if (!item || !eligible(await readItem(api, item.id, context))) continue;
    if (dryRun) {
      log(`Issue #${issueNumber}: In progress -> In review (dry run).`);
      continue;
    }
    const freshPr = await readPr();
    if (
      !freshPr ||
      freshPr.body !== pr.body ||
      freshPr.state !== 'OPEN' ||
      freshPr.isDraft
    )
      throw new Error(
        'Pull request changed during discovery; rerun reconciliation',
      );
    const freshContext = await discover(api, {
      Status: ['In progress', 'In review'],
    });
    const fresh = await readItem(api, item.id, freshContext);
    if (!eligible(fresh) || fresh.content.number !== issueNumber) continue;
    await updateProjectStatus(api, freshContext, fresh.id, 'In review');
    log(`Issue #${issueNumber}: In progress -> In review.`);
  }
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
      if (!['opened', 'ready_for_review'].includes(process.env.PR_ACTION))
        throw new Error('Unexpected pull request action');
    }
    const mode = process.env.DRY_RUN ?? 'true';
    if (!['true', 'false'].includes(mode))
      throw new Error('DRY_RUN must be true or false');
    await moveIssuesToReview({
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
