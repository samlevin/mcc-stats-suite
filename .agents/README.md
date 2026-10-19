# Repository agent workflows

This directory holds the shared sources for the MCC delivery workflows that ship with the repository for Claude Code and Codex. Contributors get the same roles, routing, checks, and handoffs in both tools without installing anything into their workstation configuration.

| Path | Purpose |
| --- | --- |
| `policy.json` | The repository binding (namespace prefix, repository, project, tracker documents, feature flags), the model and effort per capability and tool, and the values each tool accepts |
| `roles/*.md` | Source of each agent role (shared text, with `<!-- claude-only -->` and `<!-- codex-only -->` blocks) |
| `workflows/*.md` | Source of each skill, the user-facing entry points |
| `workflows/<name>/` | Supporting references copied verbatim into both tools' skills |
| `skills/mcc-*/` | Generated Codex skills (`SKILL.md`, `agents/openai.yaml`) |
| `../.codex/agents/mcc-*.toml` | Generated Codex custom agents |
| `../.claude/agents/mcc-*.md` | Generated Claude Code subagents |
| `../.claude/skills/mcc-*/` | Generated Claude Code skills |
| `../.mcp.json` | Claude Code project MCP servers (maintained directly) |
| `../.codex/config.toml` | Codex project MCP servers (maintained directly) |
| `../scripts/agent-policy.mjs` | Resolver (`resolve`), generator (`generate`), drift check (`check`), and manual review publisher (`publish-review`) |
| `worktree-isolation.md` | Shared worktree ownership and setup rules, read before roles or skills use a worktree |
| `issue-creation.md` | Tool-agnostic issue filing adapter, read by `mcc-create-github-issue` |

Edit the sources, run `npm run agents:generate`, and commit the output; `/mcc-agents` (Claude Code) or `$mcc-agents` (Codex) does the whole loop, including picking the right source file and running the checks. `npm run agents:check` and the test in `scripts/agent-policy.test.mjs` fail when a generated file is stale, so the Claude and Codex versions cannot drift apart. CI runs that check for any change under `.agents/`, `.claude/agents/`, `.claude/skills/`, `.codex/agents/`, or `scripts/agent-policy*` (`scripts/ci-scope.mjs` puts those paths in the repository scope) and fails the pull request; it does not regenerate or commit on your behalf. Generated files carry a header saying so.

## Reuse in another repository

The role and workflow sources name no repository. They carry `{{placeholders}}` (`{{prefix}}`, `{{label}}`, `{{repository}}`, `{{project.*}}`, `{{docs.*}}`) and `{{#infrastructure}}` sections that the generator resolves from `binding` in `policy.json`. Another repository copies `roles/`, `workflows/`, `worktree-isolation.md`, `scripts/agent-policy.mjs`, and its test, writes its own `policy.json` with its own `binding`, and runs `npm run agents:generate`; its agents and skills come out under its own prefix, and its `agents:check` keeps them current. Text that only makes sense with CI-applied infrastructure (Terrateam, OpenTofu, CDK) is inside `{{#infrastructure}}` sections and drops out when `features.infrastructure` is false.

## Agents and skills

Both tools support both packaging forms, and the repository uses both, each for what it does well.

Agents are the role-bearing unit. An agent definition carries the role boundary (read-only reviewer, implementer that may write and push), an isolated context, a tool allowlist in Claude Code and a permission profile in Codex, and the slot where the model and effort policy applies. The repository defines six roles: `mcc-issue-triager`, `mcc-orchestrator`, `mcc-implementer`, `mcc-stack-manager`, `mcc-code-reviewer`, and `mcc-security-reviewer`.

Skills are the entry points and the policy adapter. A skill is what a person invokes (`/mcc-implement`, `$mcc-implement`), it runs in the main thread where it can ask a question, and it is the only place that can apply the repository policy at spawn time. That last point decides the split for Codex: a Codex agent file that sets `model` or `model_reasoning_effort` takes precedence over every spawn-time value, so a pinned agent file would defeat prompt overrides. The generated Codex agents therefore carry neither field, and the skills pass the resolved values to `spawn_agent` on every dispatch. Codex also loads repository skills in an untrusted project but loads project agents only after trust, so a skill is the right place to tell the contributor that the agents are missing. In Claude Code the per-invocation `model` and `effort` parameters already override frontmatter, so the generated Claude agents pin the policy and the skills still pass the resolved values explicitly for the same reason: a dispatch must never depend on a session or contributor default.

Issue creation is the one capability without an agent. It needs to ask the person about material unknowns, and a forked subagent cannot do that in either tool, so it runs in the main thread as a skill and spawns `mcc-issue-triager` for the independent classification.

## Parity matrix

| Component | Claude Code | Codex | Checked by |
| --- | --- | --- | --- |
| Issue creation | `.claude/skills/mcc-create-github-issue` (pins `sonnet`/`medium` for the turn) | `.agents/skills/mcc-create-github-issue` | same source; skill fixture lists both |
| Issue triage | `.claude/agents/mcc-issue-triager.md` (`Read, Grep, Glob, Bash`) | `.codex/agents/mcc-issue-triager.toml` (`:read-only`) | same source; spawn fixtures below |
| Orchestration | `mcc-orchestrator` (`Agent, Bash, Read, Grep, Glob, Skill`) | `mcc-orchestrator` | same source |
| Implementation | `mcc-implementer` (`isolation: worktree`) | `mcc-implementer` (creates `.codex/worktrees/<branch>`) | same source |
| Stack management | `mcc-stack-manager` (`Bash, Read`, read-only command planning) | `mcc-stack-manager` (read-only command planning) | same source |
| Code review | `mcc-code-reviewer` (`Bash, Read, Grep, Glob`, `isolation: worktree`) | `mcc-code-reviewer` (`:read-only`) | same source |
| Security review | `mcc-security-reviewer` (adds `WebFetch, WebSearch`) | `mcc-security-reviewer` (`:read-only`) | same source |
| Entry points | `/mcc-implement`, `/mcc-review-code`, `/mcc-review-security`, `/mcc-apply-foundation`, and `/mcc-apply-bootstrap` (not model-invocable), `/mcc-plain-language`, `/mcc-agents` | `$mcc-implement`, `$mcc-review-code`, `$mcc-review-security`, `$mcc-apply-foundation`, and `$mcc-apply-bootstrap` (`allow_implicit_invocation: false`), `$mcc-plain-language`, `$mcc-agents` | same source; manifests generated |
| Foundation apply | the agent runs `gh`, `git`, `aws`, `tofu`, `direnv`, `jq`, and `shasum` through Bash; worktree under `.claude/worktrees/` | the same commands in the shell; worktree under `.codex/worktrees/` | same source |
| Bootstrap apply | the agent runs `git`, `aws`, `tofu`, `direnv`, `jq`, `shasum`, `npm`, `npx`, and `node` through Bash; worktree under `.claude/worktrees/` | the same commands in the shell; worktree under `.codex/worktrees/` | same source |
| Policy resolution | `node scripts/agent-policy.mjs resolve --tool claude ...` | `... --tool codex ...` | `scripts/agent-policy.test.mjs` |
| Playwright MCP | `.mcp.json`, server `playwright` | `.codex/config.toml`, server `playwright` | fresh-session server discovery below |
| Playwriter | `.mcp.json`, server `playwriter` | `.codex/config.toml`, server `playwriter` | fresh-session server discovery below |

"Same source" means the Claude and Codex files are rendered from one Markdown file; only the tool-only blocks differ (how to spawn, how the worktree is created, and the Claude reviewer's optional detached checkout). The test suite renders every role and workflow for both tools and compares shared lines.

[Agent worktree isolation](worktree-isolation.md) owns the setup and ownership rules for every role and skill. Stack managers inspect the creating implementer's worktree and return mutation commands for that implementer to execute.

## Model and effort policy

| Capability | Claude Code | Codex |
| --- | --- | --- |
| Issue creation (main thread) | `sonnet` / `medium` | `gpt-6.1-sol` / `medium` |
| Issue triage | `haiku` / `low` | `gpt-6-luna` / `low` |
| Orchestration | `sonnet` / `medium` | `gpt-6-luna` / `medium` |
| Implementation | `opus` / `high` | `gpt-6.1-sol` / `high` |
| Stack management | `sonnet` / `low` | `gpt-6-luna` / `low` |
| Code review | `opus` / `high` | `gpt-6.1-sol` / `high` |
| Security review | `opus` / `max` | `gpt-6-astra` / `high` |

`policy.json` is the source; this table is a copy for readers. `supported` in the same file lists the models and effort levels each tool accepts. Update it when a tool adds or retires a model (`codex debug models` prints the Codex catalog; Claude Code aliases are `haiku`, `sonnet`, `opus`, and `fable`, or a full `claude-*` ID).

### Precedence

1. An explicit `model <name>` or `effort <level>` in the request wins, for the role the skill dispatches. A role prefix targets a handoff: `reviewer effort max`, `implementer model opus`, `stack model sonnet`, `triager effort medium`.
2. Otherwise the repository policy applies.
3. A partial override changes only the named setting; the other stays at the policy value (`source` in the resolver output says which).
4. Overrides last for the task and the handoffs they name. Nothing rewrites `policy.json`, `~/.claude`, or `~/.codex`.

The resolver refuses a model or effort the repository does not list and prints why; the dispatcher stops and reports that message. Nothing substitutes another value. This matters because the runtimes do not fail on their own: Claude Code maps an unsupported effort to the highest supported level below it, and Codex falls back to `[agents]` defaults or the parent when a spawn field is missing.

### Reports

Each dispatched role reports `Requested settings: Policy: <as dispatched>`. The policy line records the requested model and effort and whether each came from policy or an explicit override. Caller workflows retain that label when relaying results, including a container's per-leaf reports and issue triage results. These values describe the dispatch request, not what the runtime ran: `CLAUDE_CODE_EFFORT_LEVEL` and a Codex agent file field override them silently (see [Known limitations](#known-limitations)). Use the effective-model verification row below when that matters. Routine reports omit model self-identification, runtime-verification fields, and automatic verification warnings or discussions; `AGENTS.md` states this once for every role and skill.

For example, a default Codex implementation reports `Requested settings: Policy: tool=codex role=implementer model=gpt-6.1-sol effort=high (model: policy, effort: policy)`. A code review requested with `model gpt-6-sol effort xhigh` reports `Requested settings: Policy: tool=codex role=code-reviewer model=gpt-6-sol effort=xhigh (model: override, effort: override)`.

### Vendor differences and adapters

| Concern | Claude Code | Codex |
| --- | --- | --- |
| Where the policy is applied | agent frontmatter (`model`, `effort`) plus explicit Agent tool parameters | explicit `spawn_agent` parameters only; agent files omit both fields on purpose |
| Precedence in the runtime | per-invocation parameter > frontmatter > `CLAUDE_CODE_SUBAGENT_MODEL` > session model; `CLAUDE_CODE_EFFORT_LEVEL` beats every effort source | agent file field > spawn value > `[agents].default_subagent_*` > parent |
| Main-thread skill model | skill frontmatter pins it for the turn | not possible; start the session with `codex -m <model> -c model_reasoning_effort=<effort>` |
| Built-in guidance | none against overrides | the `spawn_agent` description says not to set `model` unless the user asks; the skills override that because the repository policy is the user's standing request |
| Effective-model verification (operator check) | the Agent tool call shows the parameters, and the subagent's system prompt names its model | the child cannot read its model reliably; verify with `sqlite3 ~/.codex/state_5.sqlite "select agent_role, model, reasoning_effort from threads order by rowid desc limit 5"` (Codex 0.162 schema) or the thread view |

## Discovery, trust, and versions

The per-invocation `effort` parameter needs Claude Code 2.1.292 or later; Codex needs a release with `spawn_agent` (subagent workflows are on by default in current releases).

Claude Code loads `.claude/agents/` and `.claude/skills/` by walking up from the working directory to the repository root, so they load from the root, a nested directory, and a linked worktree. No trust step gates them. A project agent with the same name as a personal agent replaces the personal one, and a personal skill shadows a project skill of the same name. `/mcc-review-security` has `disable-model-invocation: true`, so only a person can start it.

Codex loads `.agents/skills/` from every directory between the working directory and the repository root, in trusted and untrusted projects alike. It loads `.codex/agents/` only when the project is trusted (`trust_level = "trusted"` for the repository path in `~/.codex/config.toml`, which Codex writes when you accept the trust prompt). A linked worktree inherits the main checkout's trust. Until the project is trusted, `spawn_agent` reports an unknown `agent_type` for `mcc-*`, and the skills say so instead of continuing. Codex lists skills that share a name side by side rather than picking one. `$mcc-review-security` has `allow_implicit_invocation: false`, so Codex never picks it on its own.

Every identifier here starts with `mcc-` so that it cannot collide with a contributor's own agents and skills in either tool.

Trusting the folder activates the agent definitions. Nothing here installs, copies, symlinks, or registers agent definitions outside the checkout, and a session in another repository does not see them. Ordinary prerequisites stay yours: the tool itself, `gh` with authentication, the `gh stack` extension for stacked branches, and `npm ci` for the checks (the resolver itself runs without `node_modules`). Browser MCP servers have the setup below.

## Browser MCP servers

Both tools start the same stdio servers through `npx -y`: [Playwright MCP](https://github.com/microsoft/playwright-mcp) (`@playwright/mcp@latest --headless`) and [Playwriter](https://github.com/remorses/playwriter) (`playwriter@latest`). Node.js and npm must be on `PATH`; the first start downloads the packages into npm's cache. The two configuration files are maintained directly, outside `agents:generate`.

Agents use Playwright MCP for headless checks by default. Use Playwriter only for a person's connected Chrome session. Install its Chrome extension and click its icon on each tab to connect it. In this extension setup, Playwriter controls only the Chrome tabs a person connects through the extension. Disconnect a tab through the extension to stop control. Keep browser credentials and personal paths out of repository configuration.

Claude Code asks for approval before using project MCP servers in an interactive session. Codex loads its project MCP configuration after the project is trusted. See the [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp#project-scope) and [Codex MCP documentation](https://developers.openai.com/codex/mcp).

To check discovery, open a fresh session in a new worktree and run `claude mcp list` and `codex mcp list`. Both lists must include `playwright` and `playwriter`. Claude Code may list them as pending approval until a person approves them. Use `/mcp` inside either tool to inspect the active server connections.

## Manual review publication

`mcc-review-code` posts the reviewer's report to a target pull request after `mcc-code-reviewer` returns. The reviewer itself stays read-only, and the skill posts through `node scripts/agent-policy.mjs publish-review`, so both tools follow one rule. That command reads the pull request again and posts nothing when its base or head differs from the reviewed pair. It compares the `gh api user` login with the PR creator's login and submits one review pinned to the reviewed head commit. The event is `REQUEST_CHANGES` only for a `REQUEST CHANGES` verdict from a different account, because GitHub rejects a change request or an approval from a pull request's own author. Every other case, including an identity it cannot establish, is a `COMMENT` review whose body says why when the event differs from the verdict. It never approves. Branch reviews and the implementer's pre-PR reviews post nothing. `scripts/agent-policy.test.mjs` covers each case against mocked `gh` responses.

## Infrastructure apply skills

`mcc-apply-foundation` stands in for Terrateam on one pull request's foundation roots. It and `mcc-apply-bootstrap` are the only workflows that apply infrastructure, and the `AGENTS.md` exception covers each only when a person invokes it: neither tool lets a model start it on its own, the skill refuses requests relayed by another agent, and it stops for that person's approval before every plan, apply, and merge. The skill is instructions only, with no repository script behind it. The agent runs `gh`, `git`, `aws`, `tofu`, `direnv`, `jq`, and `shasum` itself, and uses `gh` only for the pull request's state, checks, and merge. It reads every OpenTofu input, read-only, from each foundation root's ignored, self-contained `.envrc` in the main checkout, removes every ambient `AWS_*`, `TF_*`, and `TOFU_*` value from every `direnv`, `aws`, and `tofu` command, checks that the profile's account matches the account in the state bucket name the `.envrc` derives, and that the bucket's `Environment` tag matches the root, before any OpenTofu command, applies only the saved plan the person reviewed, and never plans a bootstrap or data-platform root. The OpenTofu state lock is the only lock. No test exercises the flow itself; running it against a real pull request is a manual check.

`mcc-apply-bootstrap` applies `infrastructure/dev/bootstrap` and then `infrastructure/prod/bootstrap` at the current `origin/main` commit, which Terrateam never runs. It has no pull request, CI gate, or merge, and it follows the same rules as the foundation skill: person-invoked only, one approval per plan, apply, and CDK bootstrap, prod only after dev has applied at the same commit, and a new `main` commit voids every plan. The agent runs `git`, `aws`, `tofu`, `direnv`, `jq`, `shasum`, `npm`, `npx`, and `node` itself. It reads every OpenTofu input, read-only, from each bootstrap root's ignored, self-contained `.envrc` and its `*.auto.tfvars` in the main checkout, removes every ambient `AWS_*`, `TF_*`, and `TOFU_*` value from every `direnv`, `aws`, and `tofu` command, checks that the profile's account matches the account in the state bucket name the `.envrc` derives, and that the bucket's `Environment` tag matches the root, before any OpenTofu command, applies only the saved plan the person reviewed, and never plans a foundation, data-platform, or local-cdk root. After the OpenTofu roots, or straight away when the person replies `cdk` because `main` has nothing to plan there, it creates or upgrades the CDK bootstraps with `npm`, `npx`, and `node` from the same detached worktree: `CDKToolkit` in dev, then in prod. It never touches `CDKToolkitLocal`, which the OpenTofu root `infrastructure/dev/local-cdk` deploys. Each CDK step reads the profile and Region from that environment's bootstrap root `.envrc`, passes them as `aws://<account>/<region>`, runs the same account and `Environment` tag checks, shows the deployed and pinned bootstrap versions, and skips a stack that is already current. Running it against both accounts is a manual check.

## Known limitations

- Codex skills cannot change the session model, so the issue-creation policy for Codex is advisory for the main thread and binding only for the spawned triager.
- Claude Code honors `CLAUDE_CODE_EFFORT_LEVEL` above everything, including the repository policy and a prompt override. Leave it unset when you want the repository defaults.
- Reports carry requested settings, never verified ones. Codex cannot verify a child's model from inside the child; the thread table or thread view is the ground truth.
- Prompt overrides are read from natural language by the dispatching skill; the resolver validates the values but cannot see the request.
- Codex approval rules belong to each contributor. The repository ships no exec policy, so a contributor's own rules decide which `git` and `gh` commands run without a prompt.
