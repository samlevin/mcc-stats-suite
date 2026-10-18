import * as path from 'path';
import type { DeploymentConfig } from '@mcc/cdk-config';
import {
  Aspects,
  CfnOutput,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  Tags,
  type StackProps,
} from 'aws-cdk-lib';
import type { Construct, IConstruct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import {
  bundlingOptions,
  bundlingRuntime,
  checkLocalEsbuild,
  localEsbuildVersion,
} from './bundling';
import {
  FUNCTION_NAME_DIMENSION,
  METRIC_NAMESPACE,
  ZERO_ROW_EXTRACTIONS_METRIC,
} from '../../src/lib/metrics';
import { REPLY_LOCAL_PART } from '../../src/lib/reply-address';

interface MatchToCsvStackProps extends StackProps {
  deployment: DeploymentConfig;
  /** Commit recorded in Lambda environments and OCR evidence. */
  gitSha: string;
  /**
   * SSM parameter that holds the email address subscribed to alarms. The
   * address resolves at deploy time, so it never appears in source or in the
   * synthesized template. Without it, alarms still publish to the topic.
   */
  alarmEmailParameter?: string;
}

export class MatchToCsvStack extends Stack {
  private readonly deployment: DeploymentConfig;

  constructor(scope: Construct, id: string, props: MatchToCsvStackProps) {
    super(scope, id, props);

    const { deployment, gitSha, alarmEmailParameter } = props;
    this.deployment = deployment;
    if (this.bundlingRequired) checkLocalEsbuild(localEsbuildVersion());
    iam.PermissionsBoundary.of(this).apply(
      iam.ManagedPolicy.fromManagedPolicyName(
        this,
        'WorkloadBoundary',
        deployment.workloadBoundaryName,
      ),
    );
    // Ephemeral roles live under the local role path, the only path the local bootstrap
    // lets CloudFormation create, change, or pass.
    const rolePath = deployment.rolePath;
    if (rolePath) {
      Aspects.of(this).add({
        visit(node: IConstruct) {
          if (node instanceof iam.CfnRole) node.path = rolePath;
        },
      });
    }
    Tags.of(this).add('Application', deployment.application);
    Tags.of(this).add('Environment', deployment.environment);
    if (deployment.ephemeral) {
      Tags.of(this).add('Ephemeral', deployment.ephemeral);
    }
    const prefix = `/mcc/${deployment.environment}/match-to-csv`;
    const lambdaEnvironment = {
      OBJECT_PREFIX: deployment.objectPrefix,
    };
    const buildEnvironment = {
      GIT_SHA: gitSha,
      DEPLOYMENT_ENVIRONMENT: deployment.environment.toUpperCase(),
    };
    const rawEmailBucket = s3.Bucket.fromBucketName(
      this,
      'RawEmailBucket',
      ssm.StringParameter.valueForStringParameter(
        this,
        `${prefix}/raw-email-bucket-name`,
      ),
    );
    const evidenceBucket = s3.Bucket.fromBucketName(
      this,
      'EvidenceBucket',
      ssm.StringParameter.valueForStringParameter(
        this,
        `${prefix}/evidence-bucket-name`,
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
    // The foundation owns the gamertag roster table (spec 1.2 §13.2). Each stack
    // reads only its own namespace's partition: `stable` for stable stacks and
    // `ephemeral/<name>` for ephemeral ones.
    const rosterTableName = ssm.StringParameter.valueForStringParameter(
      this,
      `/mcc/${deployment.environment}/roster/table-name`,
    );
    const rosterNamespace = deployment.ephemeral
      ? `ephemeral/${deployment.ephemeral}`
      : 'stable';

    // Operators create this optional parameter out of band; sender addresses
    // never live in source or OpenTofu state.
    const senderAllowlistParameter = `${prefix}/sender-allowlist`;
    // The foundation publishes the submission address's alias and domain.
    const emailAliasParameter = `${prefix}/email-alias`;
    const emailDomainParameter = `${prefix}/email-domain`;
    // process-email replies from noreply@<domain> to a message without a
    // valid match date. The domain resolves at deploy time, so the sender
    // address and the ses:SendEmail grant always name the same address.
    const emailDomain = ssm.StringParameter.valueForStringParameter(
      this,
      emailDomainParameter,
    );
    // An ephemeral stack's receipt rule keeps the alias and domain from its
    // last deploy, so its process-email checks each message's recipient
    // against the values the foundation publishes when the message arrives.
    const runtimeParameters = deployment.ephemeral
      ? [senderAllowlistParameter, emailAliasParameter, emailDomainParameter]
      : [senderAllowlistParameter];
    const processEmail = this.nodeFunction(
      'ProcessEmail',
      'process-email.ts',
      {
        EVIDENCE_BUCKET: evidenceBucket.bucketName,
        SENDER_ALLOWLIST_PARAMETER: senderAllowlistParameter,
        REPLY_FROM_DOMAIN: emailDomain,
        ...(deployment.ephemeral
          ? {
              EMAIL_ALIAS_PARAMETER: emailAliasParameter,
              EMAIL_DOMAIN_PARAMETER: emailDomainParameter,
              RECIPIENT_SUBADDRESS: deployment.ephemeral,
            }
          : {}),
        ...lambdaEnvironment,
      },
      1024,
      true,
    );
    const extractText = this.nodeFunction(
      'ExtractText',
      'extract-text.ts',
      {
        ...lambdaEnvironment,
        ...buildEnvironment,
        ROSTER_TABLE: rosterTableName,
        ROSTER_NAMESPACE: rosterNamespace,
      },
      2048,
      true,
    );
    const writeExtractedCsv = this.nodeFunction(
      'WriteExtractedCsv',
      'write-extracted-csv.ts',
      lambdaEnvironment,
      1024,
    );
    const compareRuns = this.nodeFunction(
      'CompareRuns',
      'compare-runs.ts',
      lambdaEnvironment,
      1024,
    );
    const materializeTrainingData = this.nodeFunction(
      'MaterializeTrainingData',
      'materialize-training-data.ts',
      lambdaEnvironment,
      2048,
      false,
      Duration.minutes(10),
    );

    rawEmailBucket.grantRead(processEmail);
    processEmail.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: runtimeParameters.map((name) =>
          this.formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: name.slice(1),
          }),
        ),
      }),
    );
    // In the SES sandbox, SES also authorizes the send against each
    // recipient's verified identity, so a grant on the domain identity alone
    // gets AccessDenied. The grant therefore names every identity in this
    // account and Region, and allows only the noreply@<domain> From address.
    processEmail.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail'],
        resources: [
          this.formatArn({
            service: 'ses',
            resource: 'identity',
            resourceName: '*',
          }),
        ],
        conditions: {
          StringEquals: {
            'ses:FromAddress': `${REPLY_LOCAL_PART}@${emailDomain}`,
          },
        },
      }),
    );
    this.grantEvidenceAccess(evidenceBucket, processEmail, false);
    this.grantEvidenceAccess(evidenceBucket, extractText, true);
    this.grantEvidenceAccess(evidenceBucket, writeExtractedCsv, false);
    this.grantEvidenceAccess(evidenceBucket, compareRuns, true);
    this.grantEvidenceAccess(evidenceBucket, materializeTrainingData, true);
    dataKey.grantEncryptDecrypt(processEmail);
    dataKey.grantEncryptDecrypt(extractText);
    dataKey.grantEncryptDecrypt(writeExtractedCsv);
    dataKey.grantEncryptDecrypt(compareRuns);
    dataKey.grantEncryptDecrypt(materializeTrainingData);
    extractText.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['textract:AnalyzeDocument'],
        resources: ['*'],
      }),
    );
    // Read-only, and only in this stack's partition. Null refuses a request
    // that names no leading key, which ForAllValues would otherwise allow.
    // The data key grant above covers DynamoDB's decryption of the items.
    extractText.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:Query'],
        resources: [
          this.formatArn({
            service: 'dynamodb',
            resource: 'table',
            resourceName: rosterTableName,
          }),
        ],
        conditions: {
          'ForAllValues:StringEquals': {
            'dynamodb:LeadingKeys': `ROSTER#${rosterNamespace}`,
          },
          Null: { 'dynamodb:LeadingKeys': 'false' },
        },
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
    const extractTextTask = new tasks.LambdaInvoke(this, 'Extract text', {
      lambdaFunction: extractText,
      payloadResponseOnly: true,
      retryOnServiceExceptions: false,
    });
    const writeCsvTask = new tasks.LambdaInvoke(this, 'Write extracted CSV', {
      lambdaFunction: writeExtractedCsv,
      payloadResponseOnly: true,
      resultPath: '$.summary',
      retryOnServiceExceptions: false,
    });

    const transientErrors = [
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
    ];
    const retry = {
      errors: transientErrors,
      interval: Duration.seconds(2),
      maxAttempts: 3,
      backoffRate: 2,
    };
    for (const task of [processEmailTask, extractTextTask, writeCsvTask]) {
      task.addRetry(retry);
    }

    const processAttachments = new sfn.Map(this, 'Process attachments', {
      itemsPath: '$.screenshots',
      resultPath: '$.results',
      maxConcurrency: 2,
      itemSelector: {
        'source.$': '$$.Map.Item.Value',
      },
    });
    processAttachments.itemProcessor(extractTextTask.next(writeCsvTask));

    const logGroup = this.logGroup(
      'WorkflowLogs',
      `/aws/vendedlogs/states/${deployment.resourcePrefix}`,
    );
    const workflow = new sfn.StateMachine(this, 'Workflow', {
      stateMachineName: deployment.resourcePrefix,
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(
        processEmailTask.next(processAttachments),
      ),
      timeout: Duration.minutes(15),
      logs: {
        destination: logGroup,
        level: sfn.LogLevel.ALL,
        includeExecutionData: true,
      },
      tracingEnabled: true,
    });
    const replayExtract = new tasks.LambdaInvoke(this, 'Replay extract text', {
      lambdaFunction: extractText,
      payloadResponseOnly: true,
      retryOnServiceExceptions: false,
    });
    const replayWrite = new tasks.LambdaInvoke(
      this,
      'Replay write extracted CSV',
      {
        lambdaFunction: writeExtractedCsv,
        payloadResponseOnly: true,
        retryOnServiceExceptions: false,
      },
    );
    replayExtract.addRetry(retry);
    replayWrite.addRetry(retry);
    const replayWorkflow = new sfn.StateMachine(this, 'ReplayWorkflow', {
      stateMachineName: `${deployment.resourcePrefix}-replay`,
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(
        replayExtract.next(replayWrite),
      ),
      timeout: Duration.minutes(15),
      tracingEnabled: true,
    });

    const inboundRoute = deployment.ephemeral ?? deployment.environment;
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

    // Ephemeral stacks run under the local workload boundary, which grants no
    // CloudWatch alarm or SNS administration, and nobody watches them.
    if (!deployment.isEphemeral) {
      this.addAlarms({
        alarmEmailParameter,
        stateMachines: { Workflow: workflow, ReplayWorkflow: replayWorkflow },
        functions: {
          ProcessEmail: processEmail,
          ExtractText: extractText,
          WriteExtractedCsv: writeExtractedCsv,
          CompareRuns: compareRuns,
          MaterializeTrainingData: materializeTrainingData,
        },
        deadLetterQueue: workflowDlq,
        zeroRowExtractions: new cloudwatch.Metric({
          namespace: METRIC_NAMESPACE,
          metricName: ZERO_ROW_EXTRACTIONS_METRIC,
          dimensionsMap: {
            [FUNCTION_NAME_DIMENSION]: extractText.functionName,
          },
          statistic: cloudwatch.Stats.SUM,
          period: Duration.minutes(5),
        }),
      });
    }

    // The foundation owns the receipt rule set, its activation, and the shared
    // <alias>@<domain> rule. An ephemeral stack adds only its own
    // plus-addressed rule.
    if (deployment.ephemeral) {
      // The foundation publishes the alias and domain its shared rule serves,
      // so no committed file holds either. They resolve at deploy time;
      // process-email rejects mail to them once the foundation changes.
      const emailAlias = ssm.StringParameter.valueForStringParameter(
        this,
        emailAliasParameter,
      );
      new ses.CfnReceiptRule(this, 'StoreRawEmail', {
        ruleSetName: ssm.StringParameter.valueForStringParameter(
          this,
          `${prefix}/receipt-rule-set-name`,
        ),
        rule: {
          name: deployment.resourcePrefix,
          enabled: true,
          recipients: [
            Fn.join('', [emailAlias, `+${deployment.ephemeral}@`, emailDomain]),
          ],
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
    }

    new CfnOutput(this, 'StateMachineArn', {
      value: workflow.stateMachineArn,
    });
    new CfnOutput(this, 'ReplayStateMachineArn', {
      value: replayWorkflow.stateMachineArn,
    });
    new CfnOutput(this, 'RunComparisonFunctionName', {
      value: compareRuns.functionName,
    });
    new CfnOutput(this, 'TrainingDataMaterializerFunctionName', {
      value: materializeTrainingData.functionName,
    });
    new CfnOutput(this, 'ObjectPrefix', {
      value: deployment.objectPrefix || '(environment default)',
    });
  }

  /**
   * Every alarm fires on a single occurrence in a five-minute period and
   * treats missing data as healthy, because an idle pipeline emits nothing.
   */
  private addAlarms(sources: {
    alarmEmailParameter?: string;
    stateMachines: Record<string, sfn.StateMachine>;
    functions: Record<string, lambda.IFunction>;
    deadLetterQueue: sqs.IQueue;
    zeroRowExtractions: cloudwatch.IMetric;
  }): void {
    const prefix = this.deployment.resourcePrefix;
    const topic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `${prefix}-alarms`,
    });
    if (sources.alarmEmailParameter) {
      topic.addSubscription(
        new subscriptions.EmailSubscription(
          ssm.StringParameter.valueForStringParameter(
            this,
            sources.alarmEmailParameter,
          ),
        ),
      );
    }
    const action = new cloudwatchActions.SnsAction(topic);
    const alarm = (
      id: string,
      metric: cloudwatch.IMetric,
      description: string,
    ): void => {
      new cloudwatch.Alarm(this, `${id}Alarm`, {
        alarmName: `${prefix}-${id}`,
        alarmDescription: description,
        metric,
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(action);
    };

    for (const [id, stateMachine] of Object.entries(sources.stateMachines)) {
      alarm(
        `${id}ExecutionsFailed`,
        stateMachine.metricFailed(),
        `A ${id} execution failed.`,
      );
      alarm(
        `${id}ExecutionsTimedOut`,
        stateMachine.metricTimedOut(),
        `A ${id} execution timed out.`,
      );
    }
    alarm(
      'EventsDeadLetters',
      sources.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        statistic: cloudwatch.Stats.MAXIMUM,
      }),
      'EventBridge could not start the workflow for a received email.',
    );
    for (const [id, fn] of Object.entries(sources.functions)) {
      alarm(`${id}Errors`, fn.metricErrors(), `The ${id} Lambda failed.`);
    }
    alarm(
      'ZeroRowExtractions',
      sources.zeroRowExtractions,
      'A screenshot extraction succeeded without extracting any rows.',
    );
  }

  private logGroup(id: string, logGroupName: string): logs.LogGroup {
    return new logs.LogGroup(this, id, {
      logGroupName,
      retention:
        this.deployment.environment === 'prod'
          ? logs.RetentionDays.THREE_MONTHS
          : logs.RetentionDays.TWO_WEEKS,
      // Stable groups outlive the stack but are cleaned up if their creation rolls back,
      // so a failed first deploy cannot leave a fixed name behind.
      removalPolicy: this.deployment.ephemeral
        ? RemovalPolicy.DESTROY
        : RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
    });
  }

  private nodeFunction(
    id: string,
    fileName: string,
    environment: Record<string, string>,
    memorySize: number,
    includeSharp = false,
    timeout = Duration.minutes(2),
  ): lambdaNode.NodejsFunction {
    const repositoryRoot = path.join(__dirname, '..', '..', '..', '..');
    const functionName = `${this.deployment.resourcePrefix}-${id}`;
    return new lambdaNode.NodejsFunction(this, id, {
      functionName,
      entry: path.join(__dirname, '..', '..', 'src', 'lambdas', fileName),
      handler: 'handler',
      runtime: bundlingRuntime,
      architecture: lambda.Architecture.ARM_64,
      memorySize,
      logGroup: this.logGroup(`${id}Logs`, `/aws/lambda/${functionName}`),
      timeout,
      tracing: lambda.Tracing.ACTIVE,
      environment,
      projectRoot: repositoryRoot,
      depsLockFilePath: path.join(repositoryRoot, 'package-lock.json'),
      bundling: bundlingOptions(includeSharp, this.bundlingRequired),
    });
  }

  private grantEvidenceAccess(
    bucket: s3.IBucket,
    fn: lambdaNode.NodejsFunction,
    read: boolean,
  ): void {
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: read ? ['s3:GetObject', 's3:PutObject'] : ['s3:PutObject'],
        resources: [`${bucket.bucketArn}/*`],
      }),
    );
  }
}
