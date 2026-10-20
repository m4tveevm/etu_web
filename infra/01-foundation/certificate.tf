resource "yandex_cm_certificate" "site" {
  folder_id           = var.folder_id
  name                = "${var.name_prefix}-tls"
  description         = "TLS for the separate protected laboratory site."
  domains             = [var.hostname]
  labels              = local.labels
  deletion_protection = true

  managed {
    challenge_type = "DNS_CNAME"
  }

  lifecycle {
    prevent_destroy = true
  }
}
