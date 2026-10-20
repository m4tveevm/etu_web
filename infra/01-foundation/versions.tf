terraform {
  required_version = ">= 1.6.3, < 2.0.0"

  required_providers {
    yandex = {
      source  = "registry.terraform.io/yandex-cloud/yandex"
      version = "0.206.0"
    }
  }

  backend "s3" {}
}

provider "yandex" {
  cloud_id  = var.cloud_id
  folder_id = var.folder_id
  zone      = "ru-central1-a"
}
