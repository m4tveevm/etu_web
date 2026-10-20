variable "cloud_id" {
  description = "Existing Yandex Cloud ID, supplied explicitly by the operator."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]{20}$", var.cloud_id))
    error_message = "Supply the actual 20-character cloud ID."
  }
}

variable "folder_id" {
  description = "Existing folder approved for this project's new resources."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]{20}$", var.folder_id))
    error_message = "Supply the actual 20-character folder ID."
  }
}

variable "hostname" {
  description = "Only the new site's hostname; the foundation does not change DNS."
  type        = string
  default     = "labs.spbetu.ru"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]*[a-z0-9]$", var.hostname)) && !strcontains(var.hostname, "..") && strcontains(var.hostname, ".")
    error_message = "Supply a lowercase hostname without a scheme, path, port or trailing dot."
  }
}

variable "name_prefix" {
  description = "Unique prefix for new resources; never use the LK or promo prefix."
  type        = string
  default     = "etu-web-prod"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,29}$", var.name_prefix))
    error_message = "Use 3–30 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "static_bucket_name" {
  description = "Optional globally unique bucket name. Default: prefix plus folder ID."
  type        = string
  default     = null

  validation {
    condition     = var.static_bucket_name == null || can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.static_bucket_name))
    error_message = "Use a 3–63 character lowercase bucket name without dots."
  }
}

variable "static_bucket_max_size" {
  description = "Maximum storage size in bytes, including retained releases."
  type        = number
  default     = 1073741824

  validation {
    condition     = var.static_bucket_max_size >= 104857600 && floor(var.static_bucket_max_size) == var.static_bucket_max_size
    error_message = "Use a whole number of bytes, at least 100 MiB."
  }
}

locals {
  bucket_name = coalesce(var.static_bucket_name, "${var.name_prefix}-${var.folder_id}")
  labels = {
    project    = "etu-web"
    managed_by = "terraform"
    stage      = "foundation"
  }
}
