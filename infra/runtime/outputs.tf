output "public_origin" {
  value = "https://${var.foundation.hostname}"
}

output "site_dns_record" {
  description = "Only this new subdomain record is required; keep Cloudflare proxy disabled."
  value = {
    name  = var.foundation.hostname
    type  = "CNAME"
    value = yandex_api_gateway.site.domain
  }
}

output "release_tuple" {
  description = "Record alongside the deployment evidence; contains identifiers and digests, no secret payload."
  value = {
    release_id             = var.release_id
    manifest_sha256        = var.release_manifest_sha256
    gate_zip_sha256        = var.gate_zip_sha256
    gate_revision_sha256   = local.gate_revision_sha256
    gate_function_id       = yandex_function.gate.id
    gate_version_id        = yandex_function.gate.version
    gate_tag               = local.gate_tag
    quote_function_id      = yandex_function.quote.id
    quote_version_id       = yandex_function.quote.version
    quote_tag              = local.quote_tag
    quote_zip_sha256       = var.quote_zip_sha256
    gate_secret_version_id = var.gate_secret_version_id
    gateway_id             = yandex_api_gateway.site.id
    gateway_domain         = yandex_api_gateway.site.domain
    oidc_client_id         = var.oidc_client_id
  }
}
