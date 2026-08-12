export type DeploymentEnvironment = 'dev' | 'prod';

export interface ContextSource {
  tryGetContext(key: string): unknown;
}

export interface DeploymentConfig {
  application: string;
  environment: DeploymentEnvironment;
  ephemeral?: string;
  account?: string;
  region?: string;
  stackName: string;
  resourcePrefix: string;
  objectPrefix: string;
  workloadBoundaryName: string;
  isEphemeral: boolean;
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

  const requestedEphemeral = contextValue(context, 'ephemeral');
  let ephemeral: string | undefined;
  if (requestedEphemeral) {
    if (environment !== 'dev') {
      throw new Error('Production does not support ephemeral deployments');
    }
    if (!INSTANCE_PATTERN.test(requestedEphemeral)) {
      throw new Error(
        'Development ephemeral deployments require -c ephemeral=<name> using 1-20 lowercase letters, numbers, or hyphens',
      );
    }
    ephemeral = requestedEphemeral;
  }

  const expectedAccount =
    contextValue(context, 'expectedAccount') ??
    environmentVariables[
      environment === 'dev' ? 'MCC_DEV_ACCOUNT_ID' : 'MCC_PROD_ACCOUNT_ID'
    ];
  const actualAccount = environmentVariables.CDK_DEFAULT_ACCOUNT;

  validateAccount('expected account', expectedAccount);
  validateAccount('CDK_DEFAULT_ACCOUNT', actualAccount);
  if (expectedAccount && actualAccount && expectedAccount !== actualAccount) {
    throw new Error(
      `Refusing ${environment} synthesis: active account ${actualAccount} does not match expected account ${expectedAccount}`,
    );
  }

  const qualifier = ephemeral ?? environment;
  const stackName = `${application}-${qualifier}`;
  const isEphemeral = ephemeral !== undefined;

  return {
    application,
    environment,
    ephemeral,
    account: expectedAccount ?? actualAccount,
    region:
      environmentVariables.CDK_DEFAULT_REGION ??
      environmentVariables.AWS_REGION ??
      environmentVariables.AWS_DEFAULT_REGION,
    stackName,
    resourcePrefix: stackName,
    objectPrefix: isEphemeral ? `ephemeral/${ephemeral}` : '',
    workloadBoundaryName: 'mcc-stats-suite-workload-boundary',
    isEphemeral,
    ingressEnabled: !isEphemeral,
  };
}

function contextValue(context: ContextSource, key: string): string | undefined {
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
