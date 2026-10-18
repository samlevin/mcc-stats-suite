import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Match } from 'aws-cdk-lib/assertions';
import { buildStack, synthesize } from './support/app';

test('stable stacks have termination protection', () => {
  assert.equal(buildStack({ environment: 'dev' }).terminationProtection, true);
  assert.equal(buildStack({ environment: 'prod' }).terminationProtection, true);
});

test('ephemeral stacks have no termination protection', () => {
  const stack = buildStack({ environment: 'dev', ephemeral: 'test' });
  assert.equal(stack.terminationProtection, false);
});

test('the git SHA prefers the checked-out commit', () => {
  const cases: [NodeJS.ProcessEnv, string][] = [
    [{ GIT_SHA: 'checked-out', GITHUB_SHA: 'trigger' }, 'checked-out'],
    [{ GITHUB_SHA: 'trigger' }, 'trigger'],
    [{}, 'local'],
  ];
  for (const [environmentVariables, expected] of cases) {
    synthesize(
      { environment: 'dev' },
      environmentVariables,
    ).hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ GIT_SHA: expected }) },
    });
  }
});

test('process email reads only its environment sender allowlist parameter', () => {
  for (const [environment, ephemeral] of [
    ['dev', undefined],
    ['prod', undefined],
    ['dev', 'test'],
  ] as const) {
    const template = synthesize({
      environment,
      ...(ephemeral ? { ephemeral } : {}),
    });
    const parameterName = `/mcc/${environment}/match-to-csv/sender-allowlist`;
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: Match.stringLikeRegexp('-ProcessEmail$'),
      Environment: {
        Variables: Match.objectLike({
          SENDER_ALLOWLIST_PARAMETER: parameterName,
        }),
      },
    });
    const statements = Object.values(
      template.findResources('AWS::IAM::Policy'),
    ).flatMap(
      (policy) =>
        policy.Properties.PolicyDocument.Statement as Array<{
          Action: string | string[];
          Resource: unknown;
        }>,
    );
    const ssmStatements = statements.filter((statement) =>
      [statement.Action].flat().some((action) => action.startsWith('ssm:')),
    );
    assert.equal(ssmStatements.length, 1, `${environment} ${ephemeral ?? ''}`);
    assert.equal(ssmStatements[0].Action, 'ssm:GetParameter');
    assert.ok(
      JSON.stringify(ssmStatements[0].Resource).includes(
        `:parameter${parameterName}"`,
      ),
    );
  }
});

test('process email may send only from noreply at its environment email domain', () => {
  for (const [environment, ephemeral] of [
    ['dev', undefined],
    ['prod', undefined],
    ['dev', 'test'],
  ] as const) {
    const label = `${environment} ${ephemeral ?? 'stable'}`;
    const template = synthesize({
      environment,
      ...(ephemeral ? { ephemeral } : {}),
    });
    const json = template.toJSON() as {
      Parameters: Record<string, { Type: string; Default?: string }>;
    };
    const [fn] = Object.values(
      template.findResources('AWS::Lambda::Function', {
        Properties: { FunctionName: Match.stringLikeRegexp('-ProcessEmail$') },
      }),
    );
    // The domain resolves from the foundation's parameter at deploy time, so
    // the template holds only the parameter name.
    const domain = fn.Properties.Environment.Variables.REPLY_FROM_DOMAIN as {
      Ref: string;
    };
    assert.deepEqual(json.Parameters[domain.Ref], {
      Type: 'AWS::SSM::Parameter::Value<String>',
      Default: `/mcc/${environment}/match-to-csv/email-domain`,
    });

    const statements = Object.values(
      template.findResources('AWS::IAM::Policy'),
    ).flatMap((policy) =>
      (
        policy.Properties.PolicyDocument.Statement as Array<{
          Action: string | string[];
          Resource: unknown;
          Condition?: unknown;
        }>
      ).map((statement) => ({
        ...statement,
        roles: JSON.stringify(policy.Properties.Roles),
      })),
    );
    const sesStatements = statements.filter((statement) =>
      [statement.Action].flat().some((action) => action.startsWith('ses:')),
    );
    assert.equal(sesStatements.length, 1, label);
    assert.equal(sesStatements[0].Action, 'ses:SendEmail', label);
    assert.ok(sesStatements[0].roles.includes('ProcessEmail'), label);
    // In the SES sandbox, SES also authorizes the send against the
    // recipient's identity, so the grant names every identity in the stack's
    // account and Region and limits the From address instead.
    assert.deepEqual(
      sesStatements[0].Resource,
      {
        'Fn::Join': [
          '',
          [
            'arn:',
            { Ref: 'AWS::Partition' },
            ':ses:',
            { Ref: 'AWS::Region' },
            ':',
            { Ref: 'AWS::AccountId' },
            ':identity/*',
          ],
        ],
      },
      label,
    );
    assert.deepEqual(
      sesStatements[0].Condition,
      {
        StringEquals: {
          'ses:FromAddress': {
            'Fn::Join': ['', ['noreply@', { Ref: domain.Ref }]],
          },
        },
      },
      label,
    );
  }
});

for (const [environment, ephemeral, retention] of [
  ['dev', undefined, 14],
  ['prod', undefined, 90],
  ['dev', 'test', 14],
] as const) {
  test(`${environment} ${ephemeral ?? 'stable'} log groups have bounded retention and the correct lifecycle`, () => {
    const template = synthesize({
      environment,
      ...(ephemeral ? { ephemeral } : {}),
    });
    const resources = template.toJSON().Resources as Record<
      string,
      {
        Type: string;
        DeletionPolicy?: string;
        UpdateReplacePolicy?: string;
        Properties: { LogGroupName?: string };
      }
    >;
    const logGroups = template.findResources('AWS::Logs::LogGroup');
    assert.equal(Object.keys(logGroups).length, 6);
    for (const group of Object.values(logGroups)) {
      assert.equal(group.Properties.RetentionInDays, retention);
      assert.equal(
        group.DeletionPolicy,
        ephemeral ? 'Delete' : 'RetainExceptOnCreate',
      );
      assert.equal(group.UpdateReplacePolicy, ephemeral ? 'Delete' : 'Retain');
    }
    const functions = template.findResources('AWS::Lambda::Function');
    assert.equal(Object.keys(functions).length, 5);
    const prefix = `match-to-csv-${ephemeral ? `e-${ephemeral}` : environment}-`;
    const functionNames = new Set<string>();
    for (const fn of Object.values(functions)) {
      const functionName = fn.Properties.FunctionName as string;
      assert.ok(functionName.startsWith(prefix), functionName);
      functionNames.add(functionName);
      const logGroupId = fn.Properties.LoggingConfig.LogGroup.Ref as string;
      assert.equal(resources[logGroupId].Type, 'AWS::Logs::LogGroup');
      assert.equal(
        resources[logGroupId].Properties.LogGroupName,
        `/aws/lambda/${functionName}`,
      );
    }
    assert.equal(functionNames.size, 5);
    if (ephemeral) {
      for (const resource of Object.values(resources)) {
        assert.notEqual(resource.DeletionPolicy, 'Retain');
        assert.notEqual(resource.UpdateReplacePolicy, 'Retain');
      }
    }
  });
}

type AlarmResource = {
  Properties: {
    AlarmName: string;
    Namespace: string;
    MetricName: string;
    Statistic: string;
    Threshold: number;
    ComparisonOperator: string;
    TreatMissingData: string;
    Dimensions: { Name: string; Value: unknown }[];
    AlarmActions: unknown[];
  };
};

for (const environment of ['dev', 'prod'] as const) {
  test(`${environment} alarms publish failures to the stack topic`, () => {
    const template = synthesize({ environment });
    const prefix = `match-to-csv-${environment}`;
    const topics = template.findResources('AWS::SNS::Topic');
    assert.equal(Object.keys(topics).length, 1);
    const [topicId] = Object.keys(topics);
    assert.equal(topics[topicId].Properties.TopicName, `${prefix}-alarms`);
    template.resourceCountIs('AWS::SNS::Subscription', 0);

    const alarms = Object.values(
      template.findResources('AWS::CloudWatch::Alarm'),
    ) as AlarmResource[];
    const byName = new Map(
      alarms.map((alarm) => [alarm.Properties.AlarmName, alarm.Properties]),
    );
    const expected: [string, string, string][] = [
      ['WorkflowExecutionsFailed', 'AWS/States', 'ExecutionsFailed'],
      ['WorkflowExecutionsTimedOut', 'AWS/States', 'ExecutionsTimedOut'],
      ['ReplayWorkflowExecutionsFailed', 'AWS/States', 'ExecutionsFailed'],
      ['ReplayWorkflowExecutionsTimedOut', 'AWS/States', 'ExecutionsTimedOut'],
      ['EventsDeadLetters', 'AWS/SQS', 'ApproximateNumberOfMessagesVisible'],
      ['ProcessEmailErrors', 'AWS/Lambda', 'Errors'],
      ['ExtractTextErrors', 'AWS/Lambda', 'Errors'],
      ['WriteExtractedCsvErrors', 'AWS/Lambda', 'Errors'],
      ['CompareRunsErrors', 'AWS/Lambda', 'Errors'],
      ['MaterializeTrainingDataErrors', 'AWS/Lambda', 'Errors'],
      ['ZeroRowExtractions', 'MCC/MatchToCsv', 'ZeroRowExtractions'],
    ];
    assert.equal(alarms.length, expected.length);
    for (const [id, namespace, metricName] of expected) {
      const alarm = byName.get(`${prefix}-${id}`);
      if (!alarm) {
        assert.fail(`missing alarm ${prefix}-${id}`);
        continue;
      }
      assert.equal(alarm.Namespace, namespace, id);
      assert.equal(alarm.MetricName, metricName, id);
      assert.equal(alarm.Threshold, 1, id);
      assert.equal(
        alarm.ComparisonOperator,
        'GreaterThanOrEqualToThreshold',
        id,
      );
      assert.equal(alarm.TreatMissingData, 'notBreaching', id);
      assert.deepEqual(alarm.AlarmActions, [{ Ref: topicId }], id);
    }

    const resources = template.toJSON().Resources as Record<
      string,
      { Properties: Record<string, unknown> }
    >;
    const dimensionTarget = (id: string) => {
      const [dimension] = byName.get(`${prefix}-${id}`)!.Dimensions;
      const value = dimension.Value as {
        Ref?: string;
        'Fn::GetAtt'?: [string, string];
      };
      return resources[value.Ref ?? value['Fn::GetAtt']![0]].Properties;
    };
    assert.equal(
      dimensionTarget('WorkflowExecutionsFailed').StateMachineName,
      prefix,
    );
    assert.equal(
      dimensionTarget('ReplayWorkflowExecutionsTimedOut').StateMachineName,
      `${prefix}-replay`,
    );
    assert.equal(
      dimensionTarget('EventsDeadLetters').QueueName,
      `${prefix}-events-dlq`,
    );
    for (const id of ['ExtractTextErrors', 'ZeroRowExtractions']) {
      assert.equal(
        dimensionTarget(id).FunctionName,
        `${prefix}-ExtractText`,
        id,
      );
    }
    assert.equal(byName.get(`${prefix}-ZeroRowExtractions`)!.Statistic, 'Sum');
    assert.equal(
      byName.get(`${prefix}-EventsDeadLetters`)!.Statistic,
      'Maximum',
    );
  });

  test(`${environment} subscribes the alarm email from its SSM parameter`, () => {
    const parameterName = `/mcc/${environment}/match-to-csv/alarm-email`;
    const template = synthesize(
      { environment },
      { MCC_ALARM_EMAIL_PARAMETER: parameterName },
    );
    const subscriptions = Object.values(
      template.findResources('AWS::SNS::Subscription'),
    );
    assert.equal(subscriptions.length, 1);
    const [subscription] = subscriptions;
    assert.equal(subscription.Properties.Protocol, 'email');
    const parameter = template.toJSON().Parameters[
      subscription.Properties.Endpoint.Ref
    ] as { Type: string; Default: string };
    assert.equal(parameter.Type, 'AWS::SSM::Parameter::Value<String>');
    assert.equal(parameter.Default, parameterName);
  });
}

test('ephemeral stacks create no alarms, topic, or subscription', () => {
  const template = synthesize(
    { environment: 'dev', ephemeral: 'test' },
    { MCC_ALARM_EMAIL_PARAMETER: '/mcc/dev/match-to-csv/alarm-email' },
  );
  template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
  template.resourceCountIs('AWS::SNS::Topic', 0);
  template.resourceCountIs('AWS::SNS::Subscription', 0);
});

test('extract text reads only its own roster partition of the foundation roster table', () => {
  for (const [environment, ephemeral, namespace] of [
    ['dev', undefined, 'stable'],
    ['prod', undefined, 'stable'],
    ['dev', 'test', 'ephemeral/test'],
  ] as const) {
    const label = `${environment} ${ephemeral ?? 'stable'}`;
    const template = synthesize({
      environment,
      ...(ephemeral ? { ephemeral } : {}),
    });
    const parameters = template.toJSON().Parameters as Record<
      string,
      { Type: string; Default?: string }
    >;
    const [fn] = Object.values(
      template.findResources('AWS::Lambda::Function', {
        Properties: { FunctionName: Match.stringLikeRegexp('-ExtractText$') },
      }),
    );
    const variables = fn.Properties.Environment.Variables as Record<
      string,
      unknown
    >;
    assert.equal(variables.ROSTER_NAMESPACE, namespace, label);
    // The table name resolves from the foundation's parameter at deploy time.
    const tableName = variables.ROSTER_TABLE as { Ref: string };
    assert.deepEqual(
      parameters[tableName.Ref],
      {
        Type: 'AWS::SSM::Parameter::Value<String>',
        Default: `/mcc/${environment}/roster/table-name`,
      },
      label,
    );

    const statements = Object.values(
      template.findResources('AWS::IAM::Policy'),
    ).flatMap((policy) =>
      (
        policy.Properties.PolicyDocument.Statement as Array<{
          Action: string | string[];
          Resource: unknown;
          Condition?: unknown;
        }>
      ).map((statement) => ({
        ...statement,
        roles: JSON.stringify(policy.Properties.Roles),
      })),
    );
    // One read-only statement, on ExtractText only.
    const dynamoStatements = statements.filter((statement) =>
      [statement.Action]
        .flat()
        .some((action) => action.startsWith('dynamodb:')),
    );
    assert.equal(dynamoStatements.length, 1, label);
    const [statement] = dynamoStatements;
    assert.ok(statement.roles.includes('ExtractText'), label);
    assert.deepEqual(
      statement.Action,
      ['dynamodb:GetItem', 'dynamodb:Query'],
      label,
    );
    assert.deepEqual(
      statement.Resource,
      {
        'Fn::Join': [
          '',
          [
            'arn:',
            { Ref: 'AWS::Partition' },
            ':dynamodb:',
            { Ref: 'AWS::Region' },
            ':',
            { Ref: 'AWS::AccountId' },
            ':table/',
            { Ref: tableName.Ref },
          ],
        ],
      },
      label,
    );
    assert.deepEqual(
      statement.Condition,
      {
        'ForAllValues:StringEquals': {
          'dynamodb:LeadingKeys': `ROSTER#${namespace}`,
        },
        Null: { 'dynamodb:LeadingKeys': 'false' },
      },
      label,
    );
  }
});

test('write extracted CSV reads only run normalized observations from the evidence bucket', () => {
  for (const [environment, ephemeral, namespace] of [
    ['dev', undefined, ''],
    ['prod', undefined, ''],
    ['dev', 'test', 'ephemeral/test/'],
  ] as const) {
    const label = `${environment} ${ephemeral ?? 'stable'}`;
    const template = synthesize({
      environment,
      ...(ephemeral ? { ephemeral } : {}),
    });
    const s3Statements = Object.values(
      template.findResources('AWS::IAM::Policy'),
    )
      .filter((policy) =>
        JSON.stringify(policy.Properties.Roles).includes('WriteExtractedCsv'),
      )
      .flatMap(
        (policy) =>
          policy.Properties.PolicyDocument.Statement as Array<{
            Action: string | string[];
            Resource: unknown;
          }>,
      )
      .filter((statement) =>
        [statement.Action].flat().some((action) => action.startsWith('s3:')),
      );
    assert.deepEqual(
      s3Statements.map((statement) => statement.Action).sort(),
      ['s3:GetObject', 's3:PutObject'],
      label,
    );
    const resource = (action: string) =>
      s3Statements.find((statement) => statement.Action === action)?.Resource;
    // Both statements name the evidence bucket from the foundation parameter.
    const bucketArn = (suffix: string) => ({
      'Fn::Join': [
        '',
        [
          'arn:',
          { Ref: 'AWS::Partition' },
          ':s3:::',
          (resource('s3:PutObject') as { 'Fn::Join': [string, unknown[]] })[
            'Fn::Join'
          ][1][3],
          suffix,
        ],
      ],
    });
    assert.deepEqual(resource('s3:PutObject'), bucketArn('/*'), label);
    assert.deepEqual(
      resource('s3:GetObject'),
      bucketArn(
        `/${namespace}submissions/*/runs/*/normalized/observations.json`,
      ),
      label,
    );
  }
});
