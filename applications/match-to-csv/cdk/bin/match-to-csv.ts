#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { resolveDeployment } from '@mcc/cdk-config';
import { MatchToCsvStack } from '../lib/match-to-csv-stack';

const app = new cdk.App();
const deployment = resolveDeployment(app.node, 'match-to-csv');
new MatchToCsvStack(app, deployment.stackName, {
  deployment,
  env: {
    account: deployment.account,
    region: deployment.region,
  },
  terminationProtection: deployment.environment === 'prod',
});
