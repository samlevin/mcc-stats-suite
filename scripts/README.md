# Repository command lines

Repository-owned Node commands use `scripts/cli.cjs`, with declarations separate from command execution. It uses the supported Node runtime's `node:util.parseArgs` and adds no dependencies. The helper handles exact aliases, duplicates, help, and usage errors; each command keeps its domain checks and exit statuses. CommonJS lets both the root ES modules and the TypeScript fixture utilities load the same implementation. The fixture utilities resolve it from their workspace package so source and compiled commands use the same file.

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

## Entry point inventory

The inventory covers repository-owned JavaScript and TypeScript Node entry points, including scripts outside the root `scripts/` directory.

| Entry point | CLI coverage |
| --- | --- |
| `scripts/cdk-app.mjs` | `synth`, `diff`, `deploy`, `destroy`; environment, namespace, profile; remaining CDK arguments |
| `scripts/roster.mjs`, `scripts/recipients.mjs` | Commands, operands, environment, namespace, profile, write and list options |
| `scripts/branch-name.mjs` | Issue operand, actor, layer |
| `scripts/release-metadata.mjs` | Check and application metadata modes |
| `scripts/issue-triage.mjs`, `scripts/issue-containers.mjs` | Shared `configuration`, apply/dry-run, issue filter |
| `scripts/agent-policy.mjs` | `resolve`, `generate`, `check`, `publish-review`, with options per command |
| `applications/match-to-csv/scripts/capture-textract.ts` | Output directory and image operands |
| `applications/match-to-csv/scripts/reduce-capture.ts` | Capture, mapping, name, output |

The remaining scripts accept no command-line arguments: CI scope/checks, infrastructure merge gate, issue PR metadata/status/project membership, local bootstrap template generation, and bundle verification use environment variables or fixed inputs. Library modules, test runners, and application CDK bin files have no repository option grammar. CDK bins receive context through CDK, whose external CLI owns those arguments. External CLIs (`aws`, `cdk`, `gh`, `turbo`, `tofu`, and package/build tools) retain their own parsers. Shell scripts are outside the Node inventory.
