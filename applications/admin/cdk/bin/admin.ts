#!/usr/bin/env node
import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { resolveDeployment } from '@mcc/cdk-config';
import { AdminStack } from '../lib/admin-stack';

const app = new App();
const deployment = resolveDeployment(app.node, 'admin');
new AdminStack(app, deployment.stackName, {
  deployment,
  env: { account: deployment.account, region: deployment.region },
  terminationProtection: deployment.environment === 'prod',
});
