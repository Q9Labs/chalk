import hashlib
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

from archive import package


class ArchiveContract(unittest.TestCase):
    def test_reproducible_archive_binds_runtime_and_aliases(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            release = root / 'release'
            (release / 'bin').mkdir(parents=True)
            (release / 'bin/recorder-capture').write_bytes(b'capture payload')
            (release / 'bin/chalk-recorder-bootstrap').write_bytes(b'bootstrap payload')
            (release / 'build-info.json').write_text(json.dumps(dict(
                schema_version='chalk_recorder_capture_build.v1', release_id='recorder-capture-test',
                source_commit='a' * 40, source_tree_sha256='b' * 64)))
            bundle = root / 'bundle.tar.gz'
            with tarfile.open(bundle, 'w:gz') as archive:
                archive.add(release, arcname='release')
            results = [package('capture', bundle, root / name, root / 'unused') for name in ('a.tar.gz', 'b.tar.gz')]
            self.assertEqual(results[0], results[1])
            with tarfile.open(root / 'a.tar.gz') as archive:
                raw = archive.extractfile('release/image-manifest.json').read()
                files = {item['path']: item for item in json.loads(raw)['files']}
                self.assertEqual(results[0]['image_digest'], 'sha256:' + hashlib.sha256(raw).hexdigest())
                binary = files['/opt/chalk-recorder/releases/recorder-capture-test/bin/recorder-capture']
                self.assertEqual(binary['sha256'], hashlib.sha256(b'capture payload').hexdigest())
                self.assertEqual(files['/opt/chalk-recorder/current']['type'], 'symlink')
