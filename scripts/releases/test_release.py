"""Behavior checks for cut, exact selection, corruption, envelopes and recovery."""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import release
import web
from github_release import GitHub, cut_decision, digest, held_candidates

SHA = subprocess.check_output(['git', 'rev-parse', 'origin/master'], cwd=release.ROOT, text=True).strip()
NOW = datetime(2026, 10, 17, tzinfo=timezone.utc)


def held(identity=1, sha=SHA, date='2026-09-01T02:00:00Z', status='success', proof='passed'):
    return dict(id=identity, created_at=date, latest_status=status,
                payload=dict(channel='nightly-cut', target_sha=sha, proof_result=proof, run_id='1',
                             release_id='source', manifest_artifact_id='2', manifest_sha256='a' * 64))


class CutTests(unittest.TestCase):
    def test_daily_and_no_change_rules(self):
        self.assertTrue(cut_decision(SHA, [], NOW)[0])
        self.assertFalse(cut_decision(SHA, [held()], NOW)[0])
        self.assertTrue(cut_decision('b' * 40, [held()], NOW)[0])
        today = held(date='2026-10-17T02:00:00Z')
        self.assertFalse(cut_decision('b' * 40, [today], NOW)[0])
        self.assertTrue(cut_decision(SHA, [today], NOW, manual=True)[0])

    def test_failed_cut_never_advances_baseline_and_next_day_retries(self):
        records = [held(2, 'b' * 40, '2026-10-16T02:00:00Z', status='failure', proof='failed'), held()]
        self.assertTrue(cut_decision('b' * 40, records, NOW)[0])
        self.assertTrue(cut_decision('b' * 40, records, NOW, manual=True)[0])
        records[0]['created_at'] = '2026-10-17T02:00:00Z'
        self.assertFalse(cut_decision('b' * 40, records, NOW)[0])
        self.assertTrue(cut_decision('b' * 40, records, NOW, manual=True)[0])

    def test_newest_held_has_no_age_cutoff_and_has_stable_tie_break(self):
        records = [held(1), held(2), held(3, status='failure'), held(4, proof='failed'), held(5, status='inactive')]
        self.assertEqual([item['id'] for item in held_candidates(records)], [2, 1])

    def test_invalid_newest_does_not_fall_back(self):
        api = object.__new__(GitHub)
        api.repository = 'Q9Labs/chalk'
        run = dict(head_branch='master', head_repository={'full_name': api.repository},
                   path='.github/workflows/nightly.yml', event='schedule')
        with patch.object(api, 'deployments', return_value=[held(1), held(2)]), patch.object(api, 'request', return_value=run):
            with patch.object(api, 'artifact', side_effect=ValueError('corrupt newest')) as download:
                with self.assertRaisesRegex(ValueError, 'corrupt newest'):
                    release.select(api, SimpleNamespace())
        self.assertEqual(download.call_count, 1)

    def test_latest_gate_failure_masks_old_success_not_the_reverse(self):
        api = object.__new__(GitHub)
        old = dict(run_number=1, run_attempt=1, head_sha=SHA, head_branch='master', event='push', conclusion='success')
        new = {**old, 'run_number': 2, 'conclusion': 'failure'}
        with patch.object(api, 'pages', return_value=[old, new]):
            with self.assertRaisesRegex(ValueError, 'latest master Gate'):
                api.gate(SHA)
        with patch.object(api, 'pages', return_value=[old, {**old, 'run_attempt': 2, 'conclusion': None}]):
            with self.assertRaises(ValueError):
                api.gate(SHA)

    def test_shared_invalidation_never_loses_the_completed_cut_baseline(self):
        item = held()
        def status(*_):
            item['latest_status'] = 'inactive'
        release.invalidate(SimpleNamespace(deployments=lambda _: [item], request=status), None)
        self.assertEqual(held_candidates([item]), [])
        self.assertFalse(cut_decision(SHA, [item], NOW)[0])
        self.assertTrue(cut_decision('b' * 40, [item], NOW)[0])


class ArtifactTests(unittest.TestCase):
    def test_authenticated_artifact_corruption_and_expiry(self):
        api = object.__new__(GitHub)
        api.repository = 'Q9Labs/chalk'
        artifact = dict(name='manifest', expired=False, workflow_run={'id': 1})

        def download(command, **_):
            Path(command[command.index('--dir') + 1], 'release.json').write_bytes(b'changed')

        with patch.object(api, 'request', return_value=artifact), patch('github_release.subprocess.run', side_effect=download):
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                api.artifact('1', '2', 'release.json', digest(b'original'))
            self.assertEqual(api.artifact('1', '2', 'release.json', digest(b'changed')), b'changed')
        with patch.object(api, 'request', return_value={**artifact, 'expired': True}):
            with self.assertRaisesRegex(ValueError, 'expired'):
                api.artifact('1', '2', 'release.json')

    def test_prepare_refuses_corrupt_source_before_generating_envelope(self):
        api = object.__new__(GitHub)
        api.repository = 'Q9Labs/chalk'
        run = dict(head_branch='master', head_repository={'full_name': api.repository},
                   path='.github/workflows/ci.yml', event='workflow_dispatch')
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'not-created'
            with patch.dict(os.environ, SOURCE_RUN_ID='1', SOURCE_RELEASE_ID='source', SOURCE_ARTIFACT_ID='2', SOURCE_SHA256='a' * 64, TARGET_SHA=SHA):
                with patch.object(api, 'request', return_value=run), patch.object(api, 'artifact', side_effect=ValueError('checksum mismatch')):
                    with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                        release.prepare(api, SimpleNamespace(reuse=True, directory=output))
            self.assertFalse(output.exists())


class EnvelopeTests(unittest.TestCase):
    def test_redeploy_and_rollback_use_real_generator_and_keep_component_identities(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = root / 'repo'
            shutil.copytree(release.ROOT / 'infrastructure/managed-episode', repo / 'infrastructure/managed-episode')
            shutil.copytree(release.ROOT / 'apps/api/db/migrations', repo / 'apps/api/db/migrations')
            for command in (['git', 'init', '-q', str(repo)], ['git', '-C', str(repo), 'add', '.'],
                            ['git', '-C', str(repo), '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture']):
                subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
            sha = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
            source = root / 'source.json'
            generator = repo / 'infrastructure/managed-episode/scripts/generate-release-manifest'
            image = 'example.com/chalk@sha256:' + 'a' * 64
            subprocess.run([str(generator), '--api-image', image, '--sync-image', image,
                            '--source-revision', sha, '--output', str(source)], check=True, stdout=subprocess.DEVNULL)
            original = json.loads(source.read_bytes())
            (repo / 'apps/api/db/migrations/20261201000000_future.sql').write_text('-- later migration\n')
            subprocess.run(['git', '-C', str(repo), 'add', '.'], check=True)
            subprocess.run(['git', '-C', str(repo), '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'later source'], check=True)
            with patch.object(release, 'ROOT', repo):
                promoted = release.fresh_envelope(source, root / 'promoted.json')
                rollback = release.fresh_envelope(source, root / 'rollback.json')
            self.assertEqual(len({original['release_id'], promoted['release_id'], rollback['release_id']}), 3)
            for applied in (promoted, rollback):
                self.assertEqual(applied['images'], original['images'])
                self.assertEqual(applied['component_releases'], original['component_releases'])
                self.assertEqual(applied['source_revision'], original['source_revision'])
                self.assertEqual(applied['database_compatibility'], original['database_compatibility'])

    def test_pages_rollback_restores_exact_saved_identity_without_archives(self):
        with patch.object(web, 'pages', return_value={'id': 'saved'}) as request:
            with patch.object(web, 'current', return_value='saved'):
                web.rollback('chalk-web', 'saved')
            request.assert_called_once_with('chalk-web', '/deployments/saved/rollback', 'POST')
        with patch.object(web, 'pages', return_value={'id': 'other'}):
            with self.assertRaisesRegex(ValueError, 'did not restore'):
                web.rollback('chalk-web', 'saved')

    def test_previous_production_uses_deploy_result_and_manifest_not_nightly_archive(self):
        api = SimpleNamespace(repository='Q9Labs/chalk')
        def pages(route, key):
            if '/ci.yml/' in route:
                return [dict(id=100), dict(id=200)]
            if '/promote.yml/' in route:
                return []
            run = int(route.split('/')[2])
            if '/jobs?' in route:
                return [dict(id=run, name='Deploy managed release to production', conclusion='success',
                             completed_at='2026-10-17T12:00:00Z' if run == 100 else '2026-10-16T12:00:00Z')]
            return [dict(id=run+2, name=f'managed-deployment-release{run}'), dict(id=run+1, name=f'release-manifest-release{run}')]
        api.pages = pages
        api.artifact = lambda run, identity, name, *args: json.dumps(
            dict(release_id=f'release{run}', status='deployed', health='passed', deployment_phase='complete', rolled_back=False)
            if name == 'managed-deployment.json' else dict(release_id=f'release{run}', source_revision=SHA)).encode()
        api.request = lambda _: dict(head_branch='master', head_repository={'full_name': api.repository}, path='.github/workflows/ci.yml', event='workflow_dispatch')
        previous = release.previous_production(api)
        self.assertEqual(previous['release_id'], 'release100')
        self.assertEqual(previous['run_id'], '100')
        self.assertNotIn('web', previous)



if __name__ == '__main__':
    unittest.main()
