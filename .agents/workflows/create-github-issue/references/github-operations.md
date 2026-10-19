# GitHub operations

Every call here is REST through `gh api`. `gh issue`, `gh project`, and `gh api graphql` spend the GraphQL limit, so none of them appear here. When `gh api` needs an option you are unsure of, check `gh api --help`.

Create: write the body to a scratch file outside the repository (real newlines; protects backticks and `$`), then:
`gh api repos/{{repository}}/issues -f title='T' -F body=@/abs/body.md -f 'labels[]=L' [-f type='NativeType'] [-f 'assignees[]=LOGIN'] [-F milestone=NUMBER] --jq '"\(.number) \(.id) \(.html_url)"'`
Repeat `-f 'labels[]=...'` once per label. Add `type` only for a discovered native type. Record the number, the numeric `id`, and the URL from the response. GitHub silently drops labels, type, assignees, and milestone it will not set, so the read-back confirms them. Do not rely on templates to fill forms or metadata.

Relationships use the numeric `id` of the other issue, from the create response or `gh api repos/{{repository}}/issues/N --jq .id`. Never use a displayed number or a `node_id` in its place.

- Parent link: `gh api repos/{{repository}}/issues/PARENT/sub_issues -F sub_issue_id=CHILD_ID`, where PARENT is the parent's number.
- Blocked-by edge: `gh api repos/{{repository}}/issues/BLOCKED/dependencies/blocked_by -F issue_id=BLOCKER_ID`, where BLOCKED is the number of the issue that waits. The blocker's `id` goes in the body; do not reverse the direction.

Project: select it by owner and number, never by title.
`gh api users/{{project.owner}}/projectsV2/{{project.number}}/fields --paginate`
Each single-select field lists its `options` with their `id` and `name`. A repository workflow adds each new issue to the project within about a minute. Never add an item yourself (no `POST` to the project's `items`). Find the item the workflow added:
`gh api -X GET users/{{project.owner}}/projectsV2/{{project.number}}/items -f per_page=100 --paginate --jq '.[] | select(.content.number == N and .content.repository_url == "https://api.github.com/repos/{{repository}}") | .id'`
It prints the item ID (ITEM). An empty result means the item is not there yet. Repeat every 10 seconds for up to 3 minutes. If it is still missing, skip that issue's fields and post-create commands and report it as unfinished: name the issue, say that it is not in the project and its fields are unset, and point to the repository's Actions runs for the issue. Once the item exists, write `{"fields":[{"id":FID,"value":"OID"}]}` to a scratch file, with one entry per field (FID is the numeric field ID, OID the option ID), and set the fields:
`gh api -X PATCH users/{{project.owner}}/projectsV2/{{project.number}}/items/ITEM --input /abs/fields.json`
Resolve IDs from current metadata and never copy them across projects. If project authorization is missing, keep the created issue and report the gap. Never refresh auth or add scopes without permission.

Read back with REST:

- `gh api repos/{{repository}}/issues/N` for the title, body, labels, type, assignees, and milestone.
- `gh api -X GET users/{{project.owner}}/projectsV2/{{project.number}}/items/ITEM -f fields=FID,FID` for project membership and field values. Without `fields`, only the title comes back.
- `gh api repos/{{repository}}/issues/N/sub_issues --paginate`, `gh api repos/{{repository}}/issues/N/parent` (404 when the issue has no parent), `gh api repos/{{repository}}/issues/N/dependencies/blocked_by --paginate`, and `gh api repos/{{repository}}/issues/N/dependencies/blocking --paginate` to confirm direction.
