import { parse } from 'yaml';

export const GATE_CONTEXT = 'Require applicable Terrateam applies';
const APPLY_CONTEXT = 'terrateam apply';
const CONFIG_PATH = '.terrateam/config.yml';

function matches(pattern, path) {
  // Support the committed mapping's path globs. Unsupported syntax must block
  // classification instead of silently exempting a root.
  if (/[[\]{}()!]/.test(pattern))
    throw new Error(`Unsupported Terrateam file pattern: ${pattern}`);
  const expression = pattern
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((part) => {
      if (part === '**/') return '(?:.*/)?';
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      if (part === '?') return '[^/]';
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${expression}$`).test(path);
}

export function affectedRoots(paths, configs) {
  const roots = new Set();
  const covered = new Set();
  for (const config of configs) {
    if (!config?.dirs || config.indexer?.enabled !== false)
      throw new Error(
        'Expected explicit Terrateam dirs with the indexer disabled',
      );
    for (const [dir, entry] of Object.entries(config.dirs)) {
      const patterns = entry.when_modified?.file_patterns;
      if (!Array.isArray(patterns) || !patterns.length)
        throw new Error(`Missing file_patterns for ${dir}`);
      if (patterns.length === 1 && patterns[0] === '!**/*') {
        for (const path of paths)
          if (path.startsWith(`${dir}/`)) covered.add(path);
        continue;
      }
      if (entry.workspaces || entry.stacks)
        throw new Error(`Unsupported workspaces or stacks in ${dir}`);
      const expanded = patterns.map((pattern) =>
        pattern.replaceAll('${DIR}', dir),
      );
      for (const path of paths) {
        const included = expanded.some(
          (pattern) => !pattern.startsWith('!') && matches(pattern, path),
        );
        const excluded = expanded.some(
          (pattern) =>
            pattern.startsWith('!') && matches(pattern.slice(1), path),
        );
        if (included && !excluded) {
          roots.add(dir);
          covered.add(path);
        }
      }
    }
  }
  for (const path of paths) {
    if (
      path.startsWith('infrastructure/') &&
      /\.(tf|tfvars|hcl)$/.test(path) &&
      !path.includes('/tests/') &&
      !covered.has(path)
    )
      throw new Error(
        `Infrastructure path has no explicit Terrateam mapping: ${path}`,
      );
  }
  return [...roots].sort();
}

export function applyResult(roots, statuses) {
  if (!roots.length)
    return {
      state: 'success',
      description: 'No Terrateam-managed infrastructure changes',
    };
  // The API returns newest statuses first. A later pending or failed result
  // invalidates success on the same head, including a retry after an unlock.
  const latest = new Map();
  for (const status of statuses) {
    if (!latest.has(status.context)) latest.set(status.context, status);
  }
  const required = [
    APPLY_CONTEXT,
    ...roots.map((root) => `${APPLY_CONTEXT}: ${root} default`),
  ];
  for (const context of required) {
    const status = latest.get(context);
    if (
      !status ||
      status.creator?.login !== 'terrateam-action[bot]' ||
      status.creator?.type !== 'Bot' ||
      status.state !== 'success'
    )
      return {
        state: ['failure', 'error'].includes(status?.state)
          ? 'failure'
          : 'pending',
        description:
          'Waiting for real Terrateam applies for every affected root',
      };
  }
  return {
    state: 'success',
    description: 'Terrateam applied every affected root on this head',
  };
}

export async function updateGate({ github, context, core }) {
  const repo = context.repo;
  let numbers;
  if (context.eventName === 'pull_request_target') {
    numbers = [context.payload.pull_request.number];
  } else if (context.eventName === 'workflow_dispatch') {
    const number = Number(context.payload.inputs['pull-request']);
    if (!Number.isSafeInteger(number) || number < 1)
      throw new Error('A positive pull request number is required');
    numbers = [number];
  } else if (context.eventName === 'status') {
    if (!context.payload.context.startsWith('terrateam ')) return;
    const prs = await github.paginate(
      github.rest.repos.listPullRequestsAssociatedWithCommit,
      {
        ...repo,
        commit_sha: context.payload.sha,
        per_page: 100,
      },
    );
    numbers = prs
      .filter((pr) => pr.head.sha === context.payload.sha)
      .map((pr) => pr.number);
  } else {
    throw new Error('Unsupported gate event');
  }
  for (const number of numbers) {
    const { data: pr } = await github.rest.pulls.get({
      ...repo,
      pull_number: number,
    });
    if (pr.state !== 'open' || pr.base.ref !== 'main') continue;
    const sha = pr.head.sha;
    const publish = (result) =>
      github.rest.repos.createCommitStatus({
        ...repo,
        sha,
        context: GATE_CONTEXT,
        ...result,
      });
    await publish({
      state: 'pending',
      description: 'Checking infrastructure merge requirements',
    });
    let result;
    try {
      const files = await github.paginate(github.rest.pulls.listFiles, {
        ...repo,
        pull_number: number,
        per_page: 100,
      });
      if (
        !files.length ||
        files.length !== pr.changed_files ||
        files.length >= 3000
      )
        throw new Error('Incomplete pull request file list');
      const paths = files.flatMap((file) => [
        file.filename,
        ...(file.previous_filename ? [file.previous_filename] : []),
      ]);
      const readConfig = async (ref) => {
        const { data } = await github.rest.repos.getContent({
          ...repo,
          path: CONFIG_PATH,
          ref,
        });
        if (data.encoding !== 'base64' || !data.content)
          throw new Error('Terrateam configuration is unavailable');
        return parse(Buffer.from(data.content, 'base64').toString('utf8'));
      };
      // Both mappings apply: removing a root or narrowing its patterns in the PR
      // cannot exempt changes that the protected base considers managed.
      const configs = [await readConfig(pr.base.sha), await readConfig(sha)];
      const roots = affectedRoots(paths, configs);
      const statuses = roots.length
        ? await github.paginate(github.rest.repos.listCommitStatusesForRef, {
            ...repo,
            ref: sha,
            per_page: 100,
          })
        : [];
      result = applyResult(roots, statuses);
    } catch (error) {
      core.error(error.message);
      result = {
        state: 'failure',
        description: 'Cannot verify infrastructure requirements; see gate run',
      };
    }
    const { data: fresh } = await github.rest.pulls.get({
      ...repo,
      pull_number: number,
    });
    if (
      fresh.head.sha !== sha ||
      fresh.base.sha !== pr.base.sha ||
      fresh.state !== 'open'
    )
      throw new Error(
        'Pull request changed during evaluation; reevaluate its current head',
      );
    await publish(result);
    core.info(`#${number}: ${result.state}: ${result.description}`);
  }
}
