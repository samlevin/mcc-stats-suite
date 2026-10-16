import { pathToFileURL } from 'node:url';
import { ghGraphql, REPOSITORY } from './issue-triage.mjs';

const KINDS = {
  issue: { field: 'issue', label: 'Issue' },
  pull_request: { field: 'pullRequest', label: 'Pull request' },
};

export async function addToProject({
  api,
  kind,
  number,
  dryRun = true,
  log = console.log,
}) {
  const target = Object.hasOwn(KINDS, kind) ? KINDS[kind] : null;
  if (!target) throw new Error('CONTENT_TYPE must be issue or pull_request');
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error('A positive issue or pull request number is required');
  const [owner, name] = REPOSITORY.split('/');
  const data = await api(
    `query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) { ${target.field}(number: $number) { id } }
      user(login: "samlevin") { projectV2(number: 1) { id closed } }
    }`,
    { owner, name, number },
  );
  const content = data.repository?.[target.field];
  if (!content?.id) throw new Error(`${target.label} #${number} not found`);
  const project = data.user?.projectV2;
  if (!project?.id || project.closed)
    throw new Error('MCC delivery project is unavailable');
  if (dryRun) {
    log(`${target.label} #${number}: would add to MCC delivery (dry run).`);
    return null;
  }
  // GitHub returns the existing item when the content is already in the
  // project, so reruns and earlier manual adds neither fail nor duplicate.
  const result = await api(
    `mutation($project: ID!, $content: ID!) {
      addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } }
    }`,
    { project: project.id, content: content.id },
  );
  const item = result.addProjectV2ItemById?.item?.id;
  if (!item) throw new Error('GitHub returned no project item');
  log(`${target.label} #${number}: in MCC delivery as item ${item}.`);
  return item;
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
    await addToProject({
      api: ghGraphql,
      kind: process.env.CONTENT_TYPE,
      number: Number(process.env.CONTENT_NUMBER),
      dryRun: mode === 'true',
    });
  } catch (error) {
    // Do not print subprocess stderr, which can contain authentication details.
    console.error(
      error.code || error.status
        ? 'GitHub API request failed; check authentication and Projects permissions.'
        : error.message,
    );
    process.exitCode = 1;
  }
}
