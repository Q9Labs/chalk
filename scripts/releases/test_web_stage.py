"""The web archive is uploaded as a preview while the API deploys; only a successful API deploy lets deploy-web move the alias."""

import io
import os
import re
import tarfile
import unittest
from unittest.mock import Mock, patch

import release
import web

SHA = '737897ad7361c859b1bc865d26399dd045c4fb9a'
RUN = '123'


class WebStageTests(unittest.TestCase):
    def job(self, name):
        text = (release.ROOT / '.github/workflows/ci.yml').read_text()
        start = text.index(f'\n  {name}:\n')
        following = re.search(r'\n  [A-Za-z0-9_-]+:\n', text[start + 1:])
        return text[start:start + 1 + following.start() if following else len(text)]

    def run_command(self, command):
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode='w:gz') as tar:
            tar.addfile(tarfile.TarInfo('dist/client/index.html'))
        member = dict(sha256='a' * 64, artifact_id='1')
        calls = []
        github = Mock()
        github.return_value.artifact.return_value = archive.getvalue()
        with (patch.object(web, 'GitHub', github), patch.dict(os.environ, CLOUDFLARE_ACCOUNT_ID='account'),
              patch.object(web, 'read_marker', return_value=dict(environment='production', commit=SHA)),
              patch.object(web.subprocess, 'run', side_effect=lambda command, **kwargs: calls.append(command))):
            command('production', SHA, RUN, member, 'project')
        return calls

    def wrangler_branch(self, calls):
        upload = next(call for call in calls if call[0].endswith('wrangler'))
        return upload[upload.index('--branch') + 1]

    def test_staging_uploads_a_preview_and_never_touches_the_live_alias(self):
        calls = self.run_command(web.stage)
        self.assertEqual(self.wrangler_branch(calls), web.STAGE_BRANCH)
        self.assertNotEqual(web.STAGE_BRANCH, web.PRODUCTION_BRANCH)
        self.assertFalse([call for call in calls if call[-1:] == ['production'] and 'verify-web-deploy.mjs' in call[1]])

    def test_deploying_uploads_to_the_production_branch_and_verifies_the_live_site(self):
        calls = self.run_command(web.deploy)
        self.assertEqual(self.wrangler_branch(calls), web.PRODUCTION_BRANCH)
        self.assertTrue(any('verify-web-deploy.mjs' in ' '.join(call) for call in calls))

    def test_only_deploy_web_moves_the_alias_and_it_waits_for_a_successful_api_deploy(self):
        text = (release.ROOT / '.github/workflows/ci.yml').read_text()
        self.assertEqual(text.count('web.py deploy'), 1)
        deploy = self.job('deploy-web')
        self.assertIn('web.py deploy', deploy)
        self.assertIn('needs: [prepare-web, deploy-managed, stage-web]', deploy)
        self.assertIn("needs.deploy-managed.result == 'success'", deploy)

    def test_staging_is_for_a_production_deploy_and_never_blocks_the_release(self):
        stage = self.job('stage-web')
        self.assertIn('web.py stage', stage)
        self.assertNotIn('web.py deploy', stage)
        self.assertIn("inputs.managed_environment == 'production'", stage)
        self.assertIn("inputs.pages_rollback_id == ''", stage)
        self.assertIn('continue-on-error: true', stage)
        self.assertIn('needs: [prepare-web, prepare-release]', stage)


if __name__ == '__main__':
    unittest.main()
