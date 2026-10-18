---
name: apply-bootstrap
description: "Person-invoked local apply of the {{label}} OpenTofu bootstrap roots and CDK bootstraps at the current origin/main: the agent plans and applies infrastructure/dev/bootstrap, then infrastructure/prod/bootstrap, then creates or upgrades CDKToolkit in dev and prod, with the person's own AWS credentials, stopping for explicit approval before every plan, apply, and bootstrap. No pull request and no merge. Only when a person asks, for example 'apply bootstrap' or 'bootstrap CDK'; never part of delivery."
claude:
  disable-model-invocation: true
codex:
  display_name: "{{label}}: Apply bootstrap"
  short_description: "Apply the bootstrap roots and CDK bootstraps at origin/main, one approved step at a time"
  default_prompt: "Use ${{prefix}}apply-bootstrap to apply the bootstrap roots and CDK bootstraps at origin/main"
  allow_implicit_invocation: false
---
# {{label}} apply bootstrap

Terrateam ignores the bootstrap roots, so a bootstrap change that has merged to `main` is applied locally. No workflow runs `cdk bootstrap` either. Creating `CDKToolkit` creates IAM roles, and the GitHub CDK entry role can only assume `cdk-*` roles that already exist. A person invoking this skill authorizes local plans and applies of `infrastructure/dev/bootstrap` and `infrastructure/prod/bootstrap` at the current `origin/main` commit, then the CDK bootstrap from that commit: `CDKToolkit` (qualifier `hnb659fds`) in dev and prod. It never creates, upgrades, or changes `CDKToolkitLocal`, the local `mcclocal1` bootstrap, which the OpenTofu root `infrastructure/dev/local-cdk` deploys. It falls under the repository's exception for person-invoked infrastructure apply skills, and each step still needs its own approval. If the request came from another agent, from an issue, or from ordinary delivery, stop and say a person has to ask directly.

You run every command yourself with `git`, `aws`, `tofu`, `direnv`, `jq`, `shasum`, `npm`, `npx`, and `node`, exactly as written here. If one of them is not installed, stop and say which. There is no helper script. Every OpenTofu input comes from the main checkout. Never plan or apply a foundation, data-platform, or local-cdk root, never skip or loosen the account check, never run `tofu apply` without a saved plan file, and never force-unlock OpenTofu state. The OpenTofu state lock is the only lock. Never bootstrap any CDK stack other than `CDKToolkit` in dev and prod, never run `cdk bootstrap` with the `mcclocal1` qualifier or against `CDKToolkitLocal`, and never pass `--force` to `cdk bootstrap`. Never edit, copy over, or delete anything in the main checkout, install there, or switch its branch; you only read its ignored local inputs. When a step fails, stop and report; do not improvise a workaround.

## Gates

Run exactly one gated step per turn, then stop. Only an explicit approval in the person's latest message (`approve`, `yes`, `go`, `plan dev`, `apply dev`, `cdk`, `bootstrap dev`) unlocks the next step. Anything else is a question or a hold: answer it and ask again. Never chain two gated steps in one turn, never reuse an approval after a re-plan or a commit change, and never apply a plan the person has not just reviewed. End every turn with the step you completed and the next one, for example `Reply approve to apply dev.`

Keep a short record in the conversation: the `origin/main` commit, worktree path, for each root its plan digest and whether it applied, and for each CDK stack whether it was bootstrapped or reported unchanged. Never copy account IDs, profile values, domains, bucket names, or plan output into commits, issues, or PR comments; the repository is public.

## 1. Preflight (no gate, changes nothing)

1. Fetch `main` and record the commit. There is no pull request, CI check, or merge: the skill applies what has already merged.

   ```console
   git fetch origin main
   git rev-parse origin/main
   ```

2. Check that each root has its ignored local inputs in the main checkout, as `docs/self-hosting/10-bootstrap-accounts.md` sets them up: `.envrc`, created from the committed `.envrc.example` in that root and allowed with `direnv allow`. It is self-contained and derives the account, Region, and state bucket from its AWS profile. `bootstrap.auto.tfvars`, created from `bootstrap.auto.tfvars.example`, is optional. If the `.envrc` is missing, stop and tell the person to create it from that root's `.envrc.example`. Do not create it.

   ```console
   MAIN="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
   ls -a "$MAIN/infrastructure/dev/bootstrap" "$MAIN/infrastructure/prod/bootstrap"
   ```

3. Check out the commit in a detached worktree of the main checkout, so local edits never reach a plan:

<!-- claude-only -->
   ```console
   MAIN="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
   git -C "$MAIN" worktree add --detach "$MAIN/.claude/worktrees/bootstrap-<short commit>" <commit>
   ```
<!-- /claude-only -->
<!-- codex-only -->
   ```console
   MAIN="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
   git -C "$MAIN" worktree add --detach "$MAIN/.codex/worktrees/bootstrap-<short commit>" <commit>
   ```
<!-- /codex-only -->

Report the commit, its subject, the latest commits that touched bootstrap (`git log --oneline -5 <commit> -- infrastructure/modules/bootstrap infrastructure/dev/bootstrap infrastructure/prod/bootstrap`), and the worktree path. Gate: plan dev. When `origin/main` has nothing to plan in the bootstrap roots, or the person only wants the CDK bootstraps, they may reply `cdk` instead: skip steps 2 and 3 and go to [CDK bootstrap](#4-cdk-bootstrap).

## Root setup

Shell state does not carry between commands, so every plan and apply runs as one `bash` heredoc that starts with this block. Fill in `<env>` (`dev` or `prod`) and the worktree path. The block reads inputs only from the root's local `.envrc` through `direnv` and its `*.auto.tfvars`, both in the main checkout. From the `.envrc` it reads `AWS_PROFILE`, `TF_VAR_aws_region`, `TF_CLI_ARGS_init` (the state bucket and Region), `TF_VAR_github_organization`, `TF_VAR_github_oidc_subject_repository`, and, when set, `TF_VAR_github_repository`. The CI-role flags, any `github_oidc_provider_arn`, and any `state_bucket_name` come from `bootstrap.auto.tfvars`. The block removes every ambient `AWS_*`, `TF_*`, and `TOFU_*` value from each `direnv`, `aws`, and `tofu` command, then passes exactly the loaded values. It checks that the state bucket follows the bootstrap naming rule `mcc-stats-suite-tofu-state-<account>-<region>` for the loaded Region, checks that the profile's account equals the account in that bucket name, checks that the bucket's `Environment` tag equals `<env>`, and initializes the root against the committed lock file and that bucket. It prints none of the values.

```console
bash <<'EOF'
set -euo pipefail
E=<env>; WT=<worktree path>
case "$E" in dev | prod) ;; *) echo "unknown environment $E" >&2; exit 1 ;; esac
MAIN=$(dirname "$(git -C "$WT" rev-parse --path-format=absolute --git-common-dir)")
SRC="$MAIN/infrastructure/$E/bootstrap"
R="$WT/infrastructure/$E/bootstrap"
[ -f "$SRC/.envrc" ] || { echo "$SRC/.envrc is missing; create it from .envrc.example in that directory" >&2; exit 1; }
clean() {
  env $(env | sed -nE 's/^((AWS|TF|TOFU)_[A-Za-z0-9_]*)=.*/-u \1/p' |
    grep -vE '^-u (AWS_CONFIG_FILE|AWS_SHARED_CREDENTIALS_FILE)$') "$@"
}
LOCAL=$(clean DIRENV_LOG_FORMAT= direnv exec "$SRC" bash -c \
  'for p; do n=${p#*=}; printf "%s=%q\n" "${p%%=*}" "${!n-}"; done' _ \
  PROFILE=AWS_PROFILE REGION=TF_VAR_aws_region INIT=TF_CLI_ARGS_init \
  ORG=TF_VAR_github_organization REPO_NAME=TF_VAR_github_repository \
  SUBJECT=TF_VAR_github_oidc_subject_repository) ||
  { echo "direnv could not load $SRC/.envrc; run direnv allow there" >&2; exit 1; }
eval "$LOCAL"
missing() { echo "$1 is not set by $SRC/.envrc; see $SRC/.envrc.example" >&2; exit 1; }
[ -n "$PROFILE" ] || missing AWS_PROFILE
[ -n "$ORG" ] || missing TF_VAR_github_organization
for pair in "TF_VAR_github_organization=$ORG" "TF_VAR_github_repository=$REPO_NAME" \
  "TF_VAR_github_oidc_subject_repository=$SUBJECT"; do
  case "${pair#*=}" in
    *REPLACE_WITH_* | *OWNER@OWNER_ID* | *YOUR_GITHUB_ORG_OR_USERNAME*) echo "${pair%%=*} still holds the example placeholder; set the real value in the .envrc" >&2; exit 1 ;;
  esac
done
[[ $INIT =~ ^-backend-config=bucket=(mcc-stats-suite-tofu-state-([0-9]{12})-([a-z0-9-]+))\ -backend-config=region=([a-z0-9-]+)$ ]] &&
  [ "${BASH_REMATCH[3]}" = "$REGION" ] && [ "${BASH_REMATCH[4]}" = "$REGION" ] ||
  { echo "TF_CLI_ARGS_init or TF_VAR_aws_region in $SRC/.envrc does not follow its .envrc.example; check that the profile sets sso_account_id and region" >&2; exit 1; }
BUCKET=${BASH_REMATCH[1]}; ACCOUNT=${BASH_REMATCH[2]}
CALLER=$(clean AWS_PROFILE="$PROFILE" AWS_REGION="$REGION" aws sts get-caller-identity --query Account --output text) ||
  { echo "AWS profile $PROFILE has no valid credentials; run aws sso login --profile $PROFILE" >&2; exit 1; }
[ "$CALLER" = "$ACCOUNT" ] ||
  { echo "AWS profile $PROFILE is not the account in the state bucket name its .envrc derives; nothing ran" >&2; exit 1; }
TAG=$(clean AWS_PROFILE="$PROFILE" AWS_REGION="$REGION" aws s3api get-bucket-tagging --bucket "$BUCKET" \
  --query "TagSet[?Key=='Environment'].Value | [0]" --output text) ||
  { echo "Cannot read the Environment tag of the state bucket with AWS profile $PROFILE; nothing ran" >&2; exit 1; }
[ "$TAG" = "$E" ] ||
  { echo "AWS profile $PROFILE reaches the $TAG state bucket, not the $E one; nothing ran" >&2; exit 1; }
cp "$R/backend.tf.example" "$R/backend.tf"
for f in "$SRC"/*.auto.tfvars; do [ ! -e "$f" ] || cp "$f" "$R/"; done
tf() {
  clean AWS_PROFILE="$PROFILE" AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION" \
    TF_IN_AUTOMATION=1 TF_INPUT=0 TF_VAR_aws_region="$REGION" TF_VAR_github_organization="$ORG" \
    ${REPO_NAME:+TF_VAR_github_repository="$REPO_NAME"} \
    ${SUBJECT:+TF_VAR_github_oidc_subject_repository="$SUBJECT"} \
    tofu -chdir="$R" "$@"
}
tf init -no-color -input=false -reconfigure -lockfile=readonly \
  -backend-config="bucket=$BUCKET" -backend-config="region=$REGION" >"$WT/$E.init.log" 2>&1 ||
  { tail -n 40 "$WT/$E.init.log" >&2; exit 1; }
# the step's commands follow here
EOF
```

`backend.tf` is copied from the committed `backend.tf.example`, which holds the state key, so the root always uses the S3 backend in the bucket the `.envrc` derives, never temporary local state. The copies of `backend.tf` and `*.auto.tfvars` stay in the worktree, where `.gitignore` already covers them. If direnv cannot load the `.envrc`, a value is missing, or the account check fails, the profile points at the wrong account, lacks `sso_account_id` or `region`, its credentials expired, or the `.envrc` was never set up; stop and let the person fix it. The `.envrc` derives both the bucket and the expected account from the same profile, so the account check alone cannot tell dev from prod. The block therefore also requires the state bucket's `Environment` tag, which bootstrap sets, to equal the root's environment; a missing or different tag, or a bucket the profile cannot read, stops the run before any OpenTofu command.

## 2. Plan a root (gated)

Before planning, run `git fetch origin main` and `git rev-parse origin/main`. If it differs from the recorded commit, `main` moved: remove the worktree (`git worktree remove --force <worktree path>`), forget every plan and approval, and start again at preflight. Prod is planned only after dev has applied at this commit.

Append to the root setup block:

```console
rm -f "$R/$E.tfplan"
tf plan -no-color -input=false -lock-timeout=60s -out="$E.tfplan"
tf show -json "$E.tfplan" | jq -r '.resource_changes[]? | select(.change.actions != ["no-op"]) | "\(.change.actions | join("/")) \(.address)"'
shasum -a 256 "$R/$E.tfplan"
```

The plan file stays in the root's directory inside the worktree, where `.gitignore` already covers `*.tfplan`. Record the digest. Present the root, profile, commit, counts, every action, and the digest. Read `tf show -no-color "$E.tfplan"` when an action needs detail. Call out every destroy, replacement, IAM role, trust, or policy change, import, and any change the bootstrap commits on `main` do not explain, which may be drift. Stop entirely if the plan proposes recreating the bootstrap (the state bucket, the OIDC provider, or the CI roles) or creating named resources that already exist; that means the wrong backend or account. For a prod plan, compare it with the applied dev plan, allowing for environment names, account IDs, and values. Gate: apply this root.

A "no changes" plan still gets its gate. Applying it is harmless, and prod waits until dev has applied at this commit.

## 3. Apply a root (gated)

Check the commit again as in step 2; if `main` moved, start over at preflight. Prod applies only after dev has applied at this commit. Then append to the root setup block, with the digest you recorded:

```console
echo "<digest>  $R/$E.tfplan" | shasum -a 256 -c -
tf apply -no-color -input=false -lock-timeout=60s "$E.tfplan"
rm -f "$R/$E.tfplan"
```

`apply` with a plan file runs exactly that plan, and the digest check refuses a file that changed since the person reviewed it. If the apply fails, stop and report: the fix is a new commit on `main` and a new run from preflight. Next gate: plan prod after dev, otherwise go to [CDK bootstrap](#4-cdk-bootstrap).

## 4. CDK bootstrap

The CDK steps run in this order, each at most once per commit: `CDKToolkit` in dev, then `CDKToolkit` in prod. The prod step runs only after the dev step bootstrapped or was reported unchanged at the recorded commit.

Before the first CDK step, install the pinned packages in the worktree. This changes nothing outside the worktree and needs no gate:

```console
npm --prefix <worktree path> ci --ignore-scripts --no-audit --no-fund
```

`npx --no-install cdk` then runs the `aws-cdk` version that `package-lock.json` pins, and never downloads another one.

### CDK setup

Every CDK status run and every bootstrap run is a `bash` heredoc that starts with this block. Fill in `<env>` (`dev` or `prod`) and the worktree path. Like the root setup block, it reads the profile and Region only from that environment's bootstrap root `.envrc` in the main checkout, takes the account from the state bucket name that `.envrc` derives, removes every ambient `AWS_*`, `TF_*`, and `TOFU_*` value, and stops unless `aws sts get-caller-identity` reports that account and the state bucket's `Environment` tag equals `<env>`. It never reads the Region from `aws configure get region`. It prints none of the values.

```console
bash <<'EOF'
set -euo pipefail
E=<env>; S=CDKToolkit; WT=<worktree path>
case "$E" in dev | prod) ;; *) echo "unknown environment $E" >&2; exit 1 ;; esac
MAIN=$(dirname "$(git -C "$WT" rev-parse --path-format=absolute --git-common-dir)")
SRC="$MAIN/infrastructure/$E/bootstrap"
[ -f "$SRC/.envrc" ] || { echo "$SRC/.envrc is missing; create it from .envrc.example in that directory" >&2; exit 1; }
clean() {
  env $(env | sed -nE 's/^((AWS|TF|TOFU)_[A-Za-z0-9_]*)=.*/-u \1/p' |
    grep -vE '^-u (AWS_CONFIG_FILE|AWS_SHARED_CREDENTIALS_FILE)$') "$@"
}
LOCAL=$(clean DIRENV_LOG_FORMAT= direnv exec "$SRC" bash -c \
  'for p; do n=${p#*=}; printf "%s=%q\n" "${p%%=*}" "${!n-}"; done' _ \
  PROFILE=AWS_PROFILE REGION=TF_VAR_aws_region INIT=TF_CLI_ARGS_init) ||
  { echo "direnv could not load $SRC/.envrc; run direnv allow there" >&2; exit 1; }
eval "$LOCAL"
[ -n "$PROFILE" ] || { echo "AWS_PROFILE is not set by $SRC/.envrc; see $SRC/.envrc.example" >&2; exit 1; }
[[ $INIT =~ ^-backend-config=bucket=(mcc-stats-suite-tofu-state-([0-9]{12})-([a-z0-9-]+))\ -backend-config=region=([a-z0-9-]+)$ ]] &&
  [ "${BASH_REMATCH[3]}" = "$REGION" ] && [ "${BASH_REMATCH[4]}" = "$REGION" ] ||
  { echo "TF_CLI_ARGS_init or TF_VAR_aws_region in $SRC/.envrc does not follow its .envrc.example; check that the profile sets sso_account_id and region" >&2; exit 1; }
BUCKET=${BASH_REMATCH[1]}; ACCOUNT=${BASH_REMATCH[2]}
aws_env() {
  clean AWS_PROFILE="$PROFILE" AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION" \
    CDK_DISABLE_CLI_TELEMETRY=1 "$@"
}
CALLER=$(aws_env aws sts get-caller-identity --query Account --output text) ||
  { echo "AWS profile $PROFILE has no valid credentials; run aws sso login --profile $PROFILE" >&2; exit 1; }
[ "$CALLER" = "$ACCOUNT" ] ||
  { echo "AWS profile $PROFILE is not the account in the state bucket name its .envrc derives; nothing ran" >&2; exit 1; }
TAG=$(aws_env aws s3api get-bucket-tagging --bucket "$BUCKET" \
  --query "TagSet[?Key=='Environment'].Value | [0]" --output text) ||
  { echo "Cannot read the Environment tag of the state bucket with AWS profile $PROFILE; nothing ran" >&2; exit 1; }
[ "$TAG" = "$E" ] ||
  { echo "AWS profile $PROFILE reaches the $TAG state bucket, not the $E one; nothing ran" >&2; exit 1; }
cd "$WT"
T="$WT/$E-$S.template.yaml"
# the step's commands follow here
EOF
```

If the block stops, handle it as in [Root setup](#root-setup): the person fixes the profile, credentials, or `.envrc`.

### CDK status (no gate, changes nothing)

Before each CDK step, append these commands to the CDK setup block. They generate the template from the checked-out commit and read the deployed stack:

```console
aws_env npx --no-install cdk bootstrap --show-template --no-notices >"$T"
aws_env aws cloudformation describe-stacks --stack-name "$S" --output json >"$WT/$E-$S.stack.json" 2>"$WT/$E-$S.err" ||
  { grep -q 'does not exist' "$WT/$E-$S.err" || { cat "$WT/$E-$S.err" >&2; exit 1; }; echo '{}' >"$WT/$E-$S.stack.json"; }
node - "$S" "$WT/$E-$S" <<'JS'
const { readFileSync } = require('node:fs');
const { parse } = require('yaml');
const [stack, base] = process.argv.slice(2);
const read = (file) => readFileSync(file, 'utf8');
const template = parse(read(`${base}.template.yaml`));
const pinned = template.Outputs.BootstrapVersion.Value;
const [deployed] = JSON.parse(read(`${base}.stack.json`)).Stacks ?? [];
console.log(`${stack}: pinned aws-cdk installs bootstrap version ${pinned}`);
if (!deployed) {
  console.log(`${stack} does not exist\nchange: create`);
  process.exit(0);
}
const version = deployed.Outputs?.find((o) => o.OutputKey === 'BootstrapVersion')?.OutputValue;
const checks = {
  [`status ${deployed.StackStatus}`]: /^(CREATE|UPDATE)_COMPLETE$/.test(deployed.StackStatus),
  [`deployed bootstrap version ${version ?? 'none'}`]: version === pinned,
};
for (const [check, ok] of Object.entries(checks)) console.log(`${ok ? 'ok' : 'not ok'}: ${check}`);
console.log(`change: ${Object.values(checks).every(Boolean) ? 'none' : 'update'}`);
JS
```

Present the environment, stack, commit, and every line it printed. When it prints `change: none`, report that the stack is unchanged, skip its step without a gate, and run the status for the next stack in the same turn. Otherwise, gate: bootstrap this stack, for example `Reply approve to bootstrap CDKToolkit in dev.` A deployed version newer than the pinned one means someone bootstrapped with a newer CDK; say so, because `cdk bootstrap` will not downgrade it.

### Bootstrap a CDK stack (gated)

Check the commit again as in step 2; if `main` moved, start over at preflight. Run the CDK setup block with the status commands again. If it prints anything different from what the person approved, stop: present the new status and ask again. Otherwise run the CDK setup block a second time with the commands below appended, keeping the execution policy that `docs/self-hosting/20-bootstrap-cdk.md` documents:

```console
aws_env npx --no-install cdk bootstrap "aws://$ACCOUNT/$REGION" --no-notices \
  --qualifier hnb659fds --toolkit-stack-name CDKToolkit \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
```

Report what `cdk bootstrap` printed. After dev, run the status for `CDKToolkit` in prod and gate it as above.

## 5. Finish (no gate)

Once the prod `CDKToolkit` step has bootstrapped or been reported unchanged at the recorded commit, remove the worktree with `git worktree remove --force <worktree path>` and report the commit, the roots that applied, and each CDK stack as bootstrapped or unchanged. There is nothing to merge.
