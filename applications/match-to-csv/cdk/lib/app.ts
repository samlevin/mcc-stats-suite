import { App, DefaultStackSynthesizer, type AppProps } from 'aws-cdk-lib';
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
    synthesizer: new DefaultStackSynthesizer({
      qualifier: deployment.bootstrapQualifier,
    }),
    // GIT_SHA is the checked-out commit (scripts/cdk-app.mjs). GITHUB_SHA is
    // the commit that triggered the run, which differs for workflow_run and
    // for workflow_dispatch deploys of an older release.
    gitSha:
      environmentVariables.GIT_SHA ||
      environmentVariables.GITHUB_SHA ||
      'local',
    env: {
      account: deployment.account,
      region: deployment.region,
    },
    terminationProtection: deployment.terminationProtection,
  });
}
