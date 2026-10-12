// Shared by the CDK wrapper and the local bootstrap template. Keep this module free of
// dependencies: every deployment, including GitHub Actions, loads it.
export const APPLICATIONS = [
  'admin',
  'data-pipeline',
  'match-to-csv',
  'ocr-quality',
  'player',
];
export const LOCAL_QUALIFIER = 'mcclocal1';
export const LOCAL_TOOLKIT_STACK_NAME = 'CDKToolkitLocal';
// The local deployment role executes only change sets with this name.
export const LOCAL_CHANGE_SET_NAME = `${LOCAL_QUALIFIER}-deploy`;
// Ephemeral stacks create every IAM role under this path. A role's path cannot change, so
// the local bootstrap's role permissions never reach roles that existed before it.
export const LOCAL_ROLE_PATH = '/mcc-local/';

// Returns the arguments an ephemeral deploy adds, or throws for options the local
// bootstrap cannot run. Rather than parse every spelling yargs accepts, reject any
// hotswap, watch, role, toolkit, change-set-name, or method option except a single
// `--method=direct` or `--method direct`, and any short option that groups -r or -m.
export function localDeployArguments(passthrough) {
  if (passthrough.some((argument) => /^--(hotswap|watch)/i.test(argument))) {
    throw new Error(
      'Ephemeral deploys cannot hotswap or watch; the local bootstrap updates resources only through CloudFormation',
    );
  }
  if (passthrough.some((argument) => /^--role-?arn/i.test(argument))) {
    throw new Error(
      'Ephemeral deploys always use the local CloudFormation execution role; remove the role ARN option',
    );
  }
  if (
    passthrough.some((argument) => /^--toolkit-?stack-?name/i.test(argument))
  ) {
    throw new Error(
      `Ephemeral deploys always use the ${LOCAL_TOOLKIT_STACK_NAME} toolkit stack; remove the toolkit stack option`,
    );
  }
  if (passthrough.some((argument) => /^--change-?set-?name/i.test(argument))) {
    throw new Error(
      `Ephemeral deploys use the ${LOCAL_CHANGE_SET_NAME} change set; remove the change-set name option`,
    );
  }
  if (passthrough.some((argument) => /^-[^-]*[rm]/.test(argument))) {
    throw new Error(
      'Ephemeral deploys do not accept the short -r or -m options; use --method=direct for a direct deployment',
    );
  }
  const methods = passthrough.flatMap((argument, index) =>
    /^--method/i.test(argument) ? [index] : [],
  );
  if (methods.length === 0) return ['--change-set-name', LOCAL_CHANGE_SET_NAME];
  const [index] = methods;
  const direct =
    methods.length === 1 &&
    (passthrough[index] === '--method=direct' ||
      (passthrough[index] === '--method' &&
        passthrough[index + 1] === 'direct'));
  if (!direct) {
    throw new Error(
      'Ephemeral deploys accept only --method=direct; omit the option to deploy with a change set',
    );
  }
  return [];
}

// Builds the `npm run cdk:<action>` arguments for the wrapper. Local bootstrap options are
// added only to ephemeral deploys; shared dev and prod deploys keep the default bootstrap.
export function cdkArguments({
  action,
  application,
  environment,
  ephemeral,
  expectedAccount,
  profile,
  passthrough,
}) {
  const result = [
    'run',
    `cdk:${action}`,
    '--workspace',
    `@samlevin/${application}`,
    '--',
    '-c',
    `environment=${environment}`,
  ];
  if (ephemeral) result.push('-c', `ephemeral=${ephemeral}`);
  if (expectedAccount) result.push('-c', `expectedAccount=${expectedAccount}`);
  if (profile) result.push('--profile', profile);
  if (ephemeral && action === 'deploy') {
    result.push(
      '--toolkit-stack-name',
      LOCAL_TOOLKIT_STACK_NAME,
      ...localDeployArguments(passthrough),
    );
  }
  result.push(...passthrough);
  return result;
}

const EPHEMERAL_NAME = /^[a-z0-9][a-z0-9-]{0,19}$/;

// Mirrors resolveDeployment in packages/cdk-config so the wrapper fails before any AWS
// call or build; a test keeps the two in step. Returns an error message or undefined.
export function ephemeralNameError(name) {
  if (!EPHEMERAL_NAME.test(name)) {
    return 'Ephemeral names must be 1-20 lowercase letters, numbers, or hyphens, starting with a letter or number';
  }
  if (name === 'ephemeral' || name === 'incoming') {
    return 'Ephemeral names cannot be "ephemeral" or "incoming"; those are object key prefixes';
  }
  if (name === 'dev') {
    return 'Ephemeral name "dev" is reserved for shared inbound email';
  }
  return undefined;
}
