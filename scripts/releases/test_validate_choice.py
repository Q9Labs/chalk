"""The held cut's checks are independent downloads: they run together and the first failure in order is the one reported."""

import io
import json
import tarfile
import threading
import unittest
from unittest.mock import Mock, patch

import release

SHA = '737897ad7361c859b1bc865d26399dd045c4fb9a'
OTHER_SHA = 'b' * 40


def web_archive(environment, commit):
    data = json.dumps(dict(environment=environment, commit=commit)).encode()
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode='w:gz') as tar:
        member = tarfile.TarInfo('dist/client/release.json')
        member.size = len(data)
        tar.addfile(member, io.BytesIO(data))
    return archive.getvalue()


def download(run, artifact, filename, expected=None):
    return web_archive(filename.removeprefix('web-').removesuffix('.tar.gz'), SHA)


class ValidateChoiceTests(unittest.TestCase):
    def setUp(self):
        self.info = dict(manifest_sha256='a' * 64, run_id=1, release_id='r1', target_sha=SHA, applied_release_id='r1',
                         web={target: dict(sha256='b' * 64, artifact_id=str(index)) for index, target in enumerate(('nightly', 'production'))})
        self.item = dict(payload=json.dumps(self.info))
        self.github = Mock()
        self.github.has_green_gate.return_value = True
        self.github.artifact.side_effect = download
        self.enterContext(patch.object(release, 'manifest_bytes', return_value=b'{}'))
        self.enterContext(patch.object(release, 'media_bytes', return_value=b'{}'))

    def test_a_valid_cut_is_returned(self):
        self.assertEqual(release.validate_choice(self.github, self.item), self.info)

    def test_the_checks_overlap(self):
        # Serial checks would never meet at the barrier; the timeout turns that into a failure.
        meeting = threading.Barrier(2, timeout=5)
        self.github.artifact.side_effect = lambda *args, **kwargs: (meeting.wait(), download(*args, **kwargs))[1]
        self.assertEqual(release.validate_choice(self.github, self.item), self.info)

    def test_the_first_failure_in_check_order_is_reported(self):
        self.github.has_green_gate.return_value = False
        self.github.artifact.side_effect = ValueError('web download failed')
        with self.assertRaisesRegex(ValueError, 'Gate'):
            release.validate_choice(self.github, self.item)

    def test_a_web_artifact_for_the_wrong_commit_is_refused(self):
        self.github.artifact.side_effect = lambda run, artifact, filename, expected=None: web_archive('nightly', OTHER_SHA)
        with self.assertRaisesRegex(ValueError, 'web identity mismatch'):
            release.validate_choice(self.github, self.item)


if __name__ == '__main__':
    unittest.main()
