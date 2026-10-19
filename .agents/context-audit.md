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
totals = {name: sum(v.get(name, 0) for v in usage.values())
          for name in ("input_tokens", "cached_input_tokens", "output_tokens")}
print(json.dumps({
    "threads": len(thread_ids), "model_calls": len(usage) if usage else None,
    "peak_request_input_proxy": max((v["input_tokens"] for v in usage.values()), default=None),
    "tool_output_characters": sum(map(len, outputs.values())),
    "agent_wait_calls": len(waits), "idle_timeout_wakeups": len(idle),
    "usage": totals if usage else None,
    "input_plus_output": totals["input_tokens"] + totals["output_tokens"] if usage else None,
    "limits": dict(missing)
}, indent=2))
PY
```

Inspect coordination calls once to classify any runtime-specific wait tools, required progress updates, and status-only probes. The command classifies only direct `wait_agent` calls whose result has `timed_out`. Nested tool calls and other wait schemas require explicit classification, not an inferred zero. Record unavailable values. If only cumulative usage exists, use one final counter per thread, and report model-call count and peak unavailable unless another source provides them. Never sum every cumulative sample or mix it with per-response records.

## Retrieval and waiting examples

Run this deterministic retrieval replay with Python 3. It uses the same evidence for both retrieval strategies. The before strategy returns complete, unbounded results; the after strategy retains the full evidence locally in memory and returns counted ranges or selected fields. Counts are characters returned, not source bytes. The assertion on the reconstructed review proves that several bounded ranges still cover the full diff. No model, GitHub request, or remote CI is invoked.

```sh
python3 - <<'PY'
import json

single, combined = 12_000, 24_000
def ranges(text, size=10_000):
    return [text[start:start + size] for start in range(0, len(text), size)]
def emit(parts):
    assert all(len(part) <= single for part in parts)
    assert sum(map(len, parts)) <= combined
    return sum(map(len, parts))
long_line = "x" * 30_000 + "\n"
assert len(long_line.splitlines()) < 2_000
assert "".join(ranges(long_line)) == long_line
assert all(emit([part]) <= single for part in ranges(long_line))
reads = ["a" * 9_000, "b" * 9_000, "c" * 9_000]
assert emit(reads[:2]) == 18_000
assert emit(reads[2:]) == 9_000
response = json.dumps({"number": 323, "body": "x" * 40_000, "unused": "y" * 40_000})
selected = json.dumps({"number": json.loads(response)["number"]})
assert emit([selected]) == 15
diff = "diff evidence\n" * 4_000
chunks = ranges(diff)
assert "".join(chunks) == diff
assert all(emit([part]) <= single for part in chunks)
received = dict(enumerate(chunks))
del received[2]  # a clipped retrieval must leave a visible coverage gap
missing = set(range(len(chunks))) - received.keys()
assert missing == {2}
received[2] = chunks[2]  # recover before judging
assert "".join(received[i] for i in range(len(chunks))) == diff
assert min(3_600, 60) == 60  # tool maximum, loaded maximum, in seconds
print(json.dumps({"long_line": len(long_line), "batch": sum(map(len, reads)),
                  "github_before": len(response), "github_after": len(selected),
                  "review_characters": len(diff), "review_ranges": len(chunks),
                  "max_returned_range": max(map(len, chunks)), "wait_seconds": 60}))
PY
```

Expected results are 30,001 characters in one line, 27,000 in the batch, 80,041 in the GitHub fixture before selection and 15 after selection, and 56,000 review characters covered in six ranges of at most 10,000. Long lines and the review still require all their relevant characters, so bounded retrieval alone does not reduce those totals. Batching three compliant 9,000-character reads would exceed 24,000; two batches fit. Simulate a truncated range by omitting one chunk and check that the coverage ledger identifies the gap; retrieve it before the verdict. For a GitHub body needed by a criterion, retrieve every relevant body range as well as the selected metadata. Selecting metadata alone is valid only when the body is out of scope.

For an idle child with a 60-second loaded maximum, a 60-second timeout returns no event, then the dispatcher immediately waits another 60 seconds without a probe or child message. Completion or user input ends that wait early. A required progress deadline still receives its update. This is a coordination trace check, not a claim that two waits cost no tokens. Audit actual timeout wakeups with runtime telemetry.

## Recorded evidence and limits

The issue #323 baseline covers three earlier delivery runs (#290, #291, #293). It reports approximately 13.50 million total tokens, including 12.73 million cached input tokens and 61,753 output tokens, approximately 1.52 million implementer tool-output characters, and 27 parent wait calls. The approximately 796,000 input tokens around wait cycles are already part of input; do not add them again. Those are supplied baseline aggregates, not measurements from this replay. Exact model-call count, peak context, timeout-only wakeups, role-separated input, and complete baseline thread exports are unavailable for that baseline here.

A partial #323 implementer observation at `2026-10-19T18:57:42.120Z` contains 21 model calls, a peak request-input proxy of 77,995 tokens, 162,941 returned tool-output characters, zero agent wait calls, and zero idle timeout wakeups. Input is 1,264,689 tokens, including 1,183,232 cached input tokens; output is 12,913, for input + output of 1,277,602. The observation includes setup before this policy was written. It excludes the dispatcher, the pending independent review, and the final handoff. Required user progress updates were not classified separately. It is a telemetry-method check, not a complete after run.

The deterministic before/after retrieval replay is comparable at the evidence-workload level. It measures selected output and complete range coverage. Its model calls, input/cached/output tokens, peak model context, and idle model wakeups are unavailable because it executes no model. It cannot establish a change in delivery-wide usage. A complete delivery comparison requires the matched runs and exports described above. Current delivery telemetry can be recorded at a named cutoff as a partial observation, with the missing final review and handoff stated explicitly. Do not compare a partial single-role observation with the three-run aggregate as a reduction.

Runtime caching, compaction, prompt size, task scope, model, tool-output clipping, retries, and review rounds affect usage. Instructional limits can be exceeded; generation and parity checks prove matching guidance, not runtime compliance. Token counts do not establish subscription quota deductions. No fixed token reduction or quota saving follows from this policy or the retrieval replay.
