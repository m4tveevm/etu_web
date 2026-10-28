#!/usr/bin/env python3
"""Upload an immutable static release; default mode only validates local files."""
import argparse
import base64
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess


def verify(directory):
    raw = (directory / 'manifest.json').read_bytes()
    manifest = json.loads(raw)
    if (not isinstance(manifest, dict) or type(manifest.get('schemaVersion')) is not int
            or manifest['schemaVersion'] != 2 or not isinstance(manifest.get('releaseId'), str)
            or not re.fullmatch(r'[0-9a-f]{40}', manifest['releaseId'])):
        raise ValueError('Invalid manifest identity')
    if 'quoteAccess' not in manifest or manifest['quoteAccess'] not in ('public', 'admin', None):
        raise ValueError('Invalid quote access')
    if not isinstance(manifest.get('files'), list):
        raise ValueError('Invalid manifest files')
    seen = set()
    access = {}
    for entry in manifest['files']:
        if not isinstance(entry, dict) or entry.get('access') not in ('public', 'admin'):
            raise ValueError('Invalid file access')
        name = entry.get('path')
        if not isinstance(name, str) or not name:
            raise ValueError('Invalid manifest path')
        path = PurePosixPath(name)
        if (path.is_absolute() or '..' in path.parts or '\\' in name or path.as_posix() != name
                or name in seen or name == 'manifest.json'):
            raise ValueError('Invalid or duplicate manifest path')
        seen.add(name)
        access[name] = entry['access']
        if (type(entry.get('size')) is not int or entry['size'] < 0
                or not isinstance(entry.get('sha256'), str)
                or not re.fullmatch(r'[0-9a-f]{64}', entry['sha256'])
                or not isinstance(entry.get('contentType'), str) or not entry['contentType']):
            raise ValueError('Invalid file metadata')
        source = directory / name
        if source.is_symlink() or not source.resolve().is_relative_to(directory.resolve()):
            raise ValueError('Unsafe source path')
        data = source.read_bytes()
        if len(data) != entry['size'] or len(data) > 2_200_000 or hashlib.sha256(data).hexdigest() != entry['sha256']:
            raise ValueError(f'Artifact integrity failure: {name}')
    if access.get('index.html') != 'public' or access.get('admin/index.html') != 'admin':
        raise ValueError('Invalid catalogue access')
    quote_access = manifest['quoteAccess']
    quote_files = {'quote.js', 'quote-contract.mjs', 'lab-07/assets/reading-night.webp'}
    if quote_access is not None and any(access.get(name) != quote_access for name in quote_files):
        raise ValueError('Quote files must match quote access')
    for name, policy in access.items():
        if name in quote_files or name.startswith(('lab-07/', 'view/lab-07/')):
            if policy != quote_access:
                raise ValueError('Lab 7 files must match quote access')
    actual = {p.relative_to(directory).as_posix() for p in directory.rglob('*') if p.is_file()}
    if actual != seen | {'manifest.json'}:
        raise ValueError('Artifact contains files absent from manifest')
    return manifest, hashlib.sha256(raw).hexdigest()


def yc(arguments, missing_ok=False):
    result = subprocess.run(['yc', 'storage', 's3api', *arguments, '--format', 'json', '--no-browser'],
                            check=False, capture_output=True, text=True)
    if result.returncode:
        if missing_ok and re.search(r'NoSuchKey|NotFound|Not Found|status code: 404', result.stderr):
            return None
        # Raw CLI errors can contain credential context. Keep them out of CI logs.
        raise RuntimeError(f'Object Storage operation failed: {arguments[0]}')
    return json.loads(result.stdout or '{}')


def publish(directory, bucket, runner=yc):
    manifest, digest = verify(directory)
    release = manifest['releaseId']
    entries = sorted(manifest['files'], key=lambda e: (e['path'].endswith('.html'), e['path']))
    entries.append({'path': 'manifest.json', 'size': (directory / 'manifest.json').stat().st_size,
                    'sha256': digest, 'contentType': 'application/json'})
    for entry in entries:
        # Concurrent builds of one Git commit cannot overwrite one another.
        # Equal manifest digests imply equal verified content for every path.
        key = f"releases/{release}/{digest}/{entry['path']}"
        source = directory / entry['path']
        md5 = base64.b64encode(hashlib.md5(source.read_bytes()).digest()).decode('ascii')
        expected_etag = hashlib.md5(source.read_bytes()).hexdigest()
        current = runner(['head-object', '--bucket', bucket, '--key', key], missing_ok=True)
        if current is not None:
            if int(current.get('content_length', -1)) != entry['size'] or current.get('etag', '').strip('"') != expected_etag:
                raise RuntimeError(f'Immutable release collision: {key}')
            continue
        runner(['put-object', '--bucket', bucket, '--key', key, '--body', str(source),
                '--content-type', entry['contentType'], '--cache-control', 'private, no-store',
                '--content-md5', md5, '--metadata', f"sha256={entry['sha256']}"])
        check = runner(['head-object', '--bucket', bucket, '--key', key])
        if int(check.get('content_length', -1)) != entry['size'] or check.get('etag', '').strip('"') != expected_etag:
            raise RuntimeError(f'Upload verification failed: {key}')
    return {'releaseId': release, 'manifestSha256': digest,
            'prefix': f'releases/{release}/{digest}/', 'files': len(entries) - 1}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True, type=Path)
    parser.add_argument('--bucket')
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if args.execute:
        if not args.bucket or not re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', args.bucket):
            parser.error('--execute requires a valid --bucket')
        result = publish(args.directory, args.bucket)
    else:
        manifest, digest = verify(args.directory)
        result = {'mode': 'validate-only', 'releaseId': manifest['releaseId'], 'manifestSha256': digest}
    print(json.dumps(result))
