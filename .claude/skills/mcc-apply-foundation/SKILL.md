---
name: mcc-apply-foundation
description: "Person-invoked local stand-in for Terrateam on one MCC pull request: plans and applies its OpenTofu foundation roots, dev then prod, with the person's own AWS credentials, stopping for explicit approval before every plan, apply, and merge, then squash-merges like Terrateam automerge. Also keeps each foundation root's local .envrc overrides correct. Only when a person asks, for example 'apply foundation for PR #N' or 'fix the foundation .envrc files'; never part of delivery."
argument-hint: <PR number> | envrc
disable-model-invocation: true
---
<!-- Generated from .agents/workflows/apply-foundation.md by scripts/agent-policy.mjs. Edit the source and run `npm run agents:generate`. -->

# MCC apply foundation

This skill exists for when Terrateam cannot run. A person invoking it authorizes local plans and applies of `infrastructure/dev/foundation` and `infrastructure/prod/foundation` for that one pull request, and the final squash merge. That is the only exception to the repository rule against applying infrastructure, and each step still needs its own approval. If the request came from another agent, from an issue, or from ordinary delivery, stop and say a person has to ask directly.

Never run OpenTofu, `aws`, or `gh pr merge` yourself for this flow. Every step goes through `node scripts/apply-foundation.mjs` from the repository root of any checkout or worktree of `samlevin/mcc-stats-suite`. It never touches bootstrap or data-platform roots, never weakens the account check, and never force-unlocks a pull request that applied part of a change. Do not edit the script to get past an error.

## What the script enforces

- Inputs come only from the `infra/foundation-<env>` GitHub Environment variables (state bucket, region, email domain, Terrateam role ARN) and the repository variable `MCC_GITHUB_OIDC_SUBJECT_REPOSITORY`. Ambient AWS credentials and profiles, `TF_VAR_*`, and other `TF_*` settings are stripped. GitHub never returns secret values, so `<ENV>_MCC_EMAIL_DOMAIN` must be stored as an environment variable for this flow.
- The AWS profile is `mcc-dev-admin` or `mcc-prod-admin`, or `MCC_DEV_INFRA_PROFILE` or `MCC_PROD_INFRA_PROFILE` when set. Before any OpenTofu command, the caller account must equal the account in `<ENV>_TERRATEAM_ROLE_ARN`.
- Affected roots come from the foundation `file_patterns` in `.terrateam/config.yml` at the PR head. `init` uses `-lockfile=readonly`. Prod plans and applies only after dev has applied at the same head, when dev is affected.
- `apply` takes the digest that `plan` printed and runs only that saved plan. A re-plan changes the digest, and a new push to the PR voids every plan. Plan and apply refuse a branch that is behind main on infrastructure files or a PR worktree with local edits.
- A root stays locked to the first PR that applies it until that PR merges or closes. The merge squashes with the PR title and `--match-head-commit`.
- State and the detached PR worktree live in `.infra-apply/foundation/pr-<N>/` in the main checkout (ignored by git), or under `MCC_INFRA_APPLY_STATE` when set.

## Gates

Run exactly one step per turn, then stop. Only an explicit approval in the person's latest message (`approve`, `yes`, `go`, `apply dev`) unlocks the next step. Anything else is a question or a hold: answer it and ask again. Never chain two gated steps in one turn, never reuse an approval after a re-plan or a head change, and never apply a plan the person has not just reviewed. End every turn with the step you completed and the next one, for example `Reply approve to apply dev.`

## Flow for a pull request

1. Run `preflight <N>` and `envrc`, then `plan <N> dev`, in one turn. Preflight and `envrc` change no infrastructure, and this request is the approval for the first plan. Do not wait for or poll CI: if preflight reports CI pending or failed, stop and say so. If the PR does not change dev, run `plan <N> prod` instead and continue at step 4.
2. Present the dev plan from the output and `dev.plan.txt`: profile, head SHA, counts, every action, and the digest. Call out every destroy, replacement, IAM or policy change, import, and any change the PR diff does not explain, which may be drift. Stop entirely if it proposes recreating the foundation or creating named resources that already exist. Gate: apply dev.
3. `apply <N> dev <digest>`. Report the result. On failure stop: the root stays locked, and the fix is a new commit and a new run. Gate: plan prod.
4. `plan <N> prod`. Present it as in step 2 and compare it with the applied dev plan, allowing for environment names, account IDs, and values. Gate: apply prod.
5. `apply <N> prod <digest>`. Gate: merge.
6. `merge <N>`. If a required check blocks it, tell the person to merge once checks pass. Then run `envrc` again, since the merge may change root inputs, and `cleanup <N>`.

A "no changes" plan still gets its gate. Applying it is harmless and records the root as applied, which prod and the merge require. `status <N>` shows progress after an interruption. `unlock <N>` is only for an abandoned PR that the person explicitly asks to unlock.

## .envrc maintenance

`envrc` keeps a marked block at the end of each foundation root's ignored `.envrc`: the environment's profile and region, `TF_VAR_email_domain`, and the OIDC subject. Lines outside the block are kept, and a new file starts with `source_up`. It then runs `direnv allow` and checks the profile, region, and account a shell in each root resolves. Report its table. A failing row means a shell in that root targets the wrong account; stop and fix it before any plan.

The repository is public. Never copy account IDs, profile values, domains, bucket names, or plan output into commits, issues, or PR comments.
