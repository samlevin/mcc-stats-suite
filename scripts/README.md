# Repository command lines

Repository-owned Node commands use `scripts/cli.cjs`, with declarations separate from command execution. It uses the supported Node runtime's `node:util.parseArgs` and adds no dependencies. The helper handles exact aliases, duplicates, help, and usage errors; each command keeps its domain checks and exit statuses. CommonJS lets both the root ES modules and the TypeScript fixture utilities load the same implementation. The fixture utilities resolve it from their workspace package so source and compiled commands use the same file.

## Getting started

Install the [pinned Node.js/npm](../docs/getting-started.md#tier-1-run-the-checks-locally) and run `npm ci` from the repository root. Run all commands below from that root, even though this README lives in `scripts/`. Roster, recipient, and sender allowlist commands also need built shared packages; their `npm run` entry points build them automatically. AWS commands need an authenticated profile. Keep command output containing private values local.

## Scripts reference

Use `--help` on commands with declared options. The [root reference](../README.md#scripts-reference) lists NPM entry points, including build and formatting tools. Internal modules (`cli.cjs`, account guards, CDK targets, CI scope classification, and infrastructure merge-gate evaluation) are imported by commands or workflows and have no standalone command to run. Tests run through `npm test`.

| Script | Purpose | Arguments |
| --- | --- | --- |
| `node scripts/cdk-app.mjs` | Run guarded CDK operations for one application | Required `<synth\|diff\|deploy\|destroy> <application>`; optional `--environment dev\|prod` (profile-derived, then `dev`), `--ephemeral <name>`, `--profile <profile>` (defaults to `AWS_PROFILE`), and CDK arguments. Prefer the [NPM wrappers and their deployment restrictions](../README.md#scripts-reference) |
| `npm run roster`, `npm run recipients` | Read or change gamertags or CSV recipient addresses | Required `--environment dev\|prod` and command; optional flags and operand counts are in [Operator arguments](#operator-arguments). Pass arguments after `--` |
| `npm run sender-allowlist` | Read or change the `match-to-csv` sender allowlist parameter | Required `--environment dev\|prod` and `list`, `add <address>...`, or `remove <address>...`; optional `--profile <profile>` (defaults to `AWS_PROFILE`) and `--yes` for prod writes. Pass arguments after `--`. Rules are in [Manage the sender allowlist](../docs/self-hosting/50-deploy-and-release-applications.md#manage-the-sender-allowlist) |
| `node scripts/release-metadata.mjs` | Check release metadata or print one application's metadata | Required `--check` or `--application <name>`; no default mode |
| `node scripts/local-cdk-bootstrap.mjs` | Rewrite `infrastructure/dev/local-cdk/bootstrap-template.json` offline | None |
| `node scripts/ci-checks.mjs` | Run CI-selected checks | None; requires `CI_BASE`, `CI_HEAD`, `CI_FULL`, `CI_REPOSITORY`, and `CI_MODE` environment inputs. `CI_JOB` defaults to `static`; [the implementation](ci-checks.mjs) lists job choices |
| `bash scripts/tofu-checks.sh` | Check OpenTofu pins, formatting, validation, and module tests | None; optional `--pinned-version` prints the pinned version and exits |

The tracker, delivery queue, branch name, spec filing, agent generation, review publishing, and workflow lint commands come from the `@agenticool/*` devDependencies: `npx agenticool-tracker`, `npx agenticool-delivery`, `npx agenticool-spec`, `npx agenticool-agents`, and `npx agenticool-workflow-lint`. Each package README in `node_modules/@agenticool/` lists its commands, and `--help` prints their options. See the [application script reference](../applications/match-to-csv/README.md#scripts-reference) for fixture capture, reduction, and bundle verification.

### Operator arguments

For both `roster` and `recipients`, `--environment dev|prod` is required. Optional `--profile <profile>` defaults to `AWS_PROFILE`; omitting `--ephemeral <name>` selects `stable`. Ephemeral namespaces are dev-only. Writes to prod ask for confirmation unless `--yes` is given. Run `npm run roster -- --help` or `npm run recipients -- --help` for usage.

| Script | Purpose | Arguments |
| --- | --- | --- |
| `list` | List active entries | Optional `--inactive` or `--all`; defaults to active entries |
| `history` | List changes after a version | Optional `--after <version>`; defaults to `0` |
| `add` | Add entries | Required one or more gamertags/addresses; optional `--reason <text>` (omitted by default), `--yes` |
| `deactivate`, `reactivate` | Change an entry's active status | Required exactly one gamertag/address; optional `--reason <text>` (omitted by default), `--yes` |

For example, `npm run roster -- --environment dev --profile <admin-profile> --ephemeral example list --all` lists every entry in that ephemeral namespace. AWS permissions and privacy cautions are in [Configure players and addresses](../applications/match-to-csv/README.md#configure-players-and-addresses).

## Options and values

Every migrated command accepts `-h` or `--help`. Help exits successfully before command execution. String options accept a space or an equals sign: `-env dev`, `-env=dev`, `--environment dev`, and `--environment=dev` are equivalent. Use equals for a value beginning with a dash, such as `--reason=--help`; quote a value containing spaces. Values are never rewritten. Empty values fail except for `--reason=`, which supplies an empty reason.

Aliases are exact tokens. `-env` means environment; it is never `-e` plus `nv` or a group of flags. Attached forms such as `-envdev` and grouped short flags are unsupported. Only declared options are normalized. Unknown options fail with usage, except for CDK passthrough. Repeating an option, including through two spellings with the same value, fails. Commands reject conflicting selections such as `--all --inactive`.

`--` ends option parsing. Roster, recipients, sender allowlist, and fixture capture treat following arguments as operands, including names beginning with a dash. CDK forwards the marker and everything after it unchanged. CDK passthrough spellings and order stay intact, and prohibited deployment options remain subject to the wrapper's guards. Use equals when a CDK option's value resembles a wrapper option, such as `--output=-env`.

| Long option | Alias | Commands |
| --- | --- | --- |
| `--help` | `-h` | Every migrated command |
| `--environment` | `-env` | CDK wrapper, roster, recipients, sender allowlist |
| `--ephemeral` | `-e` | CDK wrapper, roster, recipients |
| `--profile` | `-p` | CDK wrapper, roster, recipients, sender allowlist |
| `--yes` | `-y` | Roster, recipient, and sender allowlist writes |
| `--reason` | `-r` | Roster and recipient writes |
| `--application` | `-a` | Release metadata |
| `--output` | `-o` | Fixture reduction |

Other options retain their long names. Each command's help lists the options it accepts. Aliases are scoped to a command. CDK's `-r` and `-m` remain passthrough options, with the existing ephemeral deployment restrictions. The wrapper owns `-e`, `-p`, and `-h`, so use CDK's long forms `--exclusively` and `--plugin`. `-h` shows the wrapper's help.

```console
npm run app:synth -- admin -env dev -e example
npm run roster -- -env dev -e example list
npm run recipients -- -env=dev -e=example list
npm run release:metadata -- -a match-to-csv
```

The CDK wrapper defaults its environment from the profile, then `dev`. Roster, recipients, and sender allowlist require an explicit environment. Production confirmation and account checks run in the command, after parsing.

External CLIs (`aws`, `cdk`, `gh`, `turbo`, `tofu`, and package/build tools) retain their own parsers. Application CDK bin files receive context through CDK.
