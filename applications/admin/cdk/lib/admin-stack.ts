import { Aspects, CfnOutput, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import type { Construct, IConstruct } from 'constructs';
import type { DeploymentConfig } from '@samlevin/cdk-config';
import * as iam from 'aws-cdk-lib/aws-iam';

interface Props extends StackProps {
  deployment: DeploymentConfig;
}

export class AdminStack extends Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    iam.PermissionsBoundary.of(this).apply(
      iam.ManagedPolicy.fromManagedPolicyName(
        this,
        'WorkloadBoundary',
        props.deployment.workloadBoundaryName,
      ),
    );
    // Ephemeral roles live under the local role path, the only path the local bootstrap
    // lets CloudFormation create, change, or pass.
    const rolePath = props.deployment.rolePath;
    if (rolePath) {
      Aspects.of(this).add({
        visit(node: IConstruct) {
          if (node instanceof iam.CfnRole) node.path = rolePath;
        },
      });
    }
    Tags.of(this).add('Application', 'admin');
    Tags.of(this).add('Environment', props.deployment.environment);
    if (props.deployment.ephemeral) {
      Tags.of(this).add('Ephemeral', props.deployment.ephemeral);
    }
    new CfnOutput(this, 'Boundary', {
      value: 'Admin API and UI for OCR quality review and correction',
    });
  }
}
