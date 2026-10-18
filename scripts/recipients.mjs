#!/usr/bin/env node
// Maintains the CSV recipient list (spec 1.1 §4.5) with the operator's own AWS
// credentials. It writes the recipient table directly, one change item and the
// HEAD item per change, under the same change-log rules every reader folds.
// It follows the roster script's rules (spec 1.2 §4.2, §6.1).
//
//   npm run recipients -- --environment <dev|prod> [--ephemeral <name>]
//     [--profile <profile>] [--yes] <command>
//
// Addresses come only from arguments and are printed only to the terminal. The
// script reads no input file and writes no file. Only the account check and the
// recipient table calls below reach AWS, through the AWS CLI with the checked
// profile.
import { CliError, CliHelp, defineCli, parseCli } from './cli.cjs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import {
  AccountGuardError,
  awsCli,
  profileSsoAccount,
  resolveEnvironment,
  resolveExpectedAccount,
  verifyCallerAccount,
} from './account-guard.mjs';
import { ephemeralNameError } from './cdk-targets.mjs';

// `npm run recipients` builds @mcc/recipients first (`npm run build:shared`).
const require = createRequire(import.meta.url);
const {
  RecipientsIntegrityError,
  checkRecipientChange,
  foldRecipients,
  recipientsSha256,
} = require('../packages/recipients/dist/index.js');

export const USAGE = `Usage: npm run recipients -- --environment <dev|prod> [--ephemeral <name>] [--profile <profile>] <command>

Commands:
  list [--inactive | --all]
  history [--after <version>]
  add <address>... [--reason <text>] [--yes]
  deactivate <address> [--reason <text>] [--yes]
  reactivate <address> [--reason <text>] [--yes]

Writes to prod ask for confirmation unless --yes is given.
Exit status: 0 success, 1 refused change, 2 usage, account, transport or recipient list integrity error.`;

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_ERROR = 2;

// A change whose transaction fails is tried again, 3 attempts in all.
export const MAX_WRITE_ATTEMPTS = 3;

// Change items per AWS CLI query call. The CLI buffers a whole response and
// Node's spawnSync keeps at most 1 MiB of it, so the log is read in pages this
// small: a change item holds at most a 254-character address, a 256-character
// reason and one STS ARN.
export const CHANGE_PAGE_ITEMS = 100;

const CLI = defineCli(USAGE, [
  'environment',
  'ephemeral',
  'profile',
  'reason',
  'after',
  'yes',
  'inactive',
  'all',
]);
const GLOBAL_OPTIONS = ['--environment', '--ephemeral', '--profile'];
const WRITE_OPTIONS = ['--reason', '--yes'];
const COMMANDS = {
  list: { options: ['--inactive', '--all'], operands: [0, 0] },
  history: { options: ['--after'], operands: [0, 0] },
  add: { options: WRITE_OPTIONS, operands: [1, Infinity] },
  deactivate: { options: WRITE_OPTIONS, operands: [1, 1] },
  reactivate: { options: WRITE_OPTIONS, operands: [1, 1] },
};
const WRITE_ACTIONS = {
  add: 'ADD',
  deactivate: 'DEACTIVATE',
  reactivate: 'REACTIVATE',
};
const PAST_TENSE = {
  ADD: 'Added',
  DEACTIVATE: 'Deactivated',
  REACTIVATE: 'Reactivated',
};

// Stops the command with an exit status and a message for stderr.
class ExitError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Parses the command line. Throws ExitError(2) for anything the usage does not
 * list, so a mistyped command never reaches AWS.
 */
export function parseArguments(argv) {
  let parsed;
  try {
    parsed = parseCli(argv, CLI);
  } catch (error) {
    if (error instanceof CliError)
      throw new ExitError(EXIT_ERROR, error.message);
    throw error;
  }
  const { options, positionals: positional } = parsed;
  const [command, ...operands] = positional;
  const rule = COMMANDS[command];
  if (!rule) usage(command ? `Unknown command ${command}` : 'Name a command');
  for (const name of Object.keys(options)) {
    if (![...GLOBAL_OPTIONS, ...rule.options].includes(`--${name}`)) {
      usage(`${command} does not accept --${name}`);
    }
  }
  const [fewest, most] = rule.operands;
  if (operands.length < fewest || operands.length > most) {
    usage(
      most === 0
        ? `${command} takes no address`
        : most === 1
          ? `${command} takes exactly one address`
          : `${command} takes at least one address`,
    );
  }
  if (!options.environment) usage('--environment is required');
  if (options.inactive && options.all) {
    usage('--inactive and --all cannot be combined');
  }
  if (options.after !== undefined) {
    const after = /^(0|[1-9][0-9]*)$/.test(options.after)
      ? Number(options.after)
      : NaN;
    if (!Number.isSafeInteger(after)) {
      usage('--after must be a recipients version: 0 or a positive integer');
    }
    options.after = after;
  }
  return { command, operands, options };
}

function usage(message) {
  throw new ExitError(EXIT_ERROR, `${message}\n\n${CLI.help}`);
}

/**
 * Runs one command and returns its exit status. Every effect goes through
 * `dependencies`, so tests replace AWS, the clock, IDs and the terminal.
 */
export async function main(argv, dependencies = defaultDependencies()) {
  const { stderr } = dependencies;
  try {
    await run(parseArguments(argv), dependencies);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof CliHelp) {
      dependencies.stdout(`${error.message}\n`);
      return EXIT_OK;
    }
    if (error instanceof ExitError) {
      stderr(`${error.message}\n`);
      return error.status;
    }
    if (error instanceof AccountGuardError) {
      stderr(error.detail);
      stderr(`${error.message}\n`);
      return EXIT_ERROR;
    }
    stderr(`${error.stack ?? error}\n`);
    return EXIT_ERROR;
  }
}

async function run({ command, operands, options }, dependencies) {
  const { env, stdout } = dependencies;
  const profile = options.profile ?? env.AWS_PROFILE;
  const environment = resolveEnvironment(options.environment, profile);
  const ephemeral = options.ephemeral;
  if (environment === 'prod' && ephemeral) {
    throw new ExitError(EXIT_ERROR, 'Production does not support --ephemeral');
  }
  if (ephemeral) {
    const nameError = ephemeralNameError(ephemeral);
    if (nameError) throw new ExitError(EXIT_ERROR, nameError);
  }

  // The account check runs before any other AWS call, and its credentials
  // make every later call, so the checked caller is the recorded actor.
  const aws = dependencies.awsCli(profile);
  const { account: expected, source } = resolveExpectedAccount({
    environment,
    profile,
    needsAws: true,
    env,
    readSsoAccount: () => profileSsoAccount(aws),
  });
  const caller = verifyCallerAccount({
    run: aws,
    expected,
    source,
    action: `recipients ${command}`,
  });
  stdout(
    `Using ${environment}${ephemeral ? ` ephemeral ${ephemeral}` : ''} in AWS account ${caller.account}\n`,
  );

  const namespace = ephemeral ? `ephemeral/${ephemeral}` : 'stable';
  const store = recipientStore(aws, readTableName(aws, environment), namespace);
  const context = {
    ...dependencies,
    store,
    environment,
    namespace,
    actorArn: caller.arn,
    options,
  };
  if (command === 'list') return list(context);
  if (command === 'history') return history(context);
  for (const address of operands) {
    await write(context, WRITE_ACTIONS[command], address);
  }
}

function readTableName(aws, environment) {
  const name = `/mcc/${environment}/recipients/table-name`;
  const result = aws([
    'ssm',
    'get-parameter',
    '--name',
    name,
    '--query',
    'Parameter.Value',
    '--output',
    'text',
  ]);
  const table = result.status === 0 ? result.stdout.trim() : '';
  if (!table) {
    throw new ExitError(
      EXIT_ERROR,
      `${result.stderr ?? ''}Unable to read the recipient table name from ${name}`,
    );
  }
  return table;
}

/**
 * Recipient table access for one namespace: the `RECIPIENTS#<namespace>`
 * partition and nothing else. Items use DynamoDB's typed JSON, as the AWS CLI
 * reads and writes it.
 */
export function recipientStore(aws, table, namespace) {
  const pk = `RECIPIENTS#${namespace}`;
  const call = (args) => {
    const result = aws([...args, '--output', 'json']);
    if (result.status !== 0) {
      throw new ExitError(
        EXIT_ERROR,
        `${result.stderr ?? ''}DynamoDB ${args[1]} failed on ${table}`,
      );
    }
    return result.stdout.trim() ? JSON.parse(result.stdout) : {};
  };
  return {
    readHead() {
      const { Item } = call([
        'dynamodb',
        'get-item',
        '--table-name',
        table,
        '--key',
        JSON.stringify({ pk: { S: pk }, sk: { S: 'HEAD' } }),
        '--consistent-read',
      ]);
      if (!Item) return null;
      return {
        recipientsVersion: numberAttribute(Item, 'recipientsVersion'),
        recipientsSha256: stringAttribute(Item, 'recipientsSha256'),
      };
    },
    // Reads change items 1 to `recipientsVersion` in pages of
    // CHANGE_PAGE_ITEMS, passing each page's NextToken to the next call.
    readChanges(recipientsVersion) {
      if (recipientsVersion === 0) return [];
      const items = [];
      let startingToken;
      do {
        const { Items = [], NextToken } = call([
          'dynamodb',
          'query',
          '--table-name',
          table,
          '--key-condition-expression',
          'pk = :pk AND sk BETWEEN :first AND :last',
          '--expression-attribute-values',
          JSON.stringify({
            ':pk': { S: pk },
            ':first': { S: changeKey(1) },
            ':last': { S: changeKey(recipientsVersion) },
          }),
          '--consistent-read',
          '--page-size',
          String(CHANGE_PAGE_ITEMS),
          '--max-items',
          String(CHANGE_PAGE_ITEMS),
          ...(startingToken ? ['--starting-token', startingToken] : []),
        ]);
        items.push(...Items);
        startingToken = NextToken;
      } while (startingToken);
      return items
        .map(changeFromItem)
        .sort(
          (left, right) => left.recipientsVersion - right.recipientsVersion,
        );
    },
    // Puts the change item and HEAD in one transaction. Returns 'WRITTEN',
    // 'CONDITION_FAILED' when HEAD moved, or the CLI's error output when the
    // outcome is unknown.
    appendChange(change, recipientsSha, previousVersion) {
      const items = [
        {
          Put: {
            TableName: table,
            Item: changeItem(pk, change),
            ConditionExpression: 'attribute_not_exists(sk)',
          },
        },
        {
          Put: {
            TableName: table,
            Item: {
              pk: { S: pk },
              sk: { S: 'HEAD' },
              recipientsVersion: { N: String(change.recipientsVersion) },
              recipientsSha256: { S: recipientsSha },
              updatedAt: { S: change.changedAt },
            },
            ...(previousVersion === 0
              ? { ConditionExpression: 'attribute_not_exists(sk)' }
              : {
                  ConditionExpression: 'recipientsVersion = :version',
                  ExpressionAttributeValues: {
                    ':version': { N: String(previousVersion) },
                  },
                }),
          },
        },
      ];
      const result = aws([
        'dynamodb',
        'transact-write-items',
        '--transact-items',
        JSON.stringify(items),
        '--output',
        'json',
      ]);
      if (result.status === 0) return 'WRITTEN';
      const output = result.stderr ?? '';
      return /\(TransactionCanceledException\)/.test(output) &&
        /ConditionalCheckFailed|TransactionConflict/.test(output)
        ? 'CONDITION_FAILED'
        : output || 'The transaction failed with no error output';
    },
  };
}

function changeKey(recipientsVersion) {
  return `CHANGE#${String(recipientsVersion).padStart(10, '0')}`;
}

function changeItem(pk, change) {
  return {
    pk: { S: pk },
    sk: { S: changeKey(change.recipientsVersion) },
    recipientsVersion: { N: String(change.recipientsVersion) },
    action: { S: change.action },
    recipientId: { S: change.recipientId },
    address: { S: change.address },
    reason: change.reason === null ? { NULL: true } : { S: change.reason },
    actorArn: { S: change.actorArn },
    clientRequestId: { S: change.clientRequestId },
    changedAt: { S: change.changedAt },
  };
}

function changeFromItem(item) {
  return {
    recipientsVersion: numberAttribute(item, 'recipientsVersion'),
    action: stringAttribute(item, 'action'),
    recipientId: stringAttribute(item, 'recipientId'),
    address: stringAttribute(item, 'address'),
    reason: item.reason?.NULL ? null : stringAttribute(item, 'reason'),
    actorArn: stringAttribute(item, 'actorArn'),
    clientRequestId: stringAttribute(item, 'clientRequestId'),
    changedAt: stringAttribute(item, 'changedAt'),
  };
}

function stringAttribute(item, name) {
  const value = item[name]?.S;
  if (typeof value !== 'string') {
    throw integrityError(`Item ${item.sk?.S ?? '?'} has no string ${name}`);
  }
  return value;
}

function numberAttribute(item, name) {
  const value = Number(item[name]?.N);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw integrityError(`Item ${item.sk?.S ?? '?'} has no number ${name}`);
  }
  return value;
}

function integrityError(message) {
  return new ExitError(EXIT_ERROR, `RECIPIENTS_INTEGRITY: ${message}`);
}

/**
 * Reads HEAD with a consistent read, folds the change log up to its version,
 * and fails when the fold does not reproduce HEAD.
 */
function readRecipients(store) {
  const head = store.readHead();
  const recipientsVersion = head?.recipientsVersion ?? 0;
  const changes = store.readChanges(recipientsVersion);
  let recipients;
  try {
    recipients = foldRecipients(changes);
  } catch (error) {
    if (error instanceof RecipientsIntegrityError) {
      throw integrityError(error.message);
    }
    throw error;
  }
  const sha = recipientsSha256(recipients.entries);
  if (
    recipients.recipientsVersion !== recipientsVersion ||
    (head && head.recipientsSha256 !== sha)
  ) {
    throw integrityError(
      `The change log does not reproduce HEAD version ${recipientsVersion}`,
    );
  }
  return { recipientsVersion, recipientsSha256: sha, changes, recipients };
}

function list({ store, stdout, options }) {
  const {
    recipientsVersion,
    recipientsSha256: sha,
    recipients,
  } = readRecipients(store);
  const status = options.all ? null : options.inactive ? 'INACTIVE' : 'ACTIVE';
  const entries = recipients.entries
    .filter((entry) => !status || entry.status === status)
    .sort(
      (left, right) =>
        compare(left.address.toLowerCase(), right.address.toLowerCase()) ||
        compare(left.address, right.address),
    );
  stdout(
    `Recipients version ${recipientsVersion}, sha256 ${sha}: ${entries.length} ${status ? `${status.toLowerCase()} ` : ''}entries\n`,
  );
  stdout('address\tstatus\trecipientId\taddedVersion\tlastChangedVersion\n');
  for (const entry of entries) {
    stdout(
      `${entry.address}\t${entry.status}\t${entry.recipientId}\t${entry.addedVersion}\t${entry.lastChangedVersion}\n`,
    );
  }
}

function history({ store, stdout, options }) {
  const { recipientsVersion, changes } = readRecipients(store);
  const after = options.after ?? 0;
  stdout(
    `Recipients version ${recipientsVersion}: changes after version ${after}\n`,
  );
  stdout(
    'recipientsVersion\tchangedAt\taction\taddress\trecipientId\tactorArn\treason\n',
  );
  for (const change of changes.filter(
    (item) => item.recipientsVersion > after,
  )) {
    stdout(
      `${change.recipientsVersion}\t${change.changedAt}\t${change.action}\t${change.address}\t${change.recipientId}\t${change.actorArn}\t${change.reason ?? ''}\n`,
    );
  }
}

/**
 * One address: read and fold, replay by clientRequestId, check with
 * `checkRecipientChange`, then one conditional transaction, tried at most
 * MAX_WRITE_ATTEMPTS times with the same clientRequestId.
 */
async function write(context, action, address) {
  const { store, stdout, options } = context;
  const clientRequestId = context.uuid();
  let confirmed = context.environment !== 'prod' || options.yes === true;
  let failure = 'CONDITION_FAILED';
  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
    const current = readRecipients(store);
    const replay = current.changes.find(
      (change) => change.clientRequestId === clientRequestId,
    );
    if (replay) {
      stdout(
        `${PAST_TENSE[replay.action]} ${replay.address} (${replay.recipientId}) as recipients version ${replay.recipientsVersion}; this request was already recorded, so nothing more was written.\n`,
      );
      return;
    }
    const result = checkRecipientChange(current.recipients, {
      action,
      address,
      clientRequestId,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    });
    if (!result.accepted) refuse(result);

    const change = {
      recipientsVersion: current.recipientsVersion + 1,
      action: result.action,
      recipientId: result.recipientId ?? context.uuid(),
      address: result.address,
      reason: result.reason,
      actorArn: context.actorArn,
      clientRequestId,
      changedAt: context.now().toISOString(),
    };
    const sha = recipientsSha256(
      foldRecipients([change], current.recipients).entries,
    );
    if (!confirmed) {
      describe(context, change);
      const answer = await context.confirm(
        `Type yes to write this change to ${context.environment}: `,
      );
      if (answer.trim() !== 'yes') {
        throw new ExitError(EXIT_REFUSED, 'Cancelled; nothing was written.');
      }
      confirmed = true;
    }

    failure = store.appendChange(change, sha, current.recipientsVersion);
    if (failure === 'WRITTEN') {
      stdout(
        `${PAST_TENSE[change.action]} ${change.address} (${change.recipientId}) as recipients version ${change.recipientsVersion}.\n`,
      );
      return;
    }
  }
  if (failure === 'CONDITION_FAILED') {
    throw new ExitError(
      EXIT_REFUSED,
      `CONCURRENT_CHANGE: the recipient list changed during each of ${MAX_WRITE_ATTEMPTS} attempts; nothing was written. Run the command again.`,
    );
  }
  throw new ExitError(
    EXIT_ERROR,
    `${failure}The recipient list write failed ${MAX_WRITE_ATTEMPTS} times. Run history to see whether it was recorded.`,
  );
}

function refuse({ code, message, entries }) {
  const named = entries.map(
    (entry) => `\n  ${entry.address} (${entry.status}, ${entry.recipientId})`,
  );
  throw new ExitError(
    EXIT_REFUSED,
    `Refused: ${code}. ${message}${named.join('')}\nNothing was written.`,
  );
}

function describe({ stdout, environment, namespace }, change) {
  stdout(
    `Change to the ${environment} recipient list (namespace ${namespace}, version ${change.recipientsVersion - 1} -> ${change.recipientsVersion}):\n` +
      `  action   ${change.action}\n` +
      `  address  ${change.address}\n` +
      `  reason   ${change.reason ?? '(none)'}\n`,
  );
}

function compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

async function confirm(question) {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    // Closed input, such as end of file, counts as no.
    return await new Promise((resolve) => {
      terminal.once('close', () => resolve(''));
      terminal.question(question).then(resolve, () => resolve(''));
    });
  } finally {
    terminal.close();
  }
}

export function defaultDependencies() {
  return {
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    awsCli: (profile) => (args) => awsCli(profile, args, process.env),
    uuid: randomUUID,
    now: () => new Date(),
    confirm,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main(process.argv.slice(2));
}
