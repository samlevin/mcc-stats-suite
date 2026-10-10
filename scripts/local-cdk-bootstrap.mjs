import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';

const applications = [
  'admin',
  'data-pipeline',
  'match-to-csv',
  'ocr-quality',
  'player',
];
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
const document = (Statement) => ({ Version: '2012-10-17', Statement });

export function localBootstrap(template) {
  const result = structuredClone(template);
  const resources = result.Resources;
  for (const name of [
    'DeploymentActionRole',
    'CloudFormationExecutionRole',
    'FilePublishingRole',
    'ImagePublishingRole',
    'LookupRole',
  ]) {
    if (!resources[name])
      throw new Error(
        `Missing bootstrap resource ${name}; review the CDK template upgrade`,
      );
  }
  result.Parameters.Qualifier.Default = 'mcclocal1';
  // An operator cannot accidentally turn this template into the stable bootstrap.
  result.Parameters.Qualifier.AllowedValues = ['mcclocal1'];
  const stacks = applications.map((app) =>
    arn('cloudformation', `stack/${app}-*/*`),
  );
  const sharedStacks = applications.map((app) =>
    arn('cloudformation', `stack/${app}-dev/*`),
  );
  const roles = applications.map((app) => roleArn(`${app}-*`));
  const sharedRoles = applications.map((app) => roleArn(`${app}-dev*`));
  const localExecution = {
    'Fn::GetAtt': ['CloudFormationExecutionRole', 'Arn'],
  };
  const runtimeBoundary = { Ref: 'LocalWorkloadBoundary' };

  resources.LocalWorkloadBoundary = {
    Type: 'AWS::IAM::ManagedPolicy',
    Properties: {
      ManagedPolicyName: 'mcc-stats-suite-local-workload-boundary',
      PolicyDocument: document([
        statement(
          'WorkloadActions',
          [
            's3:GetObject*',
            's3:PutObject',
            's3:ListBucket',
            'kms:Decrypt',
            'kms:Encrypt',
            'kms:ReEncrypt*',
            'kms:GenerateDataKey*',
            'kms:DescribeKey',
            'textract:AnalyzeDocument',
            'lambda:InvokeFunction',
            'states:StartExecution',
            'states:DescribeExecution',
            'states:StopExecution',
            'logs:CreateLogGroup',
            'logs:CreateLogStream',
            'logs:PutLogEvents',
            'logs:CreateLogDelivery',
            'logs:GetLogDelivery',
            'logs:UpdateLogDelivery',
            'logs:DeleteLogDelivery',
            'logs:ListLogDeliveries',
            'logs:PutResourcePolicy',
            'logs:DescribeResourcePolicies',
            'logs:DescribeLogGroups',
            'sqs:SendMessage',
            'xray:PutTraceSegments',
            'xray:PutTelemetryRecords',
            'states:GetExecutionHistory',
          ],
          '*',
        ),
        {
          Sid: 'NoDeploymentOrIdentityAdministration',
          Effect: 'Deny',
          Action: [
            'iam:*',
            'sts:*',
            'cloudformation:*',
            'account:*',
            'organizations:*',
          ],
          Resource: '*',
        },
        {
          Sid: 'ProtectStableBootstrapAssets',
          Effect: 'Deny',
          Action: ['s3:*', 'ecr:*'],
          Resource: [
            sub('arn:${AWS::Partition}:s3:::cdk-hnb659fds-*'),
            sub('arn:${AWS::Partition}:s3:::cdk-hnb659fds-*/*'),
            arn('ecr', 'repository/cdk-hnb659fds-*'),
          ],
        },
      ]),
    },
  };
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
            'cloudformation:ExecuteChangeSet',
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
            'cloudformation:DeleteStack',
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
        {
          Sid: 'ProtectSharedStacks',
          Effect: 'Deny',
          Action: 'cloudformation:*',
          Resource: sharedStacks,
        },
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
        statement(
          'ReadBootstrapVersion',
          'ssm:GetParameter',
          arn('ssm', 'parameter/cdk-bootstrap/mcclocal1/version'),
        ),
      ]),
    },
  ];
  // Never inherit AdministratorAccess or user-supplied execution policy parameters.
  const execution = resources.CloudFormationExecutionRole.Properties;
  execution.ManagedPolicyArns = [];
  execution.PermissionsBoundary = { Ref: 'LocalExecutionPolicy' };
  execution.ManagedPolicyArns = [{ Ref: 'LocalExecutionPolicy' }];
  const services = ['lambda', 'events', 'states', 'sqs', 'logs'];
  const workloadResources = applications.map((app) => arn('*', `*${app}-*`));
  const stableResources = applications.map((app) => arn('*', `*${app}-dev*`));
  resources.LocalExecutionPolicy = {
    Type: 'AWS::IAM::ManagedPolicy',
    Properties: {
      ManagedPolicyName: 'mcc-stats-suite-local-cdk-execution',
      PolicyDocument: document([
        statement(
          'ManageEphemeralCompute',
          services.map((service) => `${service}:*`),
          workloadResources,
        ),
        {
          Sid: 'ProtectStableCompute',
          Effect: 'Deny',
          Action: services.map((service) => `${service}:*`),
          Resource: stableResources,
        },
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
        statement(
          'ReadConfiguration',
          [
            'ssm:GetParameter',
            'ssm:GetParameters',
            'kms:DescribeKey',
            'iam:GetPolicy',
            'iam:GetPolicyVersion',
          ],
          '*',
        ),
        statement(
          'CreateBoundedRoles',
          ['iam:CreateRole', 'iam:PutRolePermissionsBoundary'],
          roles,
          {
            Condition: {
              StringEquals: { 'iam:PermissionsBoundary': runtimeBoundary },
            },
          },
        ),
        statement(
          'ManageEphemeralRoles',
          [
            'iam:GetRole',
            'iam:DeleteRole',
            'iam:UpdateAssumeRolePolicy',
            'iam:PutRolePolicy',
            'iam:DeleteRolePolicy',
            'iam:AttachRolePolicy',
            'iam:DetachRolePolicy',
            'iam:ListInstanceProfilesForRole',
            'iam:GetRolePolicy',
            'iam:ListRolePolicies',
            'iam:ListAttachedRolePolicies',
            'iam:TagRole',
            'iam:UntagRole',
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
        {
          Sid: 'ProtectStableRoles',
          Effect: 'Deny',
          Action: 'iam:*',
          Resource: sharedRoles,
        },
      ]),
    },
  };
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.stdout.write(
    stringify(localBootstrap(parse(readFileSync(0, 'utf8')))),
  );
}
