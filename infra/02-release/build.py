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

ROOT = Path(__file__).resolve().parents[2]
LABS = (1, 2, 3, 4, 5, 7)
TITLES = {1: 'Оформление текста', 2: 'Таблицы', 3: 'Позиционирование',
          4: 'Формы', 5: 'Каркас страницы', 7: 'Адаптивная вёрстка'}
# Leaves room below Gateway's 2.5 MB body limit and the function's 3.5 MB
# JSON limit after base64 encoding binary files.
MAX_FILE_BYTES = 2_200_000
WEB_EXTENSIONS = {'.html', '.css', '.js', '.png', '.jpg', '.jpeg', '.svg', '.webp', '.ico'}


def viewers():
    """The host owns navigation; lab documents remain independent inputs."""
    for index, number in enumerate(LABS):
        lab = f'lab-{number:02d}'
        pages = {'index.html': ('index.html', 'Основная страница')}
        if number == 7:
            pages = {'assignment.html': ('index.html', 'Макет задания'),
                     'index.html': ('club.html', 'Клубные заметки'),
                     'media.html': ('media.html', 'Цитата и медиазапросы')}
        routes = {f'/{lab}/{source}': f'/view/{lab}/{view}' for source, (view, _) in pages.items()}
        routes[f'/{lab}/'] = routes[f'/{lab}/index.html']
        for source, (view, page_title) in pages.items():
            def neighbour(offset, label, css):
                pos = index + offset
                if not 0 <= pos < len(LABS):
                    return f'<span class="{css}"></span>'
                target = LABS[pos]
                return (f'<a class="{css}" href="/view/lab-{target:02d}/">'
                        f'{label}<span>ЛР{target} · {escape(TITLES[target])}</span></a>')
            tabs = ''
            if len(pages) > 1:
                links = [f'<a href="{routes[f"/{lab}/{item}"]}"'
                         + (' aria-current="page"' if item == source else '')
                         + f'>{escape(title)}</a>' for item, (_, title) in pages.items()]
                tabs = '<nav class="viewer-pages" aria-label="Страницы работы">' + ''.join(links) + '</nav>'
            html = f'''<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ЛР{number} · {escape(TITLES[number])}</title>
  <link rel="stylesheet" href="/viewer.css">
  <script src="/viewer.js" defer></script>
</head>
<body class="lab-viewer">
  <header class="viewer-header">
    <a class="viewer-back" href="/">← Все работы</a>
    <div class="viewer-heading"><small>Лабораторная работа {number}</small><h1>{escape(TITLES[number])}</h1></div>
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
            yield f'view/{lab}/{view}', html.encode()


def sources(root):
    for number in LABS:
        lab = root / f'lab-{number:02d}'
        if not (lab / 'index.html').is_file() or not (lab / 'report/report.pdf').is_file():
            raise ValueError(f'Incomplete lab: {lab.name}')
        for path in sorted(lab.iterdir()):
            if path.is_file() and path.suffix in {'.html', '.css', '.js'}:
                yield path, path.relative_to(root).as_posix()
        for folder in ('assets', 'img'):
            for path in sorted((lab / folder).rglob('*')):
                if path.is_file() and path.suffix.lower() in WEB_EXTENSIONS:
                    if path.relative_to(root).as_posix() == 'lab-07/assets/reading-night.png':
                        continue  # The hosted copy uses the pixel-identical lossless WebP.
                    yield path, path.relative_to(root).as_posix()
        yield lab / 'report/report.pdf', f'{lab.name}/report/report.pdf'
    for path in sorted((root / 'site').rglob('*')):
        if path.is_file() and path.suffix.lower() in WEB_EXTENSIONS:
            yield path, path.relative_to(root / 'site').as_posix()
    yield root / 'services/quotes/contract.mjs', 'quote-contract.mjs'


def check_links(output):
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


def build(root, output, release_id):
    if not re.fullmatch(r'[0-9a-f]{40}', release_id):
        raise ValueError('release-id must be a full Git SHA')
    if output.exists():
        raise ValueError('Output must not exist; use a fresh directory')
    entries = []
    names = set()
    def add(name, data):
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
                        'size': len(data), 'contentType': content_type})

    for source, name in sources(root):
        if source.is_symlink() or not source.resolve().is_relative_to(root.resolve()):
            raise ValueError(f'Symlink/outside source: {name}')
        data = source.read_bytes()
        if name == 'lab-07/index.html':
            data = data.replace(b'assets/reading-night.png', b'/media/reading-night.webp')
        if name == 'lab-07/media.html':
            data = data.replace(b'</head>', b'    <script src="/quote.js" type="module"></script>\n  </head>')
        add(name, data)
    for name, data in viewers():
        add(name, data)
    if 'index.html' not in names:
        raise ValueError('Missing site catalogue')
    check_links(output)
    manifest = {'schemaVersion': 1, 'releaseId': release_id, 'files': entries}
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
