// Local stand-in for Terrateam on the foundation roots of one pull request.
//
// It mirrors .terrateam/config.yml: inputs come from the infra/foundation-<env>
// GitHub Environment variables, init uses the committed lock file, prod waits
// for dev, applies use the reviewed saved plan, roots stay locked until the
// pull request merges, and the merge is a squash with the PR title. Each
// command does one step; the mcc-apply-foundation skill stops for a person's
// approval between them. Only the two foundation roots are ever selected.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CommandError,
  ENVIRONMENTS,
  accountFromRoleArn,
  assertEnvironment,
  checkLock,
  cleanEnvironment,
  fileDigest,
  githubVariable,
  lockOwner,
  matchesPatterns,
  mergeEnvrc,
  openRoot,
  profileFor,
  releaseLocks,
  repositoryInfo,
  runCommand,
  shellExport,
  stateRoot,
  summarizePlan,
  takeLock,
  verifyAccount,
} from './infra-apply.mjs';

export const FOUNDATION_ROOTS = {
  dev: 'infrastructure/dev/foundation',
  prod: 'infrastructure/prod/foundation',
};
const DIGEST_LENGTH = 12;
const ENVRC_BEGIN =
  '# >>> mcc-apply-foundation managed overrides (do not edit) >>>';
const ENVRC_END = '# <<< mcc-apply-foundation managed overrides <<<';

const require = createRequire(import.meta.url);
function loadYaml() {
  try {
    return require('yaml');
  } catch {
    throw new Error('The yaml package is missing; run npm ci in the checkout');
  }
}

const upper = (environment) => environment.toUpperCase();
const githubEnvironment = (environment) => `infra/foundation-${environment}`;

// Roots whose Terrateam file_patterns match a changed file, in apply order.
// The candidates are fixed, so a bootstrap or data-platform entry in the
// config can never be selected here.
export function affectedRoots(config, files) {
  const roots = [];
  for (const environment of ENVIRONMENTS) {
    const dir = FOUNDATION_ROOTS[environment];
    const entry = config?.dirs?.[dir];
    const patterns = entry?.when_modified?.file_patterns;
    if (!Array.isArray(patterns) || patterns.length === 0)
      throw new Error(`.terrateam/config.yml has no file_patterns for ${dir}`);
    if (
      !entry.tags?.includes(environment) ||
      !entry.tags.includes('foundation')
    )
      throw new Error(
        `.terrateam/config.yml does not tag ${dir} as ${environment} foundation`,
      );
    const expanded = patterns.map((pattern) =>
      pattern.replaceAll('${DIR}', dir),
    );
    if (files.some((file) => matchesPatterns(expanded, file)))
      roots.push(environment);
  }
  return roots;
}

// Prod depends on dev whenever dev is part of the run: it can neither plan
// nor apply until dev has applied at the recorded head.
export function assertOrder(state, environment) {
  if (
    environment === 'prod' &&
    state.roots.includes('dev') &&
    !state.applied?.dev
  )
    throw new Error('prod depends on dev: apply dev at this head first');
}

const FAILED = new Set([
  'FAILURE',
  'ERROR',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
]);

// Terrateam's own checks are left out: this flow stands in for them.
export function ciStatus(rollup = []) {
  const name = (check) => check.name ?? check.context ?? 'unnamed check';
  const checks = rollup.filter((check) => !/terrateam/i.test(name(check)));
  return {
    total: checks.length,
    failed: checks
      .filter((check) => FAILED.has(check.conclusion ?? check.state))
      .map(name),
    pending: checks
      .filter(
        (check) =>
          (check.status ?? 'COMPLETED') !== 'COMPLETED' ||
          ['PENDING', 'EXPECTED'].includes(check.state ?? ''),
      )
      .map(name),
  };
}

export function createContext({
  run = runCommand,
  env = process.env,
  cwd = process.cwd(),
  out = (line) => console.log(line),
} = {}) {
  const { checkout, repository } = repositoryInfo(run, cwd);
  return {
    run,
    env,
    out,
    checkout,
    repository,
    stateDir: join(stateRoot(checkout, env), 'foundation'),
  };
}

function check(result, message) {
  if (result.status !== 0) throw new CommandError(message, result);
  return result.stdout;
}

function git(ctx, args, message = `git ${args[0]} failed`) {
  return check(
    ctx.run('git', ['-C', ctx.checkout, ...args], {}),
    message,
  ).trim();
}

function gh(ctx, args, message = `gh ${args.slice(0, 2).join(' ')} failed`) {
  return check(ctx.run('gh', [...args, '-R', ctx.repository], {}), message);
}

const prDir = (ctx, pr) => join(ctx.stateDir, `pr-${pr}`);
const statePath = (ctx, pr) => join(prDir(ctx, pr), 'state.json');

function readState(ctx, pr) {
  const path = statePath(ctx, pr);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

function writeState(ctx, state) {
  writeFileSync(
    statePath(ctx, state.pr),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

function liveHead(ctx, pr) {
  return gh(ctx, [
    'pr',
    'view',
    String(pr),
    '--json',
    'headRefOid',
    '-q',
    '.headRefOid',
  ]).trim();
}

function prState(ctx) {
  return (owner) => {
    const result = ctx.run(
      'gh',
      [
        'pr',
        'view',
        owner,
        '--json',
        'state',
        '-q',
        '.state',
        '-R',
        ctx.repository,
      ],
      {},
    );
    return result.status === 0 ? result.stdout.trim() : 'UNKNOWN';
  };
}

// Any push after preflight voids every plan and approval for the PR.
function requireState(ctx, pr) {
  const state = readState(ctx, pr);
  if (!state)
    throw new Error(`No preflight for PR #${pr}; run preflight first`);
  const live = liveHead(ctx, pr);
  if (live !== state.head)
    throw new Error(
      `PR #${pr} head moved (${state.head} -> ${live}). Run preflight again; earlier plans and approvals are void.`,
    );
  const source = join(prDir(ctx, pr), 'src');
  const checkedOut = check(
    ctx.run('git', ['-C', source, 'rev-parse', 'HEAD'], {}),
    `The PR worktree at ${source} is missing; run preflight again`,
  ).trim();
  if (checkedOut !== state.head)
    throw new Error(`The PR worktree is not at ${state.head}`);
  return state;
}

function requireRoot(state, environment) {
  assertEnvironment(environment);
  if (!state.roots.includes(environment))
    throw new Error(
      `PR #${state.pr} does not change the ${environment} foundation`,
    );
}

function lockKey(environment) {
  return FOUNDATION_ROOTS[environment].replaceAll('/', '_');
}

function lockRoot(ctx, state, environment) {
  checkLock({
    stateDir: ctx.stateDir,
    key: lockKey(environment),
    pr: state.pr,
    prState: prState(ctx),
  });
}

// Inputs Terrateam supplies, read from the same GitHub variables.
function foundationInputs(ctx, environment) {
  const E = upper(environment);
  const variable = (name) =>
    githubVariable(ctx.run, {
      repository: ctx.repository,
      name,
      environment: githubEnvironment(environment),
    });
  const roleVariable = `${E}_TERRATEAM_ROLE_ARN`;
  return {
    bucket: variable(`${E}_TOFU_STATE_BUCKET`),
    region: variable(`${E}_AWS_REGION`),
    domain: variable(`${E}_MCC_EMAIL_DOMAIN`),
    roleVariable,
    account: accountFromRoleArn(variable(roleVariable), roleVariable),
    subject: githubVariable(ctx.run, {
      repository: ctx.repository,
      name: 'MCC_GITHUB_OIDC_SUBJECT_REPOSITORY',
      required: false,
    }),
  };
}

function openFoundation(ctx, state, environment) {
  const inputs = foundationInputs(ctx, environment);
  return openRoot({
    run: ctx.run,
    env: ctx.env,
    cwd: join(prDir(ctx, state.pr), 'src', FOUNDATION_ROOTS[environment]),
    profile: profileFor(environment, ctx.env),
    expectedAccount: inputs.account,
    accountSource: `${inputs.roleVariable} in ${githubEnvironment(environment)}`,
    region: inputs.region,
    backend: { bucket: inputs.bucket, region: inputs.region },
    inputs: {
      TF_VAR_aws_region: inputs.region,
      TF_VAR_email_domain: inputs.domain,
      ...(inputs.subject
        ? { TF_VAR_github_oidc_subject_repository: inputs.subject }
        : {}),
    },
  });
}

function writeLog(path, result) {
  writeFileSync(path, `${result.stdout}${result.stderr}`);
}

export function preflight(ctx, pr) {
  const view = JSON.parse(
    gh(ctx, [
      'pr',
      'view',
      String(pr),
      '--json',
      'number,title,state,isDraft,baseRefName,headRefOid,mergeable,statusCheckRollup',
    ]),
  );
  if (view.state !== 'OPEN') throw new Error(`PR #${pr} is ${view.state}`);
  if (view.baseRefName !== 'main')
    throw new Error(
      `PR #${pr} targets ${view.baseRefName}; foundation applies only run for main`,
    );
  if (view.mergeable === 'CONFLICTING')
    throw new Error(`PR #${pr} has merge conflicts`);
  const ci = ciStatus(view.statusCheckRollup);
  if (ci.failed.length) throw new Error(`CI failed: ${ci.failed.join(', ')}`);
  if (ci.pending.length)
    throw new Error(
      `CI still running: ${ci.pending.join(', ')}. Run preflight again once it passes.`,
    );
  if (ci.total === 0) throw new Error(`PR #${pr} has no CI checks yet`);

  const head = view.headRefOid;
  git(ctx, ['fetch', '-q', 'origin', 'main', `refs/pull/${pr}/head`]);
  git(ctx, ['cat-file', '-e', `${head}^{commit}`], `Could not fetch ${head}`);
  const base = git(ctx, ['merge-base', 'origin/main', head]);
  const files = git(ctx, ['diff', '--name-only', '--no-renames', base, head])
    .split('\n')
    .filter(Boolean);
  const config = loadYaml().parse(
    git(ctx, ['show', `${head}:.terrateam/config.yml`]),
  );
  const roots = affectedRoots(config, files);
  if (!roots.length)
    throw new Error(
      `PR #${pr} changes no Terrateam-managed foundation files; nothing to plan`,
    );
  // Every apply happens from a pull request, so a branch missing
  // infrastructure commits already on main would revert them.
  const behind = git(ctx, [
    'diff',
    '--name-only',
    base,
    'origin/main',
    '--',
    'infrastructure',
    '.terrateam',
  ]);
  if (behind)
    throw new Error(
      `PR #${pr} is behind main on infrastructure files; update the branch first:\n${behind}`,
    );

  const dir = prDir(ctx, pr);
  const source = join(dir, 'src');
  const previous = readState(ctx, pr);
  if (previous && previous.head !== head) {
    ctx.out(`Head changed since the last preflight; discarding earlier plans`);
    ctx.run(
      'git',
      ['-C', ctx.checkout, 'worktree', 'remove', '--force', source],
      {},
    );
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
  if (!existsSync(source))
    git(ctx, ['worktree', 'add', '-q', '--detach', source, head]);
  const state = {
    pr,
    head,
    title: view.title,
    roots,
    plans: previous?.head === head ? (previous.plans ?? {}) : {},
    applied: previous?.head === head ? (previous.applied ?? {}) : {},
  };
  writeState(ctx, state);
  requireState(ctx, pr);
  for (const environment of roots) lockRoot(ctx, state, environment);

  ctx.out(`PR:      #${pr} ${view.title}`);
  if (view.isDraft) ctx.out('Warning: the PR is a draft');
  ctx.out(`Head:    ${head}`);
  ctx.out(`CI:      passed (${ci.total} checks)`);
  ctx.out(
    `Roots:   ${roots.map((environment) => FOUNDATION_ROOTS[environment]).join(', ')}`,
  );
  ctx.out(`Source:  ${source}`);
  ctx.out('Changed:');
  for (const file of files) ctx.out(`  ${file}`);
  return state;
}

export function plan(ctx, pr, environment) {
  const state = requireState(ctx, pr);
  requireRoot(state, environment);
  lockRoot(ctx, state, environment);
  assertOrder(state, environment);
  const dir = prDir(ctx, pr);
  const planFile = join(dir, `${environment}.tfplan`);
  for (const suffix of ['tfplan', 'plan.json', 'plan.txt'])
    rmSync(join(dir, `${environment}.${suffix}`), { force: true });
  delete state.plans[environment];
  delete state.applied[environment];
  writeState(ctx, state);

  const tofu = openFoundation(ctx, state, environment);
  const result = tofu([
    'plan',
    '-no-color',
    '-input=false',
    '-lock-timeout=60s',
    '-detailed-exitcode',
    `-out=${planFile}`,
  ]);
  writeLog(join(dir, `${environment}.plan.log`), result);
  if (![0, 2].includes(result.status) || !existsSync(planFile))
    throw new CommandError(`tofu plan failed for ${environment}`, result);
  const text = check(tofu(['show', '-no-color', planFile]), 'tofu show failed');
  writeFileSync(join(dir, `${environment}.plan.txt`), text);
  const json = check(tofu(['show', '-json', planFile]), 'tofu show failed');
  writeFileSync(join(dir, `${environment}.plan.json`), json);
  const digest = fileDigest(planFile);
  state.plans[environment] = {
    digest,
    changes: result.status === 2,
    at: new Date().toISOString(),
  };
  writeState(ctx, state);

  ctx.out(
    `Root:    ${FOUNDATION_ROOTS[environment]} (profile ${profileFor(environment, ctx.env)})`,
  );
  ctx.out(`Head:    ${state.head}`);
  ctx.out(`Result:  ${result.status === 2 ? 'changes' : 'no changes'}`);
  for (const line of summarizePlan(JSON.parse(json))) ctx.out(line);
  ctx.out(`Plan:    ${join(dir, `${environment}.plan.txt`)}`);
  ctx.out(`Digest:  ${digest.slice(0, DIGEST_LENGTH)}`);
  return state;
}

// Applies only the saved plan whose digest the person reviewed. A re-plan in
// between changes the digest, so the apply refuses.
export function apply(ctx, pr, environment, reviewedDigest) {
  const state = requireState(ctx, pr);
  requireRoot(state, environment);
  lockRoot(ctx, state, environment);
  assertOrder(state, environment);
  const dir = prDir(ctx, pr);
  const planFile = join(dir, `${environment}.tfplan`);
  const saved = state.plans[environment];
  if (!saved || !existsSync(planFile))
    throw new Error(`No saved ${environment} plan for this head; plan first`);
  if (
    !reviewedDigest ||
    reviewedDigest.length < DIGEST_LENGTH ||
    !saved.digest.startsWith(reviewedDigest)
  )
    throw new Error(
      `Pass the digest of the reviewed ${environment} plan (${saved.digest.slice(0, DIGEST_LENGTH)}); it does not match`,
    );
  if (fileDigest(planFile) !== saved.digest)
    throw new Error(
      `The saved ${environment} plan changed on disk; plan again`,
    );

  const tofu = openFoundation(ctx, state, environment);
  takeLock(ctx.stateDir, lockKey(environment), pr);
  const result = tofu([
    'apply',
    '-no-color',
    '-input=false',
    '-lock-timeout=60s',
    planFile,
  ]);
  writeLog(join(dir, `${environment}.apply.log`), result);
  if (result.status !== 0)
    throw new CommandError(
      `tofu apply failed for ${environment}; the root stays locked to PR #${pr}. Fix forward with a new commit.`,
      result,
    );
  rmSync(planFile, { force: true });
  state.applied[environment] = new Date().toISOString();
  writeState(ctx, state);
  ctx.out(`Applied: ${FOUNDATION_ROOTS[environment]} at ${state.head}`);
  return state;
}

export function merge(ctx, pr) {
  const state = requireState(ctx, pr);
  for (const environment of state.roots)
    if (!state.applied[environment])
      throw new Error(`${environment} has not applied at this head`);
  gh(
    ctx,
    [
      'pr',
      'merge',
      String(pr),
      '--squash',
      '--subject',
      `${state.title} (#${pr})`,
      '--match-head-commit',
      state.head,
    ],
    'gh pr merge failed; if a required check blocks it, merge once checks pass',
  );
  releaseLocks(ctx.stateDir, ENVIRONMENTS.map(lockKey), pr);
  ctx.out(`Merged PR #${pr} as "${state.title} (#${pr})"`);
}

export function status(ctx, pr) {
  const state = readState(ctx, pr);
  if (!state) ctx.out(`PR #${pr}: no local run`);
  else {
    ctx.out(`PR #${pr} ${state.title}`);
    ctx.out(`Head: ${state.head} (live ${liveHead(ctx, pr)})`);
    for (const environment of state.roots) {
      let progress = 'not planned';
      if (state.plans[environment])
        progress = `planned, digest ${state.plans[environment].digest.slice(0, DIGEST_LENGTH)}`;
      if (state.applied[environment])
        progress = `applied ${state.applied[environment]}`;
      ctx.out(`  ${environment}: ${progress}`);
    }
  }
  for (const environment of ENVIRONMENTS) {
    const owner = lockOwner(ctx.stateDir, lockKey(environment));
    if (owner) ctx.out(`  lock ${FOUNDATION_ROOTS[environment]}: PR #${owner}`);
  }
}

export function unlock(ctx, pr) {
  for (const key of releaseLocks(ctx.stateDir, ENVIRONMENTS.map(lockKey), pr))
    ctx.out(`Unlocked ${key.replaceAll('_', '/')}`);
}

export function cleanup(ctx, pr) {
  const dir = prDir(ctx, pr);
  if (existsSync(join(dir, 'src')))
    git(ctx, ['worktree', 'remove', '--force', join(dir, 'src')]);
  rmSync(dir, { recursive: true, force: true });
  git(ctx, ['worktree', 'prune']);
  ctx.out(`Removed ${dir}`);
}

export function envrcLines(inputs, profile) {
  return [
    shellExport('AWS_PROFILE', profile),
    shellExport('AWS_REGION', inputs.region),
    shellExport('AWS_DEFAULT_REGION', inputs.region),
    shellExport('TF_VAR_aws_region', inputs.region),
    shellExport('TF_VAR_email_domain', inputs.domain),
    ...(inputs.subject
      ? [shellExport('TF_VAR_github_oidc_subject_repository', inputs.subject)]
      : []),
  ];
}

// Keeps a managed block in each foundation root's local .envrc so a shell in
// that root targets the right account and inputs; the repository-root .envrc
// defaults to dev, so a prod root would otherwise inherit it. Then checks what
// a shell in each root resolves. Values are never printed.
export function envrc(ctx) {
  let failures = 0;
  for (const environment of ENVIRONMENTS) {
    const dir = join(ctx.checkout, FOUNDATION_ROOTS[environment]);
    const file = join(dir, '.envrc');
    const inputs = foundationInputs(ctx, environment);
    const profile = profileFor(environment, ctx.env);
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    const wanted = mergeEnvrc(existing, {
      begin: ENVRC_BEGIN,
      end: ENVRC_END,
      lines: envrcLines(inputs, profile),
    });
    let change = 'unchanged';
    if (wanted !== existing) {
      change = existing === undefined ? 'created' : 'updated';
      writeFileSync(file, wanted);
      chmodSync(file, 0o600);
      ctx.run('direnv', ['allow', file], {});
    }
    const resolved = (name) =>
      ctx.run('direnv', ['exec', dir, 'sh', '-c', `printf %s "$${name}"`], {
        env: cleanEnvironment(ctx.env),
      }).stdout;
    let verdict = 'ok';
    const gotProfile = resolved('AWS_PROFILE');
    if (gotProfile !== profile)
      verdict = `AWS_PROFILE resolves to "${gotProfile}"`;
    else if (resolved('TF_VAR_aws_region') !== inputs.region)
      verdict = 'region mismatch';
    else
      try {
        verifyAccount({
          run: ctx.run,
          env: ctx.env,
          profile,
          expectedAccount: inputs.account,
          source: inputs.roleVariable,
        });
      } catch (error) {
        verdict = /no valid credentials/.test(error.message)
          ? `ok (credentials expired for ${profile}; account not verified)`
          : error.message;
      }
    if (!verdict.startsWith('ok')) failures += 1;
    ctx.out(
      `  ${FOUNDATION_ROOTS[environment]}/.envrc  ${change}  profile=${profile}  ${verdict}`,
    );
  }
  if (failures) throw new Error(`${failures} .envrc check(s) failed`);
}

const USAGE = `usage: node scripts/apply-foundation.mjs <command> [pr] [env] [digest]
  preflight <pr>                  verify the PR, CI, freshness, and affected roots; check out the head
  plan <pr> <dev|prod>            init and save a plan for one foundation root
  apply <pr> <dev|prod> <digest>  apply the reviewed saved plan for one foundation root
  merge <pr>                      squash-merge with the PR title once every root applied
  status <pr>                     show recorded progress and locks
  unlock <pr>                     release this PR's local root locks
  cleanup <pr>                    remove the PR worktree and run state
  envrc                           write and verify each foundation root's .envrc overrides`;

export function main(args, options = {}) {
  const [command, rawPr, environment, digest] = args;
  if (command === 'envrc') return envrc(createContext(options));
  const pr = Number(String(rawPr ?? '').replace(/^#/, ''));
  const commands = { preflight, plan, apply, merge, status, unlock, cleanup };
  if (!Object.hasOwn(commands, command) || !Number.isInteger(pr) || pr < 1)
    throw new Error(USAGE);
  if (['plan', 'apply'].includes(command)) assertEnvironment(environment);
  return commands[command](createContext(options), pr, environment, digest);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    if (error.output)
      console.error(error.output.split('\n').slice(-60).join('\n'));
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}
