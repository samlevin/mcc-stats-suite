# Configure initial production controls

Enable controls on OUs, not individual accounts. Start with a small set of
clear safeguards. Do this after `Production` is registered and before the prod
account receives a workload.

In **Control Tower → Controls**, open each control, choose **Enable control**,
and target the `Production` OU.

## Enable now

| Control | Why | Also enable on Sandbox? |
|---|---|---|
| Disallow actions as the root user | Root is recovery-only. | Yes, after confirming recovery access. |
| Disallow creation of access keys for the root user | Prevents programmatic root credentials. | Yes. |
| Detect public read access for S3 buckets | Alerts on accidental public data. | Yes. |
| Detect public write access for S3 buckets | Alerts on a high-risk bucket policy. | Yes. |

Enable the OU-level **Deny access to AWS based on the requested AWS Region**
control for `Production` only after confirming the project's deployment Region.
For the current project, allow `us-east-2` and no others unless a deliberate
service requirement exists. This is preventive: it can block a deployment that
accidentally targets another Region. Do not combine it casually with the
landing-zone-wide Region deny control; AWS documents their policy interaction.

SES delivery to a private S3 bucket remains compatible with the S3 public-access
controls. The bucket policy should grant the SES service principal, not public
access.

When enabling **Disallow actions as the root user** for `Production`, select
**Exempt requests made using AssumeRoot**. This preserves the centrally managed,
short-lived, CloudTrail-audited break-glass path from the management account;
it does not restore direct sign-in as the member-account root user. This project
enables that central root-access path in the later root-access runbook. Do not
exempt direct root sessions or re-enable member root credentials.

## Defer

Do not enable these until the infrastructure design requires them:

- IAM wildcard-policy proactive controls; early CDK bootstrap and deployment
  roles may legitimately need broad permissions.
- VPC internet, VPN, or cross-Region network restrictions; there is no project
  network design yet.
- Required-tag controls; first establish and automate the tag convention.
- Encryption, data-residency, and lake-specific controls; add these with the
  data pipeline design.

Review detective-control findings after the first production deployment. A
control is either preventive (blocks), detective (reports), or proactive
(blocks a noncompliant CloudFormation resource before provisioning).

References:

- [Control behavior and guidance](https://docs.aws.amazon.com/controltower/latest/controlreference/control-behavior.html)
- [Strongly recommended preventive controls](https://docs.aws.amazon.com/controltower/latest/controlreference/strongly-recommended-preventive-controls.html)
- [OU Region deny control](https://docs.aws.amazon.com/controltower/latest/controlreference/ou-region-deny.html)

Next: [Configure Identity Center access](30-configure-identity-center-access.md).
