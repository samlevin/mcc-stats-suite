import t from 'tap';
import { Match } from 'aws-cdk-lib/assertions';
import { buildStack, synthesize } from './support/app';

t.test('stable stacks have termination protection', (t) => {
  t.equal(buildStack({ environment: 'dev' }).terminationProtection, true);
  t.equal(buildStack({ environment: 'prod' }).terminationProtection, true);
  t.end();
});

t.test('ephemeral stacks can be destroyed', (t) => {
  const stack = buildStack({ environment: 'dev', ephemeral: 'test' });
  t.equal(stack.terminationProtection, false);
  t.end();
});

t.test('the git SHA comes from the supplied environment', (t) => {
  const template = synthesize({ environment: 'dev' }, { GITHUB_SHA: 'abc123' });
  template.hasResourceProperties('AWS::Lambda::Function', {
    Environment: { Variables: Match.objectLike({ GIT_SHA: 'abc123' }) },
  });
  t.end();
});
