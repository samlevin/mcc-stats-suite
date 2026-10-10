import t from 'tap';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { BUNDLING_STACKS } from 'aws-cdk-lib/cx-api';
import { createMatchToCsvApp } from '../cdk/lib/app';

function build(
  context: Record<string, string>,
  environmentVariables: NodeJS.ProcessEnv = {},
) {
  return createMatchToCsvApp(
    { context: { [BUNDLING_STACKS]: [], ...context } },
    environmentVariables,
  );
}

t.test('stable stacks have termination protection', (t) => {
  t.equal(build({ environment: 'dev' }).terminationProtection, true);
  t.equal(build({ environment: 'prod' }).terminationProtection, true);
  t.end();
});

t.test('ephemeral stacks can be destroyed', (t) => {
  const stack = build({ environment: 'dev', ephemeral: 'test' });
  t.equal(stack.terminationProtection, false);
  t.end();
});

t.test('the git SHA comes from the supplied environment', (t) => {
  const template = Template.fromStack(
    build({ environment: 'dev' }, { GITHUB_SHA: 'abc123' }),
  );
  template.hasResourceProperties('AWS::Lambda::Function', {
    Environment: { Variables: Match.objectLike({ GIT_SHA: 'abc123' }) },
  });
  t.end();
});
