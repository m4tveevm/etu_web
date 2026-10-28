output "hostname" {
  value = var.hostname
}

output "public_origin" {
  value = "https://${var.hostname}"
}

output "static_bucket" {
  value = yandex_storage_bucket.static.bucket
}

output "gate_service_account_id" {
  value = yandex_iam_service_account.gate.id
}

output "gateway_service_account_id" {
  value = yandex_iam_service_account.gateway.id
}

output "quote_service_account_id" {
  value = yandex_iam_service_account.quote.id
}

output "release_service_account_id" {
  value = yandex_iam_service_account.release.id
}

output "gate_secret_id" {
  value = yandex_lockbox_secret.gate.id
}

output "release_prefix" {
  value = "releases/"
}

output "certificate_dns_challenges" {
  description = "Create only these challenge records in the existing DNS zone."
  value = [for challenge in yandex_cm_certificate.site.challenges : {
    name  = challenge.dns_name
    type  = challenge.dns_type
    value = challenge.dns_value
  }]
}

output "release_config" {
  description = "Non-secret inputs for runtime; export this instead of sharing foundation state."
  value = {
    cloud_id                   = var.cloud_id
    folder_id                  = var.folder_id
    hostname                   = var.hostname
    name_prefix                = var.name_prefix
    static_bucket              = yandex_storage_bucket.static.bucket
    gate_service_account_id    = yandex_iam_service_account.gate.id
    gateway_service_account_id = yandex_iam_service_account.gateway.id
    quote_service_account_id   = yandex_iam_service_account.quote.id
    release_service_account_id = yandex_iam_service_account.release.id
    gate_secret_id             = yandex_lockbox_secret.gate.id
    certificate_id             = yandex_cm_certificate.site.id
  }
}
