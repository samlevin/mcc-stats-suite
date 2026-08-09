export type DeploymentEnvironment = 'dev' | 'prod';

export interface ContextSource {
  tryGetContext(key: string): unknown;
}

export interface DeploymentConfig {
  application: string;
  environment: DeploymentEnvironment;
  instance?: string;
  account?: string;
  region?: string;
  stackName: string;
  resourcePrefix: string;
  objectPrefix: string;
  workloadBoundaryName: string;
  isShared: boolean;
  ingressEnabled: boolean;
}

const INSTANCE_PATTERN = /^[a-z0-9][a-z0-9-]{0,19}$/;
const ACCOUNT_PATTERN = /^[0-9]{12}$/;
const APPLICATION_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}$/;

export function resolveDeployment(
  context: ContextSource,
  application: string,
  environmentVariables: NodeJS.ProcessEnv = process.env,
): DeploymentConfig {
  if (!APPLICATION_PATTERN.test(application)) {
    throw new Error(`Invalid application name: ${application}`);
  }

  const environment = contextValue(context, 'environment');
  if (environment !== 'dev' && environment !== 'prod') {
    throw new Error('Pass -c environment=dev or -c environment=prod');
  }

  const requestedInstance = contextValue(context, 'instance');
  let instance: string | undefined;
  if (environment === 'dev') {
    if (!requestedInstance || !INSTANCE_PATTERN.test(requestedInstance)) {
      throw new Error(
        'Development requires -c instance=<name> using 1-20 lowercase letters, numbers, or hyphens',
      );
    }
    instance = requestedInstance;
  } else if (requestedInstance) {
    throw new Error('Production does not support developer instances');
  }

  const expectedAccount =
    contextValue(context, 'expectedAccount') ??
    environmentVariables[
      environment === 'dev' ? 'MCC_DEV_ACCOUNT_ID' : 'MCC_PROD_ACCOUNT_ID'
    ];
  const actualAccount = environmentVariables.CDK_DEFAULT_ACCOUNT;

  validateAccount('expected account', expectedAccount);
  validateAccount('CDK_DEFAULT_ACCOUNT', actualAccount);
  if (
    expectedAccount &&
    actualAccount &&
    expectedAccount !== actualAccount
  ) {
    throw new Error(
      `Refusing ${environment} synthesis: active account ${actualAccount} does not match expected account ${expectedAccount}`,
    );
  }

  const qualifier =
    environment === 'prod'
      ? 'prod'
      : instance === 'shared'
        ? 'dev'
        : instance;
  const stackName = `${application}-${qualifier}`;
  const isShared = environment === 'prod' || instance === 'shared';

  return {
    application,
    environment,
    instance,
    account: expectedAccount ?? actualAccount,
    region:
      environmentVariables.CDK_DEFAULT_REGION ??
      environmentVariables.AWS_REGION ??
      environmentVariables.AWS_DEFAULT_REGION,
    stackName,
    resourcePrefix: stackName,
    objectPrefix: isShared ? '' : `instances/${instance}`,
    workloadBoundaryName: 'mcc-stats-suite-workload-boundary',
    isShared,
    ingressEnabled: isShared,
  };
}

function contextValue(
  context: ContextSource,
  key: string,
): string | undefined {
  const value = context.tryGetContext(key);
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new Error(`CDK context ${key} must be a string`);
  }
  return value;
}

function validateAccount(label: string, account: string | undefined): void {
  if (account && !ACCOUNT_PATTERN.test(account)) {
    throw new Error(`${label} must be a 12-digit AWS account ID`);
  }
}
