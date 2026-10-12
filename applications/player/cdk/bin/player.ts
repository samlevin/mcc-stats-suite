#!/usr/bin/env node
import 'source-map-support/register';
import { App, DefaultStackSynthesizer } from 'aws-cdk-lib';
import { resolveDeployment } from '@samlevin/cdk-config';
import { PlayerStack } from '../lib/player-stack';

const app = new App();
const deployment = resolveDeployment(app.node, 'player');
new PlayerStack(app, deployment.stackName, {
  deployment,
  synthesizer: new DefaultStackSynthesizer({
    qualifier: deployment.bootstrapQualifier,
  }),
  env: { account: deployment.account, region: deployment.region },
  terminationProtection: deployment.environment === 'prod',
});
