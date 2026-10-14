// Shared plumbing for the person-invoked infrastructure apply skills.
//
// A skill script supplies the root, its GitHub Environment inputs, and its
// ordering rules; this module owns what must behave the same in every one of
// them: the environment it strips, the account check that runs before any
// OpenTofu command, `init` against the committed lock file, saved-plan
// digests, strict local root locks, and the managed `.envrc` block. Every
// external command goes through a runner, so tests replace it and never call
// AWS.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const ENVIRONMENTS = ['dev', 'prod'];

// Local AWS profiles. The defaults follow the bootstrap .envrc.example files;
// a contributor with other profile names exports these variables.
export const PROFILE_VARIABLES = {
  dev: 'MCC_DEV_INFRA_PROFILE',
  prod: 'MCC_PROD_INFRA_PROFILE',
};
const DEFAULT_PROFILES = { dev: 'mcc-dev-admin', prod: 'mcc-prod-admin' };

// Kept from the caller's environment: where the AWS CLI finds profiles and
// the provider plugin cache. Everything else under AWS_, TF_, or TOFU_ can
// carry credentials, a different profile, or OpenTofu inputs and arguments
// that Terrateam would not supply, so it never reaches a command.
const KEPT = new Set([
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CA_BUNDLE',
  'TF_PLUGIN_CACHE_DIR',
]);

export function assertEnvironment(environment) {
  if (!ENVIRONMENTS.includes(environment))
    throw new Error(`Environment must be dev or prod, got "${environment}"`);
  return environment;
}

export function profileFor(environment, env = process.env) {
  assertEnvironment(environment);
  return env[PROFILE_VARIABLES[environment]] || DEFAULT_PROFILES[environment];
}

export function cleanEnvironment(env = process.env) {
  const clean = {};
  for (const [name, value] of Object.entries(env))
    if (KEPT.has(name) || !/^(AWS_|TF_|TOFU_)/.test(name)) clean[name] = value;
  return clean;
}

// The account comes from the role Terrateam assumes, so a local run targets
// the same account a CI run would.
export function accountFromRoleArn(arn, variable = 'the role ARN') {
  const match = /^arn:aws[a-z-]*:iam::(\d{12}):role\/[\w+=,.@/-]+$/.exec(
    arn ?? '',
  );
  if (!match) throw new Error(`${variable} is not an IAM role ARN`);
  return match[1];
}

export function runCommand(command, args, { cwd, env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error?.code === 'ENOENT')
    throw new Error(`${command} is not installed or not on PATH`);
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function firstLine(text) {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  );
}

// Reads one GitHub variable, from an environment when one is named. A
// missing optional variable is undefined; a missing required one is an error.
export function githubVariable(
  run,
  { repository, name, environment, required = true },
) {
  const args = ['variable', 'get', name, '-R', repository];
  if (environment) args.push('-e', environment);
  const result = run('gh', args, {});
  const value = result.status === 0 ? result.stdout.trim() : '';
  if (value) return value;
  if (!required) return undefined;
  const where = environment ? `GitHub Environment ${environment}` : repository;
  throw new Error(
    `Variable ${name} is not readable in ${where}${result.stderr ? `: ${firstLine(result.stderr)}` : ''}`,
  );
}

// Fails unless the profile's credentials belong to the expected account. It
// never prints either account ID.
export function verifyAccount({ run, env, profile, expectedAccount, source }) {
  const result = run(
    'aws',
    ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'],
    { env: { ...cleanEnvironment(env), AWS_PROFILE: profile } },
  );
  if (result.status !== 0)
    throw new Error(
      `AWS profile ${profile} has no valid credentials; refresh them, for example with aws sso login --profile ${profile}`,
    );
  if (result.stdout.trim() !== expectedAccount)
    throw new Error(
      `AWS profile ${profile} belongs to a different account than ${source}; nothing ran`,
    );
}

export function initArguments({ bucket, region }) {
  return [
    'init',
    '-no-color',
    '-input=false',
    '-reconfigure',
    '-lockfile=readonly',
    `-backend-config=bucket=${bucket}`,
    `-backend-config=region=${region}`,
  ];
}

export class CommandError extends Error {
  constructor(message, result) {
    super(message);
    this.output = `${result.stdout}${result.stderr}`;
  }
}

// Verifies the account, then initializes the root with only the given
// inputs. The returned function runs further OpenTofu commands in the same
// clean environment.
export function openRoot({
  run,
  env,
  cwd,
  profile,
  expectedAccount,
  accountSource,
  region,
  backend,
  inputs = {},
}) {
  for (const name of Object.keys(inputs))
    if (!/^TF_VAR_[a-z0-9_]+$/.test(name))
      throw new Error(`Unexpected OpenTofu input ${name}`);
  verifyAccount({
    run,
    env,
    profile,
    expectedAccount,
    source: accountSource,
  });
  const tofuEnv = {
    ...cleanEnvironment(env),
    AWS_PROFILE: profile,
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
    TF_IN_AUTOMATION: '1',
    TF_INPUT: '0',
    ...inputs,
  };
  const tofu = (args) => run('tofu', args, { cwd, env: tofuEnv });
  const init = tofu(initArguments(backend));
  if (init.status !== 0) throw new CommandError('tofu init failed', init);
  return tofu;
}

export function fileDigest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// Counts and lists the actions in `tofu show -json` output.
export function summarizePlan(plan) {
  const changes = (plan.resource_changes ?? []).filter(
    (change) => !['no-op', 'read'].includes(change.change.actions.join('/')),
  );
  const count = (test) =>
    changes.filter((change) => test(change.change.actions)).length;
  const lines = [
    `Summary: ${count((a) => a.join('/') === 'create')} to add, ${count(
      (a) => a.join('/') === 'update',
    )} to change, ${count((a) => a.includes('delete'))} to destroy (${count(
      (a) => a.includes('delete') && a.includes('create'),
    )} replacements)`,
    ...changes.map(
      (change) => `  ${change.change.actions.join('/')}: ${change.address}`,
    ),
  ];
  const imports = (plan.resource_changes ?? []).filter(
    (change) => change.change.importing,
  );
  if (imports.length)
    lines.push(
      'Imports:',
      ...imports.map((change) => `  import: ${change.address}`),
    );
  return lines;
}

// Terrateam's lock_policy: strict. A root stays locked to the first pull
// request that applies it until that pull request merges or closes, or a
// person explicitly unlocks it.
export function lockOwner(stateDir, key) {
  const path = join(stateDir, 'locks', key);
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : undefined;
}

export function checkLock({ stateDir, key, pr, prState }) {
  const owner = lockOwner(stateDir, key);
  if (!owner || owner === String(pr)) return;
  const state = prState(owner);
  if (state === 'MERGED' || state === 'CLOSED') {
    rmSync(join(stateDir, 'locks', key), { force: true });
    return;
  }
  throw new Error(
    `${key} is locked by PR #${owner} (${state}), which applied it and has not merged`,
  );
}

export function takeLock(stateDir, key, pr) {
  mkdirSync(join(stateDir, 'locks'), { recursive: true });
  writeFileSync(join(stateDir, 'locks', key), String(pr));
}

export function releaseLocks(stateDir, keys, pr) {
  const released = [];
  for (const key of keys)
    if (lockOwner(stateDir, key) === String(pr)) {
      rmSync(join(stateDir, 'locks', key), { force: true });
      released.push(key);
    }
  return released;
}

// Terrateam file_patterns: `*` stays inside one directory, `**` crosses
// directories, and a leading `!` excludes.
export function globToRegExp(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      index += 1;
      if (pattern[index + 1] === '/') {
        index += 1;
        source += '(?:.*/)?';
      } else source += '.*';
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

export function matchesPatterns(patterns, path) {
  const include = patterns.filter((pattern) => !pattern.startsWith('!'));
  const exclude = patterns
    .filter((pattern) => pattern.startsWith('!'))
    .map((pattern) => pattern.slice(1));
  return (
    include.some((pattern) => globToRegExp(pattern).test(path)) &&
    !exclude.some((pattern) => globToRegExp(pattern).test(path))
  );
}

// The checkout that owns the git objects, even when the caller runs from a
// linked worktree, and the GitHub repository its origin points at.
export function repositoryInfo(run, cwd) {
  const common = run(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd },
  );
  if (common.status !== 0)
    throw new Error('Run this from inside a checkout of the repository');
  const gitDir = common.stdout.trim();
  if (basename(gitDir) !== '.git')
    throw new Error(`Unsupported git directory layout: ${gitDir}`);
  const checkout = dirname(gitDir);
  const origin = run('git', ['-C', checkout, 'remote', 'get-url', 'origin'], {})
    .stdout.trim()
    .match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  if (!origin) throw new Error('The origin remote is not a GitHub repository');
  return { checkout, repository: origin[1] };
}

// Local state for every apply skill lives in one ignored directory of the
// main checkout, so it survives a reboot and stays inside the workspace.
export function stateRoot(checkout, env = process.env) {
  return env.MCC_INFRA_APPLY_STATE || join(checkout, '.infra-apply');
}

// A marked block at the end of a root's local .envrc. Lines outside the
// block are kept; a new file gets the header the .envrc.example files use.
export function shellExport(name, value) {
  if (!/^[A-Za-z0-9@._:/+=,-]*$/.test(value))
    throw new Error(`Refusing to write ${name}: unexpected characters`);
  return `export ${name}="${value}"`;
}

export function mergeEnvrc(existing, { begin, end, lines }) {
  let kept;
  if (existing === undefined)
    kept =
      '#!/usr/bin/env bash\n# Requires the repository-root .envrc.\nsource_up';
  else {
    const out = [];
    let skipping = false;
    for (const line of existing.split('\n')) {
      if (line === begin) skipping = true;
      else if (line === end) skipping = false;
      else if (!skipping) out.push(line);
    }
    kept = out.join('\n').trimEnd();
    if (!out.includes('source_up'))
      throw new Error('The .envrc exists without source_up; fix it by hand');
  }
  return `${kept}\n\n${[begin, ...lines, end].join('\n')}\n`;
}
