#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.resolve(scriptDirectory, '..', 'cdk.out');
const manifestPath = path.join(outputDirectory, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  fail(`Missing CDK manifest: ${manifestPath}`);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const stackArtifacts = Object.values(manifest.artifacts ?? {}).filter(
  (artifact) => artifact.type === 'aws:cloudformation:stack',
);
if (stackArtifacts.length === 0) fail('CDK manifest contains no stack');

for (const stack of stackArtifacts) {
  const templatePath = path.join(outputDirectory, stack.properties.templateFile);
  const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  verifyTemplate(stack.displayName, template);
  for (const logicalPrefix of ['ProcessEmail', 'ExtractText']) {
    const resource = Object.entries(template.Resources ?? {}).find(
      ([logicalId, value]) =>
        logicalId.startsWith(logicalPrefix) &&
        value.Type === 'AWS::Lambda::Function',
    );
    if (!resource) fail(`${stack.displayName} is missing ${logicalPrefix}`);
    const s3Key = resource[1].Properties?.Code?.S3Key;
    if (typeof s3Key !== 'string' || !s3Key.endsWith('.zip')) {
      fail(`${stack.displayName}/${logicalPrefix} has no file asset`);
    }
    const assetHash = s3Key.slice(0, -4);
    const assetDirectory = path.join(outputDirectory, `asset.${assetHash}`);
    const sharpDirectory = path.join(assetDirectory, 'node_modules', 'sharp');
    if (!fs.existsSync(sharpDirectory)) {
      fail(`${stack.displayName}/${logicalPrefix} does not contain Sharp`);
    }
    if (!containsLinuxArm64Binary(sharpDirectory)) {
      fail(
        `${stack.displayName}/${logicalPrefix} does not contain a Linux ARM64 Sharp binary`,
      );
    }
  }
}

process.stdout.write(
  `Verified native Sharp bundles for ${stackArtifacts.length} stack(s).\n`,
);

function containsLinuxArm64Binary(directory) {
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      if (
        entry.isFile() &&
        entry.name.endsWith('.node') &&
        candidate.includes('linux-arm64')
      ) {
        return true;
      }
    }
  }
  return false;
}

function verifyTemplate(stackName, template) {
  const processEmail = lambdaResource(template, 'ProcessEmail');
  const extractText = lambdaResource(template, 'ExtractText');
  const materializer = lambdaResource(template, 'MaterializeTrainingData');
  assertEqual(
    `${stackName}/ProcessEmail architecture`,
    processEmail.Properties.Architectures?.[0],
    'arm64',
  );
  assertEqual(
    `${stackName}/ExtractText architecture`,
    extractText.Properties.Architectures?.[0],
    'arm64',
  );
  assertPresent(
    `${stackName}/ProcessEmail evidence bucket environment`,
    processEmail.Properties.Environment?.Variables?.EVIDENCE_BUCKET,
  );
  assertPresent(
    `${stackName}/ExtractText Git commit environment`,
    extractText.Properties.Environment?.Variables?.GIT_SHA,
  );
  assertPresent(
    `${stackName}/ExtractText deployment environment`,
    extractText.Properties.Environment?.Variables?.DEPLOYMENT_ENVIRONMENT,
  );
  assertEqual(
    `${stackName}/MaterializeTrainingData timeout`,
    materializer.Properties.Timeout,
    600,
  );
  assertPresent(
    `${stackName}/TrainingDataMaterializerFunctionName output`,
    template.Outputs?.TrainingDataMaterializerFunctionName,
  );

  const definitionText = JSON.stringify(
    Object.values(template.Resources ?? {})
      .filter((resource) => resource.Type === 'AWS::StepFunctions::StateMachine')
      .map((resource) => resource.Properties?.DefinitionString),
  );
  for (const retryName of [
    'Lambda.ClientExecutionTimeoutException',
    'Textract.InternalServerError',
    'Textract.ProvisionedThroughputExceededException',
    'Textract.ThrottlingException',
  ]) {
    if (!definitionText.includes(retryName)) {
      fail(`${stackName} does not retry ${retryName}`);
    }
  }

  const policyText = JSON.stringify(
    Object.values(template.Resources ?? {})
      .filter((resource) => resource.Type === 'AWS::IAM::Policy')
      .map((resource) => resource.Properties?.PolicyDocument),
  );
  if (policyText.includes('s3:DeleteObject')) {
    fail(`${stackName} grants deletion of evidence objects`);
  }
}

function lambdaResource(template, logicalPrefix) {
  const resource = Object.entries(template.Resources ?? {}).find(
    ([logicalId, value]) =>
      logicalId.startsWith(logicalPrefix) &&
      value.Type === 'AWS::Lambda::Function',
  );
  if (!resource) fail(`Stack is missing ${logicalPrefix}`);
  return resource[1];
}

function assertPresent(label, value) {
  if (value == null || value === '') fail(`${label} is missing`);
}

function assertEqual(label, actual, expected) {
  if (actual !== expected) {
    fail(`${label} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
