# Read CDK plan output

Run `npm run app:diff -- match-to-csv --environment dev --ephemeral <name>` for a local plan. The wrapper checks the caller's account before CDK runs. Stable dev and prod deployment rules still apply. CDK options such as `--fail`, `--no-change-set`, `--security-only`, and `--output <directory>` pass through to CDK.

The raw CDK diff appears first. The explanation follows with the application, exact stack, account, Region, environment, ephemeral name, evidence namespace, and checked-out source commit. The target uses the same deployment configuration resolver as the application. Account and Region come from the fresh cloud assembly when available. A failed synthesis or unsupported output location leaves the resource summary unavailable and preserves CDK's exit status.

The proposed template supplies the resource list. Component metadata beside the match-to-csv constructs groups resources into email intake, OCR, CSV export, replay/evidence tools, and operational support. Each entry gives its purpose and three identifiers:

- A construct path identifies an object in the CDK construct tree, such as `match-to-csv-dev/ProcessEmail/Resource`.
- A CloudFormation logical ID identifies the resource within the stack. CDK usually adds a hash. Keep these IDs stable to preserve resource identity.
- A physical name identifies the AWS resource. The report distinguishes explicitly configured names, CDK-generated configured names, and names AWS generates at deployment. Intrinsic expressions stay unresolved. The report does not look up deployed names.

Shared foundation resources appear as references, including SSM contracts for buckets, the data key, roster table, and email routing, plus the IAM workload boundary. Runtime SSM parameter paths are references too. These entries do not mean the application creates those resources.

The change list reads CDK's resource lines. `Add`, `Update`, and `Delete` connect those lines to the proposed template's purpose labels. Deleted resources retain the path and type from the diff because they are absent from the proposed template. CDK's `replace` and `may be replaced` markers distinguish required and possible replacements. An update without a marker has an unestablished replacement status in this report. CloudFormation change-set information can affect that decision.

Permission changes are flagged from resource changes and CDK's IAM/security tables. Read the raw tables for the exact principals, actions, resources, conditions, additions, and removals. The explanation does not classify access as safe or broader. A filtered, quiet, failed, or unrecognized diff can omit changes. Resources absent from the change list have no reported change, which does not prove they are unchanged. Raw non-resource changes, such as stack descriptions and outputs, remain in the original diff.

The summary adds no deployment gate and does not deploy anything. It preserves CDK's exit status, including the status selected by `--fail`.
