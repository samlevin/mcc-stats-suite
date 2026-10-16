# GitHub operations

Check `gh <cmd> --help` for flags supported by the installed version.

Create: write the body to a scratch file outside the repository (real newlines; protects backticks and `$`), then:
`gh issue create --repo {{repository}} --title 'T' --body-file /abs/body.md --label 'L' [--type 'NativeType'] [--parent URL] [--blocked-by URL]`
Add `--type` only for a discovered native type. A blocker belongs in `--blocked-by`; do not reverse the direction. Do not rely on `--template` to fill forms or metadata. Capture the URL even on a non-zero exit, because a later metadata step can fail after the issue exists.

Relationships, if the CLI lacks flags: GraphQL `addSubIssue(issueId, subIssueId)` and `addBlockedBy(issueId, blockingIssueId)`, using node IDs from `gh issue view N --json id`. Never use displayed numbers as node IDs.

Project: select it by owner and number, never by title.
`gh project field-list {{project.number}} --owner {{project.owner}} --format json`
A repository workflow adds each new issue to the project within about a minute. Never run `gh project item-add`. Find the item the workflow added:
`gh api graphql -f query='query($url: URI!) { resource(url: $url) { ... on Issue { projectItems(first: 50) { nodes { id project { id number owner { ... on User { login } ... on Organization { login } } } } } } } }' -F url=ISSUE --jq '.data.resource.projectItems.nodes[] | select(.project.number == {{project.number}} and .project.owner.login == "{{project.owner}}") | "\(.id) \(.project.id)"'`
It prints the item ID (ITEM) and the project ID (PID). An empty result means the item is not there yet. Repeat every 10 seconds for up to 3 minutes. If it is still missing, skip that issue's fields and post-create commands and report it as unfinished: name the issue, say that it is not in the project and its fields are unset, and point to the repository's Actions runs for the issue. Once the item exists, set each field on it:
`gh project item-edit --id ITEM --project-id PID --field-id FID --single-select-option-id OID`
Resolve IDs from current metadata and never copy them across projects. If project authorization is missing, keep the created issue and report the gap. Never refresh auth or add scopes without permission.

Read back: `gh issue view URL --json title,body,labels,milestone,projectItems`, plus GraphQL `subIssues`, `parent`, `blockedBy`, and `blocking` to confirm direction.
