import io
import json
import os
import subprocess
import tarfile
import unittest
from unittest.mock import patch

import web


SHA = 'a' * 40


def artifact(target):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode='w:gz') as archive:
        marker = json.dumps({'environment': target, 'commit': SHA}).encode()
        member = tarfile.TarInfo('dist/client/release.json')
        member.size = len(marker)
        archive.addfile(member, io.BytesIO(marker))
    return data.getvalue()


class WebAssetRetention(unittest.TestCase):
    @patch.dict(os.environ, CLOUDFLARE_ACCOUNT_ID='fixture-account', GITHUB_REPOSITORY='fixture/repository')
    def deploy(self, target='production', without_retention=False, failure=None):
        with patch.object(web.GitHub, 'artifact', return_value=artifact(target)), patch.object(web.subprocess, 'run') as run:
            if failure:
                run.side_effect = failure
            web.deploy(target, SHA, '1', {'sha256': 'b' * 64, 'artifact_id': '2'}, 'fixture-project', without_retention)
            return run.call_args_list

    def test_prebuilt_production_retention_runs_before_upload(self):
        calls = self.deploy()
        retain, upload, verify = [call.args[0] for call in calls]
        self.assertTrue(retain[0].endswith('/node_modules/.bin/tsx'))
        self.assertTrue(retain[1].endswith('/apps/web/scripts/retain-public-assets.ts'))
        self.assertEqual(retain[-4:], ['--origin', 'https://chalkmeet.com', '--release', SHA])
        self.assertNotIn('--without-asset-retention', retain)
        self.assertTrue(upload[0].endswith('/node_modules/.bin/wrangler'))
        self.assertEqual(upload[1:4], ['pages', 'deploy', 'dist/client'])
        self.assertIn('https://chalkmeet.com', verify)

    def test_nightly_uses_its_own_origin_and_forwards_explicit_bypass(self):
        retain = self.deploy('nightly', without_retention=True)[0].args[0]
        self.assertIn('https://nightly.chalkmeet.com', retain)
        self.assertEqual(retain[-1], '--without-asset-retention')

    @patch.dict(os.environ, CLOUDFLARE_ACCOUNT_ID='fixture-account', GITHUB_REPOSITORY='fixture/repository')
    def test_retention_failure_prevents_wrangler_upload(self):
        failure = subprocess.CalledProcessError(1, 'retain-public-assets', stderr='Retained asset digest mismatch')
        with patch.object(web.GitHub, 'artifact', return_value=artifact('production')), patch.object(web.subprocess, 'run', side_effect=failure) as run:
            with self.assertRaises(subprocess.CalledProcessError):
                web.deploy('production', SHA, '1', {'sha256': 'b' * 64, 'artifact_id': '2'}, 'fixture-project')
            self.assertEqual(run.call_count, 1)
            self.assertTrue(run.call_args.args[0][1].endswith('/retain-public-assets.ts'))


if __name__ == '__main__':
    unittest.main()
