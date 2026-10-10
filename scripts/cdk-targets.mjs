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

// Returns the arguments an ephemeral deploy adds, or throws for a change-set name the
// local bootstrap cannot execute. `--method=direct` deploys without a change set.
export function localDeployArguments(passthrough) {
  if (
    passthrough.some((argument) => /^--change-set-name(=|$)/.test(argument))
  ) {
    throw new Error(
      `Ephemeral deploys use the ${LOCAL_CHANGE_SET_NAME} change set; remove --change-set-name`,
    );
  }
  const index = passthrough.findIndex((argument) =>
    /^--method(=|$)/.test(argument),
  );
  const method =
    index === -1
      ? undefined
      : passthrough[index].includes('=')
        ? passthrough[index].split('=')[1]
        : passthrough[index + 1];
  return method === 'direct'
    ? []
    : ['--change-set-name', LOCAL_CHANGE_SET_NAME];
}
