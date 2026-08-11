import { CfnOutput, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import type { DeploymentConfig } from '@mcc/cdk-config';
import * as iam from 'aws-cdk-lib/aws-iam';

interface Props extends StackProps {
  deployment: DeploymentConfig;
}

export class PlayerStack extends Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    iam.PermissionsBoundary.of(this).apply(
      iam.ManagedPolicy.fromManagedPolicyName(
        this,
        'WorkloadBoundary',
        props.deployment.workloadBoundaryName,
      ),
    );
    Tags.of(this).add('Application', 'player');
    Tags.of(this).add('Environment', props.deployment.environment);
    if (props.deployment.ephemeral) {
      Tags.of(this).add('Ephemeral', props.deployment.ephemeral);
    }
    new CfnOutput(this, 'Boundary', {
      value: 'Read-only player statistics API and user interface',
    });
  }
}
