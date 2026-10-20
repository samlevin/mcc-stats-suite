import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CliHelp, cliError, defineCli, parseCli } from './cli.cjs';
import { implementationEffort, loadPolicy } from './agent-policy.mjs';
import { closingIssues } from './issue-pr-status.mjs';

const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const text = (value) =>
  typeof value === 'string' ? value : (value?.raw ?? '');

// Every invocation refetches GitHub. The map stores responses only for this run.
export function restClient(run = execFileSync) {
  const get = (path, paginate = false) => {
    try {
      return JSON.parse(
        run(
          'gh',
          [
            'api',
            path,
            '--method',
            'GET',
            ...(paginate ? ['--paginate', '--slurp'] : []),
          ],
          {
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        ),
      );
    } catch (error) {
      throw new Error(
        `GET ${path}: ${String(error.stderr || error.message).trim()}`,
        { cause: error },
      );
    }
  };
  // gh follows Link headers, including the Projects v2 cursor-based endpoint.
  const list = (path, key) => {
    const pages = get(
      `${path}${path.includes('?') ? '&' : '?'}per_page=100`,
      true,
    );
    if (!Array.isArray(pages))
      throw new Error(`GET ${path}: expected paginated responses`);
    return pages.flatMap((page) => {
      const items = key ? page[key] : page;
      if (!Array.isArray(items))
        throw new Error(`GET ${path}: expected a list`);
      return items;
    });
  };
  return { get, list };
}

export function claimRecord(comments) {
  let active = null;
  for (const comment of comments) {
    if (!TRUSTED.has(comment.author_association)) continue;
    const body = comment.body ?? '';
    const record = /<!-- mcc-claim (\{[^\n]*\}) -->/.exec(body);
    if (record) {
      const value = JSON.parse(record[1]);
      if (value.released) {
        if (active?.agent === value.agent) active = null;
      } else active = { ...value, url: comment.html_url };
    } else if (
      /\b(?:claims?|claimed|claiming)\b/i.test(body) &&
      !/\b(?:releases?|released|releasing)\b/i.test(body)
    ) {
      active = {
        agent: /Agent\s+`([^`]+)`/i.exec(body)?.[1] ?? comment.user?.login,
        branch: /`(agent\/[^`\s]+)`/.exec(body)?.[1],
        worktree: /`([^`]*\.(?:codex|claude)\/worktrees\/[^`]+)`/.exec(
          body,
        )?.[1],
        url: comment.html_url,
      };
    } else if (/\b(?:releases?|released|releasing)\b.*\bclaim\b/i.test(body)) {
      // Legacy releases belong to the GitHub account that wrote the claim.
      if (active && comment.user?.login === active.login) active = null;
    }
    if (active && (record || /\b(?:claims?|claimed|claiming)\b/i.test(body)))
      active.login = comment.user?.login;
  }
  return active;
}

export function effortRecord(comments, policy) {
  let decision;
  let constraint;
  let transitions = 0;
  for (const comment of comments) {
    if (!TRUSTED.has(comment.author_association)) continue;
    const match = /<!-- mcc-effort (\{[^\n]*\}) -->/.exec(comment.body ?? '');
    if (!match) continue;
    const record = JSON.parse(match[1]);
    if (record.rule === 'user override') constraint = record;
    decision = implementationEffort(policy, {
      decision: constraint ?? record,
      transitions,
    });
    if (!constraint && record.later && decision.effort === 'high')
      transitions++;
  }
  return decision ?? implementationEffort(policy);
}

function fieldValues(item, fields) {
  return Object.fromEntries(
    (item?.fields ?? []).map((field) => {
      const definition = fields.find((entry) => entry.id === field.id);
      const option = definition?.options?.find(
        (entry) => entry.id === field.value,
      );
      return [
        definition?.name ?? field.name,
        text(option?.name ?? field.value?.name ?? field.value),
      ];
    }),
  );
}

export function orderLeaves(leaves, nodes) {
  const remaining = new Set(leaves);
  const result = [];
  const cycles = new Map();
  const visiting = [];
  const seen = new Set();
  function visit(number) {
    const start = visiting.indexOf(number);
    if (start >= 0) {
      const cycle = [...visiting.slice(start), number];
      for (const member of cycle) cycles.set(member, cycle);
      return;
    }
    if (seen.has(number)) return;
    visiting.push(number);
    for (const dep of nodes.get(number)?.dependencies ?? []) visit(dep.number);
    visiting.pop();
    seen.add(number);
  }
  for (const number of leaves) visit(number);
  // Kahn's algorithm gives a numeric tie break among currently eligible leaves.
  while (remaining.size) {
    function hasRemainingDependency(number, visited = new Set()) {
      if (visited.has(number)) return false;
      visited.add(number);
      return (nodes.get(number)?.dependencies ?? []).some(
        (dep) =>
          remaining.has(dep.number) ||
          hasRemainingDependency(dep.number, visited),
      );
    }
    const ready = [...remaining].filter(
      (number) => !hasRemainingDependency(number),
    );
    const number = (ready.length ? ready : [...remaining]).sort(
      (a, b) => a - b,
    )[0];
    remaining.delete(number);
    result.push(number);
  }
  return { order: result, cycles };
}

export function stackReady(pr, checks, statuses) {
  if (!pr || pr.state !== 'open' || pr.draft) return false;
  const approval =
    /Pre-PR review: APPROVE; base=([0-9a-f]{40}); head=([0-9a-f]{40})/.exec(
      pr.body ?? '',
    );
  if (!approval || approval[1] !== pr.base.sha || approval[2] !== pr.head.sha)
    return false;
  const all = [
    ...checks.map(
      (check) =>
        check.status === 'completed' &&
        ['success', 'neutral', 'skipped'].includes(check.conclusion),
    ),
    ...statuses.map((status) => status.state === 'success'),
  ];
  return all.length > 0 && all.every(Boolean);
}

export function deliveryQueue(
  policy,
  number,
  { api = restClient(), resume, actor, worktrees = [] } = {},
) {
  const { repository, project } = policy.binding;
  const repo = `repos/${repository}`;
  const nodes = new Map();
  const leaves = [];
  const errors = [];
  function readIssue(n, tree = false, ancestors = []) {
    if (ancestors.includes(n)) {
      errors.push(`native sub-issue cycle: ${[...ancestors, n].join(' -> ')}`);
      return;
    }
    let node = nodes.get(n);
    if (!node) {
      try {
        const issue = api.get(`${repo}/issues/${n}`);
        const children = api.list(`${repo}/issues/${n}/sub_issues`);
        const dependencies = api.list(
          `${repo}/issues/${n}/dependencies/blocked_by`,
        );
        const comments = api.list(`${repo}/issues/${n}/comments`);
        node = { issue, children, dependencies, comments };
        nodes.set(n, node);
      } catch (error) {
        errors.push(`issue #${n} inaccessible: ${error.message}`);
        nodes.set(n, { error: error.message, dependencies: [] });
        if (tree) leaves.push(n);
        return;
      }
    }
    if (tree) {
      if (!node.children?.length) {
        if (!leaves.includes(n)) leaves.push(n);
      } else
        for (const child of node.children)
          readIssue(child.number, true, [...ancestors, n]);
    }
    for (const dep of node.dependencies)
      if (!nodes.has(dep.number)) readIssue(dep.number);
  }
  readIssue(number, true);
  const fields = api.list(
    `users/${project.owner}/projectsV2/${project.number}/fields`,
  );
  const items = api.list(
    `users/${project.owner}/projectsV2/${project.number}/items?fields=${fields
      .filter((field) => ['Status', 'Priority', 'Size'].includes(field.name))
      .map((field) => field.id)
      .join(',')}`,
  );
  const prs = api.list(`${repo}/pulls?state=all`);
  const branches = api
    .list(`${repo}/branches`)
    .filter((branch) => branch.name.startsWith('agent/'));
  const closing = (n) =>
    prs.filter((pr) => closingIssues(pr.body, repository).includes(n));
  const merged = (n) => closing(n).find((pr) => pr.merged_at);
  const open = (n) => closing(n).find((pr) => pr.state === 'open');
  const checks = new Map();
  const qualifies = (pr) => {
    if (!pr || pr.draft) return false;
    if (!checks.has(pr.head.sha))
      checks.set(
        pr.head.sha,
        stackReady(
          pr,
          api.list(`${repo}/commits/${pr.head.sha}/check-runs`, 'check_runs'),
          api.get(`${repo}/commits/${pr.head.sha}/status`).statuses ?? [],
        ),
      );
    return checks.get(pr.head.sha);
  };
  const { order, cycles } = orderLeaves(leaves, nodes);
  const rows = order.map((n) => {
    const node = nodes.get(n);
    if (node.error)
      return {
        issue: n,
        state: 'waiting',
        blocker: `BLOCKED: ${node.error}`,
        effort: implementationEffort(policy),
      };
    const item = items.find(
      (entry) =>
        entry.content?.number === n &&
        entry.content?.repository_url?.endsWith(`/repos/${repository}`),
    );
    const metadata = fieldValues(item, fields);
    const claim = claimRecord(node.comments);
    const pr = merged(n) ?? open(n);
    const branch =
      claim?.branch ??
      branches.find((entry) => new RegExp(`^agent/${n}-`).test(entry.name))
        ?.name;
    const row = {
      issue: n,
      state: 'ready',
      title: node.issue.title,
      branch,
      head: branches.find((entry) => entry.name === branch)?.commit.sha,
      pr: pr?.html_url,
      projectState: metadata.Status ?? 'unset',
      size: metadata.Size,
      priority: metadata.Priority ?? 'P2',
      claim,
      effort: effortRecord(node.comments, policy),
    };
    if (node.issue.state === 'closed' || merged(n)) row.state = 'done';
    else if (open(n)) row.state = 'in review';
    else if (claim) {
      const owned =
        actor &&
        claim.agent === actor &&
        worktrees.some(
          (path) =>
            path === claim.worktree || path.endsWith(`/${claim.worktree}`),
        );
      row.state = Number(resume) === n || owned ? 'resume' : 'owned elsewhere';
    } else {
      const unmet = node.dependencies.filter(
        (dep) =>
          nodes.get(dep.number)?.issue?.state !== 'closed' &&
          !merged(dep.number) &&
          !qualifies(open(dep.number)),
      );
      if (unmet.length) {
        row.state = 'waiting';
        row.blocker = `unmet blockers: ${unmet.map((dep) => `#${dep.number}`).join(', ')}`;
      }
    }
    if (cycles.has(n)) {
      row.state = 'waiting';
      row.blocker = `BLOCKED: cycle ${cycles.get(n).join(' -> ')}`;
    }
    return row;
  });
  return { rows, errors };
}

export function nextLeaf(rows) {
  const resumable = rows.find((row) => row.state === 'resume');
  if (resumable) return resumable;
  return rows.find((row) => ['owned elsewhere', 'ready'].includes(row.state));
}

export function ledgerLine(row) {
  const decision = row.effort;
  return `#${row.issue} | ${row.state} | effort=${decision.effort}; rule=${decision.rule}; evidence=${decision.evidence}; reason=${decision.reason} | branch=${row.branch ?? 'none'}; head=${row.head ?? 'none'}; PR=${row.pr ?? 'none'}; project=${row.projectState ?? 'unset'}; size=${row.size ?? 'infer'} | claim=${row.claim?.url ?? 'none'}${row.blocker ? ` | ${row.blocker}` : ''}`;
}

const cli = defineCli(
  'Usage: node scripts/delivery-queue.mjs <issue> [--next] [--resume <issue>] [--actor <delivery-agent>]',
  ['next', 'resume', 'actor'],
);
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const { options, positionals } = parseCli(process.argv.slice(2), cli);
    if (positionals.length !== 1 || !/^[1-9]\d*$/.test(positionals[0]))
      throw cliError(cli, 'Give one positive issue number');
    if (options.resume && !/^[1-9]\d*$/.test(options.resume))
      throw cliError(cli, '--resume needs a positive issue number');
    const registry = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
    });
    const worktrees = [...registry.matchAll(/^worktree (.+)$/gm)].map(
      (match) => match[1],
    );
    const result = deliveryQueue(loadPolicy(), Number(positionals[0]), {
      ...options,
      worktrees,
    });
    const rows = options.next
      ? [nextLeaf(result.rows)].filter(Boolean)
      : result.rows;
    for (const row of rows) console.log(ledgerLine(row));
    for (const error of result.errors) console.error(`BLOCKED: ${error}`);
    if (result.errors.length) process.exitCode = 1;
  } catch (error) {
    if (error instanceof CliHelp) console.log(error.message);
    else {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
