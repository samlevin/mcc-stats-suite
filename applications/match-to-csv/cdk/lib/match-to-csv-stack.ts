import * as path from 'path';
import type { DeploymentConfig } from '@mcc/cdk-config';
import {
  CfnOutput,
  CfnParameter,
  Duration,
  Fn,
  Stack,
  Tags,
  type StackProps,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as customResources from 'aws-cdk-lib/custom-resources';

interface MatchToCsvStackProps extends StackProps {
  deployment: DeploymentConfig;
}

export class MatchToCsvStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    props: MatchToCsvStackProps,
  ) {
    super(scope, id, props);

    const { deployment } = props;
    iam.PermissionsBoundary.of(this).apply(
      iam.ManagedPolicy.fromManagedPolicyName(
        this,
        'WorkloadBoundary',
        deployment.workloadBoundaryName,
      ),
    );
    Tags.of(this).add('Application', deployment.application);
    Tags.of(this).add('Environment', deployment.environment);
    if (deployment.instance) {
      Tags.of(this).add('Instance', deployment.instance);
    }
    const prefix = `/mcc/${deployment.environment}/match-to-csv`;
    const lambdaEnvironment = {
      OBJECT_PREFIX: deployment.objectPrefix,
    };
    const rawEmailBucket = s3.Bucket.fromBucketName(
      this,
      'RawEmailBucket',
      ssm.StringParameter.valueForStringParameter(
        this,
        `${prefix}/raw-email-bucket-name`,
      ),
    );
    const attachmentsBucket = s3.Bucket.fromBucketName(
      this,
      'AttachmentsBucket',
      ssm.StringParameter.valueForStringParameter(
        this,
        `${prefix}/attachments-bucket-name`,
      ),
    );
    const outputBucket = s3.Bucket.fromBucketName(
      this,
      'OutputBucket',
      ssm.StringParameter.valueForStringParameter(
        this,
        `${prefix}/output-bucket-name`,
      ),
    );
    const dataKey = kms.Key.fromKeyArn(
      this,
      'DataKey',
      ssm.StringParameter.valueForStringParameter(
        this,
        `${prefix}/data-key-arn`,
      ),
    );

    const processEmail = this.nodeFunction(
      'ProcessEmail',
      'process-email.ts',
      {
        ATTACHMENTS_BUCKET: attachmentsBucket.bucketName,
        ...lambdaEnvironment,
      },
      1024,
    );
    const preprocessImage = this.nodeFunction(
      'PreprocessImage',
      'preprocess-image.ts',
      lambdaEnvironment,
      2048,
      true,
    );
    const extractText = this.nodeFunction(
      'ExtractText',
      'extract-text.ts',
      {
        OUTPUT_BUCKET: outputBucket.bucketName,
        ...lambdaEnvironment,
      },
      2048,
      true,
    );
    const writeMatchCsv = this.nodeFunction(
      'WriteMatchCsv',
      'write-match-csv.ts',
      {
        OUTPUT_BUCKET: outputBucket.bucketName,
        ...lambdaEnvironment,
      },
      1024,
    );

    rawEmailBucket.grantRead(processEmail);
    attachmentsBucket.grantReadWrite(processEmail);
    attachmentsBucket.grantReadWrite(preprocessImage);
    attachmentsBucket.grantRead(extractText);
    outputBucket.grantWrite(extractText);
    outputBucket.grantWrite(writeMatchCsv);
    dataKey.grantEncryptDecrypt(processEmail);
    dataKey.grantEncryptDecrypt(preprocessImage);
    dataKey.grantEncryptDecrypt(extractText);
    dataKey.grantEncryptDecrypt(writeMatchCsv);

    preprocessImage.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['rekognition:DetectText'],
        resources: ['*'],
      }),
    );
    extractText.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['textract:AnalyzeDocument'],
        resources: ['*'],
      }),
    );

    const processEmailTask = new tasks.LambdaInvoke(
      this,
      'Process email and attachments',
      {
        lambdaFunction: processEmail,
        payloadResponseOnly: true,
        retryOnServiceExceptions: false,
      },
    );
    const preprocessTask = new tasks.LambdaInvoke(
      this,
      'Preprocess image',
      {
        lambdaFunction: preprocessImage,
        payloadResponseOnly: true,
        retryOnServiceExceptions: false,
      },
    );
    const extractTextTask = new tasks.LambdaInvoke(this, 'Extract text', {
      lambdaFunction: extractText,
      payloadResponseOnly: true,
      retryOnServiceExceptions: false,
    });
    const writeCsvTask = new tasks.LambdaInvoke(this, 'Write match CSV', {
      lambdaFunction: writeMatchCsv,
      payloadResponseOnly: true,
      resultPath: '$.summary',
      retryOnServiceExceptions: false,
    });

    for (const task of [
      processEmailTask,
      preprocessTask,
      extractTextTask,
      writeCsvTask,
    ]) {
      task.addRetry({
        errors: [
          'Lambda.ServiceException',
          'Lambda.AWSLambdaException',
          'Lambda.SdkClientException',
        ],
        interval: Duration.seconds(2),
        maxAttempts: 3,
        backoffRate: 2,
      });
    }

    const processAttachments = new sfn.Map(this, 'Process attachments', {
      itemsPath: '$.attachments',
      resultPath: '$.results',
      maxConcurrency: 2,
      itemSelector: {
        'matchId.$': '$.matchId',
        'bucket.$': '$$.Map.Item.Value.bucket',
        'key.$': '$$.Map.Item.Value.key',
        'attachmentName.$': '$$.Map.Item.Value.attachmentName',
        'contentType.$': '$$.Map.Item.Value.contentType',
      },
    });
    processAttachments.itemProcessor(preprocessTask.next(extractTextTask));

    const logGroup = new logs.LogGroup(this, 'WorkflowLogs', {
      logGroupName: `/aws/vendedlogs/states/${deployment.resourcePrefix}`,
      retention:
        deployment.environment === 'prod'
          ? logs.RetentionDays.THREE_MONTHS
          : logs.RetentionDays.TWO_WEEKS,
    });
    const workflow = new sfn.StateMachine(this, 'Workflow', {
      stateMachineName: deployment.resourcePrefix,
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(
        processEmailTask.next(processAttachments).next(writeCsvTask),
      ),
      timeout: Duration.minutes(15),
      logs: {
        destination: logGroup,
        level: sfn.LogLevel.ALL,
        includeExecutionData: true,
      },
      tracingEnabled: true,
    });

    const inboundRoute = deployment.environment === 'prod'
      ? 'prod'
      : deployment.instance === 'shared'
        ? 'shared'
        : deployment.instance!;
    const inboundPrefix = `incoming/${inboundRoute}/`;
    const workflowDlq = new sqs.Queue(this, 'WorkflowDlq', {
      queueName: `${deployment.resourcePrefix}-events-dlq`,
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    const rawEmailCreated = new events.Rule(this, 'RawEmailCreated', {
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [rawEmailBucket.bucketName] },
          object: { key: [{ prefix: inboundPrefix }] },
        },
      },
    });
    rawEmailCreated.addTarget(
      new targets.SfnStateMachine(workflow, {
        deadLetterQueue: workflowDlq,
        retryAttempts: 3,
        maxEventAge: Duration.hours(2),
        input: events.RuleTargetInput.fromObject({
          bucket: events.EventField.fromPath('$.detail.bucket.name'),
          key: events.EventField.fromPath('$.detail.object.key'),
        }),
      }),
    );

    const emailDomain = new CfnParameter(this, 'EmailDomain', {
      type: 'String',
      description: 'Verified SES domain used for inbound match-to-CSV email',
      allowedPattern: '^[A-Za-z0-9.-]+$',
    });
    const recipient = Fn.join('', [
      deployment.environment === 'prod' || deployment.instance === 'shared'
        ? 'submit@'
        : `submit+${deployment.instance}@`,
      emailDomain.valueAsString,
    ]);
    const receiptRuleSetName = `mcc-match-to-csv-${deployment.environment}`;
    let receiptRuleSet: ses.CfnReceiptRuleSet | undefined;
    if (deployment.isShared) {
      receiptRuleSet = new ses.CfnReceiptRuleSet(this, 'ReceiptRuleSet', {
        ruleSetName: receiptRuleSetName,
      });
    }
    const receiptRule = new ses.CfnReceiptRule(this, 'StoreRawEmail', {
      ruleSetName: receiptRuleSetName,
      rule: {
        name: deployment.resourcePrefix,
        enabled: true,
        recipients: [recipient],
        scanEnabled: true,
        tlsPolicy: 'Optional',
        actions: [
          {
            s3Action: {
              bucketName: rawEmailBucket.bucketName,
              objectKeyPrefix: inboundPrefix,
            },
          },
          { stopAction: { scope: 'RuleSet' } },
        ],
      },
    });
    if (receiptRuleSet) {
      receiptRule.node.addDependency(receiptRuleSet);
      const activateRules = new customResources.AwsCustomResource(
        this,
        'ActivateReceiptRuleSet',
        {
          onCreate: {
            service: 'SES',
            action: 'setActiveReceiptRuleSet',
            parameters: { RuleSetName: receiptRuleSetName },
            physicalResourceId:
              customResources.PhysicalResourceId.of(receiptRuleSetName),
          },
          onUpdate: {
            service: 'SES',
            action: 'setActiveReceiptRuleSet',
            parameters: { RuleSetName: receiptRuleSetName },
            physicalResourceId:
              customResources.PhysicalResourceId.of(receiptRuleSetName),
          },
          onDelete: {
            service: 'SES',
            action: 'setActiveReceiptRuleSet',
            parameters: {},
          },
          policy: customResources.AwsCustomResourcePolicy.fromSdkCalls({
            resources: customResources.AwsCustomResourcePolicy.ANY_RESOURCE,
          }),
        },
      );
      activateRules.node.addDependency(receiptRule);

      new CfnOutput(this, 'ReceiptRuleSetName', {
        value: receiptRuleSetName,
      });
    }

    new CfnOutput(this, 'StateMachineArn', {
      value: workflow.stateMachineArn,
    });
    new CfnOutput(this, 'ObjectPrefix', {
      value: deployment.objectPrefix || '(shared)',
    });
  }

  private nodeFunction(
    id: string,
    fileName: string,
    environment: Record<string, string>,
    memorySize: number,
    includeSharp = false,
  ): lambdaNode.NodejsFunction {
    const repositoryRoot = path.join(__dirname, '..', '..', '..', '..');
    return new lambdaNode.NodejsFunction(this, id, {
      entry: path.join(
        __dirname,
        '..',
        '..',
        'src',
        'lambdas',
        fileName,
      ),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize,
      timeout: Duration.minutes(2),
      tracing: lambda.Tracing.ACTIVE,
      environment,
      projectRoot: repositoryRoot,
      depsLockFilePath: path.join(repositoryRoot, 'package-lock.json'),
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        nodeModules: includeSharp ? ['sharp'] : undefined,
        forceDockerBundling: includeSharp,
      },
    });
  }
}
