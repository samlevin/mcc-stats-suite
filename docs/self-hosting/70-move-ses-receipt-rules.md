# Move the SES receipt rules into the foundation

New installations skip this guide. Use it only if your `match-to-csv-dev` and `match-to-csv-prod` stacks were deployed before the foundation owned the SES receipt rule set.

Those stacks created the rule set `mcc-match-to-csv-<environment>`, an activation custom resource, and the shared rule `match-to-csv-<environment>` for `submit@<your domain>`. The foundation now owns all three, and the stacks no longer declare them. A Region has one active rule set, so a careless move can stop inbound email for the whole account:

- Removing a resource from a CloudFormation template deletes it, unless the previously deployed template already set `DeletionPolicy: Retain`.
- Removing the activation custom resource runs its delete handler. The old handler called `setActiveReceiptRuleSet` with no name, which deactivates the rule set.

The move therefore takes three steps, in this order, for dev and then prod. Do not skip one or reorder them. At no step is the account without an active rule set or the shared rule. The same rule set and rule stay in place throughout, and only the owner changes.

Run the steps in dev first and confirm each expected state before starting the same step in prod.

## Before you start

1. Confirm the dev and prod `match-to-csv` stacks exist and inbound mail currently works.
2. Set `DEV_MCC_EMAIL_DOMAIN` in the `infra/foundation-dev` GitHub Environment and `PROD_MCC_EMAIL_DOMAIN` in `infra/foundation-prod`. Each must equal the domain the matching stack uses today. Keep the existing `MCC_EMAIL_DOMAIN` variable in the `dev` and `prod` environments until the step 2 pull request has merged, because the step 1 deployment workflow still reads it. After that, the deployment workflow and ephemeral stacks read the domain from SSM, and you can delete the variable.
3. Record the current state for each environment and keep it for comparison:

   ```console
   aws ses describe-active-receipt-rule-set --profile <profile>
   ```

   Expected: the name is `mcc-match-to-csv-<environment>` and the rule `match-to-csv-<environment>` is present and enabled.

## Step 1: retain the resources in CloudFormation

Release the pull request that adds `DeletionPolicy: Retain` to the rule set and shared rule and removes the activation's delete handler. Merging it deploys dev. Release it to prod through the normal flow in [Deploy, release, and roll back applications](50-deploy-and-release-applications.md).

Verify each stack:

```console
aws cloudformation get-template --stack-name match-to-csv-<environment> --profile <profile> \
  --query 'TemplateBody.Resources.[ReceiptRuleSet.DeletionPolicy, StoreRawEmail.DeletionPolicy]'
aws ses describe-active-receipt-rule-set --profile <profile>
```

Expected: both policies are `Retain`, and the active rule set matches the state you recorded. Do not continue until prod also shows this. Without it, step 3 deletes the live resources. The deployment workflow enforces this. Before each `match-to-csv` deploy, its **Verify receipt rule handover** step compares the deployed template with the one it is about to deploy. It stops if the deploy would remove a rule set or rule that is not retained, or remove an activation that still has its delete handler. A deploy that keeps those resources, such as this step's release, passes.

Between this step and step 3, do not destroy a stable `match-to-csv` stack. The retained rule set and rule stay in SES, so recreating the stack fails with `AlreadyExists` and rolls back. Do not delete the active rule set to get past this, because that stops inbound email. Finish step 2 instead, so the foundation owns the resources and the stack no longer declares them.

## Step 2: import them into the foundation

Terrateam has no import command, so import with declarative `import` blocks, as in [Recover and troubleshoot](60-recover-and-troubleshoot.md#a-plan-wants-to-create-resources-that-already-exist). Do this on the foundation pull request, which adds `email_domain` and the `aws_ses_*` resources and removes the resources from the stack. Planning without the import proposes to create resources that already exist, and an apply fails.

Terrateam plans and applies only pull requests that target `main`. If the foundation pull request was prepared on top of the step 1 branch, it gets no plan until step 1 has merged and the pull request is retargeted to `main`. Add the import files before you retarget, because Terrateam plans as soon as the pull request targets `main`. Do not merge the pull request yourself; Terrateam merges it after both applies.

1. Add `infrastructure/dev/foundation/ses-imports.tf` and `infrastructure/prod/foundation/ses-imports.tf` in one commit, so dev and prod apply from the same commit. They hold no domain and no account ID. Dev holds the blocks below. Prod holds the same blocks with `mcc-match-to-csv-prod` and `mcc-match-to-csv-prod:match-to-csv-prod`.

   ```hcl
   import {
     to = module.foundation.aws_ses_receipt_rule_set.inbound
     id = "mcc-match-to-csv-dev"
   }

   import {
     to = module.foundation.aws_ses_receipt_rule.store_raw_email
     id = "mcc-match-to-csv-dev:match-to-csv-dev"
   }

   import {
     to = module.foundation.aws_ses_active_receipt_rule_set.inbound
     id = "mcc-match-to-csv-dev"
   }
   ```

2. Retarget the pull request to `main` if it still targets the step 1 branch. If the automatic plan is missing or stale, comment `terrateam plan dev and foundation`. Expected: three resources to import, two new SSM parameters `/mcc/dev/match-to-csv/receipt-rule-set-name` and `/mcc/dev/match-to-csv/email-domain`, and nothing else. The domain is a sensitive input, so the plan shows the rule's recipients and the domain parameter as sensitive values. If the plan proposes to create, replace, or destroy the rule set, the rule, or the activation, or to change the rule's recipients, stop and do not apply. A changed recipient means `DEV_MCC_EMAIL_DOMAIN` differs from the domain the stack uses.
3. Comment `terrateam apply dev and foundation`. Expected: three imported, two added, none changed or destroyed. Run `aws ses describe-active-receipt-rule-set` again. The result must match the recorded state.
4. Comment `terrateam plan prod and foundation`, confirm the same shape as dev, then `terrateam apply prod and foundation`, and run the same `describe` check.

The import files are in state after the applies and then do nothing, like `recovery-imports.tf`. Do not copy them into a new installation, where the resources do not exist yet and the import would fail. After the merge, remove them in a follow-up foundation pull request. Expected: its dev and prod plans are empty. Still comment `terrateam apply dev and foundation` and then `terrateam apply prod and foundation`, which release the strict locks and let Terrateam merge it.

Terrateam merges the pull request after both applies. That starts step 3 for dev.

## Step 3: drop the resources from the stacks

Merging the pull request deploys the stack that no longer declares the rule set, the activation, or the shared rule. Release it to prod through the normal flow after the prod foundation apply in step 2.

Verify each stack:

```console
aws cloudformation describe-stack-events --stack-name match-to-csv-<environment> --profile <profile> \
  --max-items 20
aws ses describe-active-receipt-rule-set --profile <profile>
```

Expected: the events show the rule set and the rule as `DELETE_SKIPPED`, and the activation resource as deleted with no error. The active rule set is unchanged, and the foundation plan is still empty. Send a test message to `submit@<your domain>` and confirm it arrives under `incoming/<environment>/` in the raw-email bucket.

## After the move

- Existing ephemeral stacks keep working once the dev foundation apply in step 2 is done. Their rule already targets `mcc-match-to-csv-dev`. The next deployment reads that name and the domain from SSM instead of `MCC_EMAIL_DOMAIN`, and the rule is unchanged when the domains match. Before that apply, an ephemeral deploy from a revision after this change stops before it changes anything, because CDK cannot resolve the two SSM parameters.
- Roll `match-to-csv` back only to the release that contains step 3 or a later one. Earlier tags declare the rule set and rule again, and CloudFormation fails with `AlreadyExists`. The deployment workflow still supplies the domain those revisions expect, so the failure happens in CloudFormation and causes no email outage.
- Destroying a `match-to-csv` stack no longer touches the rule set or the shared rule.
- Domain verification and the MX record are still manual prerequisites. Each `match-to-csv` deployment reads the domain from SSM and stops if the rule set is not active, the identity is not verified in the deployment Region, or the MX record does not point at SES inbound receiving there. See [Check prerequisites](00-prerequisites.md).

## If something looks wrong

Stop at the first unexpected plan or stack event. Do not apply a plan that creates or replaces a receipt rule set, rule, or activation. A failed import leaves the live resources untouched, so you can fix the block and retry. If inbound mail stops, restore it with `aws ses set-active-receipt-rule-set --rule-set-name mcc-match-to-csv-<environment>`. The rule set and its rule are retained at every step, so this recovers the state.
