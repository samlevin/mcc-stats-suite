import { App, type AppProps } from 'aws-cdk-lib';
import { resolveDeployment } from '@samlevin/cdk-config';
import { MatchToCsvStack } from './match-to-csv-stack';

/**
 * Builds the stack exactly as the deploy entry point does, so tests
 * synthesize the same stack that ships. Everything read from the environment
 * goes through `environmentVariables`.
 */
export function createMatchToCsvApp(
  props: AppProps = {},
  environmentVariables: NodeJS.ProcessEnv = process.env,
): MatchToCsvStack {
  const app = new App(props);
  const deployment = resolveDeployment(
    app.node,
    'match-to-csv',
    environmentVariables,
  );
  return new MatchToCsvStack(app, deployment.stackName, {
    deployment,
    gitSha:
      environmentVariables.GITHUB_SHA ??
      environmentVariables.GIT_SHA ??
      'local',
    env: {
      account: deployment.account,
      region: deployment.region,
    },
    // Stable stacks deploy only from main through GitHub Actions and are
    // never torn down; ephemeral stacks are destroyed from a developer shell.
    terminationProtection: !deployment.isEphemeral,
  });
}
