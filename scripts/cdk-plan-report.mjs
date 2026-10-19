import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

const NAME_PROPERTIES = {
  'AWS::Lambda::Function': 'FunctionName',
  'AWS::IAM::Role': 'RoleName',
  'AWS::IAM::Policy': 'PolicyName',
  'AWS::Events::Rule': 'Name',
  'AWS::StepFunctions::StateMachine': 'StateMachineName',
  'AWS::SQS::Queue': 'QueueName',
  'AWS::SNS::Topic': 'TopicName',
  'AWS::Logs::LogGroup': 'LogGroupName',
  'AWS::CloudWatch::Alarm': 'AlarmName',
  'AWS::S3::Bucket': 'BucketName',
};

// Forward both raw streams without changing CDK arguments or its exit status.
export async function runDiff(
  args,
  env,
  stdout = process.stdout,
  stderr = process.stderr,
) {
  return new Promise((done) => {
    const child = spawn('npm', args, {
      env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    const output = [];
    for (const [stream, destination] of [
      [child.stdout, stdout],
      [child.stderr, stderr],
    ]) {
      stream.on('data', (data) => {
        destination.write(data);
        output.push(data);
      });
    }
    child.on('error', (error) => stderr.write(`${error.message}\n`));
    child.on('close', async (status) => {
      await Promise.all(
        [stdout, stderr].map(
          (destination) =>
            new Promise((flushed) => destination.write('', flushed)),
        ),
      );
      done({ status: status ?? 1, raw: Buffer.concat(output).toString() });
    });
  });
}

export function assemblyDirectory(application, passthrough) {
  let output = 'cdk.out';
  for (
    let index = 0;
    index < passthrough.length && passthrough[index] !== '--';
    index++
  ) {
    const arg = passthrough[index];
    if (arg === '--output' || arg === '-o') output = passthrough[++index];
    else if (arg.startsWith('--output='))
      output = arg.slice('--output='.length);
    else if (arg.startsWith('-o=')) output = arg.slice(3);
  }
  return resolve('applications', application, output);
}

export function readPlanAssembly(directory, stackName, started) {
  const manifestPath = resolve(directory, 'manifest.json');
  if (statSync(manifestPath).mtimeMs < started)
    throw new Error('CDK did not write a fresh cloud assembly');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const entry = Object.entries(manifest.artifacts ?? {}).find(
    ([id, artifact]) =>
      artifact.type === 'aws:cloudformation:stack' &&
      (artifact.properties.stackName ?? id) === stackName,
  );
  if (!entry) throw new Error(`No synthesized stack named ${stackName}`);
  const [, stack] = entry;
  return {
    template: JSON.parse(
      readFileSync(resolve(directory, stack.properties.templateFile), 'utf8'),
    ),
    awsEnvironment: stack.environment,
  };
}

export function diffChanges(raw, stackName) {
  const changes = [];
  let selected = true;
  for (const line of stripVTControlCharacters(raw).split(/\r?\n/)) {
    const stack = /^Stack (.+)$/.exec(line.trim());
    if (stack) selected = stack[1] === stackName;
    if (!selected) continue;
    const resource = /^\s*\[([+~-])\] (\S+::\S+) (.+?)\s*$/.exec(line);
    if (resource) {
      const [, symbol, type, label] = resource;
      const impact = / (replace|may be replaced|destroy|orphan|import)$/.exec(
        label,
      )?.[1];
      const parts = (
        impact ? label.slice(0, -(impact.length + 1)) : label
      ).split(' ');
      const logicalId = parts.pop();
      changes.push({
        type,
        path: parts.join(' ') || 'path unavailable',
        logicalId,
        action: { '+': 'Add', '~': 'Update', '-': 'Delete' }[symbol],
        impact,
        fields: [],
      });
    } else {
      const field = /^ [└├]─ \[[+~-]\] (.+)$/.exec(line);
      if (field && changes.length) changes.at(-1).fields.push(field[1]);
    }
  }
  return changes;
}

function physicalName(resource) {
  const nameProperty = NAME_PROPERTIES[resource.Type];
  const name =
    resource.Type === 'AWS::SES::ReceiptRule'
      ? resource.Properties?.Rule?.Name
      : resource.Properties?.[nameProperty];
  if (name === undefined)
    return nameProperty
      ? 'generated name; unavailable before deployment'
      : 'name unavailable (no supported name property)';
  const origin =
    resource.Metadata?.['mcc:nameOrigin'] ??
    'configured in template (origin unknown)';
  return typeof name === 'string'
    ? `${origin}: ${name}`
    : `${origin}: unresolved until deployment ${JSON.stringify(name)}`;
}

export function planReport({
  deployment,
  gitSha,
  template,
  awsEnvironment,
  raw,
  status,
}) {
  const [account, region] = (
    awsEnvironment?.replace(/^aws:\/\//, '') ?? ''
  ).split('/');
  const known = (value) =>
    value && !value.startsWith('unknown-') ? value : 'unavailable';
  const lines = [
    '\nCDK plan explanation',
    `Application: ${deployment.application} | Stack: ${deployment.stackName}`,
    `Account: ${known(account || deployment.account)} | Region: ${known(region || deployment.region)}`,
    `Environment: ${deployment.environment} | Ephemeral: ${deployment.ephemeral ?? '(none)'} | Evidence namespace: ${deployment.objectPrefix || '(environment default)'}`,
    `Source commit: ${gitSha || 'unavailable'} | CDK exit status: ${status}`,
  ];
  if (template?.Description) lines.push(template.Description);
  const resources = template?.Resources ?? {};
  const groups = new Map();
  for (const [id, resource] of Object.entries(resources)) {
    const component = resource.Metadata?.['mcc:component'];
    const group = component?.group ?? 'Other resources';
    if (!groups.has(group)) groups.set(group, []);
    groups
      .get(group)
      .push(
        `  ${id} | ${resource.Type}\n    Path: ${resource.Metadata?.['aws:cdk:path'] ?? 'unavailable'}\n    Purpose: ${component?.purpose ?? resource.Properties?.Description ?? resource.Properties?.AlarmDescription ?? 'unavailable'}\n    Name: ${physicalName(resource)}`,
      );
  }
  for (const [group, entries] of groups) lines.push(`\n${group}`, ...entries);
  lines.push('\nShared foundation references (not created by this stack)');
  for (const [id, parameter] of Object.entries(template?.Parameters ?? {})) {
    if (
      parameter.Type?.startsWith('AWS::SSM::Parameter::Value') &&
      parameter.Default?.startsWith('/mcc/')
    ) {
      lines.push(
        `  ${id}: ${parameter.Default} (value resolves at deployment)`,
      );
    }
  }
  if (deployment.workloadBoundaryName)
    lines.push(`  IAM workload boundary: ${deployment.workloadBoundaryName}`);
  const runtimeParameters = new Set(
    Object.values(resources).flatMap((resource) =>
      Object.entries(resource.Properties?.Environment?.Variables ?? {})
        .filter(
          ([key, value]) =>
            key.endsWith('_PARAMETER') && typeof value === 'string',
        )
        .map(([, value]) => value),
    ),
  );
  for (const name of runtimeParameters)
    lines.push(`  Runtime SSM reference: ${name}`);
  lines.push('\nChanges reported by CDK');
  const changes = diffChanges(raw, deployment.stackName);
  for (const change of changes) {
    const resource = resources[change.logicalId];
    const purpose =
      resource?.Metadata?.['mcc:component']?.purpose ??
      'purpose unavailable in proposed template';
    const replacement =
      change.action !== 'Update'
        ? ''
        : change.impact === 'replace'
          ? '; replacement required by CDK'
          : change.impact === 'may be replaced'
            ? '; replacement possible, not confirmed'
            : '; replacement status not established by this report';
    lines.push(
      `  ${change.action} ${change.logicalId} | ${change.type} | ${change.path}: ${purpose}${replacement}${change.impact && change.impact !== 'replace' && change.impact !== 'may be replaced' ? `; CDK impact: ${change.impact}` : ''}`,
    );
    if (change.fields.length)
      lines.push(`    Changed fields: ${change.fields.join(', ')}`);
    if (
      change.type.startsWith('AWS::IAM::') ||
      /Policy|Permission/.test(change.type)
    )
      lines.push(
        '    IAM or access-control resource change. Inspect the raw policy, trust, principal, action, resource, and condition changes above.',
      );
  }
  const text = stripVTControlCharacters(raw);
  if (
    /IAM (Statement|Policy|Identity Center) Changes|Security Group Changes/.test(
      text,
    )
  )
    lines.push(
      '  CDK reports permission changes. The raw tables above show additions (+) and removals (-); this report does not infer whether access is broader.',
    );
  if (!changes.length)
    lines.push(
      /There were no differences|no differences/.test(text)
        ? '  CDK reports no differences.'
        : '  No resource change lines recognized; consult the raw diff (options or errors may limit it).',
    );
  lines.push(
    '  Resources omitted from change lines have no reported resource change; this is not proof of no changes when output is filtered or incomplete.',
    'Raw CDK output is above, unchanged. Replacement decisions may depend on a CloudFormation change set. See docs/cdk-plan-output.md.',
  );
  return `${lines.join('\n')}\n`;
}
