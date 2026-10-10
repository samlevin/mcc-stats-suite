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
      aws_ssm_parameter.turbo_cache_bucket_name.name == "/mcc/dev/turbo-cache/bucket-name" &&
      output.turbo_cache_key_arn == aws_ssm_parameter.turbo_cache_key_arn.value &&
      output.turbo_cache_key_arn == aws_kms_key.data.arn &&
      aws_ssm_parameter.turbo_cache_key_arn.name == "/mcc/dev/turbo-cache/data-key-arn"
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
      aws_ssm_parameter.turbo_cache_bucket_name.name == "/mcc/prod/turbo-cache/bucket-name" &&
      aws_ssm_parameter.turbo_cache_key_arn.name == "/mcc/prod/turbo-cache/data-key-arn" &&
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
    github_oidc_subject_repository = "owner@1/repository@2"
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
        condition.variable == "token.actions.githubusercontent.com:sub" ? toset(condition.values) == toset(["repo:owner@1/repository@2:environment:dev", "repo:owner@1/repository@2:ref:refs/heads/main"]) :
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
      statement.sid == "ReadCacheContracts" ? statement.actions == toset(["ssm:GetParameter"]) && statement.resources == toset([for name in ["bucket-name", "data-key-arn"] : "arn:aws:ssm:us-east-1:000000000000:parameter/mcc/dev/turbo-cache/${name}"]) :
      statement.sid == "UseCacheKeyThroughS3" && statement.actions == toset(["kms:Decrypt", "kms:GenerateDataKey"]) && length(statement.condition) == 2
    ])
    error_message = "The action needs prefix-scoped listing/read/write and multipart abort, without deletion or bucket-wide access."
  }
}

run "prod_github_cache_role" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables {
    environment                    = "prod"
    create_github_cache_role       = true
    github_oidc_subject_repository = "owner@1/repository@2"
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
        condition.variable == "token.actions.githubusercontent.com:sub" ? toset(condition.values) == toset(["repo:owner@1/repository@2:environment:prod"]) :
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
      statement.sid == "ReadCacheContracts" ? statement.actions == toset(["ssm:GetParameter"]) && statement.resources == toset([for name in ["bucket-name", "data-key-arn"] : "arn:aws:ssm:us-east-1:000000000000:parameter/mcc/prod/turbo-cache/${name}"]) :
      statement.sid == "UseCacheKeyThroughS3" && statement.actions == toset(["kms:Decrypt", "kms:GenerateDataKey"]) && length(statement.condition) == 2
    ])
    error_message = "The action needs prefix-scoped listing/read/write and multipart abort, without deletion or bucket-wide access."
  }
}
