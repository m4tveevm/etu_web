resource "yandex_function" "quote" {
  folder_id          = var.foundation.folder_id
  name               = "${var.foundation.name_prefix}-quote"
  description        = "Private versioned quote API, invoked only by the authenticated gate."
  labels             = local.labels
  runtime            = "nodejs22"
  entrypoint         = "index.handler"
  memory             = 128
  execution_timeout  = "5"
  concurrency        = 1
  service_account_id = var.foundation.quote_service_account_id
  user_hash          = var.quote_zip_sha256
  tags               = [local.quote_tag]

  content {
    zip_filename = var.quote_zip_path
  }

  log_options {
    min_level = "WARN"
  }

  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = try(filesha256(var.quote_zip_path), "") == var.quote_zip_sha256
      error_message = "The quote archive must exist locally and match its recorded digest."
    }
  }
}

resource "yandex_function_iam_binding" "gate_invokes_quote" {
  function_id = yandex_function.quote.id
  role        = "functions.functionInvoker"
  members     = ["serviceAccount:${var.foundation.gate_service_account_id}"]
}

locals {
  gate_environment = {
    PUBLIC_ORIGIN           = "https://${var.foundation.hostname}"
    OIDC_ISSUER             = "https://id.updspace.com"
    OIDC_CLIENT_ID          = var.oidc_client_id
    OIDC_ALLOWED_SUBJECTS   = jsonencode(var.allowed_subjects)
    STATIC_BUCKET           = var.foundation.static_bucket
    RELEASE_ID              = var.release_id
    RELEASE_MANIFEST_SHA256 = var.release_manifest_sha256
    QUOTE_FUNCTION_URL      = "https://functions.yandexcloud.net/${yandex_function.quote.id}?tag=${local.quote_tag}"
  }
  gate_secret_keys = ["OIDC_CLIENT_SECRET", "GATE_COOKIE_KEY"]
  gate_revision = {
    zip_sha256           = var.gate_zip_sha256
    runtime              = "nodejs22"
    entrypoint           = "index.handler"
    memory               = 256
    concurrency          = 8
    execution_timeout    = "30"
    service_account_id   = var.foundation.gate_service_account_id
    environment          = local.gate_environment
    secret_id            = var.foundation.gate_secret_id
    secret_version_id    = var.gate_secret_version_id
    secret_keys          = local.gate_secret_keys
    gce_http_endpoint    = 1
    aws_v1_http_endpoint = 2
    log_min_level        = "WARN"
  }
  # Only the final digest is declassified. Raw subjects and environment stay sensitive.
  # A code, allowlist, client, release or secret-version change gets a different tag.
  gate_revision_sha256 = nonsensitive(sha256(jsonencode(local.gate_revision)))
  gate_tag             = "gate-${substr(local.gate_revision_sha256, 0, 58)}"
}

resource "yandex_function" "gate" {
  folder_id          = var.foundation.folder_id
  name               = "${var.foundation.name_prefix}-gate"
  description        = "OIDC gate for every lab, asset, report and quote response."
  labels             = local.labels
  runtime            = local.gate_revision.runtime
  entrypoint         = local.gate_revision.entrypoint
  memory             = local.gate_revision.memory
  concurrency        = local.gate_revision.concurrency
  execution_timeout  = local.gate_revision.execution_timeout
  service_account_id = local.gate_revision.service_account_id
  environment        = local.gate_environment
  user_hash          = local.gate_revision_sha256
  tags               = [local.gate_tag]

  content {
    zip_filename = var.gate_zip_path
  }

  dynamic "secrets" {
    for_each = toset(local.gate_secret_keys)
    content {
      id                   = var.foundation.gate_secret_id
      version_id           = var.gate_secret_version_id
      key                  = secrets.value
      environment_variable = secrets.value
    }
  }

  metadata_options {
    gce_http_endpoint    = local.gate_revision.gce_http_endpoint
    aws_v1_http_endpoint = local.gate_revision.aws_v1_http_endpoint
  }

  log_options {
    min_level = local.gate_revision.log_min_level
  }

  depends_on = [yandex_function_iam_binding.gate_invokes_quote]

  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = try(filesha256(var.gate_zip_path), "") == var.gate_zip_sha256
      error_message = "The gate archive must exist locally and match its recorded digest."
    }
  }
}

resource "yandex_function_iam_binding" "gateway_invokes_gate" {
  function_id = yandex_function.gate.id
  role        = "functions.functionInvoker"
  members     = ["serviceAccount:${var.foundation.gateway_service_account_id}"]
}
