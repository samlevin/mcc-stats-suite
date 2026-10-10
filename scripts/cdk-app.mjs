#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findUnsafeRemovals } from './stack-migration-guard.mjs';

const applications = new Set([
  'admin',
  'data-pipeline',
  'match-to-csv',
  'ocr-quality',
  'player',
]);
const actions = new Set(['synth', 'diff', 'deploy', 'destroy']);

const [action, application, ...rawArguments] = process.argv.slice(2);
if (!actions.has(action) || !applications.has(application)) {
  fail(
    'Usage: npm run app:<synth|diff|deploy|destroy> -- <application> ' +
      '[--environment <dev|prod>] [--ephemeral <name>] [--profile <profile>]',
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
  expectedAccount = profileSsoAccount(profile);
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
  if (profile) identityArguments.push('--profile', profile);
  const identity = spawnSync('aws', identityArguments, {
    encoding: 'utf8',
    env: childEnvironment,
  });
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

const contextArguments = ['-c', `environment=${environment}`];
if (ephemeral) contextArguments.push('-c', `ephemeral=${ephemeral}`);
if (expectedAccount) {
  contextArguments.push('-c', `expectedAccount=${expectedAccount}`);
}
const profileArguments = profile ? ['--profile', profile] : [];

const cdkArguments = [
  'run',
  `cdk:${action}`,
  '--workspace',
  `@samlevin/${application}`,
  '--',
  ...contextArguments,
  ...profileArguments,
];
if (action === 'deploy' && !ephemeral) {
  refuseUnsafeRemovals(`${application}-${environment}`);
  // Deploy the assembly the guard just synthesized instead of bundling again.
  cdkArguments.push('--app', 'cdk.out');
}
if (
  application === 'match-to-csv' &&
  (action === 'deploy' || action === 'diff') &&
  emailDomain
) {
  cdkArguments.push('--parameters', `EmailDomain=${emailDomain}`);
}
cdkArguments.push(...passthrough);

const command = spawnSync('npm', cdkArguments, {
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
function refuseUnsafeRemovals(stackName) {
  const liveTemplate = deployedTemplate(stackName);
  if (!liveTemplate) return;
  const problems = findUnsafeRemovals(
    liveTemplate,
    synthesizedTemplate(stackName),
  );
  if (problems.length === 0) return;
  fail(
    [
      `Refusing deploy: ${stackName} would lose resources that its deployed template does not retain.`,
      ...problems.map((problem) => `  - ${problem}`),
      'Retain each resource, or drop its delete call, in a release that keeps its logical ID. Deploy that release, then remove the resource in the next one.',
    ].join('\n'),
  );
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
    fail(`Unable to describe ${stackName}`);
  }
  // A rolled-back first create or a review-only stack owns no resources, and
  // cdk deploy replaces it, so its template protects nothing.
  if (
    ['ROLLBACK_COMPLETE', 'REVIEW_IN_PROGRESS'].includes(status.stdout.trim())
  ) {
    return undefined;
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
    fail(`Unable to read the deployed template of ${stackName}`);
  }
  const body = JSON.parse(template.stdout).TemplateBody;
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    fail(`The deployed template of ${stackName} is not JSON; refusing deploy`);
  }
}

function synthesizedTemplate(stackName) {
  const synth = spawnSync(
    'npm',
    [
      'run',
      'cdk:synth',
      '--workspace',
      `@samlevin/${application}`,
      '--',
      ...contextArguments,
      ...profileArguments,
      '--quiet',
    ],
    { stdio: 'inherit', env: childEnvironment },
  );
  if (synth.status !== 0) process.exit(synth.status ?? 1);
  return JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          `../applications/${application}/cdk.out/${stackName}.template.json`,
          import.meta.url,
        ),
      ),
      'utf8',
    ),
  );
}

function awsCli(commandArguments) {
  return spawnSync('aws', [...commandArguments, ...profileArguments], {
    encoding: 'utf8',
    env: childEnvironment,
  });
}

function profileSsoAccount(profile) {
  const configured = spawnSync(
    'aws',
    ['configure', 'get', 'sso_account_id', '--profile', profile],
    { encoding: 'utf8', env: process.env },
  );
  return configured.status === 0 ? configured.stdout.trim() : undefined;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
