# Getting started

This guide takes you from a fresh clone to passing checks, and then, if you have a dev AWS account, to your own copy of `match-to-csv` processing a test email. You do not need to read any other guide first.

You do not need AWS access, secrets, or package registry credentials to contribute. Tier 1 is all a pull request needs, and pull requests run CI without touching AWS. Tier 2 is optional.

## Tier 1: run the checks locally

### Clone the repository

Fork the repository first if you cannot push to it, and clone your fork instead.

```console
git clone https://github.com/samlevin/mcc-stats-suite.git
cd mcc-stats-suite
```

### Install the tools

You need Git, Node.js with npm, and OpenTofu. You need OpenTofu only to check or apply infrastructure. [`.tool-versions`](../.tool-versions) pins the Node.js and OpenTofu versions, and it is the only place the versions are written down.

With [asdf](https://asdf-vm.com/), add the two plugins once, then install the pinned versions from the repository root:

```console
asdf plugin add nodejs https://github.com/asdf-vm/asdf-nodejs.git
asdf plugin add opentofu https://github.com/virtualroot/asdf-opentofu.git
asdf install
```

Without asdf, install the Node.js version from `.tool-versions` with your usual version manager or the [Node.js installer](https://nodejs.org/en/download), which includes npm. Install the OpenTofu version from `.tool-versions` by following the [OpenTofu installation guide](https://opentofu.org/docs/intro/install/). Either way, `node --version` and `tofu version` should print the pinned versions.

### Install dependencies and run the checks

From the repository root:

```console
npm ci
npm run check
```

`npm run check` runs Prettier, ESLint, the release metadata check, TypeScript, every test, and every build. None of them call AWS. `npm run format` and `npm run lint:fix` fix what they can automatically.

### Docker

`npm run check` does not need Docker. Its tests build the CDK stacks without bundling Lambda code, and its builds only compile TypeScript.

Synthesizing `match-to-csv` needs Docker that can run Linux ARM64 images, because Sharp is packaged for the Lambda ARM64 runtime. The commands that need it are:

- `npm run app:synth`, `npm run app:diff`, and `npm run app:deploy` for `match-to-csv`;
- `npm run verify:bundle --workspace @mcc/match-to-csv`, which inspects the assets a `match-to-csv` synthesis produced, so run it after `app:synth`.

Apple silicon runs ARM64 images natively. On x86, install QEMU emulation as [Tools](self-hosting/00-prerequisites.md#tools) describes.

### Choose the checks for your change

Run the narrowest set that covers your change before you push. While you iterate, run only the focused test.

| Changed | Run |
| --- | --- |
| Docs only | `npm run format:check`, `npx eslint '**/*.md' --max-warnings 0` |
| `scripts/` only | `npm run format:check`, `npx eslint scripts/ci-scope.mjs scripts/issue-*.mjs scripts/branch-name.mjs --max-warnings 0`, `node --test scripts/issue-*.test.mjs scripts/branch-name.test.mjs` |
| `.agents/`, `.claude/`, `.codex/`, or `scripts/agent-policy*` | `npm run agents:generate` after editing a source, then `npm run agents:check`, `npm run format:check`, `npx eslint scripts/agent-policy.mjs scripts/agent-policy.test.mjs '**/*.md' --max-warnings 0`, `node --test scripts/agent-policy.test.mjs` |
| A workspace | iterate with `npm test --workspace @mcc/<pkg>`; before you push, `npm run check` |
| `infrastructure/` | `npm run tofu:check`, which needs OpenTofu but no AWS access |
| CDK or bundling | also `npm run app:synth -- <app> --environment dev` and `npm run verify:bundle --workspace @mcc/match-to-csv`, which need Docker |

[TESTING.md](../TESTING.md) explains what each check covers and how CI picks checks from the changed files. [CONTRIBUTING.md](../CONTRIBUTING.md) covers claiming an issue, pull-request titles, and what happens after a merge.

## Tier 2: deploy your own ephemeral stack

An ephemeral stack is your own copy of an application in a dev AWS account, named `<application>-e-<name>`. A `match-to-csv` ephemeral stack has its own email address, `<alias>+<name>@<domain>`, and writes its evidence under `ephemeral/<name>/` in the shared dev buckets. Use one to try an ingestion or processing change against real email and Textract before you open a pull request.

### Prerequisites

Have all of these before the first step. The [self-hosting guide](self-hosting/README.md) creates each one, in its numbered order. If someone else runs the deployment you use, ask them for the access instead.

- An AWS Organization with IAM Identity Center and a dev account, as [Accounts](self-hosting/00-prerequisites.md#accounts) describes. [samlevin/aws-bootstrap](https://github.com/samlevin/aws-bootstrap) is one way to build the organization.
- A verified SES domain identity and MX record in the dev account's workload Region, from [Inbound email](self-hosting/00-prerequisites.md#inbound-email).
- AWS CLI v2, `direnv`, and Docker that can run Linux ARM64 images, from [Tools](self-hosting/00-prerequisites.md#tools).
- The bootstrapped dev account, from [Bootstrap dev](self-hosting/10-bootstrap-accounts.md#bootstrap-dev).
- The local `mcclocal1` CDK bootstrap in dev, from [Bootstrap local deployments separately](self-hosting/20-bootstrap-cdk.md#bootstrap-local-deployments-separately).
- The `mcc-dev` SSO profile, pointed at the local deploy permission set. [SSO profiles](self-hosting/00-prerequisites.md#sso-profiles) names the profile and [Grant local deploy access](self-hosting/20-bootstrap-cdk.md#grant-local-deploy-access) creates the permission set.
- The applied dev foundation, from [Apply dev](self-hosting/40-change-foundation.md#apply-dev). It publishes the email alias, domain, and bucket names that an ephemeral stack reads.
- A profile that can read SSM parameters, Step Functions, and S3 in dev, such as `mcc-dev-admin` from [SSO profiles](self-hosting/00-prerequisites.md#sso-profiles). The `mcc-dev` profile can deploy but cannot read the submission address or the results.
- A passing tier 1.

### Set up your shell

Copy [`.envrc.example`](../.envrc.example) to the ignored `.envrc` in the repository root. It sets `AWS_PROFILE=mcc-dev`, which `npm run app:*` reads. If your profile has another name, change it there and keep `dev` in the name. `scripts/cdk-app.mjs`, the wrapper behind `npm run app:*`, refuses a profile whose name does not match the environment.

```console
cp .envrc.example .envrc
direnv allow
aws sso login --profile mcc-dev
aws sts get-caller-identity
```

Stop unless STS reports the dev account.

### Pick a name

The name is 1 to 20 lowercase letters, numbers, or hyphens, and starts with a letter or number. `dev` and `prod` are reserved for the shared environments, and `incoming` and `ephemeral` are reserved object prefixes. The wrapper rejects any other name before it calls AWS. Pick a name nobody else uses in the account, because the same name deploys the same stack. The examples below use `<name>`.

### Deploy

```console
npm run app:synth -- match-to-csv --environment dev --ephemeral <name>
npm run verify:bundle --workspace @mcc/match-to-csv
npm run app:diff -- match-to-csv --environment dev --ephemeral <name>
npm run app:deploy -- match-to-csv --environment dev --ephemeral <name>
```

Before a diff or deploy, the wrapper checks that the active AWS account matches the profile's `sso_account_id`. Do not bypass that check or pass raw CDK context. Use `--environment` and `--ephemeral`. [Ephemeral stacks](self-hosting/50-deploy-and-release-applications.md#ephemeral-stacks) lists the deploy options the wrapper rejects. If CDK reports access denied, see the end of [Grant local deploy access](self-hosting/20-bootstrap-cdk.md#grant-local-deploy-access).

### Send a test email

Sign in with a profile that can read SSM, read the alias and domain the dev foundation publishes, and print your stack's address:

```console
aws sso login --profile mcc-dev-admin
alias=$(aws ssm get-parameter --profile mcc-dev-admin --name /mcc/dev/match-to-csv/email-alias --query Parameter.Value --output text)
domain=$(aws ssm get-parameter --profile mcc-dev-admin --name /mcc/dev/match-to-csv/email-domain --query Parameter.Value --output text)
echo "$alias+<name>@$domain"
```

From your own mail client, send that address a message with a PNG or JPEG screenshot attached. `match-to-csv` accepts images of at least 640 by 360 pixels and up to 10 MB. Your `From` address must be on the dev sender allowlist, which is required. Without it, every message is rejected. See [Manage the sender allowlist](self-hosting/50-deploy-and-release-applications.md#manage-the-sender-allowlist). Keep the address, the domain, and your test messages out of commits, issues, and pull requests.

### Check the result

Find your stack's workflow and its latest execution. Its status should be `SUCCEEDED`. A rejected message, such as one with no processable screenshot, also ends as `SUCCEEDED`, at the `Submission rejected` state, and runs no OCR.

```console
state_machine=$(aws cloudformation describe-stacks --profile mcc-dev-admin --stack-name match-to-csv-e-<name> --query "Stacks[0].Outputs[?OutputKey=='StateMachineArn'].OutputValue" --output text)
aws stepfunctions list-executions --profile mcc-dev-admin --state-machine-arn "$state_machine" --max-results 1
```

Then list the evidence:

```console
bucket=$(aws ssm get-parameter --profile mcc-dev-admin --name /mcc/dev/match-to-csv/evidence-bucket-name --query Parameter.Value --output text)
aws s3 ls --profile mcc-dev-admin --recursive "s3://$bucket/ephemeral/<name>/submissions/"
```

Each submission has `ingestion.json` and `completion.json`. Each accepted screenshot has its original image and one run with a manifest, the Textract request and response, normalized observations, and `export/extracted.csv`. Download the CSV with `aws s3 cp` and compare it with the screenshot. OCR differences are observations to label, not failures. A rejected submission records its reason in `completion.json`. [Sender screening](../applications/match-to-csv/README.md#sender-screening) lists the codes, and [Evidence layout](../applications/match-to-csv/README.md#evidence-layout) shows the full tree.

### Remove the stack

```console
npm run app:destroy -- match-to-csv --environment dev --ephemeral <name>
```
