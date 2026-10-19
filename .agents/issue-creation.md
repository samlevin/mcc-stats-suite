# MCC issue creation

Use the repo's issue forms and [labels](../.github/labels.json). Read [ISSUE_TRIAGE.md](../ISSUE_TRIAGE.md) only for a classification question.

- Plain titles, with no `[Type]:` prefix.
- Set Priority (default P2), Size, one severity, and area labels. Use `bug`, not `type: bug`. Use `epic` only when explicitly requested, and then as the sole work-category label.
- An issue that removes or rewrites text, rules, or behavior lists what must be kept, as acceptance criteria an implementer can check. Implementation notes state the intent and the behavior affected. Quoted strings may show where to look, but never stand alone as a find-and-replace list.
- Multiple outcomes become native sub-issues under `container.yml` (What/Why/How, no acceptance criteria). Leaves use `task.yml` or `bug.yml` with acceptance criteria.
- When the triager returns independence groups for a new container or epic, record them once its children exist by appending this section to its body, one line per group, with the leaves' issue numbers:

  ```markdown
  ### Independence groups

  <!-- mcc-independence-groups -->
  - g1: #101 #103
  - g2: #102
  <!-- /mcc-independence-groups -->
  ```

  `mcc-orchestrator` reads only the lines between the markers. It runs leaves from different groups at the same time, the leaves in one group one after another, and a leaf in no group alone. Leave out the section when the triager returns no groups. Group membership never goes in labels.
- After creating the issues, run `node scripts/issue-triage.mjs --apply --issue N` for each new issue and `node scripts/issue-containers.mjs --apply --issue N` for each new top-level container.
