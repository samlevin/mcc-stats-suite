# Delivery topology evaluation

This procedure compares two delivery topologies at runtime, within one tool at a time:

- Coordinator topology, at `main` commit `163faa854b08e826d6239eeabacb0340508abb19`: a dispatching skill spawns `mcc-orchestrator` for a container and `mcc-implementer` for each leaf, and the implementer spawns `mcc-stack-manager` for stack planning.
- Inline topology, at any `main` commit that has `.agents/workflows/implement/references/delivery.md`: the thread that invokes `mcc-implement` delivers the leaf or runs the queue itself, loads `mcc-stack` itself, and spawns only `mcc-code-reviewer`.

It separates context occupancy from total token processing and reports task quality next to both. It compares tools only descriptively, because their models, caches, and runtimes differ.

## Results

| Tool | Status |
| --- | --- |
| Claude Code | Unverified. No run has been recorded. |
| Codex | Unverified. No run has been recorded. |

Record each run in the [results table](#record-the-results) and change a tool's status only from recorded runs. Static checks, such as `npm run agents:check` and the routing tests in `scripts/agent-policy.test.mjs`, show what the generated definitions say. They are not runtime evidence.

## Fixtures

Runs use local, isolated fixtures only. They never claim real issues, move real project items, push to the real repository, or open real PRs.

1. Create a bare repository as the fixture `origin` and push the snapshot under test to it as `main`. Clone it into a fresh directory for each run, so every run starts from the same files and no shared worktree registry or `gh stack` state.
2. Put a stub `gh` first on `PATH` for the run. It answers the REST reads the workflows make (`repos/<repo>/issues/<n>`, `/comments`, `/sub_issues`, `/parent`, `/dependencies/blocked_by`, `pulls`, and `users/<owner>/projectsV2/<n>/fields` and `/items`) from JSON files in the fixture, appends every call with its arguments and body to a log, and answers writes (comments, project `PATCH`, `POST pulls`) with a fixed fake response. It refuses `gh pr merge`, `gh api graphql`, and any `merge` endpoint with a non-zero exit, and logs the refusal. For `gh stack link`, it logs the arguments and succeeds.
3. Use the same fixture issues for both topologies:
   - Leaf: one S task in `scripts/`, with two acceptance criteria and a focused test, outside the mandatory review paths.
   - Container: one container with three leaves: two in different recorded independence groups, and a third blocked by the first.
   - Stacked change with review: one M leaf that needs two layers and touches a mandatory review path, such as a document under `.agents/`.
4. Pin the snapshot SHAs, the client versions (`claude --version`, `codex --version`, and the `gh stack` line of `gh extension list`), and the fixture file hashes in the results.

## Runs

Within one tool, match the model and effort across topologies. Set the main thread to the `implementation` policy (`claude --model opus --effort high`, or `codex -m gpt-6.1-sol -c model_reasoning_effort=high`), and leave every delegated role at its repository policy. Leave `CLAUDE_CODE_EFFORT_LEVEL` unset. Start every run in a fresh session. Run each scenario three times per topology in the order coordinator, inline, inline, coordinator, and so on, so cache warmth does not favor one topology.

Run non-interactively with the same prompt per scenario, for example `implement #<fixture issue>`:

- Claude Code: `claude -p '<prompt>' --model opus --effort high --output-format json`, from the fixture clone. Keep the printed JSON; it carries `session_id`, `num_turns`, and `duration_ms`.
- Codex: `codex exec --json -m gpt-6.1-sol -c model_reasoning_effort=high '<prompt>'`, from the fixture clone, with the project trusted so the agents load.

## Extract usage

Count each model call once, keep the main thread (parent) and each spawned agent (child) apart, and write `unavailable` for any metric the telemetry lacks. Never estimate a missing value from returned characters.

Claude Code writes the parent transcript to `~/.claude/projects/<encoded cwd>/<session_id>.jsonl` and each child to `<session_id>/subagents/agent-<id>.jsonl`, with the agent type in the matching `.meta.json`. One model call can span several lines with the same `message.id`, so deduplicate on it. A transcript can record `output_tokens` before the response finishes streaming, so treat transcript output as a lower bound: take the parent's output from the `usage` in the `--output-format json` result, and report a child's output as a lower bound.

```sh
jq -s '
  [.[] | select(.type == "assistant" and .message.usage) ]
  | group_by(.message.id) | map(last)
  | map(.message.usage) as $u
  | {
      calls: ($u | length),
      input_total: ($u | map(.input_tokens + .cache_creation_input_tokens + .cache_read_input_tokens) | add),
      input_cached: ($u | map(.cache_read_input_tokens) | add),
      input_uncached: ($u | map(.input_tokens + .cache_creation_input_tokens) | add),
      output: ($u | map(.output_tokens) | add),
      reasoning: "unavailable",
      peak_context: ($u | map(.input_tokens + .cache_creation_input_tokens + .cache_read_input_tokens) | max)
    }' <transcript.jsonl>
```

Codex writes one rollout file per thread under `~/.codex/sessions/<yyyy>/<mm>/<dd>/`. A child's `session_meta` names its `parent_thread_id` and `agent_role` under `payload.source.subagent.thread_spawn`. `token_count` events carry cumulative totals, and the same total can repeat, so take the last total and count calls from distinct totals:

```sh
jq -s '
  [.[] | select(.type == "event_msg" and .payload.type == "token_count" and .payload.info)
       | .payload.info ]
  | unique_by(.total_token_usage.total_tokens)
  | {
      calls: length,
      input_total: (last.total_token_usage.input_tokens),
      input_cached: (last.total_token_usage.cached_input_tokens),
      input_uncached: (last.total_token_usage.input_tokens - last.total_token_usage.cached_input_tokens),
      output: (last.total_token_usage.output_tokens),
      reasoning: (last.total_token_usage.reasoning_output_tokens),
      peak_context: (map(.last_token_usage.input_tokens) | max)
    }' <rollout.jsonl>
```

The peak-context proxy is the largest input of a single call in that thread: it shows how full one context got. Total input is the processing over all calls. Report both, per thread, and never add the children's peaks to the parent's.

Take elapsed time from the first to the last timestamp across the run's threads. Count review rounds from the reviewer spawns, and record each verdict.

## Check quality

For every run, record:

- Correctness: the fixture issue's acceptance criteria, checked by hand against the final branches, and the result of the checks the delivery procedure requires, rerun locally at the final head.
- Delivery facts from the stub `gh` log: one claim comment, one move to In progress, one PR per layer with `Closes #N` only on the final layer, stack links by PR URL, and no merge, no In review or Done move, and no GraphQL call.
- Stack safety from the fixture's git state: `main` in the fixture clone did not move, no branch outside the delivery moved, and every immediate base is the actual parent.

## Record the results

Add one row per run. Keep observed values separate from `unavailable` ones, and keep static checks out of this table.

| Tool | Scenario | Topology | Run | Snapshot | Thread (role) | Calls | Input total | Cached | Uncached | Output | Reasoning | Peak context | Elapsed | Review rounds | Checks | Acceptance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
