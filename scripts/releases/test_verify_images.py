"""The production image check accepts the digests a release publishes: GHCR application images, ECR ones, and the public Redis and cloudflared images."""

import json
import subprocess
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

import release

DIGEST = 'sha256:' + 'a' * 64
GHCR_API = f'ghcr.io/q9labs/chalk-api@{DIGEST}'
GHCR_SYNC = f'ghcr.io/q9labs/chalk-sync@{DIGEST}'


class VerifyImagesTests(unittest.TestCase):
    def verify(self, images, inspect=None):
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / 'manifest.json'
            manifest.write_text(json.dumps({'images': images}))
            with patch.object(release.subprocess, 'run', side_effect=inspect or (lambda *args, **kwargs: subprocess.CompletedProcess(args, 0))) as run:
                release.verify_images(None, Namespace(manifest=manifest))
            return run

    def test_ghcr_application_images_pass_after_a_manifest_lookup(self):
        run = self.verify({'api': GHCR_API, 'sync': GHCR_SYNC})
        self.assertEqual([call.args[0] for call in run.call_args_list],
                         [['docker', 'manifest', 'inspect', GHCR_API], ['docker', 'manifest', 'inspect', GHCR_SYNC]])

    def test_an_image_missing_from_ghcr_refuses_the_deployment(self):
        def missing(*args, **kwargs):
            raise subprocess.CalledProcessError(1, args[0])
        with self.assertRaisesRegex(ValueError, 'api: public image check failed'):
            self.verify({'api': GHCR_API}, missing)

    def test_other_registries_and_tags_are_refused(self):
        for component, image in (('api', f'ghcr.io/other/chalk-api@{DIGEST}'), ('api', 'ghcr.io/q9labs/chalk-api:latest'),
                                 ('api', f'docker.io/library/api@{DIGEST}'), ('redis', f'ghcr.io/other/redis@{DIGEST}')):
            with self.subTest(image=image), self.assertRaisesRegex(ValueError, 'expected a digest-addressed release image'):
                self.verify({component: image})

    def test_redis_and_cloudflared_still_pass_from_docker_hub(self):
        self.verify({'redis': f'docker.io/library/redis@{DIGEST}', 'cloudflared': f'docker.io/cloudflare/cloudflared@{DIGEST}'})


if __name__ == '__main__':
    unittest.main()
