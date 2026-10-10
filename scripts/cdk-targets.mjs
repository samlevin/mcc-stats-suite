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

// Returns the arguments an ephemeral deploy adds, or throws for options the local
// bootstrap cannot run. Rather than parse every spelling yargs accepts, reject any
// hotswap, watch, role, change-set-name, or method option except a single direct method.
export function localDeployArguments(passthrough) {
  if (passthrough.some((argument) => /^--(hotswap|watch)/i.test(argument))) {
    throw new Error(
      'Ephemeral deploys cannot hotswap or watch; the local bootstrap updates resources only through CloudFormation',
    );
  }
  if (
    passthrough.some(
      (argument) => /^--role-?arn/i.test(argument) || /^-r/.test(argument),
    )
  ) {
    throw new Error(
      'Ephemeral deploys always use the local CloudFormation execution role; remove the role ARN option',
    );
  }
  if (passthrough.some((argument) => /^--change-?set-?name/i.test(argument))) {
    throw new Error(
      `Ephemeral deploys use the ${LOCAL_CHANGE_SET_NAME} change set; remove the change-set name option`,
    );
  }
  const methods = passthrough.flatMap((argument, index) =>
    /^(-m|--method)/i.test(argument) ? [index] : [],
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
