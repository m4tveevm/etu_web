resource "yandex_lockbox_secret" "gate" {
  folder_id           = var.folder_id
  name                = "${var.name_prefix}-gate"
  description         = "Metadata only. Bootstrap supplies OIDC_CLIENT_SECRET and GATE_COOKIE_KEY."
  labels              = local.labels
  deletion_protection = true

  lifecycle {
    prevent_destroy = true
  }
}

resource "yandex_lockbox_secret_iam_member" "gate_payload" {
  secret_id = yandex_lockbox_secret.gate.id
  role      = "lockbox.payloadViewer"
  member    = "serviceAccount:${yandex_iam_service_account.gate.id}"
}

# No secret_version, password_payload_specification, random_password or secret data source.
# Runtime receives an explicit Lockbox version ID; it never reads the payload.
