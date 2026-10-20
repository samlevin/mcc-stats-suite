# Evidence and waiting

Every delivery owner, isolated implementer, and code reviewer reads this file once and follows it. It decides how evidence is retrieved, never how much relevant evidence must be inspected: full review coverage, the callers and tests of changed code, and every acceptance criterion stay required.

## Retrieve what the task needs

- Start with targeted `rg` searches, the changed paths, and relevant callers and tests. Follow references when they reveal more in-scope behavior. Ask for the relevant fields and ranges. Select GitHub response fields with `--jq`, page list endpoints with `--paginate`, and pick the issue, item, comment, or PR you need instead of printing whole responses.
- Read a file of up to about 2,000 lines whole. Read a larger file by the line ranges the task needs, and never read a file you already read whole again in chunks.
- Read each unchanged file once. After an edit, inspect the changed regions with enough surrounding text to check their meaning, including whether nearby unchanged statements still hold. For a changed canonical source, inspect the corresponding regions in one generated file too. Search for other statements of changed rules and old names after a rename or move. Never reread only to confirm that an edit applied.
- Reuse evidence whose inputs have not changed: the same path and content, the same base and head, the same query, or the same validation command with unchanged code, dependencies, configuration, and environment. A new commit SHA alone does not invalidate a successful check. Repeat a successful command only when relevant inputs changed or new evidence calls its result into question.
- Save oversized responses, diffs, and full command logs to a local temporary file outside tracked paths, and use targeted searches or ranges to inspect them. Keep the file available through delivery or review. Keep validation output short in your context: pipe long logs through `tail -n 60` or a filter that keeps every failure, and report the command, its result, and the relevant failures. Never let a filter hide a failing exit status.
- Output that was not truncated is complete. When output is truncated or a page, range, or field is missing, retrieve the missing part with a narrower pattern, a range, or the next page before you edit, judge, or report from it. Never act on partial output.
- Facts a handoff already supplied, such as acceptance criteria, accepted decisions, verified prerequisites, and SHAs, are evidence. Reuse them, and retrieve only what is missing or may be stale, such as a branch head that could have moved.

These rules set no character budget, ledger, or counting step. Narrow a retrieval because the task needs less, not to meet a number.

## Wait for events

- While a child agent or a long command runs and no other authorized work remains, wait with the tool's own wait mechanism for the longest timeout that the tool and these instructions allow. A blocking agent call already waits; add no polling around it.
- Stay idle until a result, a substantive child message, or user input arrives. A timeout alone is not new information: wait again without status probes, repeated agent listings, output rereads, or status-only messages to the child. A progress update the tool requires is the one exception; send it briefly and keep waiting.
- Send a child only new evidence, a decision, a correction, or an answer it needs. Respond to user steering promptly.
- Never coordinate with shell sleep loops or polling, and never wait for, poll, or rerun remote CI.
