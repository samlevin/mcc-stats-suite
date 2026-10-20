# REST filing operations

Use only REST through `gh api` for your GitHub calls. Pass structured JSON payload files with `--input`; write prose payloads with literal newlines. Discover metadata once per batch and reuse it. Do not publish anything until offline pre-flight, triage and confirmation succeed. Before first creation, search for duplicates by spec link and draft title, and reconcile any existing run state.

| Operation | REST call / payload |
| --- | --- |
| Discover live labels | GET `repos/{{repository}}/labels` with `--paginate` |
| Discover project options | GET `users/{{project.owner}}/projectsV2/{{project.number}}/fields` |
| Create issue | POST `repos/{{repository}}/issues` with title, body including run marker, confirmed labels, and assignees required by the person's policy. Save numeric `id`, `number`, `html_url` immediately. |
| Recover uncertain creation | GET `repos/{{repository}}/issues?state=all&per_page=100` with `--paginate`, excluding pull requests, checking exact markers and creator |
| Read/add parent link | GET `repos/{{repository}}/issues/<parent>/sub_issues` with `--paginate`; POST there with `{"sub_issue_id": <child id>}` only when absent. Verify the child's `/parent` too. |
| Read/add dependency | GET `repos/{{repository}}/issues/<waiting>/dependencies/blocked_by` with `--paginate`; POST there with `{"issue_id": <blocker id>}` only when absent. Never invert the edge. |
| Rewrite body | PATCH `repos/{{repository}}/issues/<number>` with `{"body": "<final body>"}` only when different and current content is the run's expected content |
| Find project item | GET `users/{{project.owner}}/projectsV2/{{project.number}}/items?per_page=100` with `--paginate`; select content repository and number |
| Set metadata | PATCH `users/{{project.owner}}/projectsV2/{{project.number}}/items/<id>` with `{"fields":[{"id":<Priority field id>,"value":"<option id>"},{"id":<Size field id>,"value":"<option id>"}]}`. Omit Size when the triager leaves it unset for a container. Never include Status. |

Create the root, phase epics and split containers before their children. After all issues exist, render the saved reference map into bodies, attach native parents, then add blocked-by edges. Once relationships are verified, append `.agents/issue-creation.md`'s independence record to each eligible phase epic or split container. Keep the rest of each body and its recovery marker. Never put a record on the root.

Journal and pace every write, including PATCH calls and post-create script attempts. At least one second separates writes. Honor GitHub's rate-limit response; on an ambiguous failure reconcile with GET before retrying. Do not create or edit labels, project fields/options, settings, or project Status. Do not PATCH an issue outside this run's marker-verified mapping.

Repository automation adds project items. If an item is absent, report the issue and pending metadata/post-create steps with the state path; resume when it exists. Do not add the item yourself. After all items, metadata, bodies and relationships exist, run `node scripts/issue-triage.mjs --apply --issue N` for each created issue, then `node scripts/issue-containers.mjs --apply --issue N` for the root. These adapters can update tracker state under their existing repository policy; do not change their behavior. On resume verify script effects before re-running an unfinished attempt, and never repeat a completed invocation without evidence it is needed. Read back final bodies, labels, parent links, dependency direction, records, and project fields. Report partial results instead of hiding them.
