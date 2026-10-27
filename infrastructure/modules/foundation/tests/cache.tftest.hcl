# Only local plans run. Fake credentials and overrides prevent AWS calls while
# the real provider validates resource and IAM policy arguments.
provider "aws" {
  region                      = "us-east-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_region_validation      = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
}

override_data {
  target = data.aws_caller_identity.current
  values = { account_id = "000000000000" }
}

override_data {
  target = data.aws_partition.current
  values = { partition = "aws", dns_suffix = "amazonaws.com" }
}

override_data {
  target = data.aws_region.current
  values = { region = "us-east-1" }
}

override_resource {
  target = aws_kms_key.data
  values = { arn = "arn:aws:kms:us-east-1:000000000000:key/00000000-0000-0000-0000-000000000000" }
}

// The published alias matches the configured one unless a run overrides it.
override_data {
  target = data.aws_ssm_parameters_by_path.match_to_csv
  values = {
    names  = ["/mcc/dev/match-to-csv/email-alias", "/mcc/prod/match-to-csv/email-alias"]
    values = ["example-alias", "example-alias"]
  }
}

variables {
  email_alias  = "example-alias"
  email_domain = "mail.example.com"
}

run "dev_secure_defaults" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables { environment = "dev" }

  override_resource {
    target = aws_s3_bucket.turbo_cache
    values = {
      id  = "mcc-stats-suite-dev-000000000000-turbo-cache"
      arn = "arn:aws:s3:::mcc-stats-suite-dev-000000000000-turbo-cache"
    }
  }

  assert {
    condition = (
      aws_s3_bucket.turbo_cache.bucket == "mcc-stats-suite-dev-000000000000-turbo-cache" &&
      !aws_s3_bucket.turbo_cache.object_lock_enabled &&
      aws_s3_bucket_versioning.turbo_cache.versioning_configuration[0].status == "Disabled"
    )
    error_message = "Cache names must include environment/account and cache must remain unversioned without Object Lock."
  }

  assert {
    condition = (
      aws_s3_bucket_public_access_block.turbo_cache.block_public_acls &&
      aws_s3_bucket_public_access_block.turbo_cache.block_public_policy &&
      aws_s3_bucket_public_access_block.turbo_cache.ignore_public_acls &&
      aws_s3_bucket_public_access_block.turbo_cache.restrict_public_buckets
    )
    error_message = "All public access paths must be blocked."
  }

  assert {
    condition = (
      one(aws_s3_bucket_server_side_encryption_configuration.turbo_cache.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "aws:kms" &&
      one(aws_s3_bucket_server_side_encryption_configuration.turbo_cache.rule).apply_server_side_encryption_by_default[0].kms_master_key_id == aws_kms_key.data.arn &&
      one(aws_s3_bucket_server_side_encryption_configuration.turbo_cache.rule).bucket_key_enabled
    )
    error_message = "Cache encryption must use the foundation key with S3 Bucket Keys."
  }

  assert {
    condition = (
      aws_s3_bucket_lifecycle_configuration.turbo_cache.rule[0].status == "Enabled" &&
      aws_s3_bucket_lifecycle_configuration.turbo_cache.rule[0].expiration[0].days == 7 &&
      aws_s3_bucket_lifecycle_configuration.turbo_cache.rule[0].abort_incomplete_multipart_upload[0].days_after_initiation == 7 &&
      length(aws_s3_bucket_lifecycle_configuration.turbo_cache.rule[0].filter) == 1 &&
      aws_s3_bucket_lifecycle_configuration.turbo_cache.rule[0].filter[0].prefix == ""
    )
    error_message = "Every cache object must expire after seven days and incomplete multipart uploads after seven days."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.turbo_cache_bucket.statement :
      statement.effect == "Deny" && one(statement.principals).type == "*" && one(statement.principals).identifiers == toset(["*"])
    ]) && length(data.aws_iam_policy_document.turbo_cache_bucket.statement) == 4
    error_message = "The storage foundation must not grant access to any principal."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.turbo_cache_bucket.statement :
      statement.sid == "DenyInsecureTransport" ? (
        statement.actions == toset(["s3:*"]) &&
        one(statement.condition).test == "Bool" &&
        one(statement.condition).variable == "aws:SecureTransport" &&
        toset(one(statement.condition).values) == toset(["false"]) &&
        statement.resources == toset([aws_s3_bucket.turbo_cache.arn, "${aws_s3_bucket.turbo_cache.arn}/*"])
        ) : (
        statement.sid == "DenyCacheDataOutsideServiceRoles" ?
        length(statement.condition) == 0 && statement.actions == toset(["s3:*"]) && statement.resources == toset(["${aws_s3_bucket.turbo_cache.arn}/*"]) :
        (statement.sid == "DenyCacheListingOutsideServiceRoles" ?
          statement.actions == toset(["s3:ListBucket"]) && statement.resources == toset([aws_s3_bucket.turbo_cache.arn]) &&
          length(statement.condition) == 1 &&
          one(statement.condition).test == "NumericGreaterThan" &&
          one(statement.condition).variable == "s3:max-keys" &&
          toset(one(statement.condition).values) == toset(["0"]) :
          statement.sid == "DenyCacheVersionAndMultipartListingOutsideServiceRoles" &&
          length(statement.condition) == 0 &&
          statement.actions == toset(["s3:ListBucketVersions", "s3:ListBucketMultipartUploads"]) && statement.resources == toset([aws_s3_bucket.turbo_cache.arn])
        )
      )
    ])
    error_message = "TLS and data/listing denials must preserve metadata-only HeadBucket refreshes without exempting any management principal."
  }

  assert {
    condition = alltrue([
      for request in [
        { max_keys = null, denied = false }, # HeadBucket has no listing limit.
        { max_keys = 0, denied = false },    # A zero-key listing exposes no names.
        { max_keys = 1, denied = true },
        { max_keys = 1000, denied = true }, # Default limit when none is supplied.
        ] : request.denied == (request.max_keys == null ? false :
        request.max_keys > tonumber(one(one(one([
          for statement in data.aws_iam_policy_document.turbo_cache_bucket.statement : statement
          if statement.sid == "DenyCacheListingOutsideServiceRoles"
        ]).condition).values))
      )
    ])
    error_message = "Refresh must remain possible while explicit and default positive listing limits are denied."
  }

  assert {
    condition = (
      output.turbo_cache_bucket_name == aws_ssm_parameter.turbo_cache_bucket_name.value &&
      output.turbo_cache_bucket_name == aws_s3_bucket.turbo_cache.id &&
      aws_ssm_parameter.turbo_cache_bucket_name.name == "/mcc-ci/dev/turbo-cache/bucket-name" &&
      output.turbo_cache_key_arn == aws_ssm_parameter.turbo_cache_key_arn.value &&
      output.turbo_cache_key_arn == aws_kms_key.data.arn &&
      aws_ssm_parameter.turbo_cache_key_arn.name == "/mcc-ci/dev/turbo-cache/data-key-arn"
    )
    error_message = "The output and dev SSM contracts must publish the cache bucket and its encryption key."
  }

  assert {
    condition = length(data.aws_iam_policy_document.turbo_cache_service.statement) == 2 && alltrue([
      for statement in data.aws_iam_policy_document.turbo_cache_service.statement :
      statement.effect == "Allow" && length(statement.principals) == 0 &&
      (statement.sid == "ReadWriteCacheObjects" ?
        statement.actions == toset(["s3:GetObject", "s3:PutObject"]) && statement.resources == toset(["${aws_s3_bucket.turbo_cache.arn}/*"]) :
        statement.actions == toset(["kms:Decrypt", "kms:GenerateDataKey"]) &&
        statement.resources == toset([aws_kms_key.data.arn]) &&
        length(statement.condition) == 2 && alltrue([
          for condition in statement.condition :
          condition.test == "StringEquals" &&
          (condition.variable == "kms:ViaService" ?
            toset(condition.values) == toset(["s3.us-east-1.amazonaws.com"]) :
            condition.variable == "kms:EncryptionContext:aws:s3:arn" && toset(condition.values) == toset([aws_s3_bucket.turbo_cache.arn])
          )
        ])
      )
    ])
    error_message = "Future service grants must be limited to object reads/writes and this bucket's S3-mediated encryption."
  }
}

run "prod_service_contract" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables {
    environment             = "prod"
    cache_service_role_arns = ["arn:aws:iam::000000000000:role/test-cache-service"]
  }

  override_resource {
    target = aws_s3_bucket.turbo_cache
    values = {
      id  = "mcc-stats-suite-prod-000000000000-turbo-cache"
      arn = "arn:aws:s3:::mcc-stats-suite-prod-000000000000-turbo-cache"
    }
  }

  assert {
    condition = (
      aws_s3_bucket.turbo_cache.bucket == "mcc-stats-suite-prod-000000000000-turbo-cache" &&
      aws_ssm_parameter.turbo_cache_bucket_name.name == "/mcc-ci/prod/turbo-cache/bucket-name" &&
      aws_ssm_parameter.turbo_cache_key_arn.name == "/mcc-ci/prod/turbo-cache/data-key-arn" &&
      aws_ssm_parameter.turbo_cache_bucket_name.value == output.turbo_cache_bucket_name &&
      aws_ssm_parameter.turbo_cache_key_arn.value == output.turbo_cache_key_arn &&
      output.turbo_cache_key_arn == aws_kms_key.data.arn &&
      !aws_s3_bucket.turbo_cache.object_lock_enabled &&
      aws_s3_bucket_versioning.turbo_cache.versioning_configuration[0].status == "Disabled"
    )
    error_message = "Prod must have its own account-qualified bucket and SSM contract without evidence retention."
  }

  assert {
    condition = (
      aws_s3_bucket_lifecycle_configuration.turbo_cache.rule[0].status == "Enabled" &&
      aws_s3_bucket_lifecycle_configuration.turbo_cache.rule[0].expiration[0].days == 7 &&
      aws_s3_bucket_lifecycle_configuration.turbo_cache.rule[0].abort_incomplete_multipart_upload[0].days_after_initiation == 7 &&
      length(aws_s3_bucket_lifecycle_configuration.turbo_cache.rule[0].filter) == 1 &&
      aws_s3_bucket_lifecycle_configuration.turbo_cache.rule[0].filter[0].prefix == ""
    )
    error_message = "Every prod cache object must expire after seven days and incomplete multipart uploads after seven days."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.turbo_cache_bucket.statement :
      statement.effect == "Deny" &&
      (statement.sid == "DenyInsecureTransport" ?
        one(statement.condition).test == "Bool" && one(statement.condition).variable == "aws:SecureTransport" && toset(one(statement.condition).values) == toset(["false"]) :
        length(statement.condition) == (statement.sid == "DenyCacheListingOutsideServiceRoles" ? 2 : 1) && alltrue([
          for condition in statement.condition :
          condition.variable == "s3:max-keys" ?
          condition.test == "NumericGreaterThan" && toset(condition.values) == toset(["0"]) :
          condition.test == "ArnNotEquals" && condition.variable == "aws:PrincipalArn" &&
          toset(condition.values) == toset(["arn:aws:iam::000000000000:role/test-cache-service"])
        ])
      )
    ])
    error_message = "Only explicitly named service roles may escape the data denial; TLS remains required for those roles too."
  }
}

run "reject_wildcard_service_role" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables {
    environment             = "dev"
    cache_service_role_arns = ["arn:aws:iam::000000000000:role/*"]
  }
  expect_failures = [var.cache_service_role_arns]
}

run "reject_cross_account_service_role" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables {
    environment             = "dev"
    cache_service_role_arns = ["arn:aws:iam::000000000001:role/test-cache-service"]
  }
  expect_failures = [var.cache_service_role_arns]
}

run "dev_github_cache_role" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables {
    environment                    = "dev"
    create_github_cache_role       = true
    github_oidc_subject_repository = "samlevin@1/mcc-stats-suite@2"
  }
  override_resource {
    target = aws_s3_bucket.turbo_cache
    values = {
      id  = "mcc-stats-suite-dev-000000000000-turbo-cache"
      arn = "arn:aws:s3:::mcc-stats-suite-dev-000000000000-turbo-cache"
    }
  }
  assert {
    condition     = aws_iam_role.github_cache[0].permissions_boundary == "arn:aws:iam::000000000000:policy/mcc-stats-suite-workload-boundary" && aws_iam_role.github_cache[0].max_session_duration == 3600
    error_message = "The cache role must use the existing bootstrap workload boundary and a short-lived session."
  }
  assert {
    condition = alltrue([for statement in data.aws_iam_policy_document.cache_assume_role.statement :
      statement.actions == toset(["sts:AssumeRoleWithWebIdentity"]) && alltrue([for condition in statement.condition :
        condition.variable == "token.actions.githubusercontent.com:sub" ? toset(condition.values) == toset(["repo:samlevin@1/mcc-stats-suite@2:environment:dev", "repo:samlevin@1/mcc-stats-suite@2:ref:refs/heads/main"]) :
        condition.variable == "token.actions.githubusercontent.com:ref" ? toset(condition.values) == toset(["refs/heads/main"]) :
        condition.variable == "token.actions.githubusercontent.com:aud" ? toset(condition.values) == toset(["sts.amazonaws.com"]) :
        condition.variable == "token.actions.githubusercontent.com:repository" && toset(condition.values) == toset(["samlevin/mcc-stats-suite"])
      ])
    ])
    error_message = "Only exact main/environment subjects may assume the matching cache role, never a PR or another environment."
  }
  assert {
    condition     = alltrue([for statement in data.aws_iam_policy_document.turbo_cache_bucket.statement : statement.sid == "DenyInsecureTransport" ? true : anytrue([for condition in statement.condition : condition.variable == "aws:PrincipalArn" && contains(condition.values, output.github_turbo_cache_role_arn)])])
    error_message = "The managed role must escape the bucket data/listing deny statements."
  }
  assert {
    condition = length(data.aws_iam_policy_document.github_cache.statement) == 4 && alltrue([for statement in data.aws_iam_policy_document.github_cache.statement :
      statement.sid == "ReadWriteCacheObjects" ? statement.actions == toset(["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload"]) && statement.resources == toset(["arn:aws:s3:::mcc-stats-suite-dev-000000000000-turbo-cache/turbogha/dev/*"]) :
      statement.sid == "ListCacheHashCandidates" ? statement.actions == toset(["s3:ListBucket"]) && one(statement.condition).test == "StringLike" && one(statement.condition).variable == "s3:prefix" && toset(one(statement.condition).values) == toset(["turbogha/dev/*"]) :
      statement.sid == "ReadCacheContracts" ? statement.actions == toset(["ssm:GetParameter"]) && statement.resources == toset([for name in ["bucket-name", "data-key-arn"] : "arn:aws:ssm:us-east-1:000000000000:parameter/mcc-ci/dev/turbo-cache/${name}"]) :
      statement.sid == "UseCacheKeyThroughS3" && statement.actions == toset(["kms:Decrypt", "kms:GenerateDataKey"]) && length(statement.condition) == 2
    ])
    error_message = "The action needs prefix-scoped listing/read/write and multipart abort, without deletion or bucket-wide access."
  }
  assert {
    condition     = aws_iam_role.github_cache_read[0].name == "mcc-stats-suite-dev-github-turbo-cache-read" && aws_iam_role.github_cache_read[0].permissions_boundary == "arn:aws:iam::000000000000:policy/mcc-stats-suite-workload-boundary" && aws_iam_role.github_cache_read[0].max_session_duration == 3600
    error_message = "The dev read-only cache role must use the existing bootstrap workload boundary and a short-lived session."
  }
  assert {
    condition = length(data.aws_iam_policy_document.cache_read_assume_role.statement) == 1 && alltrue([for statement in data.aws_iam_policy_document.cache_read_assume_role.statement :
      statement.actions == toset(["sts:AssumeRoleWithWebIdentity"]) && length(statement.condition) == 3 && alltrue([for condition in statement.condition :
        condition.test == "StringEquals" && (
          condition.variable == "token.actions.githubusercontent.com:sub" ? toset(condition.values) == toset(["repo:samlevin@1/mcc-stats-suite@2:pull_request"]) :
          condition.variable == "token.actions.githubusercontent.com:aud" ? toset(condition.values) == toset(["sts.amazonaws.com"]) :
          condition.variable == "token.actions.githubusercontent.com:repository" && toset(condition.values) == toset(["samlevin/mcc-stats-suite"])
        )
      ])
    ])
    error_message = "Only this repository's pull request subject may assume the read-only cache role."
  }
  assert {
    condition     = alltrue([for statement in data.aws_iam_policy_document.turbo_cache_bucket.statement : statement.sid == "DenyInsecureTransport" ? true : anytrue([for condition in statement.condition : condition.variable == "aws:PrincipalArn" && toset(condition.values) == toset([output.github_turbo_cache_role_arn, "arn:aws:iam::000000000000:role/mcc-stats-suite-dev-github-turbo-cache-read"])])])
    error_message = "Exactly the write and read-only cache roles must escape the bucket data/listing deny statements."
  }
  # Pull request code must never write the trusted cache: no PutObject, no
  # multipart, no deletion, and no data key generation.
  assert {
    condition = length(data.aws_iam_policy_document.github_cache_read.statement) == 4 && alltrue([for statement in data.aws_iam_policy_document.github_cache_read.statement :
      statement.sid == "ReadCacheObjects" ? statement.actions == toset(["s3:GetObject"]) && statement.resources == toset(["arn:aws:s3:::mcc-stats-suite-dev-000000000000-turbo-cache/turbogha/dev/*"]) :
      statement.sid == "ListCacheHashCandidates" ? statement.actions == toset(["s3:ListBucket"]) && one(statement.condition).test == "StringLike" && one(statement.condition).variable == "s3:prefix" && toset(one(statement.condition).values) == toset(["turbogha/dev/*"]) :
      statement.sid == "ReadCacheContracts" ? statement.actions == toset(["ssm:GetParameter"]) && statement.resources == toset([for name in ["bucket-name", "data-key-arn"] : "arn:aws:ssm:us-east-1:000000000000:parameter/mcc-ci/dev/turbo-cache/${name}"]) :
      statement.sid == "DecryptCacheObjectsThroughS3" && statement.actions == toset(["kms:Decrypt"]) && length(statement.condition) == 2
    ])
    error_message = "The read-only cache role may only list, read, and decrypt the dev cache prefix and read its contracts; it must never write."
  }
}

run "prod_github_cache_role" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables {
    environment                    = "prod"
    create_github_cache_role       = true
    github_oidc_subject_repository = "samlevin@1/mcc-stats-suite@2"
  }
  override_resource {
    target = aws_s3_bucket.turbo_cache
    values = {
      id  = "mcc-stats-suite-prod-000000000000-turbo-cache"
      arn = "arn:aws:s3:::mcc-stats-suite-prod-000000000000-turbo-cache"
    }
  }
  assert {
    condition     = aws_iam_role.github_cache[0].permissions_boundary == "arn:aws:iam::000000000000:policy/mcc-stats-suite-workload-boundary" && aws_iam_role.github_cache[0].max_session_duration == 3600
    error_message = "The cache role must use the existing bootstrap workload boundary and a short-lived session."
  }
  assert {
    condition = alltrue([for statement in data.aws_iam_policy_document.cache_assume_role.statement :
      statement.actions == toset(["sts:AssumeRoleWithWebIdentity"]) && alltrue([for condition in statement.condition :
        condition.variable == "token.actions.githubusercontent.com:sub" ? toset(condition.values) == toset(["repo:samlevin@1/mcc-stats-suite@2:environment:prod"]) :
        condition.variable == "token.actions.githubusercontent.com:ref" ? toset(condition.values) == toset(["refs/heads/main"]) :
        condition.variable == "token.actions.githubusercontent.com:aud" ? toset(condition.values) == toset(["sts.amazonaws.com"]) :
        condition.variable == "token.actions.githubusercontent.com:repository" && toset(condition.values) == toset(["samlevin/mcc-stats-suite"])
      ])
    ])
    error_message = "Only exact main/environment subjects may assume the matching cache role, never a PR or another environment."
  }
  assert {
    condition     = alltrue([for statement in data.aws_iam_policy_document.turbo_cache_bucket.statement : statement.sid == "DenyInsecureTransport" ? true : anytrue([for condition in statement.condition : condition.variable == "aws:PrincipalArn" && contains(condition.values, output.github_turbo_cache_role_arn)])])
    error_message = "The managed role must escape the bucket data/listing deny statements."
  }
  assert {
    condition = length(data.aws_iam_policy_document.github_cache.statement) == 4 && alltrue([for statement in data.aws_iam_policy_document.github_cache.statement :
      statement.sid == "ReadWriteCacheObjects" ? statement.actions == toset(["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload"]) && statement.resources == toset(["arn:aws:s3:::mcc-stats-suite-prod-000000000000-turbo-cache/turbogha/prod/*"]) :
      statement.sid == "ListCacheHashCandidates" ? statement.actions == toset(["s3:ListBucket"]) && one(statement.condition).test == "StringLike" && one(statement.condition).variable == "s3:prefix" && toset(one(statement.condition).values) == toset(["turbogha/prod/*"]) :
      statement.sid == "ReadCacheContracts" ? statement.actions == toset(["ssm:GetParameter"]) && statement.resources == toset([for name in ["bucket-name", "data-key-arn"] : "arn:aws:ssm:us-east-1:000000000000:parameter/mcc-ci/prod/turbo-cache/${name}"]) :
      statement.sid == "UseCacheKeyThroughS3" && statement.actions == toset(["kms:Decrypt", "kms:GenerateDataKey"]) && length(statement.condition) == 2
    ])
    error_message = "The action needs prefix-scoped listing/read/write and multipart abort, without deletion or bucket-wide access."
  }
  assert {
    condition     = length(aws_iam_role.github_cache_read) == 0 && length(aws_iam_role_policy.github_cache_read) == 0 && alltrue([for statement in data.aws_iam_policy_document.turbo_cache_bucket.statement : alltrue([for condition in statement.condition : condition.variable != "aws:PrincipalArn" || toset(condition.values) == toset([output.github_turbo_cache_role_arn])])])
    error_message = "Prod CI validates no pull requests, so prod has no read-only cache role or bucket exception for one."
  }
}

# The role trusts the repository the foundation is deployed for: a fork's role
# trusts only the fork, a mutable subject keeps the same repository, and a root
# without a subject repository gets no role and no bucket exception.
run "fork_subject_trusts_only_the_fork" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables {
    environment                    = "dev"
    create_github_cache_role       = true
    github_oidc_subject_repository = "forker@3/mcc-stats-suite@4"
  }
  assert {
    condition     = length(aws_iam_role.github_cache) == 1 && output.github_turbo_cache_role_arn == "arn:aws:iam::000000000000:role/mcc-stats-suite-dev-github-turbo-cache"
    error_message = "A fork's foundation creates its own cache role."
  }
  assert {
    condition = alltrue([for statement in data.aws_iam_policy_document.cache_assume_role.statement : alltrue([for condition in statement.condition :
      condition.variable == "token.actions.githubusercontent.com:sub" ? toset(condition.values) == toset(["repo:forker@3/mcc-stats-suite@4:environment:dev", "repo:forker@3/mcc-stats-suite@4:ref:refs/heads/main"]) :
      condition.variable == "token.actions.githubusercontent.com:repository" ? toset(condition.values) == toset(["forker/mcc-stats-suite"]) : true
    ])])
    error_message = "A fork's cache role trusts only the fork, never upstream."
  }
  assert {
    condition = length(aws_iam_role.github_cache_read) == 1 && alltrue([for statement in data.aws_iam_policy_document.cache_read_assume_role.statement : alltrue([for condition in statement.condition :
      condition.variable == "token.actions.githubusercontent.com:sub" ? toset(condition.values) == toset(["repo:forker@3/mcc-stats-suite@4:pull_request"]) :
      condition.variable == "token.actions.githubusercontent.com:repository" ? toset(condition.values) == toset(["forker/mcc-stats-suite"]) : true
    ])])
    error_message = "A fork's read-only cache role trusts only the fork's pull requests, never upstream."
  }
}

run "mutable_subject_trusts_the_same_repository" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables {
    environment                    = "prod"
    create_github_cache_role       = true
    github_oidc_subject_repository = "forker/mcc-stats-suite"
  }
  assert {
    condition = length(aws_iam_role.github_cache) == 1 && alltrue([for statement in data.aws_iam_policy_document.cache_assume_role.statement : alltrue([for condition in statement.condition :
      condition.variable == "token.actions.githubusercontent.com:sub" ? toset(condition.values) == toset(["repo:forker/mcc-stats-suite:environment:prod"]) :
      condition.variable == "token.actions.githubusercontent.com:repository" ? toset(condition.values) == toset(["forker/mcc-stats-suite"]) : true
    ])])
    error_message = "A subject without immutable IDs names the repository directly."
  }
}

run "missing_subject_gets_no_github_cache_role" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables {
    environment                    = "dev"
    create_github_cache_role       = true
    github_oidc_subject_repository = null
  }
  override_resource {
    target = aws_s3_bucket.turbo_cache
    values = {
      id  = "mcc-stats-suite-dev-000000000000-turbo-cache"
      arn = "arn:aws:s3:::mcc-stats-suite-dev-000000000000-turbo-cache"
    }
  }
  assert {
    condition     = length(aws_iam_role.github_cache) == 0 && length(aws_iam_role_policy.github_cache) == 0 && length(aws_iam_role.github_cache_read) == 0 && length(aws_iam_role_policy.github_cache_read) == 0 && output.github_turbo_cache_role_arn == null
    error_message = "A foundation without a subject repository has no repository to trust and creates no cache role."
  }
  assert {
    condition     = alltrue([for statement in data.aws_iam_policy_document.turbo_cache_bucket.statement : alltrue([for condition in statement.condition : condition.variable != "aws:PrincipalArn"])])
    error_message = "Without the role, no principal may escape the bucket data/listing deny statements."
  }
}

# The ephemeral lifecycle does not read the environment, so one run covers dev and prod.
run "ephemeral_expiry" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables { environment = "dev" }

  override_resource {
    target = aws_s3_bucket.attachments
    values = { id = "test-attachments" }
  }

  override_resource {
    target = aws_s3_bucket.output
    values = { id = "test-output" }
  }

  override_resource {
    target = aws_s3_bucket.evidence
    values = { id = "test-evidence" }
  }

  assert {
    condition = (
      aws_s3_bucket_lifecycle_configuration.ephemeral["attachments"].bucket == "test-attachments" &&
      aws_s3_bucket_lifecycle_configuration.ephemeral["output"].bucket == "test-output" &&
      aws_s3_bucket_lifecycle_configuration.ephemeral["evidence"].bucket == "test-evidence" &&
      alltrue([for name, lifecycle in aws_s3_bucket_lifecycle_configuration.ephemeral :
        length(lifecycle.rule) == 2 && alltrue([for rule in lifecycle.rule :
          rule.status == "Enabled" && rule.filter[0].prefix == "ephemeral/" && (rule.id == "expire-ephemeral" ?
            rule.expiration[0].days == (name == "evidence" ? 366 : 30) &&
            rule.noncurrent_version_expiration[0].noncurrent_days == 30 &&
            rule.abort_incomplete_multipart_upload[0].days_after_initiation == 7 :
            rule.id == "remove-ephemeral-delete-markers" && rule.expiration[0].expired_object_delete_marker
          )
        ])
      ])
    )
    error_message = "Only ephemeral/ objects may expire: attachments and output after 30 days, evidence after its 365-day lock, with delete-marker and multipart cleanup."
  }
}
