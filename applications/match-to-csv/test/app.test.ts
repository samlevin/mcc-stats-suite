import t from 'tap';
import { Match } from 'aws-cdk-lib/assertions';
import { buildStack, synthesize } from './support/app';

// CDK construction and synthesis can exceed TAP's 30s default during concurrent CI checks.
t.setTimeout(60_000);

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
