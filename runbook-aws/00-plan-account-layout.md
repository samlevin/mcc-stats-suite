# Plan accounts, names, email, and Regions

Make these decisions before creating anything. Changing the Control Tower home
Region later requires decommissioning and rebuilding the landing zone.

## Record the plan privately

Use a password manager or another access-controlled system, not this repository:

```text
Organization name:
Management account name and email:
Audit account name and email:
Log Archive account name and email:
Stable dev account name and email:
Production account name and email:
Control Tower and Identity Center home Region:
Project workload Region:
GitHub owner and repository:
```

Every AWS account requires a unique email address. A controlled alias is acceptable when the mail provider preserves access.
Do not use an individual employee's mailbox for management, audit, log archive,
or production.

## Adopt the account boundaries

- The initial AWS account becomes the **management account**. It is not a
  workload account and is never “registered” beneath Control Tower.
- Control Tower creates or adopts **Audit** and **Log Archive** accounts.
- The registered **Sandbox OU** contains stable dev and disposable developer
  accounts.
- A registered **Production OU** contains prod.
- Do not create a separate data account yet.

Disposable accounts are on-demand sandboxes, not per-commit resources. AWS
accounts take time to vend, closure has a 90-day suspension period, and account
closure is quota-limited. Prefer cleaning and recycling them.

The Control Tower/Identity Center home Region and workload Region can differ.
If Identity Center already exists, its primary Region must match the Control
Tower home Region. Start with one Identity Center Region; add replication later
only for a demonstrated resilience need.

Reference: [AWS Control Tower landing-zone setup](https://docs.aws.amazon.com/prescriptive-guidance/latest/designing-control-tower-landing-zone/setup.html).

Next: [Secure the management account](10-secure-management-account.md).
