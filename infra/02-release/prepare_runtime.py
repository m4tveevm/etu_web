#!/usr/bin/env python3
"""Bind a verified artifact to explicit runtime settings, without secret payloads."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path

spec = importlib.util.spec_from_file_location('upload', Path(__file__).with_name('upload.py'))
upload = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upload)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True, type=Path)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--gate-zip', required=True, type=Path)
    parser.add_argument('--quote-zip', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    manifest, digest = upload.verify(args.directory)
    config = json.loads(args.config.read_text())
    required = {'foundation', 'gate_secret_version_id', 'oidc_client_id', 'allowed_subjects'}
    if set(config) != required or not config['allowed_subjects']:
        parser.error('Runtime config must contain foundation, secret version ID, client ID and a non-empty subject allowlist')
    result = {**config, 'release_id': manifest['releaseId'], 'release_manifest_sha256': digest,
              'gate_zip_path': str(args.gate_zip.resolve()),
              'gate_zip_sha256': hashlib.sha256(args.gate_zip.read_bytes()).hexdigest(),
              'quote_zip_path': str(args.quote_zip.resolve()),
              'quote_zip_sha256': hashlib.sha256(args.quote_zip.read_bytes()).hexdigest()}
    with os.fdopen(os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as output:
        output.write(json.dumps(result, indent=2) + '\n')
    print(f"Runtime variables prepared for release {manifest['releaseId']}")
