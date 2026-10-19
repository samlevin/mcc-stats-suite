import assert from 'node:assert/strict';
import { test } from 'node:test';
import { synthesize } from './support/app';

for (const [environment, ephemeral] of [
  ['dev', undefined],
  ['prod', undefined],
  ['dev', 'test'],
] as const) {
  test(`${environment} ${ephemeral ?? 'stable'} resources describe their component without changing names or tags`, () => {
    const template = synthesize({
      environment,
      ...(ephemeral ? { ephemeral } : {}),
    }).toJSON();
    assert.match(template.Description as string, /preserve OCR evidence/);
    const resourceMap = template.Resources as Record<
      string,
      {
        Type: string;
        Metadata: Record<string, { group: string; purpose: string } | string>;
        Properties: {
          Description?: string;
          FunctionName?: string;
          Tags?: Array<{ Key: string; Value: string }>;
        };
      }
    >;
    const resources = Object.values(resourceMap);
    const groups = new Set(
      resources.map(
        (resource) =>
          (resource.Metadata['mcc:component'] as { group: string }).group,
      ),
    );
    assert.deepEqual([...groups].sort(), [
      'CSV export',
      'Email intake',
      'OCR',
      'Operational support',
      'Replay/evidence tools',
    ]);
    for (const resource of resources) {
      const component = resource.Metadata['mcc:component'] as {
        group: string;
        purpose: string;
      };
      assert.ok(component.purpose.length > 10);
      if (resource.Type === 'AWS::Lambda::Function') {
        assert.equal(resource.Properties.Description, component.purpose);
        assert.ok(
          resource.Properties.FunctionName?.startsWith(
            `match-to-csv-${ephemeral ? `e-${ephemeral}` : environment}-`,
          ),
        );
        for (const [Key, Value] of [
          ['Application', 'match-to-csv'],
          ['Environment', environment],
          ...(ephemeral ? [['Ephemeral', ephemeral]] : []),
        ]) {
          assert.ok(
            resource.Properties.Tags?.some(
              (tag) => tag.Key === Key && tag.Value === Value,
            ),
          );
        }
      }
      if (resource.Type === 'AWS::IAM::Role')
        assert.match(
          resource.Properties.Description ?? '',
          /^Execution role for .+: /,
        );
      if (resource.Type === 'AWS::Events::Rule')
        assert.match(
          resource.Properties.Description ?? '',
          /S3 stores a message/,
        );
    }
  });
}
