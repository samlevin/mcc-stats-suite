import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';
import {
  APPLICATIONS as applications,
  LOCAL_CHANGE_SET_NAME,
  LOCAL_QUALIFIER,
  LOCAL_ROLE_PATH,
} from './cdk-targets.mjs';

// infrastructure/dev/local-cdk deploys this committed file as the CDKToolkitLocal stack.
export const LOCAL_TEMPLATE_FILE = fileURLToPath(
  new URL(
    '../infrastructure/dev/local-cdk/bootstrap-template.yaml',
    import.meta.url,
  ),
);
// CloudFormation's limit, in bytes, for an inline template body, which the root passes.
export const INLINE_TEMPLATE_BODY_LIMIT = 51_200;

const sub = (value) => ({ 'Fn::Sub': value });
const arn = (service, resource) =>
  sub(
    `arn:${'${AWS::Partition}'}:${service}:${'${AWS::Region}'}:${'${AWS::AccountId}'}:${resource}`,
  );
const roleArn = (resource) =>
  sub(
    `arn:${'${AWS::Partition}'}:iam::${'${AWS::AccountId}'}:role/${resource}`,
  );
const statement = (Sid, Action, Resource, extra = {}) => ({
  Sid,
  Effect: 'Allow',
  Action,
  Resource,
  ...extra,
});
const deny = (Sid, Action, Resource, extra = {}) => ({
  ...statement(Sid, Action, Resource, extra),
  Effect: 'Deny',
});
const document = (Statement) => ({ Version: '2012-10-17', Statement });
const managedPolicy = (ManagedPolicyName, Statement) => ({
  Type: 'AWS::IAM::ManagedPolicy',
  Properties: { ManagedPolicyName, PolicyDocument: document(Statement) },
});

// Logical IDs of the policies this transform adds. The stack policy in
// infrastructure/dev/local-cdk protects them from deletion, so a default
// re-bootstrap cannot silently restore administrator roles.
export const LOCAL_POLICY_RESOURCES = [
  'LocalWorkloadBoundary',
  'LocalExecutionBoundary',
  'LocalExecutionPolicy',
  'LocalExecutionComputePolicy',
  'LocalExecutionEventsPolicy',
];

export function localBootstrap(template) {
  const result = structuredClone(template);
  const resources = result.Resources;
  const trustedRoles = [
    'DeploymentActionRole',
    'FilePublishingRole',
    'ImagePublishingRole',
    'LookupRole',
  ];
  for (const name of [...trustedRoles, 'CloudFormationExecutionRole']) {
    if (!resources[name])
      throw new Error(
        `Missing bootstrap resource ${name}; review the CDK template upgrade`,
      );
  }
  result.Parameters.Qualifier.Default = LOCAL_QUALIFIER;
  // An operator cannot accidentally turn this template into the stable bootstrap.
  result.Parameters.Qualifier.AllowedValues = [LOCAL_QUALIFIER];
  // Only this account's principals may assume the local roles, even if an operator
  // passes --trust or --trust-for-lookup.
  for (const name of trustedRoles) {
    const trust = resources[name].Properties.AssumeRolePolicyDocument;
    trust.Statement = trust.Statement.filter((entry) => !entry['Fn::If']);
  }

  const stacks = applications.map((app) =>
    arn('cloudformation', `stack/${app}-e-*/*`),
  );
  const roles = applications.map((app) =>
    roleArn(`${LOCAL_ROLE_PATH.slice(1)}${app}-e-*`),
  );
  // Name-anchored per service, so neither unrelated names such as sysadmin-* nor
  // aliases, executions, or streams of other resources match.
  const functions = applications.map((app) =>
    arn('lambda', `function:${app}-e-*`),
  );
  const stateMachines = applications.map((app) =>
    arn('states', `stateMachine:${app}-e-*`),
  );
  const queues = applications.map((app) => arn('sqs', `${app}-e-*`));
  const computeResources = [
    ...functions,
    ...stateMachines,
    ...applications.map((app) => arn('states', `execution:${app}-e-*`)),
    ...queues,
    ...applications.map((app) => arn('logs', `log-group:/aws/*/${app}-e-*`)),
  ];
  const rules = applications.map((app) => arn('events', `rule/${app}-e-*`));
  const bootstrapVersion = arn(
    'ssm',
    `parameter/cdk-bootstrap/${LOCAL_QUALIFIER}/version`,
  );
  // Everything under /mcc/<environment>/ is application config; CI and other
  // parameters applications must not read live under other prefixes, such as
  // /mcc-ci/<environment>/. One prefix therefore covers every application.
  const applicationParameters = arn('ssm', 'parameter/mcc/dev/*');
  const deploymentParameters = [bootstrapVersion, applicationParameters];
  const OWN_TAG = '${aws:PrincipalTag/Ephemeral}';
  // ${!...} renders the literal IAM policy variable through Fn::Sub.
  const OWN = OWN_TAG.replace('${', '${!');
  const objects = (prefix) =>
    sub(`arn:${'${AWS::Partition}'}:s3:::*/${prefix}`);
  const viaS3 = {
    StringEquals: { 'kms:ViaService': sub('s3.${AWS::Region}.amazonaws.com') },
  };
  const localExecution = {
    'Fn::GetAtt': ['CloudFormationExecutionRole', 'Arn'],
  };
  const runtimeBoundary = { Ref: 'LocalWorkloadBoundary' };
  const withRuntimeBoundary = {
    Condition: {
      StringEquals: { 'iam:PermissionsBoundary': runtimeBoundary },
    },
  };

  resources.LocalWorkloadBoundary = managedPolicy(
    'mcc-stats-suite-local-workload-boundary',
    [
      statement(
        'WorkloadActions',
        [
          'kms:DescribeKey',
          'textract:AnalyzeDocument',
          'logs:CreateLogDelivery',
          'logs:GetLogDelivery',
          'logs:UpdateLogDelivery',
          'logs:DeleteLogDelivery',
          'logs:ListLogDeliveries',
          'logs:PutResourcePolicy',
          'logs:DescribeResourcePolicies',
          'logs:DescribeLogGroups',
          'xray:PutTraceSegments',
          'xray:PutTelemetryRecords',
          'xray:GetSamplingRules',
          'xray:GetSamplingTargets',
        ],
        '*',
      ),
      statement(
        'WriteEphemeralLogs',
        ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        applications.map((app) => arn('logs', `log-group:/aws/*/${app}-e-*`)),
      ),
      // Functions read single dev application parameters at runtime, such as
      // match-to-csv's sender allowlist and the submission address it checks.
      // The boundary allows any application's; each function's own policy
      // still names the exact parameters it reads.
      statement(
        'ReadApplicationParameters',
        'ssm:GetParameter',
        applicationParameters,
      ),
      // The app uses keys only for S3 server-side encryption.
      statement(
        'UseKeysThroughS3',
        [
          'kms:Decrypt',
          'kms:Encrypt',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
        ],
        '*',
        { Condition: viaS3 },
      ),
      // Each stack tags its roles Ephemeral=<name>, so a runtime reaches only its own
      // ephemeral/<name>/ and incoming/<name>/ objects. Shared dev evidence is outside both.
      statement(
        'WriteEphemeralObjects',
        's3:PutObject',
        objects(`ephemeral/${OWN}/*`),
      ),
      statement('ReadEphemeralObjects', 's3:GetObject*', [
        objects(`ephemeral/${OWN}/*`),
        objects(`incoming/${OWN}/*`),
      ]),
      statement('ListEphemeralObjects', 's3:ListBucket', '*', {
        Condition: { StringLike: { 's3:prefix': `ephemeral/${OWN_TAG}/*` } },
      }),
      // IAM's * also matches /, so the allows above would otherwise match these prefixes
      // anywhere in a key, such as submissions/ephemeral/<name>/ in shared evidence.
      deny('EphemeralPrefixesAtKeyRoot', 's3:*', [
        objects('*/ephemeral/*'),
        objects('*/incoming/*'),
      ]),
      // S3 ARNs carry no account, so the object allows would also match other accounts.
      deny('OnlyThisAccountsBuckets', 's3:*', '*', {
        Condition: {
          StringNotEquals: { 's3:ResourceAccount': '${aws:PrincipalAccount}' },
          Null: { 's3:ResourceAccount': 'false' },
        },
      }),
      deny('ProtectSharedInboundEmail', 's3:*', objects('incoming/dev/*')),
      statement(
        'UseEphemeralCompute',
        [
          'lambda:InvokeFunction',
          'states:StartExecution',
          'states:DescribeExecution',
          'states:StopExecution',
          'states:GetExecutionHistory',
          'sqs:SendMessage',
        ],
        computeResources,
      ),
      deny(
        'NoDeploymentOrIdentityAdministration',
        ['iam:*', 'sts:*', 'cloudformation:*', 'account:*', 'organizations:*'],
        '*',
      ),
      deny(
        'ProtectStableBootstrapAssets',
        ['s3:*', 'ecr:*'],
        [
          sub('arn:${AWS::Partition}:s3:::cdk-hnb659fds-*'),
          sub('arn:${AWS::Partition}:s3:::cdk-hnb659fds-*/*'),
          arn('ecr', 'repository/cdk-hnb659fds-*'),
        ],
      ),
    ],
  );

  // This repository makes no context lookups, so the lookup role reads only stack
  // metadata and the bootstrap version instead of inheriting ReadOnlyAccess.
  const lookup = resources.LookupRole.Properties;
  lookup.ManagedPolicyArns = [];
  lookup.Policies = [
    {
      PolicyName: 'LookupRolePolicy',
      PolicyDocument: document([
        statement(
          'ReadStacks',
          [
            'cloudformation:DescribeStacks',
            'cloudformation:GetTemplate',
            'cloudformation:ListStacks',
          ],
          '*',
        ),
        statement(
          'ReadBootstrapVersion',
          ['ssm:GetParameter', 'ssm:GetParameters'],
          bootstrapVersion,
        ),
      ]),
    },
  ];

  const deployment = resources.DeploymentActionRole.Properties;
  deployment.ManagedPolicyArns = [];
  deployment.Policies = [
    {
      PolicyName: 'ephemeral-stack-deployment',
      PolicyDocument: document([
        statement(
          'ReadStacks',
          [
            'cloudformation:Describe*',
            'cloudformation:Get*',
            'cloudformation:List*',
          ],
          '*',
        ),
        statement(
          'ChangeEphemeralStacks',
          [
            'cloudformation:TagResource',
            'cloudformation:UntagResource',
            // The CLI deletes a stack that failed creation without a role ARN. CloudFormation
            // then uses the stack's stored role, and passing any other role needs PassRole.
            'cloudformation:DeleteStack',
            'cloudformation:DeleteChangeSet',
            'cloudformation:UpdateTerminationProtection',
          ],
          stacks,
        ),
        statement(
          'UseLocalExecutionForStackChanges',
          [
            'cloudformation:CreateStack',
            'cloudformation:UpdateStack',
            'cloudformation:CreateChangeSet',
            'cloudformation:ContinueUpdateRollback',
            'cloudformation:RollbackStack',
          ],
          stacks,
          {
            Condition: {
              StringEquals: { 'cloudformation:RoleArn': localExecution },
            },
          },
        ),
        // ExecuteChangeSet has no RoleArn condition. Requiring the wrapper's change-set name
        // keeps change sets created under the administrator bootstrap unexecutable. The CLI
        // passes the change-set ARN in ChangeSetName, so accept the name in either form.
        statement(
          'ExecuteLocalChangeSets',
          'cloudformation:ExecuteChangeSet',
          stacks,
          {
            Condition: {
              StringLike: {
                'cloudformation:ChangeSetName': [
                  LOCAL_CHANGE_SET_NAME,
                  arn('cloudformation', `changeSet/${LOCAL_CHANGE_SET_NAME}/*`),
                ],
              },
            },
          },
        ),
        statement('PassLocalExecution', 'iam:PassRole', localExecution, {
          Condition: {
            StringEquals: {
              'iam:PassedToService': 'cloudformation.amazonaws.com',
            },
          },
        }),
        statement(
          'ReadLocalAssets',
          ['s3:GetObject', 's3:GetBucketLocation', 's3:ListBucket'],
          [
            { 'Fn::GetAtt': ['StagingBucket', 'Arn'] },
            sub('${StagingBucket.Arn}/*'),
          ],
        ),
        // CloudFormation resolves SSM-typed template parameters with the caller's credentials.
        statement(
          'ReadDeploymentParameters',
          ['ssm:GetParameter', 'ssm:GetParameters'],
          deploymentParameters,
        ),
      ]),
    },
  ];

  // Never inherit AdministratorAccess or user-supplied execution policy parameters. The
  // identity policies hold the scoped grants (split to fit the managed policy size limit);
  // the boundary caps the role at those services and denies deployment and identity
  // administration.
  const execution = resources.CloudFormationExecutionRole.Properties;
  execution.ManagedPolicyArns = [
    { Ref: 'LocalExecutionPolicy' },
    { Ref: 'LocalExecutionComputePolicy' },
    { Ref: 'LocalExecutionEventsPolicy' },
  ];
  execution.PermissionsBoundary = { Ref: 'LocalExecutionBoundary' };
  const computeServices = ['lambda', 'states', 'sqs', 'logs'];

  resources.LocalExecutionBoundary = managedPolicy(
    'mcc-stats-suite-local-cdk-execution-boundary',
    [
      statement(
        'ExecutionServices',
        [
          ...computeServices.map((service) => `${service}:*`),
          'events:*',
          'ses:*ReceiptRule*',
          's3:GetObject',
          's3:GetBucketLocation',
          'kms:Decrypt',
          'kms:DescribeKey',
          'ssm:GetParameter',
          'ssm:GetParameters',
          'iam:*Role*',
          'iam:GetPolicy',
          'iam:GetPolicyVersion',
        ],
        '*',
      ),
      deny(
        'NoDeploymentOrIdentityAdministration',
        [
          'cloudformation:*',
          'sts:*',
          'account:*',
          'organizations:*',
          'iam:DeleteRolePermissionsBoundary',
          'iam:CreateServiceLinkedRole',
        ],
        '*',
      ),
    ],
  );

  resources.LocalExecutionComputePolicy = managedPolicy(
    'mcc-stats-suite-local-cdk-execution-compute',
    [
      statement(
        'ManageEphemeralCompute',
        computeServices.map((service) => `${service}:*`),
        computeResources,
      ),
      // The AWS::Logs::LogGroup handler lists groups, which IAM checks against no group ARN.
      statement('DescribeLogGroups', 'logs:DescribeLogGroups', '*'),
    ],
  );

  resources.LocalExecutionEventsPolicy = managedPolicy(
    'mcc-stats-suite-local-cdk-execution-events',
    [
      statement(
        'ManageEphemeralRules',
        [
          'events:DescribeRule',
          'events:DeleteRule',
          'events:EnableRule',
          'events:DisableRule',
          'events:ListTargetsByRule',
          'events:RemoveTargets',
          'events:TagResource',
          'events:UntagResource',
          'events:ListTagsForResource',
        ],
        rules,
      ),
      // Rules may match only S3 events, so a local template cannot subscribe to the shared
      // workflows' Step Functions events.
      statement('PutEphemeralRules', 'events:PutRule', rules, {
        Condition: {
          'ForAllValues:StringEquals': { 'events:source': 'aws.s3' },
          Null: { 'events:source': 'false' },
        },
      }),
      // Rules may deliver only to ephemeral compute.
      statement('PutEphemeralTargets', 'events:PutTargets', rules, {
        Condition: {
          'ForAllValues:ArnLike': {
            'events:TargetArn': [...functions, ...stateMachines, ...queues],
          },
          Null: { 'events:TargetArn': 'false' },
        },
      }),
    ],
  );

  resources.LocalExecutionPolicy = managedPolicy(
    'mcc-stats-suite-local-cdk-execution',
    [
      statement(
        'ManageEphemeralReceiptRules',
        [
          'ses:CreateReceiptRule',
          'ses:UpdateReceiptRule',
          'ses:DeleteReceiptRule',
          'ses:DescribeReceiptRule',
          'ses:DescribeReceiptRuleSet',
        ],
        '*',
      ),
      statement(
        'ReadLambdaAssets',
        ['s3:GetObject', 's3:GetBucketLocation'],
        [
          { 'Fn::GetAtt': ['StagingBucket', 'Arn'] },
          sub('${StagingBucket.Arn}/*'),
        ],
      ),
      // Lambda reads the code object with the caller's credentials; the staging bucket uses SSE-KMS.
      statement('DecryptLambdaAssets', 'kms:Decrypt', '*', {
        Condition: viaS3,
      }),
      statement(
        'ReadConfiguration',
        ['kms:DescribeKey', 'iam:GetPolicy', 'iam:GetPolicyVersion'],
        '*',
      ),
      statement(
        'ReadDeploymentParameters',
        ['ssm:GetParameter', 'ssm:GetParameters'],
        deploymentParameters,
      ),
      // Roles under the local path exist only through CreateRole with the runtime boundary.
      statement(
        'CreateBoundedRoles',
        ['iam:CreateRole', 'iam:PutRolePermissionsBoundary'],
        roles,
        withRuntimeBoundary,
      ),
      statement(
        'ChangeBoundedRolePolicies',
        [
          'iam:PutRolePolicy',
          'iam:DeleteRolePolicy',
          'iam:AttachRolePolicy',
          'iam:DetachRolePolicy',
        ],
        roles,
        withRuntimeBoundary,
      ),
      statement(
        'ManageEphemeralRoles',
        [
          'iam:GetRole',
          'iam:DeleteRole',
          'iam:UpdateAssumeRolePolicy',
          'iam:ListInstanceProfilesForRole',
          'iam:GetRolePolicy',
          'iam:ListRolePolicies',
          'iam:ListAttachedRolePolicies',
          'iam:TagRole',
          'iam:UntagRole',
          'iam:ListRoleTags',
          'iam:UpdateRole',
          'iam:UpdateRoleDescription',
        ],
        roles,
      ),
      statement('PassRuntimeRoles', 'iam:PassRole', roles, {
        Condition: {
          StringEquals: {
            'iam:PassedToService': [
              'lambda.amazonaws.com',
              'states.amazonaws.com',
              'events.amazonaws.com',
            ],
          },
        },
      }),
    ],
  );
  return result;
}

// The bootstrap template of the aws-cdk version that package-lock.json pins. The CLI
// renders it offline; telemetry and notices stay off.
export function pinnedBootstrapTemplate() {
  const cdk = fileURLToPath(
    new URL('../node_modules/aws-cdk/bin/cdk', import.meta.url),
  );
  return parse(
    execFileSync(
      process.execPath,
      [cdk, 'bootstrap', '--show-template', '--no-notices'],
      {
        encoding: 'utf8',
        env: { ...process.env, CDK_DISABLE_CLI_TELEMETRY: '1' },
      },
    ),
  );
}

export function renderLocalBootstrap(upstream = pinnedBootstrapTemplate()) {
  return stringify(localBootstrap(upstream));
}

// `npm run cdk:local-template` rewrites the committed template.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  writeFileSync(LOCAL_TEMPLATE_FILE, renderLocalBootstrap());
}
