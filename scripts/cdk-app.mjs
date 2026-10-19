#!/usr/bin/env node
import { CliHelp, cliError, defineCli, parseCli } from './cli.cjs';
import { spawnSync } from 'node:child_process';
import {
  assemblyDirectory,
  planReport,
  readPlanAssembly,
  runDiff,
} from './cdk-plan-report.mjs';
import {
  AccountGuardError,
  awsCli,
  profileSsoAccount,
  resolveEnvironment,
  resolveExpectedAccount,
  verifyCallerAccount,
} from './account-guard.mjs';
import {
  APPLICATIONS,
  cdkArguments,
  ephemeralNameError,
  localDeployArguments,
} from './cdk-targets.mjs';

const applications = new Set(APPLICATIONS);
const actions = new Set(['synth', 'diff', 'deploy', 'destroy']);

const CLI = defineCli(
  'Usage: npm run app:<synth|diff|deploy|destroy> -- <application> [options] [CDK arguments]\nDiff report reference: docs/cdk-plan-output.md',
  ['environment', 'ephemeral', 'profile'],
  { passthrough: true },
);
const [action, ...arguments_] = process.argv.slice(2);
let parsed;
try {
  parsed = parseCli(arguments_, CLI);
  if (action === '--help' || action === '-h') throw new CliHelp(CLI.help);
  if (!actions.has(action)) throw cliError(CLI, 'Name a valid action');
  // CDK has its own option grammar. Do not normalize its options or values.
  if (!applications.has(parsed.passthrough[0]))
    throw cliError(CLI, 'Name a valid application');
} catch (error) {
  if (error instanceof CliHelp) {
    console.log(error.message);
    process.exit(0);
  }
  fail(error.message);
}
const { options } = parsed;
const [application, ...passthrough] = parsed.passthrough;
if (passthrough.some((argument) => /^--context(?:=|$)|^-c/.test(argument)))
  fail('Use --environment and --ephemeral instead of passing CDK context');
const profile = options.profile ?? process.env.AWS_PROFILE;
const environment = guard(() =>
  resolveEnvironment(options.environment, profile),
);
const ephemeral = options.ephemeral;

if (environment === 'prod' && ephemeral) {
  fail('Production does not support --ephemeral');
}
if (ephemeral) {
  const nameError = ephemeralNameError(ephemeral);
  if (nameError) fail(nameError);
}
if (action === 'destroy' && !ephemeral) {
  fail(
    'Only ephemeral stacks can be destroyed. Stable stacks deploy from main ' +
      'through GitHub Actions and have termination protection. ' +
      'Pass --ephemeral <name>',
  );
}
if (!ephemeral && action === 'deploy') {
  if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true') {
    fail(`${environment} deployments are only allowed from GitHub Actions`);
  }
  if (process.env.GITHUB_REF !== 'refs/heads/main') {
    fail(`${environment} deployments are only allowed from the main branch`);
  }
}
if (ephemeral && process.env.GITHUB_ACTIONS === 'true') {
  fail('Ephemeral deployments are only allowed from a local developer shell');
}

// Reject options the local bootstrap cannot run before any AWS call or build.
if (ephemeral && action === 'deploy') {
  try {
    localDeployArguments(passthrough);
  } catch (error) {
    fail(error.message);
  }
}

const needsAws = action !== 'synth';
const { account: expectedAccount, source: expectedAccountSource } = guard(() =>
  resolveExpectedAccount({
    environment,
    profile,
    needsAws,
    env: process.env,
    readSsoAccount: () =>
      profileSsoAccount((args) => awsCli(profile, args, process.env)),
  }),
);

const childEnvironment = { ...process.env };
const gitRevision = spawnSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
  env: childEnvironment,
});
if (gitRevision.status === 0) {
  childEnvironment.GIT_SHA = gitRevision.stdout.trim();
}
if (needsAws) {
  const { account: actualAccount } = guard(() =>
    verifyCallerAccount({
      run: (args) => awsCli(profile, args, childEnvironment),
      expected: expectedAccount,
      source: expectedAccountSource,
      action,
    }),
  );
  childEnvironment.CDK_DEFAULT_ACCOUNT = actualAccount;
  process.stdout.write(
    `Using ${environment}${ephemeral ? ` ephemeral ${ephemeral}` : ''} in AWS account ${actualAccount}\n`,
  );
}

const sharedBuild = spawnSync(
  'npm',
  ['run', 'build', '--workspace', '@mcc/cdk-config'],
  {
    stdio: 'inherit',
    env: childEnvironment,
  },
);
if (sharedBuild.status !== 0) process.exit(sharedBuild.status ?? 1);

const targetOptions = {
  application,
  environment,
  ephemeral,
  expectedAccount,
  profile,
};
const npmArguments = cdkArguments({ ...targetOptions, action, passthrough });

if (action === 'diff') {
  const { resolveDeployment } = await import('@mcc/cdk-config');
  const context = { environment, ephemeral, expectedAccount };
  const deployment = resolveDeployment(
    { tryGetContext: (key) => context[key] },
    application,
    childEnvironment,
  );
  const started = Date.now();
  const command = await runDiff(npmArguments, childEnvironment);
  let assembly = {};
  try {
    assembly = readPlanAssembly(
      assemblyDirectory(application, passthrough),
      deployment.stackName,
      started,
    );
  } catch (error) {
    process.stderr.write(
      `Plan resource summary unavailable: ${error.message}\n`,
    );
  }
  try {
    await new Promise((flushed) =>
      process.stdout.write(
        planReport({
          deployment,
          gitSha: childEnvironment.GIT_SHA,
          ...assembly,
          raw: command.raw,
          status: command.status,
        }),
        flushed,
      ),
    );
  } catch (error) {
    process.stderr.write(`Plan explanation unavailable: ${error.message}\n`);
  }
  process.exit(command.status);
}

const command = spawnSync('npm', npmArguments, {
  stdio: 'inherit',
  env: childEnvironment,
});
process.exit(command.status ?? 1);

// Runs one account check and exits on a refusal, after the AWS CLI's output.
function guard(check) {
  try {
    return check();
  } catch (error) {
    if (!(error instanceof AccountGuardError)) throw error;
    process.stderr.write(error.detail);
    fail(error.message);
  }
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
