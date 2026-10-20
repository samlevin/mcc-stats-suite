import * as path from 'path';
import type { DeploymentConfig } from '@mcc/cdk-config';
import type {
  ExtractTextOutput,
  ProcessEmailInput,
  ProcessingRunInput,
  TraceContext,
  WorkflowKind,
  WriteGamertagCsvsInput,
} from '@mcc/contracts';
import {
  Aspects,
  CfnOutput,
  CfnResource,
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

/**
 * The Step Functions context each Lambda task payload carries (spec 1.3
 * §4.1). It is read when the task starts, so a retried attempt reports its
 * own retry count.
 */
function traceContext(workflow: WorkflowKind): TraceContext {
  return {
    executionId: sfn.JsonPath.executionId,
    retryCount: sfn.JsonPath.numberAt('$$.State.RetryCount'),
    workflow,
  };
}

/** The `extract-text` task payload in both workflows. */
function extractTextPayload(workflow: WorkflowKind): sfn.TaskInput {
  return sfn.TaskInput.fromObject({
    source: sfn.JsonPath.objectAt('$.source'),
    trace: traceContext(workflow),
  } satisfies Record<keyof ProcessingRunInput, unknown>);
}

/**
 * The `write-extracted-csv` task payload in both workflows: every field of
 * the `extract-text` output, with this task's own trace context.
 */
function writeExtractedCsvPayload(workflow: WorkflowKind): sfn.TaskInput {
  return sfn.TaskInput.fromObject({
    runId: sfn.JsonPath.stringAt('$.runId'),
    source: sfn.JsonPath.objectAt('$.source'),
    rows: sfn.JsonPath.listAt('$.rows'),
    normalizedArtifact: sfn.JsonPath.objectAt('$.normalizedArtifact'),
    roster: sfn.JsonPath.objectAt('$.roster'),
    trace: traceContext(workflow),
  } satisfies Record<keyof ExtractTextOutput, unknown>);
}

/**
 * Runs `withReceivedAt` when the state has `$.receivedAt` and
 * `withoutReceivedAt` otherwise. The EventBridge rule always sets
 * `receivedAt`, but a manual start may leave it out and `process-email` drops
 * a malformed one. A JSONPath payload field fails the execution when its path
 * is missing, so only the first branch may read `$.receivedAt`.
 */
function whenReceivedAt(
  scope: Construct,
  id: string,
  withReceivedAt: sfn.IChainable,
  withoutReceivedAt: sfn.IChainable,
): sfn.Choice {
  return new sfn.Choice(scope, id)
    .when(sfn.Condition.isPresent('$.receivedAt'), withReceivedAt)
    .otherwise(withoutReceivedAt);
}

interface MatchToCsvStackProps extends StackProps {
  deployment: DeploymentConfig;
  /** Commit recorded in Lambda environments and OCR evidence. */
  gitSha: string;
  /**
   * SSM parameter that holds the email address subscribed to alarms. The
   * address resolves at deploy time, so it never appears in source or in the
   * synthesized template. Without it, alarms still publish to the topic. Only
   * prod has alarms, so other stacks ignore it.
   */
  alarmEmailParameter?: string;
}

export class MatchToCsvStack extends Stack {
  private readonly deployment: DeploymentConfig;

  constructor(scope: Construct, id: string, props: MatchToCsvStackProps) {
    super(scope, id, {
      ...props,
      description:
        'Receive match screenshots by email, preserve OCR evidence, and export match and gamertag CSVs.',
    });
    Aspects.of(this).add({
      visit(node: IConstruct) {
        if (!(node instanceof CfnResource)) return;
        const owner = [node, ...node.node.scopes.slice().reverse()].find(
          (ancestor) =>
            ancestor.node.metadata.some(
              (entry) => entry.type === 'mcc:component',
            ),
        );
        const component = owner?.node.metadata.find(
          (entry) => entry.type === 'mcc:component',
        )?.data as { group: string; purpose: string } | undefined;
        node.addMetadata(
          'mcc:nameOrigin',
          node.cfnResourceType === 'AWS::IAM::Policy'
            ? 'CDK-generated'
            : 'explicitly configured',
        );
        node.addMetadata(
          'mcc:component',
          component ?? {
            group: 'Operational support',
            purpose: 'Support email-to-CSV processing and failure monitoring',
          },
        );
        if (node instanceof iam.CfnRole) {
          const ownerId = owner?.node.id ?? 'match-to-csv';
          const purpose = component?.purpose ?? 'support processing';
          // EventBridge targets create an EventsRole that EventBridge assumes
          // to start the target, not the target's own execution role.
          node.description =
            node.node.scope?.node.id === 'EventsRole'
              ? `Role EventBridge assumes to start ${ownerId} from stored-message events`
              : `Execution role for ${ownerId}: ${purpose}`;
        }
      },
    });

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

    // Required: process-email rejects every message while it is missing or
    // empty. Administrators manage it with `npm run sender-allowlist`; sender
    // addresses never live in source or OpenTofu state.
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
      'Email intake',
      'Validate sender and match date, then preserve attachments',
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
      'OCR',
      'Extract screenshot tables with Textract and resolve roster players',
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
      'CSV export',
      'Write extracted match tables and CSV evidence',
      'write-extracted-csv.ts',
      lambdaEnvironment,
      1024,
    );
    const writeGamertagCsvs = this.nodeFunction(
      'WriteGamertagCsvs',
      'CSV export',
      'Write per-gamertag CSV exports after every screenshot succeeds',
      'write-gamertag-csvs.ts',
      lambdaEnvironment,
      1024,
    );
    const compareRuns = this.nodeFunction(
      'CompareRuns',
      'Replay/evidence tools',
      'Compare immutable OCR runs for a submission',
      'compare-runs.ts',
      lambdaEnvironment,
      1024,
    );
    const materializeTrainingData = this.nodeFunction(
      'MaterializeTrainingData',
      'Replay/evidence tools',
      'Materialize selected evidence for OCR training',
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
    // The export reads each row's player resolution from the run's normalized
    // observations (spec 1.2 §6.2), and may read no other evidence object.
    const objectNamespace = deployment.objectPrefix
      ? `${deployment.objectPrefix}/`
      : '';
    writeExtractedCsv.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [
          `${evidenceBucket.bucketArn}/${objectNamespace}submissions/*/runs/*/normalized/observations.json`,
        ],
      }),
    );
    // The per-gamertag export reads each run's structured table and may only
    // create files under its submission's export prefix.
    writeGamertagCsvs.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [
          `${evidenceBucket.bucketArn}/${objectNamespace}submissions/*/runs/*/export/extracted-table.json`,
        ],
      }),
    );
    writeGamertagCsvs.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [
          `${evidenceBucket.bucketArn}/${objectNamespace}submissions/*/export/gamertags/*`,
        ],
      }),
    );
    this.grantEvidenceAccess(evidenceBucket, compareRuns, true);
    this.grantEvidenceAccess(evidenceBucket, materializeTrainingData, true);
    dataKey.grantEncryptDecrypt(processEmail);
    dataKey.grantEncryptDecrypt(extractText);
    dataKey.grantEncryptDecrypt(writeExtractedCsv);
    dataKey.grantEncryptDecrypt(writeGamertagCsvs);
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

    // Each step that passes `receivedAt` on has a variant without it, chosen
    // by whenReceivedAt.
    const processEmailTask = (id: string, payload: object) =>
      new tasks.LambdaInvoke(this, id, {
        lambdaFunction: processEmail,
        payloadResponseOnly: true,
        payload: sfn.TaskInput.fromObject(payload),
        retryOnServiceExceptions: false,
      });
    const processEmailPayload = {
      bucket: sfn.JsonPath.stringAt('$.bucket'),
      key: sfn.JsonPath.stringAt('$.key'),
      trace: traceContext('INGEST'),
    } satisfies Record<keyof Omit<ProcessEmailInput, 'receivedAt'>, unknown>;
    const processEmailTasks = [
      processEmailTask('Process email and attachments', {
        ...processEmailPayload,
        receivedAt: sfn.JsonPath.stringAt('$.receivedAt'),
      } satisfies Record<keyof ProcessEmailInput, unknown>),
      processEmailTask(
        'Process email and attachments without receivedAt',
        processEmailPayload,
      ),
    ] as const;
    const extractTextTask = new tasks.LambdaInvoke(this, 'Extract text', {
      lambdaFunction: extractText,
      payloadResponseOnly: true,
      payload: extractTextPayload('INGEST'),
      retryOnServiceExceptions: false,
    });
    const writeCsvTask = new tasks.LambdaInvoke(this, 'Write extracted CSV', {
      lambdaFunction: writeExtractedCsv,
      payloadResponseOnly: true,
      payload: writeExtractedCsvPayload('INGEST'),
      resultPath: '$.summary',
      retryOnServiceExceptions: false,
    });
    // Runs only after every Map item succeeds. Its input holds the export
    // keys, the match date, trace context and receivedAt when present, and
    // never a row, so no roster gamertag enters the state.
    const writeGamertagCsvsTask = (id: string, payload: object) =>
      new tasks.LambdaInvoke(this, id, {
        lambdaFunction: writeGamertagCsvs,
        payloadResponseOnly: true,
        payload: sfn.TaskInput.fromObject(payload),
        resultPath: '$.gamertagCsvs',
        retryOnServiceExceptions: false,
      });
    const writeGamertagCsvsPayload = {
      submissionId: sfn.JsonPath.stringAt('$.submissionId'),
      matchDate: sfn.JsonPath.stringAt('$.matchDate'),
      exports: sfn.JsonPath.listAt('$.results[*].summary'),
      trace: traceContext('INGEST'),
    } satisfies Record<
      keyof Omit<WriteGamertagCsvsInput, 'receivedAt'>,
      unknown
    >;
    const writeGamertagCsvsTasks = [
      writeGamertagCsvsTask('Write gamertag CSVs', {
        ...writeGamertagCsvsPayload,
        receivedAt: sfn.JsonPath.stringAt('$.receivedAt'),
      } satisfies Record<keyof WriteGamertagCsvsInput, unknown>),
      writeGamertagCsvsTask(
        'Write gamertag CSVs without receivedAt',
        writeGamertagCsvsPayload,
      ),
    ] as const;

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
    for (const task of [
      ...processEmailTasks,
      extractTextTask,
      writeCsvTask,
      ...writeGamertagCsvsTasks,
    ]) {
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
    // A whole-submission rejection is a result, not an error, so its
    // execution succeeds and the failure alarms fire only on real failures.
    const submissionResult = new sfn.Choice(this, 'Rejected?')
      .when(
        sfn.Condition.stringEquals('$.status', 'REJECTED'),
        new sfn.Succeed(this, 'Submission rejected'),
      )
      .otherwise(
        processAttachments.next(
          whenReceivedAt(
            this,
            'Email output has receivedAt',
            ...writeGamertagCsvsTasks,
          ),
        ),
      );

    const logGroup = this.logGroup(
      'WorkflowLogs',
      `/aws/vendedlogs/states/${deployment.resourcePrefix}`,
    );
    this.describe(
      logGroup,
      'Operational support',
      'Record email workflow execution details',
    );
    const workflow = new sfn.StateMachine(this, 'Workflow', {
      stateMachineName: deployment.resourcePrefix,
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(
        whenReceivedAt(this, 'Input has receivedAt', ...processEmailTasks)
          .afterwards()
          .next(submissionResult),
      ),
      timeout: Duration.minutes(15),
      logs: {
        destination: logGroup,
        level: sfn.LogLevel.ALL,
        includeExecutionData: true,
      },
      tracingEnabled: true,
    });
    this.describe(
      workflow,
      'Email intake',
      'Process stored email, OCR attachments, and export CSVs',
    );
    const replayExtract = new tasks.LambdaInvoke(this, 'Replay extract text', {
      lambdaFunction: extractText,
      payloadResponseOnly: true,
      payload: extractTextPayload('REPLAY'),
      retryOnServiceExceptions: false,
    });
    const replayWrite = new tasks.LambdaInvoke(
      this,
      'Replay write extracted CSV',
      {
        lambdaFunction: writeExtractedCsv,
        payloadResponseOnly: true,
        payload: writeExtractedCsvPayload('REPLAY'),
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

    this.describe(
      replayWorkflow,
      'Replay/evidence tools',
      'Create a new OCR run and CSV export from preserved evidence',
    );

    const inboundRoute = deployment.ephemeral ?? deployment.environment;
    const inboundPrefix = `incoming/${inboundRoute}/`;
    const workflowDlq = new sqs.Queue(this, 'WorkflowDlq', {
      queueName: `${deployment.resourcePrefix}-events-dlq`,
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    this.describe(
      workflowDlq,
      'Operational support',
      'Preserve events that could not start the email workflow',
    );
    const rawEmailCreated = new events.Rule(this, 'RawEmailCreated', {
      description:
        'Start email processing when S3 stores a message under this stack inbound prefix.',
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
          receivedAt: events.EventField.time,
        } satisfies Record<keyof Omit<ProcessEmailInput, 'trace'>, unknown>),
      }),
    );

    this.describe(
      rawEmailCreated,
      'Email intake',
      'Start the workflow for stored-message events under the stack inbound prefix',
    );

    // Only prod has alarms. Nobody watches dev or ephemeral stacks, and the
    // local workload boundary grants no CloudWatch alarm or SNS administration.
    if (deployment.environment === 'prod') {
      this.addAlarms({
        alarmEmailParameter,
        stateMachines: { Workflow: workflow, ReplayWorkflow: replayWorkflow },
        functions: {
          ProcessEmail: processEmail,
          ExtractText: extractText,
          WriteExtractedCsv: writeExtractedCsv,
          WriteGamertagCsvs: writeGamertagCsvs,
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
      const receiptRule = new ses.CfnReceiptRule(this, 'StoreRawEmail', {
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
      this.describe(
        receiptRule,
        'Email intake',
        'Store plus-addressed ephemeral email in the shared raw-message bucket',
      );
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
    this.describe(
      topic,
      'Operational support',
      'Publish pipeline failure alarms to operators',
    );
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
      const resource = new cloudwatch.Alarm(this, `${id}Alarm`, {
        alarmName: `${prefix}-${id}`,
        alarmDescription: description,
        metric,
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      resource.addAlarmAction(action);
      this.describe(resource, 'Operational support', description);
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
    group: string,
    purpose: string,
    fileName: string,
    environment: Record<string, string>,
    memorySize: number,
    includeSharp = false,
    timeout = Duration.minutes(2),
  ): lambdaNode.NodejsFunction {
    const repositoryRoot = path.join(__dirname, '..', '..', '..', '..');
    const functionName = `${this.deployment.resourcePrefix}-${id}`;
    const logGroup = this.logGroup(`${id}Logs`, `/aws/lambda/${functionName}`);
    this.describe(logGroup, group, `Logs for ${id}: ${purpose}`);
    const fn = new lambdaNode.NodejsFunction(this, id, {
      functionName,
      description: purpose,
      entry: path.join(__dirname, '..', '..', 'src', 'lambdas', fileName),
      handler: 'handler',
      runtime: bundlingRuntime,
      architecture: lambda.Architecture.ARM_64,
      memorySize,
      logGroup,
      timeout,
      tracing: lambda.Tracing.ACTIVE,
      environment,
      projectRoot: repositoryRoot,
      depsLockFilePath: path.join(repositoryRoot, 'package-lock.json'),
      bundling: bundlingOptions(includeSharp, this.bundlingRequired),
    });
    this.describe(fn, group, purpose);
    return fn;
  }

  private describe(
    construct: IConstruct,
    group: string,
    purpose: string,
  ): void {
    construct.node.addMetadata('mcc:component', { group, purpose });
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
