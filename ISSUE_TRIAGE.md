# Issue triage

Use [MCC delivery](https://github.com/users/samlevin/projects/1) for Priority, Size, and Status. Default Priority is **P2**. Assign one severity label to every issue, including containers.

| Severity | Meaning | Default priority |
| --- | --- | --- |
| critical | Outage, data loss, serious security impact | P0 while active; otherwise P1 |
| high | Important functionality broken | P1 |
| medium | Bounded functional defect | P2 |
| low / none | Minor defect / planned work | P2; P3 when optional |

Deadlines and blocking dependencies can raise priority. Use reported facts; note material uncertainty without inventing impact. No separate label-evidence report is needed.

| Size | Scope |
| --- | --- |
| XS | Narrow edit |
| S | One component |
| M | One outcome across cooperating components |
| L | Needs planning or decomposition |

Split multiple logical outcomes into native sub-issues, even when small. Size alone does not create an epic. M and larger work can use stacked PRs for reviewable layers; retain the production-code size guidance in [WORKFLOW.md](WORKFLOW.md).

## Labels

Use existing `bug`, `enhancement`, or `documentation` labels where applicable, one `severity:` label, and labels for directly affected `package:` workspaces. Repository and infrastructure work use `area: repository` and `area: infrastructure`. Apply exceptional `risk:` labels only when useful. Avoid duplicate `type: bug` and package/area pairs. Apply `type: epic` only when epic creation was explicitly requested. Other standard labels remain available for their ordinary purpose. See [.github/labels.json](.github/labels.json) for exact names. The issue description supplies context; do not justify each label individually.

## Planning and hierarchy

A leaf issue delivers one logical feature, bug, or change with observable acceptance criteria. Any issue with native sub-issues is a container and never has its own implementation branch or PR. Containers can contain other containers. Epics are explicitly requested, notable bodies of work, often linked to a requested milestone; ordinary multi-part requests become an Issue with Sub-issues. Use `Parent epic` in a child body only when its immediate parent is an epic, otherwise `Parent issue`.

Clear requests need little planning. For broad requests, establish boundaries, acceptance criteria, and native blocking relationships; ask only about material unknowns. Creation of multiple logical changes authorizes the necessary sub-issues within the requested scope. Never invent additional product work or create an epic implicitly. Container acceptance criteria must be covered by its children, including any integration or verification work, so closure can follow child completion.

## Automation

The [workflow](.github/workflows/issue-triage.yml) uses deterministic GitHub API calls, with no model usage. It moves an open issue from Inbox to Ready when Priority, exactly one supported severity, and Size are present. Other statuses are left alone by metadata triage. Ready means triaged; implementation still requires clear scope, acceptance criteria, validation, and satisfied dependencies.

It also closes any container when all direct children are closed and updates its project status to Done. Nested completion rolls up in the same run. If an unfinished child appears, it reopens only containers carrying the automation's `automation: container-closed` marker and sets their status to Ready. Manually closed containers are left alone. An empty issue is never auto-closed. Closed children count as complete regardless of close reason; a cancelled child should have its scope removed or reassigned before closure.

Issue events reconcile immediately; a 15 minute schedule catches project field and hierarchy edits that lack an Actions trigger. Issue creation performs scoped reconciliation immediately after metadata and relationships are complete:

```console
node scripts/issue-triage.mjs --apply --issue NUMBER
node scripts/issue-containers.mjs --apply --issue NUMBER
```

The second command reconciles the named issue's container subtree and ancestors, never unrelated issues. Drafts perform no writes. Both scripts default to dry-run. Actions uses `MCC_PROJECT_TOKEN`, provisioned from the owner's existing GitHub credential with explicit authorization. Local use relies on existing `gh` authentication. Do not print credentials or copy them during ordinary issue filing. Workflow activation requires publication on `main`; runtime field IDs are discovered. Concurrent human edits can race API writes, so avoid competing reconciliation sessions.
