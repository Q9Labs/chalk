import io
import json
import os
import subprocess
import tarfile
import unittest
from unittest.mock import patch

import web


SHA = 'a' * 40


def legacy_artifact(target):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode='w:gz') as archive:
        marker = json.dumps({'environment': target, 'commit': SHA}).encode()
        member = tarfile.TarInfo('dist/client/release.json')
        member.size = len(marker)
        archive.addfile(member, io.BytesIO(marker))
    return data.getvalue()


@patch.dict(os.environ, CLOUDFLARE_ACCOUNT_ID='fixture-account', GITHUB_REPOSITORY='fixture/repository')
class WebVendorStore(unittest.TestCase):
    def test_worker_probe_failure_stops_native_pages_rollback(self):
        with patch.object(web.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'verify-vendor-store')), patch.object(web, 'pages', return_value={'id': 'saved'}) as pages, patch.object(web, 'current', return_value='saved'), patch.object(web, 'outputs'):
            with self.assertRaises(subprocess.CalledProcessError):
                web.rollback('chalk', 'saved')
            pages.assert_not_called()

    def test_legacy_archives_deploy_without_an_asset_manifest(self):
        for target in ['production', 'nightly']:
            with self.subTest(target=target):
                def execute(args, **kwargs):
                    if args[1].endswith('/prepare-vendor-store.ts'):
                        self.assertEqual(os.listdir(args[args.index('--directory') + 1]), ['release.json'])
                    return subprocess.CompletedProcess(args, 0)

                with patch.object(web.GitHub, 'artifact', return_value=legacy_artifact(target)), patch.object(web.subprocess, 'run', side_effect=execute) as run:
                    web.deploy(target, SHA, '1', {'sha256': 'b' * 64, 'artifact_id': '2'}, 'fixture-project')
                publish, upload, verify = [call.args[0] for call in run.call_args_list]
                self.assertEqual(publish[-2:], ['--target', target])
                self.assertEqual(upload[1:4], ['pages', 'deploy', 'dist/client'])
                self.assertIn(web.public_config(target, SHA)['VITE_PUBLIC_APP_URL'], verify)

    def test_vendor_upload_failure_stops_pages_publication(self):
        with patch.object(web.GitHub, 'artifact', return_value=legacy_artifact('production')), patch.object(web.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'upload-vendor-assets')) as run:
            with self.assertRaises(subprocess.CalledProcessError):
                web.deploy('production', SHA, '1', {'sha256': 'b' * 64, 'artifact_id': '2'}, 'fixture-project')
            self.assertEqual(run.call_count, 1)
            self.assertTrue(run.call_args.args[0][1].endswith('/prepare-vendor-store.ts'))


if __name__ == '__main__':
    unittest.main()
