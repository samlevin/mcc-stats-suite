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
    assert.equal(Object.keys(logGroups).length, 7);
    for (const group of Object.values(logGroups)) {
      assert.equal(group.Properties.RetentionInDays, retention);
      assert.equal(
        group.DeletionPolicy,
        ephemeral ? 'Delete' : 'RetainExceptOnCreate',
      );
      assert.equal(group.UpdateReplacePolicy, ephemeral ? 'Delete' : 'Retain');
    }
    const functions = template.findResources('AWS::Lambda::Function');
    assert.equal(Object.keys(functions).length, 6);
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
    assert.equal(functionNames.size, 6);
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
      ['WriteGamertagCsvsErrors', 'AWS/Lambda', 'Errors'],
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

type StateDefinition = {
  StartAt: string;
  States: Record<string, Record<string, unknown>>;
};

/** Parses a state machine definition, with each token as a placeholder. */
function stateMachineDefinition(
  template: ReturnType<typeof synthesize>,
  stateMachineName: string,
): StateDefinition {
  const [stateMachine] = Object.values(
    template.findResources('AWS::StepFunctions::StateMachine', {
      Properties: { StateMachineName: stateMachineName },
    }),
  );
  const parts = stateMachine.Properties.DefinitionString['Fn::Join'][1] as (
    string | { 'Fn::GetAtt'?: [string, string] }
  )[];
  return JSON.parse(
    parts
      .map((part) =>
        typeof part === 'string'
          ? part
          : `token:${part['Fn::GetAtt']?.[0] ?? 'other'}`,
      )
      .join(''),
  ) as StateDefinition;
}

/** The `trace` payload member every Lambda task of the workflow sets. */
function trace(workflow: 'INGEST' | 'REPLAY') {
  return {
    'executionId.$': '$$.Execution.Id',
    'retryCount.$': '$$.State.RetryCount',
    workflow,
  };
}

const writeExtractedCsvParameters = (workflow: 'INGEST' | 'REPLAY') => ({
  'runId.$': '$.runId',
  'source.$': '$.source',
  'rows.$': '$.rows',
  'normalizedArtifact.$': '$.normalizedArtifact',
  'roster.$': '$.roster',
  trace: trace(workflow),
});

test('every main workflow task payload carries INGEST trace context', () => {
  const definition = stateMachineDefinition(
    synthesize({ environment: 'dev' }),
    'match-to-csv-dev',
  );
  const processEmail = definition.States['Process email and attachments'];
  assert.deepEqual(processEmail.Parameters, {
    'bucket.$': '$.bucket',
    'key.$': '$.key',
    'receivedAt.$': '$.receivedAt',
    trace: trace('INGEST'),
  });
  assert.equal(processEmail.ResultPath, undefined);
  const processEmailWithout =
    definition.States['Process email and attachments without receivedAt'];
  assert.deepEqual(processEmailWithout.Parameters, {
    'bucket.$': '$.bucket',
    'key.$': '$.key',
    trace: trace('INGEST'),
  });
  assert.equal(processEmailWithout.ResultPath, undefined);

  const map = definition.States['Process attachments'];
  assert.deepEqual(map.ItemSelector, { 'source.$': '$$.Map.Item.Value' });
  const item = (map.ItemProcessor as StateDefinition).States;
  assert.deepEqual(Object.keys(item).sort(), [
    'Extract text',
    'Write extracted CSV',
  ]);
  assert.deepEqual(item['Extract text'].Parameters, {
    'source.$': '$.source',
    trace: trace('INGEST'),
  });
  assert.equal(item['Extract text'].ResultPath, undefined);
  assert.deepEqual(
    item['Write extracted CSV'].Parameters,
    writeExtractedCsvParameters('INGEST'),
  );
  assert.equal(item['Write extracted CSV'].ResultPath, '$.summary');

  // Every Lambda task in the workflow sets its own trace context.
  const tasks = [
    ...Object.values(definition.States),
    ...Object.values(item),
  ].filter((state) => state.Type === 'Task');
  assert.equal(tasks.length, 6);
  for (const task of tasks) {
    assert.deepEqual(
      (task.Parameters as { trace: unknown }).trace,
      trace('INGEST'),
    );
  }
});

test('every replay workflow task payload carries REPLAY trace context', () => {
  const replay = stateMachineDefinition(
    synthesize({ environment: 'dev' }),
    'match-to-csv-dev-replay',
  );
  assert.equal(replay.StartAt, 'Replay extract text');
  const extract = replay.States['Replay extract text'];
  assert.deepEqual(extract.Parameters, {
    'source.$': '$.source',
    trace: trace('REPLAY'),
  });
  assert.equal(extract.ResultPath, undefined);
  assert.equal(extract.Next, 'Replay write extracted CSV');
  const write = replay.States['Replay write extracted CSV'];
  assert.deepEqual(write.Parameters, writeExtractedCsvParameters('REPLAY'));
  assert.equal(write.ResultPath, undefined);
  assert.equal(write.End, true);
});

test('the stored-email rule starts the workflow with the object and its receive time', () => {
  const template = synthesize({ environment: 'dev' });
  const [rule] = Object.values(template.findResources('AWS::Events::Rule'));
  const targets = rule.Properties.Targets as {
    InputTransformer: {
      InputPathsMap: Record<string, string>;
      InputTemplate: string;
    };
  }[];
  assert.equal(targets.length, 1);
  const { InputPathsMap, InputTemplate } = targets[0].InputTransformer;
  // Rebuild the input from a sample event the way EventBridge does, by
  // replacing each <name> with the JSON value at its path.
  const event = {
    time: '2026-10-19T12:34:56Z',
    detail: {
      bucket: { name: 'raw-email-bucket' },
      object: { key: 'incoming/dev/message-id' },
    },
  };
  const input = InputTemplate.replace(/<([^>]+)>/g, (_, name: string) => {
    const pathExpression = InputPathsMap[name];
    assert.ok(pathExpression, name);
    const value = pathExpression
      .replace(/^\$\./, '')
      .split('.')
      .reduce<unknown>(
        (node, key) => (node as Record<string, unknown>)[key],
        event,
      );
    return JSON.stringify(value);
  });
  assert.deepEqual(JSON.parse(input), {
    bucket: 'raw-email-bucket',
    key: 'incoming/dev/message-id',
    receivedAt: '2026-10-19T12:34:56Z',
  });
});

/**
 * Walks a Choice on `$.receivedAt` and returns the states it runs with and
 * without the field.
 */
function receivedAtBranches(definition: StateDefinition, choiceName: string) {
  const choice = definition.States[choiceName];
  assert.equal(choice.Type, 'Choice', choiceName);
  const choices = choice.Choices as Record<string, unknown>[];
  assert.equal(choices.length, 1, choiceName);
  assert.equal(choices[0].Variable, '$.receivedAt', choiceName);
  assert.equal(choices[0].IsPresent, true, choiceName);
  return {
    present: choices[0].Next as string,
    absent: choice.Default as string,
  };
}

test('a main workflow start without receivedAt runs steps that never read it', () => {
  const definition = stateMachineDefinition(
    synthesize({ environment: 'dev' }),
    'match-to-csv-dev',
  );
  // EventBridge sets receivedAt, a manual start may send only bucket and key.
  assert.equal(definition.StartAt, 'Input has receivedAt');
  assert.deepEqual(receivedAtBranches(definition, 'Input has receivedAt'), {
    present: 'Process email and attachments',
    absent: 'Process email and attachments without receivedAt',
  });
  for (const name of [
    'Process email and attachments',
    'Process email and attachments without receivedAt',
  ]) {
    assert.match(
      definition.States[name].Resource as string,
      /^token:ProcessEmail/,
      name,
    );
    assert.equal(definition.States[name].Next, 'Rejected?', name);
  }
  assert.equal(definition.States['Rejected?'].Default, 'Process attachments');
  // process-email omits receivedAt from its output when the input had none
  // or a malformed one, so the gamertag step checks again.
  assert.equal(
    definition.States['Process attachments'].Next,
    'Email output has receivedAt',
  );
  assert.deepEqual(
    receivedAtBranches(definition, 'Email output has receivedAt'),
    {
      present: 'Write gamertag CSVs',
      absent: 'Write gamertag CSVs without receivedAt',
    },
  );

  // Only the branches taken when receivedAt is present read it, because a
  // JSONPath field with a missing path fails the execution.
  const item = (
    definition.States['Process attachments'].ItemProcessor as StateDefinition
  ).States;
  const readers = Object.entries({ ...definition.States, ...item })
    .filter(([, state]) => JSON.stringify(state).includes('$.receivedAt'))
    .filter(([, state]) => state.Type !== 'Choice')
    .map(([name]) => name)
    .sort();
  assert.deepEqual(readers, [
    'Process email and attachments',
    'Write gamertag CSVs',
  ]);
});

test('the main workflow writes gamertag CSVs only after the attachments Map', () => {
  const template = synthesize({ environment: 'dev' });
  const definition = stateMachineDefinition(template, 'match-to-csv-dev');
  const map = definition.States['Process attachments'];
  assert.equal(map.Type, 'Map');
  // No Catch: a failed item fails the Map and the execution before the step.
  assert.equal(map.Catch, undefined);
  assert.equal(map.Next, 'Email output has receivedAt');

  // Only the keys, the match date, trace context and receivedAt when present
  // enter the step, never a row.
  const parameters = {
    'submissionId.$': '$.submissionId',
    'matchDate.$': '$.matchDate',
    'exports.$': '$.results[*].summary',
    trace: trace('INGEST'),
  };
  for (const [name, expected] of [
    ['Write gamertag CSVs', { ...parameters, 'receivedAt.$': '$.receivedAt' }],
    ['Write gamertag CSVs without receivedAt', parameters],
  ] as const) {
    const step = definition.States[name];
    assert.equal(step.Type, 'Task', name);
    assert.equal(step.End, true, name);
    assert.equal(step.Catch, undefined, name);
    assert.match(step.Resource as string, /^token:WriteGamertagCsvs/, name);
    assert.deepEqual(step.Parameters, expected, name);
    assert.equal(step.ResultPath, '$.gamertagCsvs', name);
  }

  const step = definition.States['Write gamertag CSVs'];
  for (const name of [
    'Process email and attachments',
    'Process email and attachments without receivedAt',
    'Write gamertag CSVs without receivedAt',
  ]) {
    assert.deepEqual(definition.States[name].Retry, step.Retry, name);
  }
  assert.deepEqual(step.Retry, [
    {
      ErrorEquals: [
        'Lambda.ClientExecutionTimeoutException',
        'Lambda.ServiceException',
        'Lambda.AWSLambdaException',
        'Lambda.SdkClientException',
        'Lambda.TooManyRequestsException',
        'Textract.InternalServerError',
        'Textract.ProvisionedThroughputExceededException',
        'Textract.ThrottlingException',
        'InternalServerError',
        'ProvisionedThroughputExceededException',
        'ThrottlingException',
      ],
      IntervalSeconds: 2,
      MaxAttempts: 3,
      BackoffRate: 2,
    },
  ]);

  // The replay workflow writes no per-gamertag files.
  const replay = stateMachineDefinition(template, 'match-to-csv-dev-replay');
  assert.deepEqual(Object.keys(replay.States).sort(), [
    'Replay extract text',
    'Replay write extracted CSV',
  ]);
  assert.ok(!JSON.stringify(replay).includes('WriteGamertagCsvs'));
});

test('the main workflow ends a rejected submission as succeeded and sends an accepted one to the Map', () => {
  for (const ephemeral of [undefined, 'test']) {
    const template = synthesize({
      environment: 'dev',
      ...(ephemeral ? { ephemeral } : {}),
    });
    const definition = stateMachineDefinition(
      template,
      ephemeral ? `match-to-csv-e-${ephemeral}` : 'match-to-csv-dev',
    );
    assert.equal(definition.StartAt, 'Input has receivedAt');
    for (const name of [
      'Process email and attachments',
      'Process email and attachments without receivedAt',
    ]) {
      const processEmail = definition.States[name];
      assert.equal(processEmail.Next, 'Rejected?', name);
      // No Catch: an error that is not a rejection still fails the execution.
      assert.equal(processEmail.Catch, undefined, name);
    }
    assert.deepEqual(definition.States['Rejected?'], {
      Type: 'Choice',
      Choices: [
        {
          Variable: '$.status',
          StringEquals: 'REJECTED',
          Next: 'Submission rejected',
        },
      ],
      Default: 'Process attachments',
    });
    assert.deepEqual(definition.States['Submission rejected'], {
      Type: 'Succeed',
    });
  }
});

test('write gamertag CSVs reads run tables and writes only submission gamertag exports', () => {
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
    const statements = Object.values(template.findResources('AWS::IAM::Policy'))
      .filter((policy) =>
        JSON.stringify(policy.Properties.Roles).includes('WriteGamertagCsvs'),
      )
      .flatMap(
        (policy) =>
          policy.Properties.PolicyDocument.Statement as Array<{
            Action: string | string[];
            Resource: unknown;
          }>,
      );
    const s3Statements = statements.filter((statement) =>
      [statement.Action].flat().some((action) => action.startsWith('s3:')),
    );
    assert.deepEqual(
      s3Statements.map((statement) => statement.Action).sort(),
      ['s3:GetObject', 's3:PutObject'],
      label,
    );
    const suffix = (action: string) => {
      const resource = s3Statements.find(
        (statement) => statement.Action === action,
      )?.Resource as { 'Fn::Join': [string, unknown[]] };
      const parts = resource['Fn::Join'][1];
      assert.deepEqual(parts.slice(0, 3), [
        'arn:',
        { Ref: 'AWS::Partition' },
        ':s3:::',
      ]);
      // The bucket name resolves from the foundation's evidence parameter.
      assert.deepEqual(
        Object.keys(parts[3] as object),
        ['Ref'],
        `${label} ${action}`,
      );
      return parts.slice(4).join('');
    };
    assert.equal(
      suffix('s3:GetObject'),
      `/${namespace}submissions/*/runs/*/export/extracted-table.json`,
      label,
    );
    assert.equal(
      suffix('s3:PutObject'),
      `/${namespace}submissions/*/export/gamertags/*`,
      label,
    );
    // The data key encrypts the files and decrypts the run tables.
    assert.ok(
      statements.some(
        (statement) =>
          [statement.Action].flat().includes('kms:Decrypt') &&
          [statement.Action].flat().includes('kms:GenerateDataKey*'),
      ),
      label,
    );
    assert.ok(
      !statements.some((statement) =>
        [statement.Action]
          .flat()
          .some((action) =>
            /^(s3:Delete|s3:\*|dynamodb:|ses:|textract:)/.test(action),
          ),
      ),
      label,
    );
  }
});
