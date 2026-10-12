#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  APPLICATIONS,
  cdkArguments,
  ephemeralNameError,
  localDeployArguments,
} from './cdk-targets.mjs';
import {
  findUnsafeRemovals,
  parseTemplateBody,
  rolledBackMessage,
  stableDeployOptionsError,
  stackArtifact,
  stackStatusAction,
} from './stack-migration-guard.mjs';

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
const profileEnvironment = environmentFromProfile(profile);
const environment = options.environment ?? profileEnvironment ?? 'dev';
const ephemeral = options.ephemeral;

if (environment !== 'dev' && environment !== 'prod') {
  fail('--environment must be dev or prod');
}
if (
  options.environment &&
  profileEnvironment &&
  options.environment !== profileEnvironment
) {
  fail(
    `AWS_PROFILE=${profile} looks like ${profileEnvironment}, not ${options.environment}`,
  );
}
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

// Stable deploys reuse the guard's assembly, so options that change synthesis
// cannot apply; reject them before any AWS call or build.
if (!ephemeral && action === 'deploy') {
  const optionsError = stableDeployOptionsError(passthrough);
  if (optionsError) fail(optionsError);
}

// Reject options the local bootstrap cannot run before any AWS call or build.
if (ephemeral && action === 'deploy') {
  try {
    localDeployArguments(passthrough);
  } catch (error) {
    fail(error.message);
  }
}

const accountVariable =
  environment === 'dev' ? 'MCC_DEV_ACCOUNT_ID' : 'MCC_PROD_ACCOUNT_ID';
const emailDomain = process.env.MCC_EMAIL_DOMAIN;
if (application === 'match-to-csv' && action === 'deploy' && !emailDomain) {
  fail('Export MCC_EMAIL_DOMAIN before deploying match-to-csv');
}
let expectedAccount = process.env[accountVariable];
let expectedAccountSource = accountVariable;
const needsAws = action !== 'synth';

if (needsAws && !profile && process.env.GITHUB_ACTIONS !== 'true') {
  fail('Export AWS_PROFILE or pass --profile before using AWS');
}
if (needsAws && !expectedAccount && profile) {
  expectedAccount = profileSsoAccount();
  expectedAccountSource = `AWS_PROFILE=${profile} sso_account_id`;
}
if (needsAws && !expectedAccount) {
  fail(
    `AWS profile ${profile ?? '(ambient credentials)'} has no sso_account_id; ` +
      `configure it or export ${accountVariable}`,
  );
}
if (expectedAccount && !/^[0-9]{12}$/.test(expectedAccount)) {
  fail(`${accountVariable} must contain a 12-digit AWS account ID`);
}

const childEnvironment = { ...process.env };
const gitRevision = spawnSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
  env: childEnvironment,
});
if (gitRevision.status === 0) {
  childEnvironment.GIT_SHA = gitRevision.stdout.trim();
}
if (needsAws) {
  const identityArguments = [
    'sts',
    'get-caller-identity',
    '--query',
    'Account',
    '--output',
    'text',
  ];
  const identity = awsCli(identityArguments, childEnvironment);
  if (identity.status !== 0) {
    process.stderr.write(identity.stderr ?? '');
    fail('Unable to resolve the active AWS account');
  }
  const actualAccount = identity.stdout.trim();
  if (actualAccount !== expectedAccount) {
    fail(
      `Refusing ${action}: active account ${actualAccount} does not match ${expectedAccountSource} (${expectedAccount})`,
    );
  }
  childEnvironment.CDK_DEFAULT_ACCOUNT = actualAccount;
  process.stdout.write(
    `Using ${environment}${ephemeral ? ` ephemeral ${ephemeral}` : ''} in AWS account ${actualAccount}\n`,
  );
}

const sharedBuild = spawnSync(
  'npm',
  ['run', 'build', '--workspace', '@samlevin/cdk-config'],
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
  emailDomain,
};
const npmArguments = cdkArguments({ ...targetOptions, action, passthrough });
if (action === 'deploy' && !ephemeral) {
  refuseUnsafeRemovals();
  // Deploy the assembly the guard just synthesized instead of bundling again.
  npmArguments.push('--app', 'cdk.out');
}

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

function environmentFromProfile(profile) {
  if (!profile) return undefined;
  const normalized = profile.toLowerCase();
  if (/(^|[-_])prod(uction)?($|[-_])/.test(normalized)) return 'prod';
  if (/(^|[-_])dev(elopment)?($|[-_])/.test(normalized)) return 'dev';
  return undefined;
}

// CloudFormation deletes a removed resource using the DeletionPolicy of the
// template that is already deployed. A release that drops a stateful resource
// is only safe after a release that retains it has reached the stack.
// The deploy always uses the assembly synthesized here, even when there is no
// deployed template to compare against.
function refuseUnsafeRemovals() {
  const { stackName, template: nextTemplate } = synthesizedStack();
  const liveTemplate = deployedTemplate(stackName);
  if (!liveTemplate) return;
  const problems = findUnsafeRemovals(liveTemplate, nextTemplate);
  if (problems.length === 0) return;
  fail(
    [
      `Refusing deploy: ${stackName} would lose resources that its deployed template does not retain.`,
      ...problems.map((problem) => `  - ${problem}`),
      'Retain each resource, or drop its delete call, in a release that keeps its logical ID and properties. Deploy that release, then remove or replace the resource in the next one.',
    ].join('\n'),
  );
}

function guardFail(message) {
  fail(`Stack removal guard: ${message}`);
}

function deployedTemplate(stackName) {
  const status = awsCli([
    'cloudformation',
    'describe-stacks',
    '--stack-name',
    stackName,
    '--query',
    'Stacks[0].StackStatus',
    '--output',
    'text',
  ]);
  if (status.status !== 0) {
    if (/does not exist/.test(status.stderr ?? '')) return undefined;
    process.stderr.write(status.stderr ?? '');
    guardFail(`unable to describe ${stackName}`);
  }
  const stackStatus = status.stdout.trim();
  const statusAction = stackStatusAction(stackStatus);
  if (statusAction === 'skip') return undefined;
  if (statusAction === 'rolled-back') refuseRolledBack(stackName);
  if (statusAction === 'refuse') {
    guardFail(
      stackStatus.endsWith('_FAILED')
        ? `${stackName} is ${stackStatus}; recover it in CloudFormation, then redeploy`
        : `${stackName} is ${stackStatus}; wait for it to settle, then redeploy`,
    );
  }
  const template = awsCli([
    'cloudformation',
    'get-template',
    '--stack-name',
    stackName,
    '--output',
    'json',
  ]);
  if (template.status !== 0) {
    process.stderr.write(template.stderr ?? '');
    guardFail(`unable to read the deployed template of ${stackName}`);
  }
  try {
    return parseTemplateBody(JSON.parse(template.stdout).TemplateBody);
  } catch (error) {
    guardFail(`${stackName}: ${error.message}; refusing deploy`);
  }
}

// A stable first create that rolled back can keep resources with
// DeletionPolicy Retain, and its termination protection blocks the delete
// cdk deploy would do before creating it again. Recovery needs an operator, so
// name what survived and stop.
function refuseRolledBack(stackName) {
  const resources = awsCli([
    'cloudformation',
    'describe-stack-resources',
    '--stack-name',
    stackName,
    '--output',
    'json',
  ]);
  let stackResources;
  if (resources.status === 0) {
    try {
      stackResources = JSON.parse(resources.stdout).StackResources;
    } catch {
      stackResources = undefined;
    }
  } else {
    process.stderr.write(resources.stderr ?? '');
  }
  guardFail(rolledBackMessage(stackName, stackResources, profile));
}

// Synthesizes the stack the deploy targets and reads its name and template
// from the cloud assembly, so the guard never rebuilds the stack name.
function synthesizedStack() {
  const synth = spawnSync(
    'npm',
    [
      ...cdkArguments({ ...targetOptions, action: 'synth', passthrough: [] }),
      '--quiet',
    ],
    { stdio: 'inherit', env: childEnvironment },
  );
  if (synth.status !== 0) process.exit(synth.status ?? 1);
  const assembly = fileURLToPath(
    new URL(`../applications/${application}/cdk.out/`, import.meta.url),
  );
  try {
    const { stackName, templateFile } = stackArtifact(
      JSON.parse(readFileSync(`${assembly}manifest.json`, 'utf8')),
    );
    return {
      stackName,
      template: JSON.parse(readFileSync(`${assembly}${templateFile}`, 'utf8')),
    };
  } catch (error) {
    guardFail(
      `unable to read the cloud assembly in ${assembly}: ${error.message}`,
    );
  }
}

// Every AWS CLI call goes through here so the profile is applied one way.
function awsCli(commandArguments, environmentVariables = childEnvironment) {
  const profileArguments = profile ? ['--profile', profile] : [];
  return spawnSync('aws', [...commandArguments, ...profileArguments], {
    encoding: 'utf8',
    env: environmentVariables,
  });
}

function profileSsoAccount() {
  const configured = awsCli(
    ['configure', 'get', 'sso_account_id'],
    process.env,
  );
  return configured.status === 0 ? configured.stdout.trim() : undefined;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
