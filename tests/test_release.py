import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import subprocess
import sys

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


builder, upload = load('build'), load('upload')


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.labs = [{'id': f'lab-{number:02d}', 'title': f'Test lab {number}',
                      'access': 'public', 'enabled': True} for number in (1, 2, 3, 4, 5, 7)]
        self.labs[-1]['pages'] = [
            {'source': 'assignment.html', 'path': 'index.html', 'title': 'Assignment'},
            {'source': 'index.html', 'path': 'club.html', 'title': 'Club'},
            {'source': 'media.html', 'path': 'media.html', 'title': 'Media'}]
        for item in self.labs:
            number = int(item['id'][-2:])
            path = self.root / f'lab-{number:02d}'
            (path / 'report').mkdir(parents=True)
            (path / 'index.html').write_text('<h1>Lab</h1>')
            (path / 'style.css').write_text('h1 { color: black; }')
            (path / 'report/report.pdf').write_bytes(b'%PDF-test')
            (path / 'report/private.tex').write_text('do not publish')
            (path / '.env').write_text('do not publish')
        (self.root / 'site').mkdir()
        (self.root / 'site/index.html').write_text(
            '<!doctype html><html><head><link rel="stylesheet" href="/catalogue.css"></head>'
            '<body><h1>Labs</h1><ol><!-- LABS --></ol><!-- ACCOUNT -->'
            '<footer><a href="https://github.com/example/labs">GitHub</a></footer></body></html>')
        (self.root / 'site/labs.json').write_text(json.dumps(self.labs))
        (self.root / 'site/private.json').write_text('{"secret": "do not publish"}')
        (self.root / 'site/catalogue.css').write_text('ol { list-style: none; }')
        (self.root / 'site/media').mkdir()
        (self.root / 'site/media/reading-night.webp').write_bytes(b'webp fixture')
        (self.root / 'lab-07/assets').mkdir()
        (self.root / 'lab-07/assets/reading-night.png').write_bytes(b'png fixture')
        (self.root / 'lab-07/index.html').write_text('<img src="assets/reading-night.png">')
        (self.root / 'site/viewer.css').write_text('iframe { width: 100%; }')
        (self.root / 'site/viewer.js').write_text('// Host navigation')
        for name in ('assignment.html', 'media.html'):
            (self.root / 'lab-07' / name).write_text('<!doctype html><html><head></head><body>Lab 7</body></html>')
        (self.root / 'services/quotes').mkdir(parents=True)
        (self.root / 'services/quotes/contract.mjs').write_text('export const version = 1;')
        (self.root / 'site/quote.js').write_text('import { version } from "/quote-contract.mjs";')
        self.originals = {path: path.read_bytes() for item in self.labs
                          for path in (self.root / item['id']).rglob('*') if path.is_file()}
        self.out = self.root / 'dist'
        self.manifest = builder.build(self.root, self.out, 'a' * 40)

    def test_only_web_and_pdf_are_published(self):
        names = {entry['path'] for entry in self.manifest['files']}
        self.assertTrue({'index.html', 'admin/index.html', 'lab-07/assets/reading-night.webp'} <= names)
        self.assertFalse(any(name.endswith(('.tex', '.env', '.json')) for name in names))
        self.assertNotIn('media/reading-night.webp', names)
        self.assertNotIn('lab-07/assets/reading-night.png', names)
        self.assertEqual(self.manifest['schemaVersion'], 2)
        self.assertEqual(self.manifest['quoteAccess'], 'public')
        upload.verify(self.out)

    def test_host_navigation_preserves_standalone_sources_and_pdf(self):
        for path, content in self.originals.items():
            self.assertEqual(path.read_bytes(), content)
            if path.suffix == '.pdf':
                self.assertEqual((self.out / path.relative_to(self.root)).read_bytes(), content)
        first = (self.out / 'view/lab-01/index.html').read_text()
        self.assertIn('src="/lab-01/index.html"', first)
        self.assertIn('href="/lab-01/report/report.pdf"', first)
        self.assertIn('href="/view/lab-02/"', first)
        self.assertNotIn('href="/view/lab-00/"', first)
        last = (self.out / 'view/lab-07/index.html').read_text()
        self.assertIn('src="/lab-07/assignment.html"', last)
        self.assertIn('href="/view/lab-05/"', last)
        self.assertNotIn('href="/view/lab-08/"', last)
        self.assertIn('src="/lab-07/media.html"', (self.out / 'view/lab-07/media.html').read_text())
        self.assertIn('/quote.js', (self.out / 'lab-07/media.html').read_text())
        self.assertNotIn('/quote.js', (self.root / 'lab-07/media.html').read_text())

    def rebuild(self, labs, name):
        (self.root / 'site/labs.json').write_text(json.dumps(labs))
        output = self.root / name
        return output, builder.build(self.root, output, 'a' * 40)

    def test_public_and_admin_catalogues_and_navigation(self):
        labs = copy.deepcopy(self.labs)
        labs[1].update(access='admin', title='Private lab <two>')
        output, manifest = self.rebuild(labs, 'mixed')
        public = (output / 'index.html').read_text()
        admin = (output / 'admin/index.html').read_text()
        self.assertNotIn('lab-02', public)
        self.assertNotIn('Private lab', public)
        self.assertIn('<a class="login-button" href="/auth/login">Войти как администратор</a>', public)
        self.assertNotIn('action="/auth/login"', public)
        self.assertNotIn('/auth/logout', public)
        self.assertIn('href="/view/lab-02/"', admin)
        self.assertIn('Private lab &lt;two&gt;', admin)
        self.assertIn('action="/auth/logout" method="post"', admin)
        self.assertIn('href="/catalogue.css"', admin)
        self.assertIn('href="/lab-02/report/report.pdf"', admin)
        self.assertIn('https://github.com/example/labs', public)
        self.assertIn('https://github.com/example/labs', admin)
        first = (output / 'view/lab-01/index.html').read_text()
        self.assertNotIn('lab-02', first)
        self.assertNotIn('Private lab', first)
        self.assertIn('href="/view/lab-03/"', first)
        private = (output / 'view/lab-02/index.html').read_text()
        self.assertIn('href="/view/lab-01/"', private)
        self.assertIn('href="/view/lab-03/"', private)
        access = {entry['path']: entry['access'] for entry in manifest['files']}
        for path in ('lab-02/index.html', 'lab-02/style.css', 'lab-02/report/report.pdf',
                     'view/lab-02/index.html', 'admin/index.html'):
            self.assertEqual(access[path], 'admin')
        self.assertEqual(access['index.html'], 'public')
        upload.verify(output)

    def test_lab7_assets_and_quote_inherit_admin_access(self):
        labs = copy.deepcopy(self.labs)
        labs[-1]['access'] = 'admin'
        output, manifest = self.rebuild(labs, 'private-seven')
        self.assertEqual(manifest['quoteAccess'], 'admin')
        access = {entry['path']: entry['access'] for entry in manifest['files']}
        private_paths = [path for path in access if path.startswith(('lab-07/', 'view/lab-07/'))]
        private_paths += ['quote.js', 'quote-contract.mjs']
        for path in private_paths:
            self.assertEqual(access[path], 'admin', path)
        self.assertEqual(access['lab-07/assets/reading-night.webp'], 'admin')
        self.assertIn('/lab-07/assets/reading-night.webp', (output / 'lab-07/index.html').read_text())
        self.assertNotIn('lab-07', (output / 'index.html').read_text())
        self.assertNotIn('lab-07', (output / 'view/lab-05/index.html').read_text())
        upload.verify(output)

    def test_disabled_lab_is_absent_from_files_catalogues_and_navigation(self):
        labs = copy.deepcopy(self.labs)
        labs[1].update(enabled=False, title='Disabled private name')
        labs[-1]['enabled'] = False
        output, manifest = self.rebuild(labs, 'disabled')
        self.assertIsNone(manifest['quoteAccess'])
        for entry in manifest['files']:
            self.assertNotIn('lab-02', entry['path'])
            self.assertNotIn('lab-07', entry['path'])
            self.assertNotIn(entry['path'], ('quote.js', 'quote-contract.mjs'))
        for path in output.rglob('*.html'):
            text = path.read_text()
            self.assertNotIn('lab-02', text)
            self.assertNotIn('lab-07', text)
            self.assertNotIn('Disabled private name', text)
        self.assertFalse((output / 'lab-02').exists())
        self.assertFalse((output / 'lab-07').exists())
        self.assertFalse((output / 'media').exists())
        upload.verify(output)

    def test_default_access_and_enabled_and_empty_catalogue(self):
        labs = [{'id': 'lab-01', 'title': 'Default lab'}]
        output, manifest = self.rebuild(labs, 'defaults')
        self.assertIn('Default lab', (output / 'index.html').read_text())
        self.assertEqual(next(entry['access'] for entry in manifest['files']
                              if entry['path'] == 'lab-01/index.html'), 'public')
        self.assertIsNone(manifest['quoteAccess'])
        upload.verify(output)
        output, manifest = self.rebuild([], 'empty')
        self.assertIsNone(manifest['quoteAccess'])
        self.assertNotIn('/view/lab-', (output / 'index.html').read_text())
        upload.verify(output)

    def test_invalid_lab_config_is_rejected_before_build(self):
        invalid_items = [
            {'access': 'hidden'}, {'access': None}, {'access': False},
            {'enabled': 'false'}, {'enabled': 0}, {'enabled': None},
            {'publc': True}, {'id': '../lab-01'}, {'id': 'lab-1'}, {'id': 1},
            {'title': ''}, {'title': None}, {'pages': []}, {'pages': None},
            {'pages': [{'source': '../index.html', 'path': 'index.html', 'title': 'Page'}]},
            {'pages': [{'source': 'index.html', 'path': '../index.html', 'title': 'Page'}]},
            {'pages': [{'source': 'index.html', 'path': 'other.html', 'title': 'Page'}]},
            {'pages': [{'source': 'index.html', 'path': 'index.html', 'title': 'Page', 'hidden': True}]},
            {'pages': [{'source': 'index.html', 'path': 'index.html', 'title': 'Page'},
                       {'source': 'index.html', 'path': 'copy.html', 'title': 'Copy'}]},
            {'pages': [{'source': 'index.html', 'path': 'index.html', 'title': 'Page'},
                       {'source': 'other.html', 'path': 'index.html', 'title': 'Other'}]},
        ]
        for changes in invalid_items:
            with self.subTest(changes=changes):
                labs = copy.deepcopy(self.labs)
                labs[0].update(changes)
                with self.assertRaises(ValueError):
                    self.rebuild(labs, 'invalid')
                self.assertFalse((self.root / 'invalid').exists())
        for labs in ({}, [None], self.labs + [self.labs[0]]):
            with self.subTest(labs=labs):
                with self.assertRaises(ValueError):
                    self.rebuild(labs, 'invalid')

    def test_manifest_requires_valid_access_and_quote_policy(self):
        original = copy.deepcopy(self.manifest)
        for value in (None, False, 'hidden', '', []):
            with self.subTest(access=value):
                manifest = copy.deepcopy(original)
                manifest['files'][0]['access'] = value
                (self.out / 'manifest.json').write_text(json.dumps(manifest))
                with self.assertRaises(ValueError):
                    upload.verify(self.out)
        manifest = copy.deepcopy(original)
        del manifest['files'][0]['access']
        (self.out / 'manifest.json').write_text(json.dumps(manifest))
        with self.assertRaises(ValueError):
            upload.verify(self.out)
        for value in (None, False, 'hidden', '', [], 'admin'):
            with self.subTest(quoteAccess=value):
                manifest = copy.deepcopy(original)
                manifest['quoteAccess'] = value
                (self.out / 'manifest.json').write_text(json.dumps(manifest))
                with self.assertRaises(ValueError):
                    upload.verify(self.out)
        manifest = copy.deepcopy(original)
        del manifest['quoteAccess']
        (self.out / 'manifest.json').write_text(json.dumps(manifest))
        with self.assertRaises(ValueError):
            upload.verify(self.out)
        for name, policy in [('index.html', 'admin'), ('admin/index.html', 'public'),
                             ('lab-07/assets/reading-night.webp', 'admin')]:
            with self.subTest(path=name):
                manifest = copy.deepcopy(original)
                next(entry for entry in manifest['files'] if entry['path'] == name)['access'] = policy
                (self.out / 'manifest.json').write_text(json.dumps(manifest))
                with self.assertRaises(ValueError):
                    upload.verify(self.out)
        (self.out / 'manifest.json').write_text(json.dumps(original))
        upload.verify(self.out)

    def test_public_content_cannot_link_to_admin_files(self):
        labs = copy.deepcopy(self.labs)
        labs[1]['access'] = 'admin'
        (self.root / 'lab-01/index.html').write_text('<a href="/lab-02/">Private lab</a>')
        with self.assertRaisesRegex(ValueError, 'Public link to restricted file'):
            self.rebuild(labs, 'public-leak')

    def test_changed_or_extra_file_is_rejected(self):
        (self.out / 'index.html').write_text('changed')
        with self.assertRaises(ValueError):
            upload.verify(self.out)

    def test_unlisted_secret_is_rejected(self):
        (self.out / '.env').write_text('secret')
        with self.assertRaises(ValueError):
            upload.verify(self.out)

    def test_manifest_last_and_upload_failure_never_publishes_manifest(self):
        calls = []
        stored = {}
        def runner(args, missing_ok=False):
            key = args[args.index('--key') + 1]
            calls.append((args[0], key))
            if args[0] == 'head-object':
                return stored.get(key)
            data = Path(args[args.index('--body') + 1]).read_bytes()
            stored[key] = {'content_length': len(data), 'etag': hashlib.md5(data).hexdigest()}
            return {}
        upload.publish(self.out, 'example-bucket', runner)
        writes = [key for command, key in calls if command == 'put-object']
        self.assertTrue(writes[-1].endswith('/manifest.json'))
        def failure(args, missing_ok=False):
            if args[0] == 'head-object':
                return None
            raise RuntimeError('upload failed')
        with self.assertRaises(RuntimeError):
            upload.publish(self.out, 'example-bucket', failure)

    def test_existing_release_collision_is_rejected(self):
        def collision(args, missing_ok=False):
            return {'content_length': 0, 'etag': 'different'}
        with self.assertRaisesRegex(RuntimeError, 'Immutable release collision'):
            upload.publish(self.out, 'example-bucket', collision)

    def test_missing_html_image_and_css_background_fail_build_checks(self):
        for source, content in [('index.html', '<img src="missing.png">'),
                                ('broken.css', 'body {background: url("missing.jpg")}')]:
            path = self.out / source
            previous = path.read_bytes() if path.exists() else None
            path.write_text(content)
            with self.assertRaisesRegex(ValueError, 'Broken release link'):
                builder.check_links(self.out)
            if previous is None:
                path.unlink()
            else:
                path.write_bytes(previous)

    def test_different_builds_of_same_commit_use_different_prefixes(self):
        prefixes = []
        def runner(args, missing_ok=False):
            if args[0] == 'head-object':
                if missing_ok:
                    return None
                source = self.out / args[args.index('--key') + 1].split('/', 3)[3]
                data = source.read_bytes()
                return {'content_length': len(data), 'etag': hashlib.md5(data).hexdigest()}
            prefixes.append(args[args.index('--key') + 1].split('/')[2])
            return {}
        first = upload.publish(self.out, 'example-bucket', runner)['prefix']
        data = b'<h1>Different build</h1>'
        (self.out / 'index.html').write_bytes(data)
        manifest = json.loads((self.out / 'manifest.json').read_text())
        for entry in manifest['files']:
            if entry['path'] == 'index.html':
                entry.update(size=len(data), sha256=hashlib.sha256(data).hexdigest())
        (self.out / 'manifest.json').write_text(json.dumps(manifest))
        second = upload.publish(self.out, 'example-bucket', runner)['prefix']
        self.assertNotEqual(first, second)
        self.assertEqual(len(set(prefixes)), 2)

    def test_runtime_inputs_pin_both_function_archives_and_keep_policy_private(self):
        config = self.root / 'runtime-config.json'
        config.write_text(json.dumps({'foundation': {}, 'gate_secret_version_id': 'version',
            'oidc_client_id': 'client', 'allowed_subjects': [{'issuer': 'https://id.example', 'sub': 'owner'}]}))
        gate, quote = self.root / 'gate.zip', self.root / 'quotes.zip'
        gate.write_bytes(b'gate-archive')
        quote.write_bytes(b'quote-archive')
        output = self.root / 'runtime.tfvars.json'
        command = [sys.executable, str(SCRIPTS / 'prepare_runtime.py'),
            '--directory', str(self.out), '--config', str(config), '--gate-zip', str(gate),
            '--quote-zip', str(quote), '--output', str(output)]
        subprocess.run(command, check=True, capture_output=True)
        runtime = json.loads(output.read_text())
        self.assertEqual(runtime['gate_zip_sha256'], hashlib.sha256(gate.read_bytes()).hexdigest())
        self.assertEqual(runtime['quote_zip_sha256'], hashlib.sha256(quote.read_bytes()).hexdigest())
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        before = output.read_bytes()
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
        self.assertEqual(output.read_bytes(), before)

    def test_runtime_plan_rejects_deletion_and_resources_outside_functions_and_gateway(self):
        checker = load('check_plan')
        def plan(kind, actions):
            return {'resource_changes': [{'mode': 'managed', 'type': kind,
                'address': kind + '.test', 'change': {'actions': actions}}]}
        checker.check(plan('yandex_function', ['update']))
        for kind, actions in [('yandex_function', ['delete', 'create']),
                              ('yandex_storage_bucket', ['update']),
                              ('yandex_serverless_container', ['create'])]:
            with self.assertRaises(ValueError):
                checker.check(plan(kind, actions))

    def test_public_release_can_deploy_without_admins_but_rejects_invalid_allowlist(self):
        config = self.root / 'public-runtime-config.json'
        gate, quote = self.root / 'public-gate.zip', self.root / 'public-quotes.zip'
        gate.write_bytes(b'gate-archive')
        quote.write_bytes(b'quote-archive')
        for index, subjects in enumerate(([], None, False, {}, '', '[]')):
            with self.subTest(allowed_subjects=subjects):
                config.write_text(json.dumps({'foundation': {}, 'gate_secret_version_id': 'version',
                    'oidc_client_id': 'client', 'allowed_subjects': subjects}))
                output = self.root / f'public-runtime-{index}.tfvars.json'
                command = [sys.executable, str(SCRIPTS / 'prepare_runtime.py'),
                    '--directory', str(self.out), '--config', str(config), '--gate-zip', str(gate),
                    '--quote-zip', str(quote), '--output', str(output)]
                result = subprocess.run(command, capture_output=True)
                if subjects == []:
                    self.assertEqual(result.returncode, 0, result.stderr.decode())
                    runtime = json.loads(output.read_text())
                    self.assertEqual(runtime['allowed_subjects'], [])
                    self.assertEqual(runtime['release_id'], self.manifest['releaseId'])
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
