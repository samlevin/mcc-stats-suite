import { App, type AppProps } from 'aws-cdk-lib';
import { resolveDeployment } from '@samlevin/cdk-config';
import { MatchToCsvStack } from './match-to-csv-stack';

export interface MatchToCsvApp {
  app: App;
  stack: MatchToCsvStack;
}

/**
 * Builds the CDK app exactly as the deploy entry point does, so tests
 * synthesize the same stack that ships.
 */
export function createMatchToCsvApp(
  props: AppProps = {},
  environmentVariables: NodeJS.ProcessEnv = process.env,
): MatchToCsvApp {
  const app = new App(props);
  const deployment = resolveDeployment(
    app.node,
    'match-to-csv',
    environmentVariables,
  );
  const stack = new MatchToCsvStack(app, deployment.stackName, {
    deployment,
    env: {
      account: deployment.account,
      region: deployment.region,
    },
    terminationProtection: deployment.environment === 'prod',
  });
  return { app, stack };
}
