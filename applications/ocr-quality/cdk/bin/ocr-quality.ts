#!/usr/bin/env node
import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { resolveDeployment } from '@mcc/cdk-config';
import { OcrQualityStack } from '../lib/ocr-quality-stack';

const app = new App();
const deployment = resolveDeployment(app.node, 'ocr-quality');
new OcrQualityStack(app, deployment.stackName, {
  deployment,
  env: {
    account: deployment.account,
    region: deployment.region,
  },
  terminationProtection: deployment.environment === 'prod',
});
