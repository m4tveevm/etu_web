#!/usr/bin/env python3
"""Unauthenticated smoke check; does not stand in for an authenticated browser test."""
import sys
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


origin = sys.argv[1].rstrip('/')
if urllib.parse.urlsplit(origin).scheme != 'https':
    raise SystemExit('HTTPS is required')
opener = urllib.request.build_opener(NoRedirect)
for path in ('/', '/lab-07/media.html', '/lab-01/report/report.pdf', '/quote.js', '/api/v1/quote'):
    try:
        response = opener.open(origin + path, timeout=15)
        status, headers = response.status, response.headers
        response.close()
    except urllib.error.HTTPError as error:
        status, headers = error.code, error.headers
    if status not in (302, 303, 401):
        raise SystemExit(f'Unexpected anonymous response: {path} status={status}')
    if status in (302, 303) and headers.get('Location') != '/auth/login':
        raise SystemExit(f'Unexpected login redirect: {path}')
    print(f'Anonymous access denied: {path} status={status}')
