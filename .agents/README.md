# Repository agent workflows

The MCC delivery agents and skills for Claude Code and Codex come from the shared sources in [`@agenticool/agents`](https://www.npmjs.com/package/@agenticool/agents), rendered for this repository from `policy.json` and the repository-only sources under `local/`. Contributors get the same roles, routing, checks, and handoffs in both tools without installing anything into their workstation configuration. The package README has the source syntax, the parity matrix, model and effort precedence, report labels, vendor differences, discovery and trust, the browser MCP servers, manual review publication, and the known runtime limits.

| Path | Purpose |
| --- | --- |
| `policy.json` | The repository binding (display label, project, board documents, feature flags, infrastructure account checks) and the repository-only labels. Model, effort, supported values, and the implementation effort rubric come from the `@agenticool/core` defaults, which `policy.json` may override |
| `local/workflows/*.md` | Sources of the repository-only skills, `apply-foundation` and `apply-bootstrap` |
| `skills/<skill>/` | Generated Codex skills (`SKILL.md`, `agents/openai.yaml`) |
| `../.codex/agents/<role>.toml` | Generated Codex custom agents |
| `../.claude/agents/<role>.md` | Generated Claude Code subagents |
| `../.claude/skills/<skill>/` | Generated Claude Code skills |
| `worktree-isolation.md`, `review.md`, `evidence.md`, `issue-creation.md`, `independence-groups.md` | Generated shared rules that roles and skills in both tools read by these paths |

`npm run agents:sync` also writes the shared files the board and agents need: the marked sections of `../AGENTS.md`, `../ISSUE_TRIAGE.md`, `../.github/labels.json` (the base catalog plus `labels.extra`), the issue forms, the PR template, the `tracker-*.yml` caller workflows, the agent block in `../.gitignore`, and the browser MCP servers in `../.mcp.json` and `../.codex/config.toml`. Lines outside a marked block are the repository's own.

Edit `policy.json` or a local source, run `npm run agents:generate` (and `npm run agents:sync` after changing `binding` or `labels.extra`, or after upgrading the `@agenticool/*` packages), and commit the output; `/agents` (Claude Code) or `$agents` (Codex) does the whole loop. `npm run agents:check` fails when a generated or synced file is stale, so the Claude and Codex versions cannot drift apart. CI runs that check for any change in the repository scope or the full gate (`scripts/ci-scope.mjs` puts the policy, local sources, and generated and synced agent files in the repository scope) and fails the pull request; it does not regenerate or commit on your behalf. Generated files carry a header saying so.

## Model and effort policy

| Capability | Claude Code | Codex |
| --- | --- | --- |
| Issue creation (main thread) | `sonnet` / `medium` | `gpt-6.1-sol` / `medium` |
| Issue triage | `haiku` / `low` | `gpt-6-luna` / `low` |
| Implementation (binding for an implementer, advisory for explicit inline) | `claude-opus-5-5` / `medium` | `gpt-6.1-sol` / `medium` |
| Code review | `opus` / `high` | `gpt-6.1-sol` / `high` |
| Security review | `opus` / `max` | `gpt-6-astra` / `high` |

The `@agenticool/core` defaults are the source, and `policy.json` overrides none of them; this table is a copy for readers. The same defaults list the models and effort levels each tool accepts. Update it when a tool adds or retires a model (`codex debug models` prints the Codex catalog; Claude Code aliases are `haiku`, `sonnet`, `opus`, and `fable`, or a full `claude-*` ID).

## Infrastructure apply skills

`apply-foundation` stands in for Terrateam on one pull request's foundation roots. It and `apply-bootstrap` are the only workflows that apply infrastructure, and the `AGENTS.md` exception covers each only when a person invokes it: neither tool lets a model start it on its own, the skill refuses requests relayed by another agent, and it stops for that person's approval before every plan, apply, and merge. The skill is instructions only, with no repository script behind it. The agent runs `gh`, `git`, `aws`, `tofu`, `direnv`, `jq`, and `shasum` itself, and uses `gh` only for the pull request's state, checks, and merge. It reads every OpenTofu input, read-only, from each foundation root's ignored, self-contained `.envrc` in the main checkout, removes every ambient `AWS_*`, `TF_*`, and `TOFU_*` value from every `direnv`, `aws`, and `tofu` command, checks that the profile's account matches the account in the state bucket name the `.envrc` derives, and that the bucket's `Environment` tag matches the root, before any OpenTofu command, applies only the saved plan the person reviewed, and never plans a bootstrap or data-platform root. The OpenTofu state lock is the only lock. No test exercises the flow itself; running it against a real pull request is a manual check.

`apply-bootstrap` applies `infrastructure/dev/bootstrap` and then `infrastructure/prod/bootstrap` at the current `origin/main` commit, which Terrateam never runs. It has no pull request, CI gate, or merge, and it follows the same rules as the foundation skill: person-invoked only, one approval per plan, apply, and CDK bootstrap, prod only after dev has applied at the same commit, and a new `main` commit voids every plan. The agent runs `git`, `aws`, `tofu`, `direnv`, `jq`, `shasum`, `npm`, `npx`, and `node` itself. It reads every OpenTofu input, read-only, from each bootstrap root's ignored, self-contained `.envrc` and its `*.auto.tfvars` in the main checkout, removes every ambient `AWS_*`, `TF_*`, and `TOFU_*` value from every `direnv`, `aws`, and `tofu` command, checks that the profile's account matches the account in the state bucket name the `.envrc` derives, and that the bucket's `Environment` tag matches the root, before any OpenTofu command, applies only the saved plan the person reviewed, and never plans a foundation, data-platform, or local-cdk root. After the OpenTofu roots, or straight away when the person replies `cdk` because `main` has nothing to plan there, it creates or upgrades the CDK bootstraps with `npm`, `npx`, and `node` from the same detached worktree: `CDKToolkit` in dev, then in prod. It never touches `CDKToolkitLocal`, which the OpenTofu root `infrastructure/dev/local-cdk` deploys. Each CDK step reads the profile and Region from that environment's bootstrap root `.envrc`, passes them as `aws://<account>/<region>`, runs the same account and `Environment` tag checks, shows the deployed and pinned bootstrap versions, and skips a stack that is already current. Running it against both accounts is a manual check.
