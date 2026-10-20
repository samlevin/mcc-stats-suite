// The AWS account check shared by the CDK wrapper (scripts/cdk-app.mjs), the
// roster script (scripts/roster.mjs), the recipient script
// (scripts/recipients.mjs) and the sender allowlist script
// (scripts/sender-allowlist.mjs). Each runs it before any AWS call that reads
// or changes a resource. Keep it free of dependencies: every deployment,
// including GitHub Actions, loads it.
import { spawnSync } from 'node:child_process';

// A failed check. `detail` holds the AWS CLI's error output, when there is one.
export class AccountGuardError extends Error {
  constructor(message, detail = '') {
    super(message);
    this.name = 'AccountGuardError';
    this.detail = detail;
  }
}

// The environment a profile name implies, such as `mcc-prod-admin` -> prod.
export function environmentFromProfile(profile) {
  if (!profile) return undefined;
  const normalized = profile.toLowerCase();
  if (/(^|[-_])prod(uction)?($|[-_])/.test(normalized)) return 'prod';
  if (/(^|[-_])dev(elopment)?($|[-_])/.test(normalized)) return 'dev';
  return undefined;
}

// Returns the requested environment, else the one the profile implies, else dev.
// Refuses any other environment, and a profile whose name implies the other one.
export function resolveEnvironment(requested, profile) {
  const profileEnvironment = environmentFromProfile(profile);
  const environment = requested ?? profileEnvironment ?? 'dev';
  if (environment !== 'dev' && environment !== 'prod') {
    throw new AccountGuardError('--environment must be dev or prod');
  }
  if (requested && profileEnvironment && requested !== profileEnvironment) {
    throw new AccountGuardError(
      `AWS_PROFILE=${profile} looks like ${profileEnvironment}, not ${requested}`,
    );
  }
  return environment;
}

// The account the active credentials must belong to: MCC_DEV_ACCOUNT_ID or
// MCC_PROD_ACCOUNT_ID, else the profile's sso_account_id. When `needsAws` is
// true, a profile is required outside GitHub Actions and some account must be
// found. Returns `{ account, source }`; `account` is undefined only when
// `needsAws` is false and no variable is set.
export function resolveExpectedAccount({
  environment,
  profile,
  needsAws,
  env,
  readSsoAccount,
}) {
  const accountVariable =
    environment === 'dev' ? 'MCC_DEV_ACCOUNT_ID' : 'MCC_PROD_ACCOUNT_ID';
  let account = env[accountVariable];
  let source = accountVariable;
  if (needsAws && !profile && env.GITHUB_ACTIONS !== 'true') {
    throw new AccountGuardError(
      'Export AWS_PROFILE or pass --profile before using AWS',
    );
  }
  if (needsAws && !account && profile) {
    account = readSsoAccount();
    source = `AWS_PROFILE=${profile} sso_account_id`;
  }
  if (needsAws && !account) {
    throw new AccountGuardError(
      `AWS profile ${profile ?? '(ambient credentials)'} has no sso_account_id; ` +
        `configure it or export ${accountVariable}`,
    );
  }
  if (account && !/^[0-9]{12}$/.test(account)) {
    throw new AccountGuardError(
      `${accountVariable} must contain a 12-digit AWS account ID`,
    );
  }
  return { account, source };
}

// Asks STS who the active credentials are and refuses any account but
// `expected`. Returns `{ account, arn }`. `run(args)` runs one AWS CLI command.
export function verifyCallerAccount({ run, expected, source, action }) {
  const identity = run(['sts', 'get-caller-identity', '--output', 'json']);
  let caller;
  try {
    if (identity.status !== 0) throw new Error('STS call failed');
    caller = JSON.parse(identity.stdout);
  } catch {
    throw new AccountGuardError(
      'Unable to resolve the active AWS account',
      identity.stderr ?? '',
    );
  }
  if (caller.Account !== expected) {
    throw new AccountGuardError(
      `Refusing ${action}: active account ${caller.Account} does not match ${source} (${expected})`,
    );
  }
  return { account: caller.Account, arn: caller.Arn };
}

// The profile's sso_account_id from the local AWS configuration, or undefined.
export function profileSsoAccount(run) {
  const configured = run(['configure', 'get', 'sso_account_id']);
  return configured.status === 0 ? configured.stdout.trim() : undefined;
}

// Every AWS CLI call goes through here so the profile is applied one way.
export function awsCli(profile, commandArguments, environmentVariables) {
  const profileArguments = profile ? ['--profile', profile] : [];
  return spawnSync('aws', [...commandArguments, ...profileArguments], {
    encoding: 'utf8',
    env: environmentVariables,
  });
}
