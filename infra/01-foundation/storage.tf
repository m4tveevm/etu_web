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
        Sid       = "ReleaseUploadsAndVerifiesObjects"
        Effect    = "Allow"
        Principal = { CanonicalUser = yandex_iam_service_account.release.id }
        Action    = ["s3:PutObject", "s3:GetObject"]
        Resource  = "arn:aws:s3:::${local.bucket_name}/releases/*"
      },
      {
        Sid       = "ReleaseListsItsPrefix"
        Effect    = "Allow"
        Principal = { CanonicalUser = yandex_iam_service_account.release.id }
        Action    = ["s3:ListBucket"]
        Resource  = "arn:aws:s3:::${local.bucket_name}"
        Condition = { StringLike = { "s3:prefix" = ["releases/", "releases/*"] } }
      }
    ]
  })

  lifecycle {
    prevent_destroy = true
  }
}
