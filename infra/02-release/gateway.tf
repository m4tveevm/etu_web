data "yandex_cm_certificate" "site" {
  certificate_id  = var.foundation.certificate_id
  wait_validation = false
}

locals {
  gate_integration = {
    type                   = "cloud_functions"
    function_id            = yandex_function.gate.id
    tag                    = local.gate_tag
    service_account_id     = var.foundation.gateway_service_account_id
    payload_format_version = "1.0"
  }
}

resource "yandex_api_gateway" "site" {
  folder_id         = var.foundation.folder_id
  name              = "${var.foundation.name_prefix}-site"
  description       = "TLS entrypoint; every path and method passes through the private gate."
  labels            = local.labels
  execution_timeout = "30"

  spec = yamlencode({
    openapi = "3.0.0"
    info    = { title = "ETU protected labs", version = "1.0.0" }
    paths = {
      "/" = {
        "x-yc-apigateway-any-method" = {
          "x-yc-apigateway-integration" = local.gate_integration
        }
      }
      "/{proxy+}" = {
        "x-yc-apigateway-any-method" = {
          "x-yc-apigateway-integration" = local.gate_integration
          parameters = [{
            in       = "path"
            name     = "proxy"
            required = false
            schema   = { type = "string", default = "-" }
            style    = "simple"
            explode  = false
          }]
        }
      }
    }
  })

  custom_domains {
    fqdn           = var.foundation.hostname
    certificate_id = var.foundation.certificate_id
  }

  # Generic request logs can contain OAuth callback query parameters.
  # The application emits only sanitized operational errors.
  log_options {
    disabled = true
  }

  depends_on = [yandex_function_iam_binding.gateway_invokes_gate]

  lifecycle {
    prevent_destroy = true
    precondition {
      condition = (contains(["ISSUED", "RENEWING"], data.yandex_cm_certificate.site.status) &&
      contains(data.yandex_cm_certificate.site.domains, var.foundation.hostname))
      error_message = "Validate the stage-01 certificate for this hostname before releasing."
    }
  }
}
