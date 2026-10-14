import { Template } from 'aws-cdk-lib/assertions';
import { BUNDLING_STACKS } from 'aws-cdk-lib/cx-api';
import { createMatchToCsvApp } from '../../cdk/lib/app';
import type { MatchToCsvStack } from '../../cdk/lib/match-to-csv-stack';

/**
 * Builds the stack as the entry point does, without bundling Lambda code.
 * Test processes skip CDK's built-in CloudFormation schema validation;
 * ci:synth validates the real bundled template. Keep construct validation and
 * template assertions here without repeatedly starting the WASM schema engine.
 */
export function buildStack(
  context: Record<string, string>,
  environmentVariables: NodeJS.ProcessEnv = {},
): MatchToCsvStack {
  return createMatchToCsvApp(
    { context: { [BUNDLING_STACKS]: [], ...context } },
    environmentVariables,
  );
}

export function synthesize(
  context: Record<string, string>,
  environmentVariables: NodeJS.ProcessEnv = {},
): Template {
  return Template.fromStack(buildStack(context, environmentVariables));
}
