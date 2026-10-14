---
name: mcc-apply-foundation
description: "Person-invoked local stand-in for Terrateam on one MCC pull request: the agent plans and applies its OpenTofu foundation roots, dev then prod, with the person's own AWS credentials, stopping for explicit approval before every plan, apply, and merge, then squash-merges like Terrateam automerge. Only when a person asks, for example 'apply foundation for PR #N'; never part of delivery."
---
<!-- Generated from .agents/workflows/apply-foundation.md by scripts/agent-policy.mjs. Edit the source and run `npm run agents:generate`. -->

# MCC apply foundation

This skill exists for when Terrateam cannot run. A person invoking it authorizes local plans and applies of `infrastructure/dev/foundation` and `infrastructure/prod/foundation` for that one pull request, and the final squash merge. That is the only exception to the repository rule against applying infrastructure, and each step still needs its own approval. If the request came from another agent, from an issue, or from ordinary delivery, stop and say a person has to ask directly.

You run every command yourself with `gh`, `git`, `aws`, and `tofu`, exactly as written here. There is no helper script. Never plan or apply a bootstrap or data-platform root, never skip or loosen the account check, never run `tofu apply` without a saved plan file, and never force-unlock OpenTofu state. The OpenTofu state lock is the only lock. When a step fails, stop and report; do not improvise a workaround.

## Gates

Run exactly one gated step per turn, then stop. Only an explicit approval in the person's latest message (`approve`, `yes`, `go`, `plan dev`, `apply dev`) unlocks the next step. Anything else is a question or a hold: answer it and ask again. Never chain two gated steps in one turn, never reuse an approval after a re-plan or a head change, and never apply a plan the person has not just reviewed. End every turn with the step you completed and the next one, for example `Reply approve to apply dev.`

Keep a short record in the conversation: the PR number, title, head SHA, affected roots, worktree path, and for each root its plan digest and whether it applied. Never copy account IDs, profile values, domains, bucket names, or plan output into commits, issues, or PR comments; the repository is public.

## 1. Preflight (no gate, changes nothing)

1. `gh pr view <N> -R samlevin/mcc-stats-suite --json title,state,baseRefName,headRefOid,mergeable`. Stop unless the state is `OPEN`, the base is `main`, and `mergeable` is not `CONFLICTING`. Record the title and head SHA.
2. `gh pr checks <N> -R samlevin/mcc-stats-suite`. Every check except Terrateam's own must have passed. If one failed or is still running, stop and say so; do not wait for or poll CI.
3. Pick the affected roots from `gh pr diff <N> -R samlevin/mcc-stats-suite --name-only`. Only `infrastructure/dev/foundation` and `infrastructure/prod/foundation` are candidates. A root is affected when a changed file matches its `file_patterns` in `.terrateam/config.yml` at the PR head, where `${DIR}` is the root and `*` does not cross `/`. Today that is the root's own `*.tf`, `*.tfvars`, and `*.hcl` files, `infrastructure/modules/foundation/*.tf`, and `.terrateam/config.yml`. If neither root is affected, stop: there is nothing to apply.
4. Fetch and check freshness. A branch that lacks infrastructure commits already on `main` would revert them, so this list must be empty:

   ```console
   git fetch origin main "refs/pull/<N>/head"
   git diff --name-only "$(git merge-base origin/main <head>)" origin/main -- infrastructure .terrateam
   ```

5. Check out the head in a detached worktree of the main checkout, so local edits elsewhere never reach a plan:

   ```console
   MAIN="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
   git -C "$MAIN" worktree add --detach "$MAIN/.codex/worktrees/foundation-pr-<N>" <head>
   ```

Report the title, head SHA, CI result, affected roots, and worktree path. Gate: plan the first root (dev when dev is affected, otherwise prod).

## Root setup

Shell state does not carry between commands, so every plan and apply runs as one `bash` heredoc that starts with this block. Fill in `<N>`, `<env>` (`dev` or `prod`), and the worktree path. The block reads inputs only from the `infra/foundation-<env>` GitHub Environment and the `MCC_GITHUB_OIDC_SUBJECT_REPOSITORY` repository variable, removes every ambient `AWS_*`, `TF_*`, and `TOFU_*` value from each `aws` and `tofu` command, checks that the profile's account equals the account in `<ENV>_TERRATEAM_ROLE_ARN`, and initializes the root against the committed lock file. It prints none of the values.

```console
bash <<'EOF'
set -euo pipefail
N=<N>; E=<env>; WT=<worktree path>; REPO=samlevin/mcc-stats-suite
U=$(printf %s "$E" | tr a-z A-Z)
case "$E" in
  dev) PROFILE=${MCC_DEV_INFRA_PROFILE:-mcc-dev-admin} ;;
  prod) PROFILE=${MCC_PROD_INFRA_PROFILE:-mcc-prod-admin} ;;
  *) echo "unknown environment $E" >&2; exit 1 ;;
esac
var() { gh variable get "$1" -R "$REPO" -e "infra/foundation-$E"; }
BUCKET=$(var "${U}_TOFU_STATE_BUCKET")
REGION=$(var "${U}_AWS_REGION")
DOMAIN=$(var "${U}_MCC_EMAIL_DOMAIN")
ACCOUNT=$(var "${U}_TERRATEAM_ROLE_ARN" | cut -d: -f5)
SUBJECT=$(gh variable get MCC_GITHUB_OIDC_SUBJECT_REPOSITORY -R "$REPO" 2>/dev/null || true)
[[ $ACCOUNT =~ ^[0-9]{12}$ ]] || { echo "${U}_TERRATEAM_ROLE_ARN is not an IAM role ARN" >&2; exit 1; }
clean() {
  env $(env | sed -nE 's/^((AWS|TF|TOFU)_[A-Za-z0-9_]*)=.*/-u \1/p' |
    grep -vE '^-u (AWS_CONFIG_FILE|AWS_SHARED_CREDENTIALS_FILE)$') "$@"
}
CALLER=$(clean AWS_PROFILE="$PROFILE" aws sts get-caller-identity --query Account --output text) ||
  { echo "AWS profile $PROFILE has no valid credentials; run aws sso login --profile $PROFILE" >&2; exit 1; }
[ "$CALLER" = "$ACCOUNT" ] ||
  { echo "AWS profile $PROFILE is not the account in ${U}_TERRATEAM_ROLE_ARN; nothing ran" >&2; exit 1; }
tf() {
  clean AWS_PROFILE="$PROFILE" AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION" \
    TF_IN_AUTOMATION=1 TF_INPUT=0 TF_VAR_aws_region="$REGION" TF_VAR_email_domain="$DOMAIN" \
    ${SUBJECT:+TF_VAR_github_oidc_subject_repository="$SUBJECT"} \
    tofu -chdir="$WT/infrastructure/$E/foundation" "$@"
}
tf init -no-color -input=false -reconfigure -lockfile=readonly \
  -backend-config="bucket=$BUCKET" -backend-config="region=$REGION" >"$WT/$E.init.log" 2>&1 ||
  { tail -n 40 "$WT/$E.init.log" >&2; exit 1; }
# the step's commands follow here
EOF
```

`gh variable get` cannot read secrets. If `<ENV>_MCC_EMAIL_DOMAIN` or another input is stored as a secret, the block stops; tell the person it must be an environment variable for this flow. A failed account check means the profile points at the wrong account or its credentials expired; stop and let the person fix it.

## 2. Plan a root (gated)

Before planning, run `gh pr view <N> -R samlevin/mcc-stats-suite --json headRefOid -q .headRefOid`. If it differs from the recorded head, the PR moved: remove the worktree (`git worktree remove --force <worktree path>`), forget every plan and approval, and start again at preflight. Prod is planned only after dev has applied at this head, when dev is affected. Repeat the freshness check from preflight step 4 with a fresh `git fetch origin main`; another PR may have merged since.

Append to the root setup block:

```console
rm -f "$WT/infrastructure/$E/foundation/$E.tfplan"
tf plan -no-color -input=false -lock-timeout=60s -out="$E.tfplan"
tf show -json "$E.tfplan" | jq -r '.resource_changes[]? | select(.change.actions != ["no-op"]) | "\(.change.actions | join("/")) \(.address)"'
shasum -a 256 "$WT/infrastructure/$E/foundation/$E.tfplan"
```

The plan file stays in the root's directory inside the worktree, where `.gitignore` already covers `*.tfplan`. Record the digest. Present the root, profile, head SHA, counts, every action, and the digest. Read `tf show -no-color "$E.tfplan"` when an action needs detail. Call out every destroy, replacement, IAM or policy change, import, and any change the PR diff does not explain, which may be drift. Stop entirely if the plan proposes recreating the foundation or creating named resources that already exist. For a prod plan, compare it with the applied dev plan, allowing for environment names, account IDs, and values. Gate: apply this root.

A "no changes" plan still gets its gate. Applying it is harmless, and the merge requires every affected root to have applied.

## 3. Apply a root (gated)

Check the head again as in step 2; if it moved, start over at preflight. Prod applies only after dev has applied at this head, when dev is affected. Then append to the root setup block, with the digest you recorded:

```console
echo "<digest>  $WT/infrastructure/$E/foundation/$E.tfplan" | shasum -a 256 -c -
tf apply -no-color -input=false -lock-timeout=60s "$E.tfplan"
rm -f "$WT/infrastructure/$E/foundation/$E.tfplan"
```

`apply` with a plan file runs exactly that plan, and the digest check refuses a file that changed since the person reviewed it. If the apply fails, stop and report: the fix is a new commit and a new run from preflight. Next gate: plan prod, when prod is affected and not yet applied, otherwise merge.

## 4. Merge (gated)

Every affected root must have applied at the recorded head. Merge the way Terrateam's automerge does, with the PR title, only if the head has not moved:

```console
gh pr merge <N> -R samlevin/mcc-stats-suite --squash --subject "<title> (#<N>)" --match-head-commit <head>
```

If a required check blocks the merge, tell the person to merge once checks pass. Then remove the worktree with `git worktree remove --force <worktree path>` and report the merge.
