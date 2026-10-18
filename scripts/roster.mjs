#!/usr/bin/env node
// Maintains the gamertag roster (spec 6 §4.2, §6.1) with the operator's own AWS
// credentials. It writes the roster table directly, one change item and the
// HEAD item per change, under the same change-log rules every reader folds.
//
//   npm run roster -- --environment <dev|prod> [--ephemeral <name>]
//     [--profile <profile>] [--yes] <command>
//
// Gamertags come only from arguments and are printed only to the terminal. The
// script reads no input file and writes no file. Only the account check and the
// roster calls below reach AWS, through the AWS CLI with the checked profile.
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

// `npm run roster` builds @mcc/roster first (`npm run build:shared`).
const require = createRequire(import.meta.url);
const {
  RosterIntegrityError,
  checkChange,
  foldRoster,
  rosterKey,
  rosterSha256,
} = require('../packages/roster/dist/index.js');

export const USAGE = `Usage: npm run roster -- --environment <dev|prod> [--ephemeral <name>] [--profile <profile>] <command>

Commands:
  list [--inactive | --all]
  history [--after <version>]
  add <gamertag>... [--reason <text>] [--yes]
  deactivate <gamertag> [--reason <text>] [--yes]
  reactivate <gamertag> [--reason <text>] [--yes]

Writes to prod ask for confirmation unless --yes is given.
Exit status: 0 success, 1 refused change, 2 usage, account, transport or roster integrity error.`;

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_ERROR = 2;

// Spec 6 §6.1: a change whose transaction fails is tried again, 3 attempts in all.
export const MAX_WRITE_ATTEMPTS = 3;

// Change items per AWS CLI query call. The CLI buffers a whole response and
// Node's spawnSync keeps at most 1 MiB of it, so the log is read in pages this
// small: a change item holds at most a 256-character reason and one STS ARN.
export const CHANGE_PAGE_ITEMS = 100;

const VALUE_OPTIONS = new Set([
  '--environment',
  '--ephemeral',
  '--profile',
  '--reason',
  '--after',
]);
const FLAG_OPTIONS = new Set(['--yes', '--inactive', '--all']);
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
 * Parses the command line. Throws ExitError(2) for anything spec 6 §4.2 does
 * not list, so a mistyped command never reaches AWS.
 */
export function parseArguments(argv) {
  const options = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('-')) {
      positional.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (name in options) usage(`${argument} is given more than once`);
    if (VALUE_OPTIONS.has(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        usage(`${argument} requires a value`);
      }
      options[name] = value;
      index += 1;
    } else if (FLAG_OPTIONS.has(argument)) {
      options[name] = true;
    } else {
      usage(`Unknown option ${argument}`);
    }
  }
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
        ? `${command} takes no gamertag`
        : most === 1
          ? `${command} takes exactly one gamertag`
          : `${command} takes at least one gamertag`,
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
      usage('--after must be a roster version: 0 or a positive integer');
    }
    options.after = after;
  }
  return { command, operands, options };
}

function usage(message) {
  throw new ExitError(EXIT_ERROR, `${message}\n\n${USAGE}`);
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
    action: `roster ${command}`,
  });
  stdout(
    `Using ${environment}${ephemeral ? ` ephemeral ${ephemeral}` : ''} in AWS account ${caller.account}\n`,
  );

  const namespace = ephemeral ? `ephemeral/${ephemeral}` : 'stable';
  const store = rosterStore(aws, readTableName(aws, environment), namespace);
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
  for (const gamertag of operands) {
    await write(context, WRITE_ACTIONS[command], gamertag);
  }
}

function readTableName(aws, environment) {
  const name = `/mcc/${environment}/roster/table-name`;
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
      `${result.stderr ?? ''}Unable to read the roster table name from ${name}`,
    );
  }
  return table;
}

/**
 * Roster table access for one namespace: the `ROSTER#<namespace>` partition and
 * nothing else (spec 6 §5.1). Items use DynamoDB's typed JSON, as the AWS CLI
 * reads and writes it.
 */
export function rosterStore(aws, table, namespace) {
  const pk = `ROSTER#${namespace}`;
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
        rosterVersion: numberAttribute(Item, 'rosterVersion'),
        rosterSha256: stringAttribute(Item, 'rosterSha256'),
      };
    },
    // Reads change items 1 to `rosterVersion` in pages of CHANGE_PAGE_ITEMS,
    // passing each page's NextToken to the next call.
    readChanges(rosterVersion) {
      if (rosterVersion === 0) return [];
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
            ':last': { S: changeKey(rosterVersion) },
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
        .sort((left, right) => left.rosterVersion - right.rosterVersion);
    },
    // Spec 6 §6.1 step 5. Returns 'WRITTEN', 'CONDITION_FAILED' when HEAD
    // moved, or the CLI's error output when the outcome is unknown.
    appendChange(change, previousVersion) {
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
              rosterVersion: { N: String(change.rosterVersion) },
              rosterSha256: { S: change.rosterSha256 },
              updatedAt: { S: change.changedAt },
            },
            ...(previousVersion === 0
              ? { ConditionExpression: 'attribute_not_exists(sk)' }
              : {
                  ConditionExpression: 'rosterVersion = :version',
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

function changeKey(rosterVersion) {
  return `CHANGE#${String(rosterVersion).padStart(10, '0')}`;
}

function changeItem(pk, change) {
  return {
    pk: { S: pk },
    sk: { S: changeKey(change.rosterVersion) },
    schemaVersion: { S: change.schemaVersion },
    namespace: { S: change.namespace },
    rosterVersion: { N: String(change.rosterVersion) },
    action: { S: change.action },
    gamertagId: { S: change.gamertagId },
    gamertag: { S: change.gamertag },
    reason: change.reason === null ? { NULL: true } : { S: change.reason },
    actorArn: { S: change.actorArn },
    clientRequestId: { S: change.clientRequestId },
    changedAt: { S: change.changedAt },
    rosterSha256: { S: change.rosterSha256 },
  };
}

function changeFromItem(item) {
  return {
    schemaVersion: stringAttribute(item, 'schemaVersion'),
    namespace: stringAttribute(item, 'namespace'),
    rosterVersion: numberAttribute(item, 'rosterVersion'),
    action: stringAttribute(item, 'action'),
    gamertagId: stringAttribute(item, 'gamertagId'),
    gamertag: stringAttribute(item, 'gamertag'),
    reason: item.reason?.NULL ? null : stringAttribute(item, 'reason'),
    actorArn: stringAttribute(item, 'actorArn'),
    clientRequestId: stringAttribute(item, 'clientRequestId'),
    changedAt: stringAttribute(item, 'changedAt'),
    rosterSha256: stringAttribute(item, 'rosterSha256'),
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
  return new ExitError(EXIT_ERROR, `ROSTER_INTEGRITY: ${message}`);
}

/**
 * Spec 6 §6.1 step 2: reads HEAD with a consistent read, folds the change log
 * up to its version, and fails when the fold does not reproduce HEAD.
 */
function readRoster(store) {
  const head = store.readHead();
  const rosterVersion = head?.rosterVersion ?? 0;
  const changes = store.readChanges(rosterVersion);
  let roster;
  try {
    roster = foldRoster(changes);
  } catch (error) {
    if (error instanceof RosterIntegrityError) {
      throw integrityError(error.message);
    }
    throw error;
  }
  const sha = rosterSha256(roster.entries);
  if (
    roster.rosterVersion !== rosterVersion ||
    (head && head.rosterSha256 !== sha)
  ) {
    throw integrityError(
      `The change log does not reproduce HEAD version ${rosterVersion}`,
    );
  }
  return { rosterVersion, rosterSha256: sha, changes, roster };
}

function list({ store, stdout, options }) {
  const { rosterVersion, rosterSha256: sha, roster } = readRoster(store);
  const status = options.all ? null : options.inactive ? 'INACTIVE' : 'ACTIVE';
  const entries = roster.entries
    .filter((entry) => !status || entry.status === status)
    .sort(
      (left, right) =>
        compare(left.gamertag.toLowerCase(), right.gamertag.toLowerCase()) ||
        compare(left.gamertag, right.gamertag),
    );
  stdout(
    `Roster version ${rosterVersion}, sha256 ${sha}: ${entries.length} ${status ? `${status.toLowerCase()} ` : ''}entries\n`,
  );
  stdout(
    'gamertag\tstatus\tgamertagId\tmatchKey\taddedVersion\tlastChangedVersion\n',
  );
  for (const entry of entries) {
    stdout(
      `${entry.gamertag}\t${entry.status}\t${entry.gamertagId}\t${rosterKey(entry.gamertag)}\t${entry.addedVersion}\t${entry.lastChangedVersion}\n`,
    );
  }
}

function history({ store, stdout, options }) {
  const { rosterVersion, changes } = readRoster(store);
  const after = options.after ?? 0;
  stdout(`Roster version ${rosterVersion}: changes after version ${after}\n`);
  stdout(
    'rosterVersion\tchangedAt\taction\tgamertag\tgamertagId\tactorArn\treason\n',
  );
  for (const change of changes.filter((item) => item.rosterVersion > after)) {
    stdout(
      `${change.rosterVersion}\t${change.changedAt}\t${change.action}\t${change.gamertag}\t${change.gamertagId}\t${change.actorArn}\t${change.reason ?? ''}\n`,
    );
  }
}

/**
 * Spec 6 §6.1 for one gamertag: read and fold, replay by clientRequestId,
 * check with `checkChange`, then one conditional transaction, tried at most
 * MAX_WRITE_ATTEMPTS times with the same clientRequestId.
 */
async function write(context, action, gamertag) {
  const { store, stdout, options } = context;
  const clientRequestId = context.uuid();
  let confirmed = context.environment !== 'prod' || options.yes === true;
  let failure = 'CONDITION_FAILED';
  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
    const current = readRoster(store);
    const replay = current.changes.find(
      (change) => change.clientRequestId === clientRequestId,
    );
    if (replay) {
      stdout(
        `${PAST_TENSE[replay.action]} ${replay.gamertag} (${replay.gamertagId}) as roster version ${replay.rosterVersion}; this request was already recorded, so nothing more was written.\n`,
      );
      return;
    }
    const result = checkChange(
      current.roster,
      changeRequest(current.roster, action, gamertag, {
        clientRequestId,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
      }),
    );
    if (!result.accepted) refuse(result);

    const change = {
      schemaVersion: 'roster-change/v1',
      namespace: context.namespace,
      rosterVersion: current.rosterVersion + 1,
      action: result.action,
      gamertagId: result.gamertagId ?? context.evidenceId(),
      gamertag: result.gamertag,
      reason: result.reason,
      actorArn: context.actorArn,
      clientRequestId,
      changedAt: context.now().toISOString(),
      rosterSha256: '',
    };
    change.rosterSha256 = rosterSha256(
      foldRoster([change], current.roster).entries,
    );
    if (!confirmed) {
      describe(context, change, result.warnings);
      const answer = await context.confirm(
        `Type yes to write this change to ${context.environment}: `,
      );
      if (answer.trim() !== 'yes') {
        throw new ExitError(EXIT_REFUSED, 'Cancelled; nothing was written.');
      }
      confirmed = true;
    }

    failure = store.appendChange(change, current.rosterVersion);
    if (failure === 'WRITTEN') {
      stdout(
        `${PAST_TENSE[change.action]} ${change.gamertag} (${change.gamertagId}) as roster version ${change.rosterVersion}.\n`,
      );
      warn(context, result.warnings);
      return;
    }
  }
  if (failure === 'CONDITION_FAILED') {
    throw new ExitError(
      EXIT_REFUSED,
      `CONCURRENT_CHANGE: the roster changed during each of ${MAX_WRITE_ATTEMPTS} attempts; nothing was written. Run the command again.`,
    );
  }
  throw new ExitError(
    EXIT_ERROR,
    `${failure}The roster write failed ${MAX_WRITE_ATTEMPTS} times. Run history to see whether it was recorded.`,
  );
}

// Builds the `checkChange` request. Deactivate and reactivate find the entry by
// a case-insensitive exact match on the gamertag, as `list --all` shows it.
function changeRequest(roster, action, gamertag, body) {
  if (action === 'ADD') return { action, body: { ...body, gamertag } };
  const wanted = gamertag.trim().replace(/\s+/gu, ' ').toLowerCase();
  const matches = roster.entries.filter(
    (entry) => entry.gamertag.toLowerCase() === wanted,
  );
  if (matches.length !== 1) {
    refuse({
      code: 'GAMERTAG_NOT_FOUND',
      message:
        matches.length === 0
          ? 'No roster entry has this gamertag.'
          : 'More than one roster entry has this gamertag.',
      entries: matches,
    });
  }
  return { action, gamertagId: matches[0].gamertagId, body };
}

function refuse({ code, message, entries }) {
  const named = entries.map(
    (entry) => `\n  ${entry.gamertag} (${entry.status}, ${entry.gamertagId})`,
  );
  throw new ExitError(
    EXIT_REFUSED,
    `Refused: ${code}. ${message}${named.join('')}\nNothing was written.`,
  );
}

function describe({ stdout, environment, namespace }, change, warnings) {
  stdout(
    `Change to the ${environment} roster (namespace ${namespace}, version ${change.rosterVersion - 1} -> ${change.rosterVersion}):\n` +
      `  action    ${change.action}\n` +
      `  gamertag  ${change.gamertag}\n` +
      `  reason    ${change.reason ?? '(none)'}\n`,
  );
  warn({ stdout }, warnings);
}

function warn({ stdout }, warnings) {
  if (warnings.nearKeyGamertags.length === 0) return;
  stdout(
    `Warning: these active gamertags are one key edit away, so readings between them will not resolve: ${warnings.nearKeyGamertags.join(', ')}\n`,
  );
}

function compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

// Spec 1 §5.1: base-36 milliseconds, a hyphen, and a random UUID.
function evidenceId() {
  return `${Date.now().toString(36)}-${randomUUID()}`;
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
    evidenceId,
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
