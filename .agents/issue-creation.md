# MCC issue creation

Use the repo's issue forms and [labels](../.github/labels.json). Read [ISSUE_TRIAGE.md](../ISSUE_TRIAGE.md) when you classify an issue; it owns severity, Priority, Size, labels, and the leaf and container rules.

- Plain titles, with no `[Type]:` prefix.
- Set Priority (default P2), Size, one severity, and area labels. Use `bug`, not `type: bug`. Use `epic` only when explicitly requested, and then as the sole work-category label.
- An issue that removes or rewrites text, rules, or behavior lists what must be kept, as acceptance criteria an implementer can check. Implementation notes state the intent and the behavior affected. Quoted strings may show where to look, but never stand alone as a find-and-replace list.
- Multiple outcomes become native sub-issues under `container.yml` (What/Why/How, no acceptance criteria). Leaves use `task.yml` or `bug.yml` with acceptance criteria.
- After creating the issues, run `node scripts/issue-triage.mjs --apply --issue N` for each new issue and `node scripts/issue-containers.mjs --apply --issue N` for each new top-level container.

## Independence groups

Only `mcc-issue-triager` forms independence groups, for a new container or epic with two or more leaf children. Two leaves are independent when all of these hold:

- No chain of blocked-by edges links them in either direction, directly or through another leaf.
- They share no blocker that is still open, because both would stack on its unmerged PR.
- Their implementation notes name no overlapping files or shared contracts.

Every leaf in a group must be independent of every leaf in every other group. Leaves in one group may depend on each other.

When the triager returns groups, record them once the children exist by appending this section to the container's body, one line per group, with the leaves' issue numbers:

```markdown
### Independence groups

<!-- mcc-independence-groups -->
- g1: #101 #103
- g2: #102
<!-- /mcc-independence-groups -->
```

Leave out the section when the triager returns no groups. Group membership never goes in labels.

`mcc-implement` reads only the lines between the markers, and only for the container that holds them. It ignores the whole record, and treats the container as having none, when the section is malformed, names an issue that is not a direct sub-issue of that container, lists an issue twice, or when leaves in different groups are now linked by a chain of blocked-by edges or share a blocker that is still open. A valid record makes leaves eligible for the queue's parallel exception; delivery stays sequential unless a person explicitly asks for parallel delivery.
