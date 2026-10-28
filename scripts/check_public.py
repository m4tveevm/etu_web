#!/usr/bin/env python3
"""Check anonymous access against the deployed site's manifest."""
import argparse
import json
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def checks(manifest):
    if manifest.get('schemaVersion') != 2:
        raise ValueError('Manifest schemaVersion must be 2')
    yield 'GET', '/', 200
    yield 'HEAD', '/admin/index.html', 401
    statuses = {'public': 200, 'admin': 401}
    for entry in manifest['files']:
        if entry.get('access') not in statuses:
            raise ValueError(f"Invalid access policy: {entry['path']}")
        path = '/' + urllib.parse.quote(entry['path'], safe='/')
        if path != '/admin/index.html':
            yield 'HEAD', path, statuses[entry['access']]
    if 'quoteAccess' not in manifest or manifest['quoteAccess'] not in (*statuses, None):
        raise ValueError('Invalid quoteAccess policy')
    yield 'GET', '/api/v1/quote', statuses.get(manifest['quoteAccess'], 404)


def check(origin, manifest, opener=None):
    cases = list(checks(manifest))
    opener = opener or urllib.request.build_opener(NoRedirect)
    for method, path, expected in cases:
        request = urllib.request.Request(origin + path, method=method)
        try:
            with opener.open(request, timeout=15) as response:
                status = response.status
        except urllib.error.HTTPError as error:
            status = error.code
            error.close()
        if status != expected:
            raise ValueError(f'{method} {path}: expected {expected}, got {status}')
        print(f'{method} {path}: {status}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('origin')
    parser.add_argument('--directory', type=Path, default=Path('dist/site'))
    args = parser.parse_args()
    origin = urllib.parse.urlsplit(args.origin)
    if (origin.scheme != 'https' or not origin.netloc or origin.username
            or origin.path not in ('', '/') or origin.query or origin.fragment):
        parser.error('Use an HTTPS origin without a path, credentials or query')
    manifest = json.loads((args.directory / 'manifest.json').read_text())
    try:
        check(args.origin.rstrip('/'), manifest)
    except (ValueError, urllib.error.URLError) as error:
        raise SystemExit(str(error)) from None


if __name__ == '__main__':
    main()
