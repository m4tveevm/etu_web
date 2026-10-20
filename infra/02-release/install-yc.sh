#!/usr/bin/env bash
set -euo pipefail
# Official vendor binary, fixed version and verified digest. No shell profile changes.
destination="${RUNNER_TEMP:-/tmp}/etu-web-tools"
mkdir -p "$destination"
curl --fail --silent --show-error --location --retry 3 \
  https://storage.yandexcloud.net/yandexcloud-yc/release/1.41.0/linux/amd64/yc \
  --output "$destination/yc"
printf '%s  %s\n' 7231c18ab1553fc1ac2a8157cad8b230156b08c2c7852509a7bd765efcd27956 "$destination/yc" | sha256sum --check
chmod 700 "$destination/yc"
if [[ -n "${GITHUB_PATH:-}" ]]; then printf '%s\n' "$destination" >> "$GITHUB_PATH"; fi
