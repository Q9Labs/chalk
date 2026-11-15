"""The web archive is uploaded as a preview while the API deploys; only a successful API deploy lets deploy-web move the alias."""

import io
import json
import os
import re
import tarfile
import tempfile
import unittest
from pathlib import Path
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

    def archive(self, environment):
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode='w:gz') as tar:
            tar.addfile(tarfile.TarInfo('dist/client/index.html'))
            marker = json.dumps(dict(environment=environment, commit=SHA)).encode()
            release = tarfile.TarInfo('dist/client/release.json')
            release.size = len(marker)
            tar.addfile(release, io.BytesIO(marker))
        return archive.getvalue()

    def run_command(self, command):
        archive = self.archive('production')
        member = dict(sha256='a' * 64, artifact_id='1')
        calls = []
        github = Mock()
        github.return_value.artifact.return_value = archive
        with (patch.object(web, 'GitHub', github), patch.dict(os.environ, CLOUDFLARE_ACCOUNT_ID='account'),
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

    def rehearse(self, target='nightly', delay=0):
        """Runs the real rehearsal against a fake Pages API, a fake wrangler and a fake artifact store: `delay` is how many reads
        of the project go by after the upload before Pages makes it the live deployment (never, when it is larger than the polls)."""
        pages = dict(live='old', uploaded=False, delay=delay, rollbacks=[], branches=[])

        def urlopen(request, timeout=None):
            if request.get_method() == 'POST':
                deployment = request.full_url.split('/deployments/')[1].split('/')[0]
                pages.update(live=deployment, uploaded=False)
                rollbacks = pages['rollbacks']
                rollbacks.append(deployment)
                result = dict(id=deployment)
            else:
                if pages['uploaded'] and pages['delay'] <= 0:
                    pages.update(live='new', uploaded=False)
                pages['delay'] -= 1
                result = dict(canonical_deployment=dict(id=pages['live'], environment='production', latest_stage=dict(status='success')))
            return io.BytesIO(json.dumps(dict(success=True, result=result)).encode())

        def run(command, **kwargs):
            if command[0].endswith('wrangler'):
                pages['branches'].append(command[command.index('--branch') + 1])
                pages['uploaded'] = True

        github = Mock()
        github.return_value.artifact.return_value = self.archive(target)
        with tempfile.TemporaryDirectory() as directory:
            environment = dict(CLOUDFLARE_ACCOUNT_ID='account', CLOUDFLARE_API_TOKEN='token', GITHUB_OUTPUT=str(Path(directory) / 'output'))
            with (patch.object(web, 'GitHub', github), patch.dict(os.environ, environment), patch.object(web.subprocess, 'run', side_effect=run),
                  patch.object(web.urllib.request, 'urlopen', side_effect=urlopen), patch.object(web.time, 'sleep')):
                try:
                    web.rehearse_rollback(target, SHA, RUN, dict(sha256='a' * 64, artifact_id='1'), 'chalk-nightly')
                finally:
                    pages['output'] = (Path(directory) / 'output').read_text() if (Path(directory) / 'output').exists() else ''
        return pages

    def test_the_rehearsal_uploads_to_the_production_branch_then_restores_the_saved_deployment(self):
        pages = self.rehearse()
        self.assertEqual(pages['branches'], [web.PRODUCTION_BRANCH])
        self.assertEqual(pages['live'], 'old')
        self.assertEqual(pages['rollbacks'], ['old'])
        self.assertEqual(pages['output'], 'pages_deployment_id=old\n')

    def test_the_rehearsal_waits_for_the_upload_to_go_live(self):
        pages = self.rehearse(delay=3)
        self.assertEqual((pages['live'], pages['rollbacks']), ('old', ['old']))

    def test_the_rehearsal_never_touches_production(self):
        with self.assertRaises(ValueError):
            self.rehearse('production')

    def test_the_rehearsal_fails_when_the_upload_never_goes_live(self):
        with self.assertRaisesRegex(ValueError, 'did not become the live'):
            self.rehearse(delay=100)

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
