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
