---
name: mcc-apply-foundation
description: "Person-invoked local stand-in for Terrateam on one MCC pull request: the agent plans and applies its OpenTofu foundation roots, dev then prod, with the person's own AWS credentials, stopping for explicit approval before every plan, apply, merge, and unlock, then squash-merges like Terrateam automerge and releases any Terrateam lock left on the merged PR. Only when a person asks, for example 'apply foundation for PR #N'; never part of delivery."
argument-hint: <PR number>
disable-model-invocation: true
---
<!-- Generated from .agents/workflows/apply-foundation.md by scripts/agent-policy.mjs. Edit the source and run `npm run agents:generate`. -->

# MCC apply foundation

This skill exists for when Terrateam cannot run. A person invoking it authorizes local plans and applies of `infrastructure/dev/foundation` and `infrastructure/prod/foundation` for that one pull request, and the final squash merge. It falls under the repository's exception for person-invoked infrastructure apply skills, and each step still needs its own approval. If the request came from another agent, from an issue, or from ordinary delivery, stop and say a person has to ask directly.

You run every command yourself with `gh`, `git`, `aws`, `tofu`, `direnv`, `jq`, and `shasum`, exactly as written here. If one of them is not installed, stop and say which. There is no helper script. `gh` is only for the pull request's state, its checks, the merge, and the Terrateam unlock comment; every OpenTofu input comes from the main checkout. Never plan or apply a bootstrap or data-platform root, never skip or loosen the account check, never run `tofu apply` without a saved plan file, and never force-unlock OpenTofu state. The OpenTofu state lock is the only lock. Never edit, copy over, or delete anything in the main checkout, install there, or switch its branch; you only read its ignored local inputs. When a step fails, stop and report; do not improvise a workaround.

## Gates

Run exactly one gated step per turn, then stop. Only an explicit approval in the person's latest message (`approve`, `yes`, `go`, `plan dev`, `apply dev`) unlocks the next step. Anything else is a question or a hold: answer it and ask again. Never chain two gated steps in one turn, never reuse an approval after a re-plan or a head change, and never apply a plan the person has not just reviewed. End every turn with the step you completed and the next one, for example `Reply approve to apply dev.`

Keep a short record in the conversation: the PR number, title, head SHA, affected roots, worktree path, and for each root its plan digest and whether it applied. Never copy account IDs, profile values, domains, bucket names, or plan output into commits, issues, or PR comments; the repository is public.

## 1. Preflight (no gate, changes nothing)

1. `gh pr view <N> -R samlevin/mcc-stats-suite --json title,state,baseRefName,headRefOid,mergeable`. Stop unless the state is `OPEN`, the base is `main`, and `mergeable` is not `CONFLICTING`. Record the title and head SHA.
2. `gh pr checks <N> -R samlevin/mcc-stats-suite`. Every check except Terrateam's own must have passed. If one failed or is still running, stop and say so; do not wait for or poll CI.
3. Fetch and check freshness. A branch that lacks infrastructure commits already on `main` would revert them, so this list must be empty:

   ```console
   git fetch origin main "refs/pull/<N>/head"
   git diff --name-only "$(git merge-base origin/main <head>)" origin/main -- infrastructure .terrateam
   ```

4. Pick the affected roots from `gh pr diff <N> -R samlevin/mcc-stats-suite --name-only`. Only `infrastructure/dev/foundation` and `infrastructure/prod/foundation` are candidates. A root is affected when a changed file matches its `file_patterns` in the PR head's `.terrateam/config.yml`, which you read with `git show <head>:.terrateam/config.yml`. In those patterns `${DIR}` is the root and `*` does not cross `/`. Today that is the root's own `*.tf`, `*.tfvars`, and `*.hcl` files, `infrastructure/modules/foundation/*.tf`, and `.terrateam/config.yml`. If neither root is affected, stop: there is nothing to apply.

5. Check that each affected root has its ignored local inputs in the main checkout: `.envrc`, created from the committed `.envrc.example` in that root and allowed with `direnv allow` (it loads the repository-root `.envrc`, created from the root `.envrc.example`), and `backend.hcl`, created from `backend.hcl.example` with the bucket Terrateam uses for that environment. If one is missing, stop and tell the person which file to create from which example. Do not create them.

   ```console
   MAIN="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
   ls -a "$MAIN/infrastructure/dev/foundation" "$MAIN/infrastructure/prod/foundation"
   ```

6. Check out the head in a detached worktree of the main checkout, so local edits never reach a plan:

   ```console
   MAIN="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
   git -C "$MAIN" worktree add --detach "$MAIN/.claude/worktrees/foundation-pr-<N>" <head>
   ```

Report the title, head SHA, CI result, affected roots, and worktree path. Gate: plan the first root (dev when dev is affected, otherwise prod).

## Root setup

Shell state does not carry between commands, so every plan and apply runs as one `bash` heredoc that starts with this block. Fill in `<env>` (`dev` or `prod`) and the worktree path. The block reads inputs only from the root's local `.envrc` through `direnv` and its `backend.hcl`, both in the main checkout: the profile `MCC_<ENV>_INFRA_PROFILE`, the account `MCC_<ENV>_ACCOUNT_ID`, and `TF_VAR_aws_region`, `TF_VAR_email_domain`, and `TF_VAR_github_oidc_subject_repository`. These match what Terrateam supplies from the `infra/foundation-<env>` GitHub Environment. The block removes every ambient `AWS_*`, `TF_*`, and `TOFU_*` value from each `direnv`, `aws`, and `tofu` command, then passes exactly the loaded values. It checks that the profile's account equals `MCC_<ENV>_ACCOUNT_ID` and initializes the root against the committed lock file and the S3 backend. It prints none of the values.

```console
bash <<'EOF'
set -euo pipefail
E=<env>; WT=<worktree path>
U=$(printf %s "$E" | tr a-z A-Z)
case "$E" in dev | prod) ;; *) echo "unknown environment $E" >&2; exit 1 ;; esac
MAIN=$(dirname "$(git -C "$WT" rev-parse --path-format=absolute --git-common-dir)")
SRC="$MAIN/infrastructure/$E/foundation"
R="$WT/infrastructure/$E/foundation"
[ -f "$SRC/.envrc" ] || { echo "$SRC/.envrc is missing; create it from .envrc.example in that directory" >&2; exit 1; }
[ -f "$SRC/backend.hcl" ] || { echo "$SRC/backend.hcl is missing; create it from backend.hcl.example in that directory" >&2; exit 1; }
clean() {
  env $(env | sed -nE 's/^((AWS|TF|TOFU)_[A-Za-z0-9_]*)=.*/-u \1/p' |
    grep -vE '^-u (AWS_CONFIG_FILE|AWS_SHARED_CREDENTIALS_FILE)$') "$@"
}
LOCAL=$(clean DIRENV_LOG_FORMAT= direnv exec "$SRC" bash -c \
  'for p; do n=${p#*=}; printf "%s=%q\n" "${p%%=*}" "${!n-}"; done' _ \
  PROFILE="MCC_${U}_INFRA_PROFILE" ACCOUNT="MCC_${U}_ACCOUNT_ID" REGION=TF_VAR_aws_region \
  DOMAIN=TF_VAR_email_domain SUBJECT=TF_VAR_github_oidc_subject_repository) ||
  { echo "direnv could not load $SRC/.envrc; run direnv allow there" >&2; exit 1; }
eval "$LOCAL"
missing() { echo "$1 is not set by $SRC/.envrc or the repository-root .envrc it loads; see $2" >&2; exit 1; }
[ -n "$PROFILE" ] || missing "MCC_${U}_INFRA_PROFILE" "$SRC/.envrc.example"
[[ $ACCOUNT =~ ^[0-9]{12}$ ]] || missing "MCC_${U}_ACCOUNT_ID (an account ID)" "the .envrc.example files"
[ -n "$REGION" ] || missing TF_VAR_aws_region "the repository-root .envrc.example"
[ -n "$DOMAIN" ] || missing TF_VAR_email_domain "$SRC/.envrc.example"
[ -n "$SUBJECT" ] || missing TF_VAR_github_oidc_subject_repository "the repository-root .envrc.example"
for pair in "MCC_${U}_INFRA_PROFILE=$PROFILE" "TF_VAR_aws_region=$REGION" "TF_VAR_email_domain=$DOMAIN" \
  "TF_VAR_github_oidc_subject_repository=$SUBJECT"; do
  case "${pair#*=}" in
    *REPLACE_WITH_* | *OWNER@OWNER_ID*) echo "${pair%%=*} still holds the example placeholder; set the real value in the .envrc" >&2; exit 1 ;;
  esac
done
CALLER=$(clean AWS_PROFILE="$PROFILE" AWS_REGION="$REGION" aws sts get-caller-identity --query Account --output text) ||
  { echo "AWS profile $PROFILE has no valid credentials; run aws sso login --profile $PROFILE" >&2; exit 1; }
[ "$CALLER" = "$ACCOUNT" ] ||
  { echo "AWS profile $PROFILE is not the account in MCC_${U}_ACCOUNT_ID; nothing ran" >&2; exit 1; }
tf() {
  clean AWS_PROFILE="$PROFILE" AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION" \
    TF_IN_AUTOMATION=1 TF_INPUT=0 TF_VAR_aws_region="$REGION" TF_VAR_email_domain="$DOMAIN" \
    TF_VAR_github_oidc_subject_repository="$SUBJECT" \
    tofu -chdir="$R" "$@"
}
tf init -no-color -input=false -reconfigure -lockfile=readonly \
  -backend-config="$SRC/backend.hcl" >"$WT/$E.init.log" 2>&1 ||
  { tail -n 40 "$WT/$E.init.log" >&2; exit 1; }
# the step's commands follow here
EOF
```

The worktree holds no `*.auto.tfvars`, so like Terrateam the plan sees only these inputs and the committed code. If direnv cannot load the `.envrc`, a value is missing, or the account check fails, the profile points at the wrong account, its credentials expired, or the local files were never set up; stop and let the person fix it.

## 2. Plan a root (gated)

Before planning, run `gh pr view <N> -R samlevin/mcc-stats-suite --json headRefOid -q .headRefOid`. If it differs from the recorded head, the PR moved: remove the worktree (`git worktree remove --force <worktree path>`), forget every plan and approval, and start again at preflight. Prod is planned only after dev has applied at this head, when dev is affected. Repeat the freshness check from preflight step 3 with a fresh `git fetch origin main`; another PR may have merged since.

Append to the root setup block:

```console
rm -f "$R/$E.tfplan"
tf plan -no-color -input=false -lock-timeout=60s -out="$E.tfplan"
tf show -json "$E.tfplan" | jq -r '.resource_changes[]? | select(.change.actions != ["no-op"]) | "\(.change.actions | join("/")) \(.address)"'
shasum -a 256 "$R/$E.tfplan"
```

The plan file stays in the root's directory inside the worktree, where `.gitignore` already covers `*.tfplan`. Record the digest. Present the root, profile, head SHA, counts, every action, and the digest. Read `tf show -no-color "$E.tfplan"` when an action needs detail. Call out every destroy, replacement, IAM or policy change, import, and any change the PR diff does not explain, which may be drift. Stop entirely if the plan proposes recreating the foundation or creating named resources that already exist; that means the wrong backend or account. For a prod plan, compare it with the applied dev plan, allowing for environment names, account IDs, and values. Gate: apply this root.

A "no changes" plan still gets its gate. Applying it is harmless, and the merge requires every affected root to have applied.

## 3. Apply a root (gated)

Check the head again as in step 2; if it moved, start over at preflight. Prod applies only after dev has applied at this head, when dev is affected. Then append to the root setup block, with the digest you recorded:

```console
echo "<digest>  $R/$E.tfplan" | shasum -a 256 -c -
tf apply -no-color -input=false -lock-timeout=60s "$E.tfplan"
rm -f "$R/$E.tfplan"
```

`apply` with a plan file runs exactly that plan, and the digest check refuses a file that changed since the person reviewed it. If the apply fails, stop and report: the fix is a new commit and a new run from preflight. Next gate: plan prod, when prod is affected and not yet applied, otherwise merge.

## 4. Merge (gated)

Every affected root must have applied at the recorded head. Merge the way Terrateam's automerge does, with the PR title, only if the head has not moved:

```console
gh pr merge <N> -R samlevin/mcc-stats-suite --squash --subject "<title> (#<N>)" --match-head-commit <head>
```

If a required check blocks the merge, tell the person to merge once checks pass, and stop. Otherwise remove the worktree with `git worktree remove --force <worktree path>` and report the merge. Next gate: release the Terrateam lock, when step 5 finds one.

## 5. Release the Terrateam lock (gated)

Terrateam never applied this pull request, and under `lock_policy: strict` in `.terrateam/config.yml` a merge takes the locks anyway, so Terrateam may now hold the applied foundation roots locked to this pull request. Read what Terrateam reports after the merge, through `gh` as the invoking person:

```console
gh pr view <N> -R samlevin/mcc-stats-suite --comments
gh pr checks <N> -R samlevin/mcc-stats-suite
```

If no Terrateam comment or check reports `infrastructure/dev/foundation` or `infrastructure/prod/foundation` as locked by this pull request, report that and finish. If one does, report which roots are locked and ask for approval to release them. With approval, post the unlock comment on the merged pull request:

```console
gh pr comment <N> -R samlevin/mcc-stats-suite --body "terrateam unlock"
```

`access_control.unlock` in `.terrateam/config.yml` allows only `role:admin`, so the comment works only when the invoking person is a repository administrator. Read Terrateam's reply. If it reports the unlock as denied or the roots as still locked, say that the person lacks the admin role or the unlock failed, and stop. This releases only Terrateam's pull-request lock. The OpenTofu state lock is automatic and needs no step; never force-unlock OpenTofu state.
