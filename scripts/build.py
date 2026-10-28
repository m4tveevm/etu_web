#!/usr/bin/env python3
"""Build an allowlisted static release. No cloud credentials are needed."""
import argparse
import hashlib
from html import escape
import json
import mimetypes
from html.parser import HTMLParser
from pathlib import Path
import re
from urllib.parse import urljoin, urlsplit, unquote

ROOT = Path(__file__).resolve().parents[1]
# Leaves room below Gateway's 2.5 MB body limit and the function's 3.5 MB
# JSON limit after base64 encoding binary files.
MAX_FILE_BYTES = 2_200_000
WEB_EXTENSIONS = {'.html', '.css', '.js', '.png', '.jpg', '.jpeg', '.svg', '.webp', '.ico'}


def load_labs(root):
    config = root / 'site/labs.json'
    if config.is_symlink() or not config.resolve().is_relative_to(root.resolve()):
        raise ValueError('Unsafe lab configuration path')
    labs = json.loads(config.read_text())
    if not isinstance(labs, list):
        raise ValueError('Lab configuration must be a list')
    result, seen = [], set()
    for item in labs:
        if not isinstance(item, dict) or set(item) - {'id', 'title', 'access', 'enabled', 'pages'}:
            raise ValueError('Unknown lab configuration fields')
        lab = item.get('id')
        if not isinstance(lab, str) or not re.fullmatch(r'lab-(?:0[1-9]|[1-9][0-9])', lab) or lab in seen:
            raise ValueError('Invalid or duplicate lab id')
        seen.add(lab)
        title = item.get('title')
        access, enabled = item.get('access', 'public'), item.get('enabled', True)
        if not isinstance(title, str) or not title.strip():
            raise ValueError(f'Invalid lab title: {lab}')
        if access not in ('public', 'admin') or type(enabled) is not bool:
            raise ValueError(f'Invalid access or enabled value: {lab}')
        pages = item.get('pages', [{'source': 'index.html', 'path': 'index.html', 'title': 'Основная страница'}])
        if not isinstance(pages, list) or not pages:
            raise ValueError(f'Invalid pages: {lab}')
        sources_seen, paths_seen = set(), set()
        for page in pages:
            if not isinstance(page, dict) or set(page) != {'source', 'path', 'title'}:
                raise ValueError(f'Invalid page fields: {lab}')
            for key, used in [('source', sources_seen), ('path', paths_seen)]:
                value = page[key]
                if (not isinstance(value, str) or not re.fullmatch(r'[a-zA-Z0-9_-]+\.html', value)
                        or value in used):
                    raise ValueError(f'Invalid or duplicate page {key}: {lab}')
                used.add(value)
            if not isinstance(page['title'], str) or not page['title'].strip():
                raise ValueError(f'Invalid page title: {lab}')
        if 'index.html' not in paths_seen:
            raise ValueError(f'Pages must include index.html: {lab}')
        if enabled:
            result.append({'id': lab, 'title': title, 'access': access, 'pages': pages})
    return result


def catalogue(template, labs, admin=False):
    cards = []
    for lab in labs:
        if not admin and lab['access'] != 'public':
            continue
        extra = [f'<a href="/view/{lab["id"]}/{page["path"]}">{escape(page["title"])}</a>'
                 for page in lab['pages'] if page['path'] != 'index.html']
        details = '<p>' + ' · '.join(extra) + '</p>' if extra else ''
        cards.append(f'<li><span>{lab["id"][-2:]}</span><h2><a href="/view/{lab["id"]}/">'
                     f'{escape(lab["title"])}</a></h2><a href="/{lab["id"]}/report/report.pdf">'
                     f'Отчёт PDF</a>{details}</li>')
    account = ('<form action="/auth/logout" method="post"><button type="submit">Выйти</button></form>'
               if admin else '<a class="login-button" href="/auth/login">Войти как администратор</a>')
    return template.replace('<!-- LABS -->', '\n        '.join(cards)).replace('<!-- ACCOUNT -->', account)


def viewers(labs):
    """The host owns navigation; lab documents remain independent inputs."""
    for item in labs:
        lab, title, access = item['id'], item['title'], item['access']
        number = int(lab[-2:])
        neighbours = [other for other in labs if access == 'admin' or other['access'] == 'public']
        index = neighbours.index(item)
        pages = item['pages']
        routes = {f'/{lab}/{page["source"]}': f'/view/{lab}/{page["path"]}' for page in pages}
        if f'/{lab}/index.html' in routes:
            routes[f'/{lab}/'] = routes[f'/{lab}/index.html']
        for page in pages:
            source, view, page_title = page['source'], page['path'], page['title']
            def neighbour(offset, label, css):
                pos = index + offset
                if not 0 <= pos < len(neighbours):
                    return f'<span class="{css}"></span>'
                target = neighbours[pos]
                return (f'<a class="{css}" href="/view/{target["id"]}/">'
                        f'{label}<span>ЛР{int(target["id"][-2:])} · {escape(target["title"])}</span></a>')
            tabs = ''
            if len(pages) > 1:
                links = [f'<a href="/view/{lab}/{other["path"]}"'
                         + (' aria-current="page"' if other['source'] == source else '')
                         + f'>{escape(other["title"])}</a>' for other in pages]
                tabs = '<nav class="viewer-pages" aria-label="Страницы работы">' + ''.join(links) + '</nav>'
            html = f'''<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ЛР{number} · {escape(title)}</title>
  <link rel="stylesheet" href="/viewer.css">
  <script src="/viewer.js" defer></script>
</head>
<body class="lab-viewer">
  <header class="viewer-header">
    <a class="viewer-back" href="/">← Все работы</a>
    <div class="viewer-heading"><small>Лабораторная работа {number}</small><h1>{escape(title)}</h1></div>
    <nav class="viewer-actions" aria-label="Материалы работы">
      <a href="/{lab}/report/report.pdf" target="_blank" rel="noopener">Отчёт PDF ↗</a>
      <a href="/{lab}/{source}" target="_blank" rel="noopener">Открыть отдельно ↗</a>
    </nav>
  </header>
  {tabs}
  <main id="viewer-main">
    <p id="viewer-status" role="status">Загрузка работы…</p>
    <noscript><p>Для просмотра без JavaScript <a href="/{lab}/{source}">откройте работу отдельно</a>.</p></noscript>
    <iframe id="lab-frame" src="/{lab}/{source}" title="ЛР{number}: {escape(page_title)}"
      data-pages="{escape(json.dumps(routes, ensure_ascii=False), quote=True)}"></iframe>
  </main>
  <footer class="viewer-footer"><nav aria-label="Переходы между работами">
    {neighbour(-1, '← Предыдущая', 'viewer-previous')}
    <a class="viewer-catalogue" href="/">К списку работ</a>
    {neighbour(1, 'Следующая →', 'viewer-next')}
  </nav></footer>
</body>
</html>
'''
            yield f'view/{lab}/{view}', html.encode(), access


def sources(root, labs):
    for item in labs:
        lab, access = root / item['id'], item['access']
        required = [lab / page['source'] for page in item['pages']] + [lab / 'report/report.pdf']
        if not all(path.is_file() for path in required):
            raise ValueError(f'Incomplete lab: {lab.name}')
        for path in sorted(lab.iterdir()):
            if path.is_file() and path.suffix in {'.html', '.css', '.js'}:
                yield path, path.relative_to(root).as_posix(), access
        for folder in ('assets', 'img'):
            for path in sorted((lab / folder).rglob('*')):
                if path.is_file() and path.suffix.lower() in WEB_EXTENSIONS:
                    if path.relative_to(root).as_posix() == 'lab-07/assets/reading-night.png':
                        continue
                    yield path, path.relative_to(root).as_posix(), access
        yield lab / 'report/report.pdf', f'{lab.name}/report/report.pdf', access
        if lab.name == 'lab-07':
            yield root / 'site/media/reading-night.webp', 'lab-07/assets/reading-night.webp', access
            yield root / 'site/quote.js', 'quote.js', access
            yield root / 'services/quotes/contract.mjs', 'quote-contract.mjs', access
    for name in ('catalogue.css', 'viewer.css', 'viewer.js'):
        yield root / 'site' / name, name, 'public'


def check_links(output, access=None):
    class References(HTMLParser):
        def __init__(self):
            super().__init__()
            self.urls = []

        def handle_starttag(self, tag, attrs):
            self.urls.extend(value for key, value in attrs if key in ('src', 'href') and value)

    for file in output.rglob('*'):
        if file.suffix not in ('.html', '.css', '.js', '.mjs'):
            continue
        text = file.read_text()
        if file.suffix == '.html':
            parser = References()
            parser.feed(text)
            references = parser.urls
        elif file.suffix == '.css':
            references = re.findall(r'url\([\"\']?([^\"\')]+)', text)
        else:
            references = re.findall(r"(?:from|import)\s*['\"]([^'\"]+)['\"]", text)
        base = 'https://artifact.invalid/' + file.relative_to(output).as_posix()
        for reference in references:
            url = urlsplit(urljoin(base, reference))
            if url.netloc != 'artifact.invalid' or url.path.startswith(('/auth/', '/api/')):
                continue
            path = unquote(url.path).lstrip('/')
            if path.endswith('/') or not path:
                path += 'index.html'
            destination = output / path
            if not destination.resolve().is_relative_to(output.resolve()) or not destination.is_file():
                raise ValueError(f'Broken release link: {file.relative_to(output)} -> {reference}')
            if access and access[file.relative_to(output).as_posix()] == 'public' and access[path] != 'public':
                raise ValueError(f'Public link to restricted file: {file.relative_to(output)} -> {reference}')


def build(root, output, release_id):
    if not re.fullmatch(r'[0-9a-f]{40}', release_id):
        raise ValueError('release-id must be a full Git SHA')
    if output.exists():
        raise ValueError('Output must not exist; use a fresh directory')
    labs = load_labs(root)
    entries = []
    names = set()
    def add(name, data, access):
        if name in names:
            raise ValueError(f'Duplicate path: {name}')
        names.add(name)
        if len(data) > MAX_FILE_BYTES:
            raise ValueError(f'File exceeds gateway budget: {name}')
        destination = output / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
        content_type = mimetypes.guess_type(name)[0] or 'application/octet-stream'
        if name.endswith(('.js', '.mjs')):
            content_type = 'text/javascript'
        if content_type.startswith('text/'):
            content_type += '; charset=utf-8'
        entries.append({'path': name, 'sha256': hashlib.sha256(data).hexdigest(),
                        'size': len(data), 'contentType': content_type, 'access': access})

    for source, name, access in sources(root, labs):
        if source.is_symlink() or not source.resolve().is_relative_to(root.resolve()):
            raise ValueError(f'Symlink/outside source: {name}')
        data = source.read_bytes()
        if name == 'lab-07/index.html':
            data = data.replace(b'assets/reading-night.png', b'/lab-07/assets/reading-night.webp')
        if name == 'lab-07/media.html':
            data = data.replace(b'</head>', b'    <script src="/quote.js" type="module"></script>\n  </head>')
        add(name, data, access)
    for name, data, access in viewers(labs):
        add(name, data, access)
    template_path = root / 'site/index.html'
    if template_path.is_symlink() or not template_path.resolve().is_relative_to(root.resolve()):
        raise ValueError('Unsafe catalogue template path')
    template = template_path.read_text()
    if template.count('<!-- LABS -->') != 1 or template.count('<!-- ACCOUNT -->') != 1:
        raise ValueError('Catalogue template must contain LABS and ACCOUNT markers once')
    add('index.html', catalogue(template, labs).encode(), 'public')
    add('admin/index.html', catalogue(template, labs, admin=True).encode(), 'admin')
    check_links(output, {entry['path']: entry['access'] for entry in entries})
    quote_access = next((lab['access'] for lab in labs if lab['id'] == 'lab-07'), None)
    manifest = {'schemaVersion': 2, 'releaseId': release_id, 'quoteAccess': quote_access, 'files': entries}
    (output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release-id', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    manifest = build(ROOT, args.output.resolve(), args.release_id)
    print(json.dumps({'releaseId': manifest['releaseId'], 'files': len(manifest['files']),
                      'bytes': sum(entry['size'] for entry in manifest['files'])}))
