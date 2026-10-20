#!/usr/bin/env node
// Maintains match-to-csv's sender allowlist, the SSM parameter
// /mcc/<environment>/match-to-csv/sender-allowlist, with the operator's own AWS
// credentials. `process-email` rejects every message while the parameter is
// missing or lists no address, so the script never deletes it and never
// removes its last address.
//
//   npm run sender-allowlist -- --environment <dev|prod> [--profile <profile>]
//     [--yes] <command>
//
// Addresses come only from arguments and are printed only to the terminal. The
// script reads no input file and writes no file. Only the account check and the
// parameter calls below reach AWS, through the AWS CLI with the checked profile.
// Parameter Store has no conditional write, so each write is read back and
// compared with the intended list and version.
import { CliError, CliHelp, defineCli, parseCli } from './cli.cjs';
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

// `npm run sender-allowlist` builds @mcc/recipients first
// (`npm run build:shared`), which holds the address rule.
const require = createRequire(import.meta.url);
const { normalizeAddress } = require('../packages/recipients/dist/index.js');

export const USAGE = `Usage: npm run sender-allowlist -- --environment <dev|prod> [--profile <profile>] <command>

Commands:
  list
  add <address>... [--yes]
  remove <address>... [--yes]

Dev stacks, including ephemeral ones, share the dev allowlist.
Writes to prod ask for confirmation unless --yes is given.
Exit status: 0 success, 1 refused change, 2 usage, account, transport or read-back error.`;

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_ERROR = 2;

// The parameter types process-email reads as plain text.
const SUPPORTED_TYPES = ['String', 'StringList'];

// A parsed From address never holds angle brackets or quotes, so an entry
// containing one would never match a sender.
const DISPLAY_CHARACTERS = /[<>"]/;

const CLI = defineCli(USAGE, ['environment', 'profile', 'yes']);
const GLOBAL_OPTIONS = ['--environment', '--profile'];
const COMMANDS = {
  list: { options: [], operands: [0, 0] },
  add: { options: ['--yes'], operands: [1, Infinity] },
  remove: { options: ['--yes'], operands: [1, Infinity] },
};

// Stops the command with an exit status and a message for stderr.
class ExitError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** The allowlist parameter name for an environment. */
export function parameterName(environment) {
  return `/mcc/${environment}/match-to-csv/sender-allowlist`;
}

/**
 * Splits a parameter value on commas and whitespace into lowercase addresses,
 * as `process-email` does.
 */
export function parseAllowlist(value) {
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.toLowerCase())
    .filter((entry) => entry.length > 0);
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
  const rule = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
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
        : `${command} takes at least one address`,
    );
  }
  if (!options.environment) usage('--environment is required');
  return { command, operands, options };
}

function usage(message) {
  throw new ExitError(EXIT_ERROR, `${message}\n\n${CLI.help}`);
}

/**
 * Runs one command and returns its exit status. Every effect goes through
 * `dependencies`, so tests replace AWS and the terminal.
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

  // The account check runs before any other AWS call, and its credentials
  // make every later call.
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
    action: `sender-allowlist ${command}`,
  });
  stdout(`Using ${environment} in AWS account ${caller.account}\n`);

  const context = {
    ...dependencies,
    store: parameterStore(aws, parameterName(environment)),
    environment,
    options,
  };
  if (command === 'list') return list(context);
  return write(context, command, operands);
}

/**
 * Reads and writes the one allowlist parameter. `read` returns
 * `{ type, value, version }`, or null when the parameter does not exist.
 * `write` returns the version Parameter Store assigned.
 */
export function parameterStore(aws, name) {
  return {
    name,
    read() {
      const result = aws([
        'ssm',
        'get-parameter',
        '--name',
        name,
        '--output',
        'json',
      ]);
      if (result.status !== 0) {
        if (/ParameterNotFound/.test(result.stderr ?? '')) return null;
        throw new ExitError(
          EXIT_ERROR,
          `${result.stderr ?? ''}Unable to read ${name}`,
        );
      }
      const parameter = parseJson(result.stdout, name)?.Parameter;
      if (
        typeof parameter?.Type !== 'string' ||
        typeof parameter.Value !== 'string' ||
        !Number.isSafeInteger(parameter.Version)
      ) {
        throw new ExitError(EXIT_ERROR, `Unexpected response reading ${name}`);
      }
      return {
        type: parameter.Type,
        value: parameter.Value,
        version: parameter.Version,
      };
    },
    // The value goes inside --cli-input-json, so the AWS CLI never reads it as
    // a file:// or URL argument.
    write({ type, value, overwrite }) {
      const result = aws([
        'ssm',
        'put-parameter',
        '--cli-input-json',
        JSON.stringify({
          Name: name,
          Type: type,
          Value: value,
          Overwrite: overwrite,
        }),
        '--output',
        'json',
      ]);
      if (result.status !== 0) {
        throw new ExitError(
          EXIT_ERROR,
          `${result.stderr ?? ''}Unable to write ${name}. Run list to see the saved allowlist.`,
        );
      }
      const version = parseJson(result.stdout, name)?.Version;
      if (!Number.isSafeInteger(version)) {
        throw new ExitError(
          EXIT_ERROR,
          `Unexpected response writing ${name}. Run list to see the saved allowlist.`,
        );
      }
      return version;
    },
  };
}

function parseJson(text, name) {
  try {
    return JSON.parse(text);
  } catch {
    throw new ExitError(EXIT_ERROR, `Unexpected response for ${name}`);
  }
}

/** Reads the parameter and refuses a type process-email cannot read. */
function readAllowlist(store) {
  const parameter = store.read();
  if (parameter && !SUPPORTED_TYPES.includes(parameter.type)) {
    throw new ExitError(
      EXIT_ERROR,
      `UNSUPPORTED_TYPE: ${store.name} is a ${parameter.type} parameter. process-email reads only String or StringList.`,
    );
  }
  return parameter;
}

function list({ store, stdout }) {
  const parameter = readAllowlist(store);
  if (!parameter) {
    stdout(
      `Sender allowlist ${store.name} does not exist. match-to-csv rejects every message until it lists an address.\n`,
    );
    return;
  }
  const addresses = parseAllowlist(parameter.value);
  stdout(
    `Sender allowlist ${store.name} (${parameter.type}, version ${parameter.version}): ${count(addresses.length)}\n`,
  );
  if (addresses.length === 0) {
    stdout('match-to-csv rejects every message until it lists an address.\n');
  }
  for (const address of addresses) stdout(`${address}\n`);
}

/**
 * Adds or removes addresses in one write: read, check, confirm in prod, write
 * the whole list, then read it back.
 */
async function write(context, command, operands) {
  const { store, stdout, environment, options } = context;
  const current = readAllowlist(store);
  const before = current ? parseAllowlist(current.value) : [];
  const after =
    command === 'add' ? added(before, operands) : removed(before, operands);
  const type = current?.type ?? 'StringList';
  const changed = operands.map((operand) => operand.trim().toLowerCase());

  if (environment === 'prod' && options.yes !== true) {
    stdout(
      `Change to the prod sender allowlist ${store.name} (${current ? `${type}, version ${current.version}` : `new ${type}`}):\n` +
        changed
          .map((address) => `  ${command.padEnd(7)}${address}\n`)
          .join('') +
        `  result ${count(after.length)}\n`,
    );
    const answer = await context.confirm(
      'Type yes to write this change to prod: ',
    );
    if (answer.trim() !== 'yes') {
      throw new ExitError(EXIT_REFUSED, 'Cancelled; nothing was written.');
    }
  }

  const version = store.write({
    type,
    value: after.join(','),
    overwrite: current !== null,
  });
  const saved = store.read();
  const savedAddresses = saved ? parseAllowlist(saved.value) : null;
  const expectedVersion = current ? current.version + 1 : version;
  if (
    !saved ||
    saved.type !== type ||
    saved.version !== version ||
    version !== expectedVersion ||
    savedAddresses.join(',') !== after.join(',')
  ) {
    throw new ExitError(
      EXIT_ERROR,
      `READ_BACK_MISMATCH: ${store.name} does not hold the intended list. Another change may have been saved at the same time.\n` +
        `  intended ${type}, version ${expectedVersion}: ${after.join(', ')}\n` +
        `  saved    ${saved ? `${saved.type}, version ${saved.version}: ${savedAddresses.join(', ')}` : 'no parameter'}\n` +
        'Run list, then repeat the change if it is still needed.',
    );
  }
  stdout(
    `${command === 'add' ? 'Added' : 'Removed'} ${changed.join(', ')}. ${store.name} is version ${saved.version} with ${count(after.length)}. Running stacks use it within one minute.\n`,
  );
}

function added(before, operands) {
  const after = [...before];
  for (const operand of operands) {
    const address = DISPLAY_CHARACTERS.test(operand)
      ? null
      : normalizeAddress(operand)?.toLowerCase();
    if (!address) {
      refuse('INVALID_ADDRESS', `${operand.trim()} is not a valid address.`);
    }
    if (after.includes(address)) {
      refuse('ALREADY_LISTED', `${address} is already on the allowlist.`);
    }
    after.push(address);
  }
  return after;
}

function removed(before, operands) {
  let after = [...before];
  for (const operand of operands) {
    const address = operand.trim().toLowerCase();
    if (!after.includes(address)) {
      refuse('NOT_LISTED', `${address} is not on the allowlist.`);
    }
    after = after.filter((entry) => entry !== address);
  }
  if (after.length === 0) {
    refuse(
      'LAST_ADDRESS',
      'The allowlist must keep at least one address, because match-to-csv rejects every message without one. Add the replacement address first.',
    );
  }
  return after;
}

function refuse(code, message) {
  throw new ExitError(
    EXIT_REFUSED,
    `Refused: ${code}. ${message}\nNothing was written.`,
  );
}

function count(addresses) {
  return `${addresses} ${addresses === 1 ? 'address' : 'addresses'}`;
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
    confirm,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main(process.argv.slice(2));
}
