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
const policyArn = (name) =>
  sub(`arn:${'${AWS::Partition}'}:iam::${'${AWS::AccountId}'}:policy/${name}`);
const statement = (Sid, Action, Resource, extra = {}) => ({
  Sid,
  Effect: 'Allow',
  Action,
  Resource,
  ...extra,
});
const document = (Statement) => ({ Version: '2012-10-17', Statement });

// The dev foundation owns the execution role's policies and boundary
// (infrastructure/modules/foundation/local-cdk-policies.tf), so the policies
// change through a foundation pull request instead of a bootstrap upgrade.
export const LOCAL_EXECUTION_POLICIES = [
  'mcc-stats-suite-local-cdk-execution',
  'mcc-stats-suite-local-cdk-execution-compute',
  'mcc-stats-suite-local-cdk-execution-events',
];
export const LOCAL_EXECUTION_BOUNDARY =
  'mcc-stats-suite-local-cdk-execution-boundary';

// A resource the upstream template lacks. The operator's stack policy protects it from
// deletion, so a default re-bootstrap, which would remove it, cannot silently restore
// administrator roles.
export const LOCAL_GUARD_RESOURCE = 'LocalBootstrapGuard';

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
  const bootstrapVersion = arn(
    'ssm',
    `parameter/cdk-bootstrap/${LOCAL_QUALIFIER}/version`,
  );
  // Everything under /mcc/<environment>/ is application config; CI and other
  // parameters applications must not read live under other prefixes, such as
  // /mcc-ci/<environment>/. One prefix therefore covers every application.
  const applicationParameters = arn('ssm', 'parameter/mcc/dev/*');
  const deploymentParameters = [bootstrapVersion, applicationParameters];
  const localExecution = {
    'Fn::GetAtt': ['CloudFormationExecutionRole', 'Arn'],
  };

  // Creates nothing. See LOCAL_GUARD_RESOURCE.
  resources[LOCAL_GUARD_RESOURCE] = {
    Type: 'AWS::CloudFormation::WaitConditionHandle',
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
  // administration. The dev foundation must exist before this template is deployed.
  const execution = resources.CloudFormationExecutionRole.Properties;
  execution.ManagedPolicyArns = LOCAL_EXECUTION_POLICIES.map(policyArn);
  execution.PermissionsBoundary = policyArn(LOCAL_EXECUTION_BOUNDARY);

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
