import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  APPLICATIONS as applications,
  LOCAL_CHANGE_SET_NAME,
  LOCAL_QUALIFIER,
} from './cdk-targets.mjs';

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
  result.Parameters.Qualifier.Default = LOCAL_QUALIFIER;
  // An operator cannot accidentally turn this template into the stable bootstrap.
  result.Parameters.Qualifier.AllowedValues = [LOCAL_QUALIFIER];
  const stacks = applications.map((app) =>
    arn('cloudformation', `stack/${app}-*/*`),
  );
  const sharedStacks = applications.map((app) =>
    arn('cloudformation', `stack/${app}-dev*/*`),
  );
  const roles = applications.map((app) => roleArn(`${app}-*`));
  const sharedRoles = applications.map((app) => roleArn(`${app}-dev*`));
  // Anchor allows on a delimiter so unrelated names such as sysadmin-* never match.
  const workloadResources = applications.flatMap((app) => [
    arn('*', `*:${app}-*`),
    arn('sqs', `${app}-*`),
    arn('events', `rule/${app}-*`),
    arn('logs', `log-group:/aws/*/${app}-*`),
  ]);
  // Unanchored denies stay short and only over-match shared names.
  const stableResources = applications.map((app) => arn('*', `*${app}-dev*`));
  const objects = (prefix) =>
    sub(`arn:${'${AWS::Partition}'}:s3:::*/${prefix}`);
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
            'kms:Decrypt',
            'kms:Encrypt',
            'kms:ReEncrypt*',
            'kms:GenerateDataKey*',
            'kms:DescribeKey',
            'textract:AnalyzeDocument',
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
            'xray:PutTraceSegments',
            'xray:PutTelemetryRecords',
            'xray:GetSamplingRules',
            'xray:GetSamplingTargets',
          ],
          '*',
        ),
        // Shared dev evidence lives outside ephemeral/, so local runtimes cannot overwrite it.
        statement(
          'WriteEphemeralObjects',
          's3:PutObject',
          objects('ephemeral/*'),
        ),
        statement('ReadEphemeralObjects', 's3:GetObject*', [
          objects('ephemeral/*'),
          objects('incoming/*'),
        ]),
        // Listing cannot be scoped per developer under incoming/, and the app never lists.
        statement('ListEphemeralObjects', 's3:ListBucket', '*', {
          Condition: { StringLike: { 's3:prefix': 'ephemeral/*' } },
        }),
        {
          Sid: 'ProtectSharedInboundEmail',
          Effect: 'Deny',
          Action: 's3:*',
          Resource: objects('incoming/dev*'),
        },
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
          workloadResources,
        ),
        {
          Sid: 'ProtectSharedCompute',
          Effect: 'Deny',
          Action: ['lambda:*', 'states:*', 'sqs:*', 'events:*'],
          Resource: stableResources,
        },
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
          arn('ssm', `parameter/cdk-bootstrap/${LOCAL_QUALIFIER}/version`),
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
        // keeps change sets created under the administrator bootstrap unexecutable.
        statement(
          'ExecuteLocalChangeSets',
          'cloudformation:ExecuteChangeSet',
          stacks,
          {
            Condition: {
              StringEquals: {
                'cloudformation:ChangeSetName': LOCAL_CHANGE_SET_NAME,
              },
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
          ['ssm:GetParameter', 'ssm:GetParameters'],
          arn('ssm', `parameter/cdk-bootstrap/${LOCAL_QUALIFIER}/version`),
        ),
      ]),
    },
  ];
  // Never inherit AdministratorAccess or user-supplied execution policy parameters.
  const execution = resources.CloudFormationExecutionRole.Properties;
  execution.PermissionsBoundary = { Ref: 'LocalExecutionPolicy' };
  execution.ManagedPolicyArns = [{ Ref: 'LocalExecutionPolicy' }];
  const services = ['lambda', 'events', 'states', 'sqs', 'logs'];
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
        // Lambda reads the code object with the caller's credentials; the staging bucket uses SSE-KMS.
        statement('DecryptLambdaAssets', 'kms:Decrypt', '*', {
          Condition: {
            StringEquals: {
              'kms:ViaService': sub('s3.${AWS::Region}.amazonaws.com'),
            },
          },
        }),
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
  const { parse, stringify } = await import('yaml');
  process.stdout.write(
    stringify(localBootstrap(parse(readFileSync(0, 'utf8')))),
  );
}
