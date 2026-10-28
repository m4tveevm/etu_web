variable "foundation" {
  description = "The foundation release_config output, with no secret values."
  type = object({
    cloud_id                   = string
    folder_id                  = string
    hostname                   = string
    name_prefix                = string
    static_bucket              = string
    gate_service_account_id    = string
    gateway_service_account_id = string
    quote_service_account_id   = string
    release_service_account_id = string
    gate_secret_id             = string
    certificate_id             = string
  })

  validation {
    condition = alltrue([for id in [
      var.foundation.cloud_id, var.foundation.folder_id,
      var.foundation.gate_service_account_id, var.foundation.gateway_service_account_id,
      var.foundation.quote_service_account_id, var.foundation.release_service_account_id,
      var.foundation.gate_secret_id, var.foundation.certificate_id
    ] : can(regex("^[a-z0-9]{20}$", id))])
    error_message = "Export real resource IDs from foundation; empty or placeholder IDs are invalid."
  }

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]*[a-z0-9]$", var.foundation.hostname)) && !strcontains(var.foundation.hostname, "..") && strcontains(var.foundation.hostname, ".")
    error_message = "The hostname must be a lowercase DNS name without a scheme or path."
  }
}

variable "release_id" {
  description = "Full Git SHA of the built, tested release."
  type        = string
  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.release_id))
    error_message = "Use the full 40-character lowercase Git SHA."
  }
}

variable "release_manifest_sha256" {
  description = "SHA-256 of the exact uploaded manifest.json bytes, not an ETag."
  type        = string
  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.release_manifest_sha256))
    error_message = "Use the actual 64-character lowercase SHA-256 digest."
  }
}

variable "gate_zip_path" {
  description = "Local path to the verified services/gate release archive."
  type        = string
}

variable "gate_zip_sha256" {
  description = "Expected SHA-256 from the verified gate artifact."
  type        = string
  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.gate_zip_sha256))
    error_message = "Use the actual 64-character lowercase gate archive SHA-256."
  }
}

variable "quote_zip_path" {
  description = "Local path to the verified services/quotes release archive."
  type        = string
}

variable "quote_zip_sha256" {
  description = "Expected SHA-256 from the verified quote artifact."
  type        = string
  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.quote_zip_sha256))
    error_message = "Use the actual 64-character lowercase archive SHA-256."
  }
}

variable "gate_secret_version_id" {
  description = "Actual Lockbox version with OIDC_CLIENT_SECRET and GATE_COOKIE_KEY; never payload."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9]{20}$", var.gate_secret_version_id))
    error_message = "Use an existing 20-character Lockbox version ID."
  }
}

variable "oidc_client_id" {
  description = "Dedicated confidential UpdSpace ID client, registered for the exact public callback."
  type        = string
  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{1,64}$", var.oidc_client_id))
    error_message = "Supply the real OIDC client ID (1–64 letters, digits, underscores or hyphens)."
  }
}

variable "allowed_subjects" {
  description = "Explicit issuer/sub pairs from UpdSpace ID. Empty denies everyone; email is never an identity key."
  type = list(object({
    issuer = string
    sub    = string
  }))
  default   = []
  sensitive = true
  validation {
    condition = length(var.allowed_subjects) <= 100 && alltrue([for identity in var.allowed_subjects :
      identity.issuer == "https://id.updspace.com" &&
      length(identity.sub) > 0 && length(identity.sub) <= 256 && identity.sub == trimspace(identity.sub)
    ])
    error_message = "Use up to 100 exact issuer/sub pairs; subjects must contain 1–256 characters without surrounding spaces."
  }
}

locals {
  # 62 characters; the tag changes with the code artifact, including rebuilds of one Git SHA.
  # The full digest and the actual function version are recorded in release_tuple.
  quote_tag = "quote-${substr(var.quote_zip_sha256, 0, 56)}"
  labels = {
    project    = "etu-web"
    managed_by = "terraform"
    stage      = "release"
  }
}
