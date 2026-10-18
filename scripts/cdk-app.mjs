#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
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

const [action, application, ...rawArguments] = process.argv.slice(2);
if (!actions.has(action) || !applications.has(application)) {
  fail(
    'Usage: npm run app:<synth|diff|deploy> -- <application> ' +
      '[--environment <dev|prod>] [--ephemeral <name>] [--profile <profile>]\n' +
      '       npm run app:destroy -- <application> --environment dev ' +
      '--ephemeral <name> [--profile <profile>]',
  );
}

const { options, passthrough } = parseArguments(rawArguments);
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

const command = spawnSync('npm', npmArguments, {
  stdio: 'inherit',
  env: childEnvironment,
});
process.exit(command.status ?? 1);

function parseArguments(args) {
  const options = {};
  const passthrough = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (
      argument === '--environment' ||
      argument === '--ephemeral' ||
      argument === '--profile'
    ) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        fail(`${argument} requires a value`);
      }
      options[argument.slice(2)] = value;
      index += 1;
    } else if (argument === '-c' || argument === '--context') {
      fail('Use --environment and --ephemeral instead of passing CDK context');
    } else {
      passthrough.push(argument);
    }
  }
  return { options, passthrough };
}

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
