# Repository command lines

Repository-owned Node commands use `scripts/cli.cjs`, with declarations separate from command execution. It uses the supported Node runtime's `node:util.parseArgs` and adds no dependencies. The helper handles exact aliases, duplicates, help, and usage errors; each command keeps its domain checks and exit statuses. CommonJS lets both the root ES modules and the TypeScript fixture utilities load the same implementation. The fixture utilities resolve it from their workspace package so source and compiled commands use the same file.

## Getting started

Install the [pinned Node.js/npm](../docs/getting-started.md#tier-1-run-the-checks-locally) and run `npm ci` from the repository root. Run all commands below from that root, even though this README lives in `scripts/`. Roster and recipient commands also need built shared packages; their `npm run` entry points build them automatically. AWS commands need an authenticated profile, and tracker commands need `gh` with repository and Projects access. Keep command output containing private values local.

## Scripts reference

Use `--help` on commands with declared options. The [root reference](../README.md#scripts-reference) lists NPM entry points, including build and formatting tools. Internal modules (`cli.cjs`, account guards, CDK targets, CI scope classification, and infrastructure merge-gate evaluation) are imported by commands or workflows and have no standalone command to run. Tests run through `npm test`.

| Script | Purpose | Arguments |
| --- | --- | --- |
| `node scripts/cdk-app.mjs` | Run guarded CDK operations for one application | Required `<synth\|diff\|deploy\|destroy> <application>`; optional `--environment dev\|prod` (profile-derived, then `dev`), `--ephemeral <name>`, `--profile <profile>` (defaults to `AWS_PROFILE`), and CDK arguments. Prefer the [NPM wrappers and their deployment restrictions](../README.md#scripts-reference) |
| `npm run roster`, `npm run recipients` | Read or change gamertags or CSV recipient addresses | Required `--environment dev\|prod` and command; optional flags and operand counts are in [Operator arguments](#operator-arguments). Pass arguments after `--` |
| `node scripts/branch-name.mjs` | Print a branch name from a GitHub issue's current title | Required positive issue number; optional `--actor <login>` (default `agent`) and `--layer <n>` (default `1`) |
| `node scripts/release-metadata.mjs` | Check release metadata or print one application's metadata | Required `--check` or `--application <name>`; no default mode |
| `node scripts/issue-triage.mjs` | Reconcile epic labels and move eligible Inbox issues to Ready | Optional `--issue <number>`, `--dry-run` or `--apply`; defaults to dry run unless `DRY_RUN=false` |
| `node scripts/issue-containers.mjs` | Close completed containers and reopen incomplete ones | Optional `--issue <number>`, `--dry-run` or `--apply`; same dry-run default as triage |
| `node scripts/agent-policy.mjs resolve` | Print requested agent settings | Required `--tool claude\|codex` and either `--role <role>` or `--capability <capability>`; optional `--model <model>`, `--effort <effort>` override policy defaults |
| `node scripts/agent-policy.mjs generate`, `node scripts/agent-policy.mjs check` | Generate agent definitions or check for stale output | None |
| `node scripts/agent-policy.mjs publish-review` | Post an independent review at the reviewed PR commits | Required `--pr <number> --base <40-character SHA> --head <40-character SHA> --report <file>`; no defaults |
| `node scripts/local-cdk-bootstrap.mjs` | Rewrite `infrastructure/dev/local-cdk/bootstrap-template.json` offline | None |
| `node scripts/ci-checks.mjs` | Run CI-selected checks | None; requires `CI_BASE`, `CI_HEAD`, `CI_FULL`, `CI_REPOSITORY`, and `CI_MODE` environment inputs. `CI_JOB` defaults to `static`; [the implementation](ci-checks.mjs) lists job choices |
| `node scripts/issue-pr-metadata.mjs`, `node scripts/issue-pr-status.mjs` | Copy linked-issue metadata to a PR, or move its closing issues to In review | None; requires `PR_NUMBER`. `DRY_RUN` defaults to `true`; `false` enables writes |
| `node scripts/issue-project-membership.mjs` | Add an issue to MCC delivery | None; requires `CONTENT_TYPE=issue` and positive `CONTENT_NUMBER`. `DRY_RUN` defaults to `true` |
| `bash scripts/tofu-checks.sh` | Check OpenTofu pins, formatting, validation, and module tests | None; optional `--pinned-version` prints the pinned version and exits |

Tracker entry points running in GitHub Actions also require `MCC_PROJECT_TOKEN`. PR metadata/status and project membership require the expected `GITHUB_REPOSITORY`, and PR status requires `PR_ACTION` to be `opened`, `edited`, `reopened`, or `ready_for_review`. Outside Actions they use the current `gh` authentication. See the [application script reference](../applications/match-to-csv/README.md#scripts-reference) for fixture capture, reduction, and bundle verification.

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

Aliases are exact tokens. `-env` means environment; it is never `-e` plus `nv` or a group of flags. Attached forms such as `-envdev` and grouped short flags are unsupported. Only declared options are normalized. Unknown options fail with usage, except for CDK passthrough. Repeating an option, including through two spellings with the same value, fails. Commands reject conflicting selections such as `--all --inactive`, `--apply --dry-run`, and `--role ... --capability ...`.

`--` ends option parsing. Roster, recipients, branch naming, and fixture capture treat following arguments as operands, including names beginning with a dash. CDK forwards the marker and everything after it unchanged. CDK passthrough spellings and order stay intact, and prohibited deployment options remain subject to the wrapper's guards. Use equals when a CDK option's value resembles a wrapper option, such as `--output=-env`.

| Long option | Alias | Commands |
| --- | --- | --- |
| `--help` | `-h` | Every migrated command |
| `--environment` | `-env` | CDK wrapper, roster, recipients |
| `--ephemeral` | `-e` | CDK wrapper, roster, recipients |
| `--profile` | `-p` | CDK wrapper, roster, recipients |
| `--yes` | `-y` | Roster and recipient writes |
| `--reason` | `-r` | Roster and recipient writes |
| `--actor` | `-a` | Branch naming |
| `--layer` | `-l` | Branch naming |
| `--application` | `-a` | Release metadata |
| `--issue` | `-i` | Tracker reconciliation |
| `--dry-run` | `-n` | Tracker reconciliation |
| `--tool` | `-t` | Agent policy resolution |
| `--model` | `-m` | Agent policy resolution |
| `--output` | `-o` | Fixture reduction |

Other options retain their long names. Each command's help lists the options it accepts. Aliases are scoped to a command, so `-a` has no collision between branch naming and release metadata. CDK's `-r` and `-m` remain passthrough options, with the existing ephemeral deployment restrictions. The wrapper owns `-e`, `-p`, and `-h`, so use CDK's long forms `--exclusively` and `--plugin`. `-h` shows the wrapper's help.

```console
npm run app:synth -- admin -env dev -e example
npm run roster -- -env dev -e example list
npm run recipients -- -env=dev -e=example list
node scripts/branch-name.mjs 285 -a agent -l 2
npm run release:metadata -- -a match-to-csv
node scripts/issue-triage.mjs -n -i 285
node scripts/agent-policy.mjs resolve -t codex --role implementer
```

The CDK wrapper defaults its environment from the profile, then `dev`. Roster and recipients require an explicit environment. Tracker commands default to dry run, unless `DRY_RUN=false` or `--apply` selects writes. Production confirmation and account checks run in the command, after parsing.

External CLIs (`aws`, `cdk`, `gh`, `turbo`, `tofu`, and package/build tools) retain their own parsers. Application CDK bin files receive context through CDK.
