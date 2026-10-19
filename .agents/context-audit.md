# Delivery context audit

Use this procedure to compare delivery runs under [Evidence and waiting](evidence-and-waiting.md). Keep raw telemetry, private paths, response bodies, and transcripts outside tracked files. Publish only aggregate counts, public issue/PR numbers, policy revisions, the cutoff, and limitations.

## Comparable runs

Choose the same delivery outcome, role set, model/effort, acceptance criteria, validation commands, and review rounds. Record source/base/head revisions, tool versions, concurrency, runtime wait maximum, loaded instruction limits, and whether caches are warm. Use an isolated fixture or an authorized delivery. Do not create duplicate claims or PRs, rerun remote CI, or change workstation settings for a measurement. If exact replay is unavailable, name the scope difference and report descriptive counts without attributing a difference to the policy.

For each before/after run, collect each participating thread once, from dispatch through final handoff, with one fixed cutoff. Keep roles separate before summing them. A parent record can contain a child's final message without containing the child's usage; do not treat that message as another usage record. Deduplicate by thread and response ID, including across exports. Retain compaction boundaries. Note missing threads, missing tool output, and partial runs.

Report these metrics:

| Metric | Counting rule |
| --- | --- |
| Model calls | Unique completed response IDs with usage, not tool invocations or cumulative usage events |
| Peak context | Runtime-reported peak when available; otherwise peak per-request input tokens, labelled a proxy, or unavailable. The advertised context-window limit is not measured usage |
| Tool-output characters | Unicode characters in returned tool-output bodies, once per call ID per thread. Count an enclosing batch's returned body once, without adding nested outputs again. Include logs and metadata actually returned to the model; distinguish retained output from omitted/truncated output |
| Idle wakeups | Agent waits returning a timeout with no substantive event. Report wait calls, timeout wakeups, required progress updates, and status-only probes separately. A completion or user interruption is not idle |
| Input, cached input, output | Sum per-response usage once. Cached input is a subset of input, and reasoning output is a subset of output. Total is input + output. Do not add cumulative counters, cached input, or reasoning output to that total |

For local Codex JSONL exports with `token_usage_record`, the following read-only Python command prints aggregates for explicitly supplied thread files. Supply all participating thread exports once. File arguments remain local. It deliberately ignores cumulative `event_msg.token_count` records. Other schemas need an adapter using the same counting rules; do not combine the two representations. A missing usage record makes model/usage totals unavailable rather than zero.

```sh
python3 - <before-or-after-thread.jsonl> ... <<'PY'
import json, sys
from collections import Counter

usage, outputs, waits, idle = {}, {}, set(), set()
names, missing, thread_ids = {}, Counter(), set()
for path in sys.argv[1:]:
    thread = None
    for line in open(path, encoding="utf-8"):
        record = json.loads(line)
        item = record.get("payload", {})
        kind = record.get("type")
        if kind == "session_meta":
            thread = item.get("id") or item.get("session_id")
            thread_ids.add(thread)
        if not thread:
            raise ValueError("Export needs a session/thread identity")
        if kind == "token_usage_record":
            response = item.get("response_id")
            if not response:
                raise ValueError("Usage record needs a response identity")
            key = (thread, response)
            value = item["usage"]
            if key in usage and usage[key] != value:
                raise ValueError("Conflicting usage for one response")
            usage[key] = value
        if kind != "response_item":
            continue
        key = (thread, item.get("call_id"))
        if item.get("type") in ("function_call", "custom_tool_call"):
            names[key] = item.get("name", "")
        if item.get("type") in ("function_call_output", "custom_tool_call_output"):
            body = item.get("output", "")
            outputs[key] = body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)
for key, body in outputs.items():
    if names.get(key, "").split(".")[-1] != "wait_agent":
        continue
    waits.add(key)
    try:
        result = json.loads(body)
    except (ValueError, TypeError):
        missing["unclassified_wait_results"] += 1
        continue
    if result.get("timed_out") is True:
        idle.add(key)
missing["threads_without_usage"] = len(thread_ids - {key[0] for key in usage})
complete = bool(usage) and missing["threads_without_usage"] == 0
totals = {name: sum(v.get(name, 0) for v in usage.values())
          for name in ("input_tokens", "cached_input_tokens", "output_tokens")}
print(json.dumps({
    "threads": len(thread_ids), "model_calls": len(usage) if complete else None,
    "peak_request_input_proxy": max(v["input_tokens"] for v in usage.values()) if complete else None,
    "tool_output_characters": sum(map(len, outputs.values())),
    "agent_wait_calls": len(waits), "idle_timeout_wakeups": len(idle),
    "usage": totals if complete else None,
    "known_partial_usage": totals if usage and not complete else None,
    "known_partial_model_calls": len(usage) if usage and not complete else None,
    "input_plus_output": totals["input_tokens"] + totals["output_tokens"] if complete else None,
    "limits": dict(missing)
}, indent=2))
PY
```

Inspect coordination calls once to classify any runtime-specific wait tools, required progress updates, and status-only probes. The command classifies only direct `wait_agent` calls whose result has `timed_out`. Nested tool calls and other wait schemas require explicit classification, not an inferred zero. If any participating thread lacks usage, the command reports aggregate model-call, peak-input, and token totals as unavailable. It labels any observed subset as `known_partial_usage` and `known_partial_model_calls`; those fields are not run totals. Record unavailable values. If only cumulative usage exists, use one final counter per thread, and report model-call count and peak unavailable unless another source provides them. Never sum every cumulative sample or mix it with per-response records.

## Controlled before/after replay

When historical exports are unavailable, use a reconstructed baseline and the candidate against the same fixed task, evidence, and cutoffs. This is a delivery evidence and coordination replay, not an observed model delivery. It needs no legacy logs. The baseline is the guidance at `63a65a1c5f7537e993b3a7ba9fa1ee287a3e4fcc`. Its implementer permits whole reads below about 2,000 lines, its reviewer has no equivalent output budget, and its waits have no prescribed cadence. The candidate uses [Evidence and waiting](evidence-and-waiting.md). The command checks those source assumptions and prints policy and fixture hashes so a later reproduction can identify its inputs.

Both variants gather the same dispatch criteria, inspect the same implementation evidence, cover every review diff/caller/test range, reuse an unchanged read, and reach the same handoff after the child completes at virtual second 145. No implementation change, test execution, real review decision, model inference, GitHub write, or actual sleep occurs inside the replay. Long-line and review evidence remains fully in scope. The large GitHub fixture has one explicitly irrelevant field, which only the candidate omits from returned evidence. The baseline returns full results; the candidate selects fields and splits results into counted ranges. Tool-output measurements count the constructed JSON return envelopes, including scope labels and escaping, once per enclosing batch. They do not estimate runtime wrappers, model tokens, or quota use.

For coordination, the baseline uses a chosen 30-second wait, matching the tool default in the audited interface. The old policy permits that cadence but does not require it. The candidate uses the longest permitted wait under the same 60-second loaded maximum. Both variants model progress deadlines at seconds 60 and 120, react to completion at second 145, send zero child probes, and preserve dependency order. These wait and update counts are modeled from a virtual clock. Changing the chosen baseline cadence changes that comparison; no historical cadence is inferred.

Run from the repository root with Python 3 and Git:

```sh
python3 - <<'PY'
import hashlib, json, math, subprocess
from pathlib import Path

baseline = "63a65a1c5f7537e993b3a7ba9fa1ee287a3e4fcc"
paths = [".agents/roles/implementer.md", ".agents/roles/code-reviewer.md",
         ".agents/roles/orchestrator.md", ".agents/workflows/implement.md"]
old = [subprocess.check_output(["git", "show", f"{baseline}:{p}"], text=True) for p in paths]
new = [Path(p).read_text() for p in paths]
policy = Path(".agents/evidence-and-waiting.md").read_text()
assert "about 2,000 lines" in old[0] and "evidence-and-waiting.md" not in old[0]
assert "12,000 characters" in policy and "24,000 characters" in policy
encode = lambda value: json.dumps(value, ensure_ascii=False, separators=(",", ":"))
digest = lambda text: hashlib.sha256(text.encode()).hexdigest()
criteria = ["full diff", "relevant callers", "tests", "all acceptance criteria"]
response = encode({"number": 323, "criteria": criteria, "irrelevant": "y" * 80_000})
evidence = {"long-line": "x" * 30_000 + "\n",
            "file-a": "a" * 9_000, "file-b": "b" * 9_000, "file-c": "c" * 9_000,
            "diff": "diff evidence\n" * 4_000,
            "callers": "caller\n" * 1_000, "tests": "test\n" * 1_200,
            "handoff": "coverage complete; child result recorded"}
assert len(evidence["long-line"].splitlines()) < 2_000
fixture = encode({"response": response, "evidence": evidence,
                  "completion": 145, "loaded_wait_max": 60, "baseline_wait": 30})
groups = [("dispatcher", ["github"]), ("implementer", ["long-line"]),
          ("implementer", ["file-a", "file-b", "file-c"]),
          ("reviewer", ["diff"]), ("reviewer", ["callers", "tests"]),
          ("implementer", ["file-a"]), ("implementer", ["handoff"])]

def replay(bounded):
    sources = dict(evidence, github=response)
    if bounded:
        data = json.loads(response)
        sources["github"] = encode({key: data[key] for key in ("number", "criteria")})
    batches, covered, cache = [], {}, set()
    reuse_hits = 0
    def packet(role, rows):
        return encode({"role": role, "results": rows})
    for role, keys in groups:
        rows = []
        for key in keys:
            identity = (role, key, digest(sources[key]))
            if identity in cache:
                reuse_hits += 1
                continue
            cache.add(identity)
            text = sources[key]
            size = 10_000 if bounded else len(text)
            for start in range(0, len(text), size):
                row = {"scope": key, "start": start, "text": text[start:start + size]}
                if bounded and rows and len(packet(role, rows + [row])) > 22_000:
                    batches.append(packet(role, rows)); rows = []
                if bounded:
                    assert len(encode(row)) <= 12_000
                rows.append(row)
                covered.setdefault(key, []).append((start, row["text"]))
        if rows:
            batches.append(packet(role, rows))
    for key, text in sources.items():
        assert "".join(part for _, part in sorted(covered[key])) == text
    for key in ("number", "criteria"):
        assert json.loads(sources["github"])[key] == json.loads(response)[key]
    if bounded:
        assert all(len(batch) <= 24_000 for batch in batches)
    unchanged = ("implementer", "file-a", digest(sources["file-a"]))
    assert unchanged in cache and reuse_hits == 1  # the repeat returns no output
    wait_seconds = min(60, 60) if bounded else 30
    waits = math.ceil(145 / wait_seconds)
    return {"returned_payload_characters": sum(map(len, batches)),
            "peak_batch_characters": max(map(len, batches)), "retrieval_batches": len(batches),
            "modeled_wait_calls": waits, "modeled_idle_timeout_wakeups": waits - 1,
            "modeled_progress_updates": 2, "modeled_status_probes": 0, "unchanged_read_reuses": reuse_hits,
            "runtime_model_calls": None, "runtime_peak_context": None,
            "runtime_input_cached_output": None, "coverage": "complete"}

chunks = [evidence["diff"][i:i + 10_000] for i in range(0, len(evidence["diff"]), 10_000)]
received = dict(enumerate(chunks)); del received[2]
assert set(range(len(chunks))) - received.keys() == {2}
received[2] = chunks[2]  # recover the missing range before judging
assert "".join(received[i] for i in range(len(chunks))) == evidence["diff"]
print(json.dumps({"baseline_revision": baseline, "baseline_policy_sha256": digest("".join(old)),
                  "candidate_policy_sha256": digest("".join(new) + policy),
                  "fixture_sha256": digest(fixture), "before": replay(False),
                  "after": replay(True)}, indent=2))
PY
```

The replay enforces its candidate payload assertions in Python. The delivery policy itself remains instructional. The baseline has no replay cap, allowing the long line and combined reads to demonstrate the gap. The same 56,000 review characters, relevant callers/tests, and criteria must be reconstructed before either variant reaches the common handoff cutoff. The missing-range example detects and repairs a gap before judging. Both variants model unchanged evidence reuse, so the comparison does not attribute any reduction to weakening #308's read-once rule.

## Recorded evidence and limits

The controlled replay results below are reproducible from the command above. Runtime model-call count, peak context, input/cached/output tokens, and actual idle model wakeups are unavailable for both variants because no inference runtime participates. The wait counts are modeled; payload counts are measured on the replay's constructed return envelopes. More retrieval batches do not establish more or fewer model calls because a runtime may batch, cache, or compact them differently.

| Metric | Reconstructed baseline | Candidate | Evidence type |
| --- | --- | --- | --- |
| Returned tool-output payload characters | 212,916 | 133,369 | Measured replay envelopes |
| Peak combined return characters | 80,196 | 21,542 | Measured replay envelopes |
| Retrieval batches | 6 | 10 | Measured replay trace |
| Agent wait calls / idle timeout wakeups | 5 / 4 | 3 / 2 | Modeled at 30s / 60s cadence |
| Required progress updates / status probes | 2 / 0 | 2 / 0 | Modeled at common deadlines |
| Unchanged successful reads reused | 1 | 1 | Measured replay trace |
| Model calls / peak runtime context | unavailable / unavailable | unavailable / unavailable | No inference runtime |
| Input / cached input / output tokens | unavailable / unavailable / unavailable | unavailable / unavailable / unavailable | No inference runtime |
| Relevant evidence coverage at handoff | complete | complete | Reconstructed text and criteria assertions |

Input identifiers from the recorded replay:

- Baseline policy SHA-256: `d1e4d1f7a9553c051b2db4db86be7701bf70b12e3617d5b31da4c46f25b02569`.
- Candidate policy SHA-256: `63ad8f59628a9b1d9a88d9c638b84ccee70579cd724299a2fa1fa5361b158b9b`.
- Fixture SHA-256: `43cdfdd331cd2b87499fbc73a2f3978165231ab6612d85f5bb1bc63476d4258f`.

The issue #323 historical baseline reports approximately 13.50 million total tokens, including 12.73 million cached input tokens and 61,753 output tokens, approximately 1.52 million implementer tool-output characters, and 27 parent wait calls across #290, #291, and #293. The approximately 796,000 input tokens around wait cycles are already part of input. These are supplied context, not a comparator for this replay. Their raw exports are unavailable and are not needed to reproduce the controlled audit.

A partial #323 implementer observation at `2026-10-19T18:57:42.120Z` contains 21 model calls, a peak request-input proxy of 77,995 tokens, 162,941 returned tool-output characters, zero agent wait calls, and zero idle timeout wakeups. Input is 1,264,689 tokens, including 1,183,232 cached input tokens; output is 12,913, for input + output of 1,277,602. It includes setup before this policy was written and excludes the dispatcher, independent review, and final handoff. Required user progress updates were not classified separately. It checks the telemetry method and is not the after column of the controlled comparison.

For a prospective runtime comparison, run an authorized isolated delivery fixture twice from the same task/source snapshot, once with the pinned baseline guidance and once with candidate guidance. Keep model/effort, role set, review rounds, required checks, concurrency, wait limits, and cache conditions matched. Collect each role from dispatch through final handoff with the same cutoff. Report the metrics above separately by role and in aggregate using the extractor, marking missing metrics unavailable. Record any mismatch instead of claiming causation. This procedure collects new paired evidence; it does not require recovery of historical sessions.

Runtime caching, compaction, prompt size, task scope, model, tool-output clipping, retries, and review rounds affect usage. Generation and parity checks prove matching guidance, not runtime compliance. Token counts do not establish subscription quota deductions. No fixed token reduction or quota saving follows from this policy or the controlled replay.
