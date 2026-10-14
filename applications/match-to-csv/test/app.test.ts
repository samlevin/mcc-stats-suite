import t from 'tap';
import { Match } from 'aws-cdk-lib/assertions';
import { buildStack, synthesize } from './support/app';

t.test('stable stacks have termination protection', (t) => {
  t.equal(buildStack({ environment: 'dev' }).terminationProtection, true);
  t.equal(buildStack({ environment: 'prod' }).terminationProtection, true);
  t.end();
});

t.test('ephemeral stacks have no termination protection', (t) => {
  const stack = buildStack({ environment: 'dev', ephemeral: 'test' });
  t.equal(stack.terminationProtection, false);
  t.end();
});

t.test('the git SHA prefers the checked-out commit', (t) => {
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
  t.end();
});

t.test(
  'process email reads only its environment sender allowlist parameter',
  (t) => {
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
      t.equal(ssmStatements.length, 1, `${environment} ${ephemeral ?? ''}`);
      t.equal(ssmStatements[0].Action, 'ssm:GetParameter');
      t.match(
        JSON.stringify(ssmStatements[0].Resource),
        `:parameter${parameterName}"`,
      );
    }
    t.end();
  },
);

for (const [environment, ephemeral, retention] of [
  ['dev', undefined, 14],
  ['prod', undefined, 90],
  ['dev', 'test', 14],
] as const) {
  t.test(
    `${environment} ${ephemeral ?? 'stable'} log groups have bounded retention and the correct lifecycle`,
    (t) => {
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
      t.equal(Object.keys(logGroups).length, 6);
      for (const group of Object.values(logGroups)) {
        t.equal(group.Properties.RetentionInDays, retention);
        t.equal(
          group.DeletionPolicy,
          ephemeral ? 'Delete' : 'RetainExceptOnCreate',
        );
        t.equal(group.UpdateReplacePolicy, ephemeral ? 'Delete' : 'Retain');
      }
      const functions = template.findResources('AWS::Lambda::Function');
      t.equal(Object.keys(functions).length, 5);
      const prefix = `match-to-csv-${ephemeral ? `e-${ephemeral}` : environment}-`;
      const functionNames = new Set<string>();
      for (const fn of Object.values(functions)) {
        const functionName = fn.Properties.FunctionName as string;
        t.ok(functionName.startsWith(prefix), functionName);
        functionNames.add(functionName);
        const logGroupId = fn.Properties.LoggingConfig.LogGroup.Ref as string;
        t.equal(resources[logGroupId].Type, 'AWS::Logs::LogGroup');
        t.equal(
          resources[logGroupId].Properties.LogGroupName,
          `/aws/lambda/${functionName}`,
        );
      }
      t.equal(functionNames.size, 5);
      if (ephemeral) {
        for (const resource of Object.values(resources)) {
          t.not(resource.DeletionPolicy, 'Retain');
          t.not(resource.UpdateReplacePolicy, 'Retain');
        }
      }
      t.end();
    },
  );
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
  t.test(`${environment} alarms publish failures to the stack topic`, (t) => {
    const template = synthesize({ environment });
    const prefix = `match-to-csv-${environment}`;
    const topics = template.findResources('AWS::SNS::Topic');
    t.equal(Object.keys(topics).length, 1);
    const [topicId] = Object.keys(topics);
    t.equal(topics[topicId].Properties.TopicName, `${prefix}-alarms`);
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
    t.equal(alarms.length, expected.length);
    for (const [id, namespace, metricName] of expected) {
      const alarm = byName.get(`${prefix}-${id}`);
      if (!alarm) {
        t.fail(`missing alarm ${prefix}-${id}`);
        continue;
      }
      t.equal(alarm.Namespace, namespace, id);
      t.equal(alarm.MetricName, metricName, id);
      t.equal(alarm.Threshold, 1, id);
      t.equal(alarm.ComparisonOperator, 'GreaterThanOrEqualToThreshold', id);
      t.equal(alarm.TreatMissingData, 'notBreaching', id);
      t.same(alarm.AlarmActions, [{ Ref: topicId }], id);
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
    t.equal(
      dimensionTarget('WorkflowExecutionsFailed').StateMachineName,
      prefix,
    );
    t.equal(
      dimensionTarget('ReplayWorkflowExecutionsTimedOut').StateMachineName,
      `${prefix}-replay`,
    );
    t.equal(
      dimensionTarget('EventsDeadLetters').QueueName,
      `${prefix}-events-dlq`,
    );
    for (const id of ['ExtractTextErrors', 'ZeroRowExtractions']) {
      t.equal(dimensionTarget(id).FunctionName, `${prefix}-ExtractText`, id);
    }
    t.equal(byName.get(`${prefix}-ZeroRowExtractions`)!.Statistic, 'Sum');
    t.equal(byName.get(`${prefix}-EventsDeadLetters`)!.Statistic, 'Maximum');
    t.end();
  });

  t.test(
    `${environment} subscribes the alarm email from its SSM parameter`,
    (t) => {
      const parameterName = `/mcc/${environment}/match-to-csv/alarm-email`;
      const template = synthesize(
        { environment },
        { MCC_ALARM_EMAIL_PARAMETER: parameterName },
      );
      const subscriptions = Object.values(
        template.findResources('AWS::SNS::Subscription'),
      );
      t.equal(subscriptions.length, 1);
      const [subscription] = subscriptions;
      t.equal(subscription.Properties.Protocol, 'email');
      const parameter = template.toJSON().Parameters[
        subscription.Properties.Endpoint.Ref
      ] as { Type: string; Default: string };
      t.equal(parameter.Type, 'AWS::SSM::Parameter::Value<String>');
      t.equal(parameter.Default, parameterName);
      t.end();
    },
  );
}

t.test('ephemeral stacks create no alarms, topic, or subscription', (t) => {
  const template = synthesize(
    { environment: 'dev', ephemeral: 'test' },
    { MCC_ALARM_EMAIL_PARAMETER: '/mcc/dev/match-to-csv/alarm-email' },
  );
  template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
  template.resourceCountIs('AWS::SNS::Topic', 0);
  template.resourceCountIs('AWS::SNS::Subscription', 0);
  t.end();
});
