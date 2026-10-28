# Synthetic IDs are local test fixtures. The mocked provider cannot call YC.
mock_provider "yandex" {}

override_resource {
  target = yandex_iam_service_account.gate
  values = { id = "gggggggggggggggggggg" }
}

override_resource {
  target = yandex_iam_service_account.release
  values = { id = "rrrrrrrrrrrrrrrrrrrr" }
}

variables {
  cloud_id                        = "aaaaaaaaaaaaaaaaaaaa"
  folder_id                       = "bbbbbbbbbbbbbbbbbbbb"
  bucket_management_principal_ids = ["mmmmmmmmmmmmmmmmmmmm"]
}

run "restricted_storage_access" {
  command = plan

  assert {
    condition = (
      yandex_storage_bucket_iam_binding.gate_reader.role == "storage.viewer" &&
      yandex_storage_bucket_iam_binding.release_uploader.role == "storage.uploader" &&
      yandex_storage_bucket_iam_binding.gate_reader.bucket == yandex_storage_bucket.static.bucket &&
      yandex_storage_bucket_iam_binding.release_uploader.bucket == yandex_storage_bucket.static.bucket &&
      yandex_storage_bucket_iam_binding.gate_reader.members == toset(["serviceAccount:gggggggggggggggggggg"]) &&
      yandex_storage_bucket_iam_binding.release_uploader.members == toset(["serviceAccount:rrrrrrrrrrrrrrrrrrrr"])
    )
    error_message = "Gate and release must receive only their bucket-scoped reader/uploader roles."
  }

  assert {
    condition = alltrue([
      for rule in jsondecode(yandex_storage_bucket.static.policy).Statement : (
        rule.Effect == "Allow" &&
        alltrue([for action in rule.Action : contains(["s3:GetObject", "s3:PutObject", "s3:ListBucket"], action)]) &&
        (contains(rule.Action, "s3:ListBucket") ? (
          rule.Resource == "arn:aws:s3:::${yandex_storage_bucket.static.bucket}" &&
          toset(rule.Condition.StringLike["s3:prefix"]) == toset(["releases/", "releases/*"])
          ) : (
          rule.Resource == "arn:aws:s3:::${yandex_storage_bucket.static.bucket}/releases/*"
        )) &&
        (rule.Principal.CanonicalUser != "gggggggggggggggggggg" || rule.Action == ["s3:GetObject"])
      ) if rule.Sid != "BucketManagement"
    ])
    error_message = "Runtime accounts must not gain access outside releases/, delete rights or bucket management."
  }

  assert {
    condition = alltrue([
      for rule in jsondecode(yandex_storage_bucket.static.policy).Statement : (
        toset(keys(rule.Condition.Null)) == toset([
          "s3:x-amz-acl", "s3:x-amz-grant-read", "s3:x-amz-grant-write",
          "s3:x-amz-grant-read-acp", "s3:x-amz-grant-write-acp", "s3:x-amz-grant-full-control"
        ]) && alltrue([for value in values(rule.Condition.Null) : value == "true"])
      ) if contains(rule.Action, "s3:PutObject")
      ]) && length([
      for rule in jsondecode(yandex_storage_bucket.static.policy).Statement : rule
      if contains(rule.Action, "s3:PutObject")
    ]) == 1
    error_message = "PUT must reject every object-ACL header, including explicit grant headers."
  }

  assert {
    condition = length([
      for rule in jsondecode(yandex_storage_bucket.static.policy).Statement : rule
      if rule.Principal.CanonicalUser == "rrrrrrrrrrrrrrrrrrrr" && rule.Action == ["s3:GetObject"] && !can(rule.Condition)
    ]) == 1
    error_message = "Release verification GET must be separate from PUT's ACL conditions."
  }

  assert {
    condition = length([
      for rule in jsondecode(yandex_storage_bucket.static.policy).Statement : rule
      if rule.Sid == "BucketManagement" &&
      toset(rule.Principal.CanonicalUser) == toset(var.bucket_management_principal_ids) &&
      rule.Action == ["s3:*"] && toset(rule.Resource) == toset([
        "arn:aws:s3:::${yandex_storage_bucket.static.bucket}",
        "arn:aws:s3:::${yandex_storage_bucket.static.bucket}/*"
      ])
    ]) == 1
    error_message = "Bucket management must be limited to the explicit operator subject IDs."
  }
}

run "missing_management_principals_rejected" {
  command = plan
  variables {
    bucket_management_principal_ids = []
  }
  expect_failures = [var.bucket_management_principal_ids]
}

run "wildcard_management_principal_rejected" {
  command = plan
  variables {
    bucket_management_principal_ids = ["*"]
  }
  expect_failures = [var.bucket_management_principal_ids]
}

run "runtime_account_cannot_manage_bucket" {
  command = plan
  variables {
    bucket_management_principal_ids = ["gggggggggggggggggggg"]
  }
  expect_failures = [yandex_storage_bucket.static]
}
