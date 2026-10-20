import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import subprocess
import sys


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


builder, upload = load('build'), load('upload')


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for number in builder.LABS:
            path = self.root / f'lab-{number:02d}'
            (path / 'report').mkdir(parents=True)
            (path / 'index.html').write_text('<h1>Lab</h1>')
            (path / 'report/report.pdf').write_bytes(b'%PDF-test')
            (path / 'report/private.tex').write_text('do not publish')
            (path / '.env').write_text('do not publish')
        (self.root / 'site').mkdir()
        (self.root / 'site/index.html').write_text('<h1>Labs</h1>')
        (self.root / 'services/quotes').mkdir(parents=True)
        (self.root / 'services/quotes/contract.mjs').write_text('export const version = 1;')
        self.out = self.root / 'dist'
        self.manifest = builder.build(self.root, self.out, 'a' * 40)

    def test_only_web_and_pdf_are_published(self):
        names = {entry['path'] for entry in self.manifest['files']}
        self.assertEqual(len(names), 14)
        self.assertFalse(any(name.endswith(('.tex', '.env')) for name in names))
        upload.verify(self.out)

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
        command = [sys.executable, str(Path(__file__).with_name('prepare_runtime.py')),
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


if __name__ == '__main__':
    unittest.main()
