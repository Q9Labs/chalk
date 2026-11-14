"""Release files of a public repository are ciphertext: artifacts and Deployment payloads never carry the plaintext."""

import base64
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import release
import seal
from github_release import GitHub, retain, retained

MANIFEST = json.dumps(dict(release_id='release', source_revision='a' * 40,
                           images=dict(api='123456789012.dkr.ecr.example.amazonaws.com/chalk-api@sha256:' + 'b' * 64))).encode()


class Sealed(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.dict(os.environ, CHALK_RELEASE_SEAL_KEY='test-seal-key'))
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)

    def test_sealed_bytes_hide_the_plaintext_and_open_with_the_key(self):
        sealed = seal.seal(MANIFEST)
        self.assertNotIn(b'123456789012', sealed)
        self.assertEqual(seal.unseal(sealed), MANIFEST)
        with patch.dict(os.environ, CHALK_RELEASE_SEAL_KEY='another-key'), self.assertRaises(ValueError):
            seal.unseal(sealed)

    def test_a_missing_key_fails_before_any_file_is_written(self):
        with patch.dict(os.environ, CHALK_RELEASE_SEAL_KEY=''), self.assertRaises(ValueError) as error:
            seal.seal(MANIFEST)
        self.assertIn('CHALK_RELEASE_SEAL_KEY', str(error.exception))

    def test_files_and_directories_are_sealed_as_copies_and_opened_in_place(self):
        source = self.directory / 'source'
        (source / 'nested').mkdir(parents=True)
        (source / 'a.json').write_bytes(MANIFEST)
        (source / 'nested' / 'b.txt').write_bytes(b'registry.example/chalk-api@sha256:abc\n')
        single = self.directory / 'single.json'
        single.write_bytes(b'{}')
        out = self.directory / 'out'
        seal.seal_files([source, single], out)
        self.assertEqual(sorted(str(path.relative_to(out)) for path in out.rglob('*') if path.is_file()),
                         ['a.json.sealed', 'nested/b.txt.sealed', 'single.json.sealed'])
        self.assertEqual((source / 'a.json').read_bytes(), MANIFEST)
        self.assertNotIn(b'123456789012', (out / 'a.json.sealed').read_bytes())
        seal.unseal_tree(out)
        self.assertEqual(sorted(str(path.relative_to(out)) for path in out.rglob('*') if path.is_file()),
                         ['a.json', 'nested/b.txt', 'single.json'])
        self.assertEqual((out / 'a.json').read_bytes(), MANIFEST)

    def test_wildcards_match_like_a_shell_and_an_empty_match_fails_unless_allowed(self):
        (self.directory / 'r-1.json').write_bytes(b'{}')
        (self.directory / 'r-1.media.json').write_bytes(b'{}')
        (self.directory / 'other.json').write_bytes(b'{}')
        out = self.directory / 'out'
        seal.seal_files([self.directory / 'r-1*.json'], out)
        self.assertEqual(sorted(path.name for path in out.iterdir()), ['r-1.json.sealed', 'r-1.media.json.sealed'])
        with self.assertRaises(ValueError):
            seal.seal_files([self.directory / 'none*.json'], self.directory / 'empty')
        seal.seal_files([self.directory / 'none*.json', self.directory / 'missing.json'], self.directory / 'empty', allow_empty=True)
        seal.seal_files([self.directory / 'other.json', self.directory / 'missing.json'], self.directory / 'partial')
        self.assertEqual([path.name for path in (self.directory / 'partial').iterdir()], ['other.json.sealed'])

    def test_files_that_were_never_sealed_pass_through_opening_without_a_key(self):
        (self.directory / 'old.json').write_bytes(MANIFEST)
        with patch.dict(os.environ, CHALK_RELEASE_SEAL_KEY=''):
            seal.unseal_tree(self.directory)
        self.assertEqual((self.directory / 'old.json').read_bytes(), MANIFEST)

    def test_a_deployment_payload_keeps_ciphertext_and_still_reads_a_record_from_before_sealing(self):
        record = retain(dict(channel='production-release'), 'manifest', MANIFEST)
        self.assertNotIn('manifest_base64', record)
        self.assertNotIn('123456789012', json.dumps(record))
        self.assertEqual(retained(record, 'manifest'), MANIFEST)
        legacy = dict(channel='production-release', manifest_base64=base64.b64encode(MANIFEST).decode())
        self.assertEqual(retained(legacy, 'manifest'), MANIFEST)

    def test_retaining_a_production_release_writes_no_plaintext_manifest_or_media(self):
        (self.directory / 'release.json').write_bytes(MANIFEST)
        (self.directory / 'release.media.json').write_bytes(b'{"recorder_source_bucket": "bucket-123456789012"}')
        api = Mock(spec=GitHub)
        api.request.return_value = dict(id=2)
        with patch.dict(os.environ, RELEASE_ID='release', TARGET_SHA='a' * 40, GITHUB_RUN_ID='456', MANIFEST_ARTIFACT_ID='10',
                        MANIFEST_SHA256=release.digest(MANIFEST), PROMOTION_AUDIT='', GITHUB_OUTPUT=str(self.directory / 'out')):
            release.retain_production(api, SimpleNamespace(directory=self.directory))
        record = api.request.call_args.args[1]['payload']
        self.assertEqual(sorted(key for key in record if key.endswith(('_sealed', '_base64'))), ['manifest_sealed', 'media_sealed'])
        self.assertNotIn('123456789012', json.dumps(record))
        self.assertEqual(retained(record, 'manifest'), MANIFEST)


if __name__ == '__main__':
    unittest.main()
