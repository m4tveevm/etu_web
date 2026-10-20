resource "yandex_storage_bucket" "static" {
  folder_id     = var.folder_id
  bucket        = local.bucket_name
  force_destroy = false
  max_size      = var.static_bucket_max_size
  tags          = local.labels

  anonymous_access_flags {
    read        = false
    list        = false
    config_read = false
  }

  versioning {
    enabled = true
  }

  # Website hosting and public CORS are intentionally absent.
  # The browser only receives bytes after the gate checks its session.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "GateReadsReleaseObjects"
        Effect    = "Allow"
        Principal = { CanonicalUser = yandex_iam_service_account.gate.id }
        Action    = ["s3:GetObject"]
        Resource  = "arn:aws:s3:::${local.bucket_name}/releases/*"
      },
      {
        Sid       = "ReleaseVerifiesObjects"
        Effect    = "Allow"
        Principal = { CanonicalUser = yandex_iam_service_account.release.id }
        Action    = ["s3:GetObject"]
        Resource  = "arn:aws:s3:::${local.bucket_name}/releases/*"
      },
      {
        Sid       = "ReleaseUploadsWithoutObjectACL"
        Effect    = "Allow"
        Principal = { CanonicalUser = yandex_iam_service_account.release.id }
        Action    = ["s3:PutObject"]
        Resource  = "arn:aws:s3:::${local.bucket_name}/releases/*"
        # Object ACLs can bypass the bucket policy. Keep uploaded ACLs empty.
        Condition = {
          Null = {
            "s3:x-amz-acl"                = "true"
            "s3:x-amz-grant-read"         = "true"
            "s3:x-amz-grant-write"        = "true"
            "s3:x-amz-grant-read-acp"     = "true"
            "s3:x-amz-grant-write-acp"    = "true"
            "s3:x-amz-grant-full-control" = "true"
          }
        }
      },
      {
        Sid       = "ReleaseListsItsPrefix"
        Effect    = "Allow"
        Principal = { CanonicalUser = yandex_iam_service_account.release.id }
        Action    = ["s3:ListBucket"]
        Resource  = "arn:aws:s3:::${local.bucket_name}"
        Condition = { StringLike = { "s3:prefix" = ["releases/", "releases/*"] } }
      },
      {
        Sid       = "BucketManagement"
        Effect    = "Allow"
        Principal = { CanonicalUser = sort(tolist(var.bucket_management_principal_ids)) }
        Action    = ["s3:*"]
        Resource = [
          "arn:aws:s3:::${local.bucket_name}",
          "arn:aws:s3:::${local.bucket_name}/*"
        ]
      }
    ]
  })

  lifecycle {
    prevent_destroy = true

    precondition {
      condition = !contains(var.bucket_management_principal_ids, yandex_iam_service_account.gate.id) && !contains(
        var.bucket_management_principal_ids, yandex_iam_service_account.release.id
      )
      error_message = "Gate and release accounts must not be bucket management principals."
    }
  }
}

# YC checks IAM or bucket ACL before evaluating the restrictive bucket policy.
# These bindings grant only the base permissions on this bucket, not the folder.
resource "yandex_storage_bucket_iam_binding" "gate_reader" {
  bucket  = yandex_storage_bucket.static.bucket
  role    = "storage.viewer"
  members = ["serviceAccount:${yandex_iam_service_account.gate.id}"]
}

resource "yandex_storage_bucket_iam_binding" "release_uploader" {
  bucket  = yandex_storage_bucket.static.bucket
  role    = "storage.uploader"
  members = ["serviceAccount:${yandex_iam_service_account.release.id}"]
}
