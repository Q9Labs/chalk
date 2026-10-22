"""Behavior checks for cut, exact selection, corruption, envelopes and recovery."""

import json
import io
import os
import shutil
import subprocess
import tempfile
import tarfile
import textwrap
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


class MemoryGitHub(GitHub):
    """Offline GitHub boundary with durable deployment and artifact responses."""
    def __init__(self):
        self.repository = 'Q9Labs/chalk'
        self.items = []
        self.archives = {}
        self.tip = SHA
        self.dispatches = 0
        self.created_at = '2026-10-17T02:00:00Z'
        self.gates = [dict(run_number=1, run_attempt=1, head_sha=SHA, head_branch='master',
                           event='push', conclusion='success')]

    def dispatch_nightly(self):
        self.dispatches += 1

    def info(self, run, identity):
        data = json.dumps(dict(release_id=identity, source_revision=SHA)).encode()
        return dict(run_id=run, release_id=identity, applied_release_id=identity,
                    manifest_artifact_id='10', manifest_sha256=digest(data), media_sha256=digest(b'{}'),
                    web=json.dumps({target: dict(artifact_id='20', sha256=digest(self.archive(target)))
                                    for target in ('nightly', 'production')}))

    def archive(self, target):
        if target in self.archives:
            return self.archives[target]
        result = io.BytesIO()
        with tarfile.open(fileobj=result, mode='w:gz') as archive:
            data = json.dumps(dict(environment=target, commit=SHA)).encode()
            member = tarfile.TarInfo('dist/client/release.json')
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
        self.archives[target] = result.getvalue()
        return self.archives[target]

    def request(self, route, data=None):
        if route == 'git/ref/heads/master':
            return dict(object=dict(sha=self.tip))
        if route == 'deployments':
            item = dict(data, id=len(self.items) + 1, created_at=self.created_at, latest_status='pending')
            self.items.append(item)
            return item
        if '/statuses' in route:
            self.items[int(route.split('/')[1]) - 1]['latest_status'] = data['state']
            return {}
        return dict(head_branch='master', head_repository={'full_name': self.repository},
                    path='.github/workflows/nightly.yml', event='schedule')

    def deployments(self, environment, task='nightly-cut', sha=None, manifest_sha256=None):
        return [item for item in reversed(self.items) if item.get('environment') == environment
                and (task != 'production-release' or item['latest_status'] == 'success')
                and item['payload'].get('channel') == task
                and (not sha or item['payload'].get('target_sha') == sha)
                and (not manifest_sha256 or item['payload'].get('manifest_sha256') == manifest_sha256)]

    def pages(self, route, key):
        if '/workflows/gate.yml/' in route:
            return self.gates
        if '/workflows/ci.yml/' in route:
            return [dict(id=10)]
        if '/jobs?' in route:
            return [dict(id=10, name='Deploy managed release to production', conclusion='success',
                         completed_at='2026-10-16T02:00:00Z')]
        if '/artifacts' in route:
            return [dict(id=30, name='managed-deployment-previous'), dict(id=31, name='release-manifest-previous')]
        return []

    def artifact(self, run, identity, name, expected=None):
        if name.endswith('.media.json'):
            return b'{}'
        if name == 'managed-deployment.json':
            return json.dumps(dict(release_id='previous', status='deployed', health='passed',
                                   deployment_phase='complete', rolled_back=False)).encode()
        data = self.archive(name[4:-7]) if name.startswith('web-') else json.dumps(
            dict(release_id=name[:-5], source_revision=SHA)).encode()
        if expected is not None and digest(data) != expected:
            raise ValueError('checksum mismatch')
        return data


class CutTests(unittest.TestCase):
    @patch.dict(os.environ, GITHUB_OUTPUT=os.devnull, TARGET_SHA=SHA)
    @patch.dict(os.environ, GITHUB_RUN_ID='1')
    def test_cut_requires_both_proofs_and_records_each_result(self):
        for real_call, web_e2e, expected in [('passed', 'passed', True), ('failed', 'passed', False),
                                             ('passed', 'failed', False), ('passed', '', False),
                                             ('passed', 'cancelled', False)]:
            with self.subTest(real_call=real_call, web_e2e=web_e2e):
                api = MemoryGitHub()
                with patch.dict(os.environ, RELEASE_ID='A'):
                    release.invalidate(api, None)
                with patch.dict(os.environ, RELEASE=json.dumps(api.info('1', 'A')),
                                DEPLOY_RESULT='success', PROOF_RESULT=real_call, WEB_E2E_RESULT=web_e2e):
                    release.record(api, None)
                cut = api.items[-1]
                self.assertEqual(cut['latest_status'], 'success' if expected else 'failure')
                self.assertEqual(cut['payload']['real_call_proof_result'], real_call)
                self.assertEqual(cut['payload']['web_e2e_result'], web_e2e)
                self.assertEqual(cut['payload']['proof_result'], 'passed' if expected else 'failed')

    @patch.dict(os.environ, GITHUB_OUTPUT=os.devnull, TARGET_SHA=SHA)
    def test_old_web_retry_cannot_replace_new_backend_or_held_nightly(self):
        api = MemoryGitHub()
        for run, identity in [('1', 'A'), ('2', 'B')]:
            with patch.dict(os.environ, GITHUB_RUN_ID=run, RELEASE_ID=identity):
                release.invalidate(api, None)  # backend succeeds; A's web fails before recording
                if identity == 'B':
                    with patch.dict(os.environ, EXPECTED_BACKEND_RELEASE_ID=identity):
                        release.invalidate(api, None)
                    with patch.dict(os.environ, RELEASE=json.dumps(api.info(run, identity)), DEPLOY_RESULT='success', PROOF_RESULT='passed', WEB_E2E_RESULT='passed'):
                        release.record(api, None)
        before = json.dumps(api.items)
        with patch.dict(os.environ, GITHUB_RUN_ID='1', EXPECTED_BACKEND_RELEASE_ID='A'):
            with self.assertRaisesRegex(ValueError, "a newer nightly write replaced this run's backend"):
                release.invalidate(api, None)
        self.assertEqual(json.dumps(api.items), before)
        with patch.dict(os.environ, GITHUB_RUN_ID='1', RELEASE=json.dumps(api.info('1', 'A')), DEPLOY_RESULT='success', PROOF_RESULT='passed', WEB_E2E_RESULT='passed'):
            with self.assertRaisesRegex(ValueError, 'newer nightly write'):
                release.record(api, None)
        with patch.dict(os.environ, GITHUB_RUN_ID='2', RELEASE=json.dumps(api.info('2', 'B')), DEPLOY_RESULT='success', PROOF_RESULT='passed', WEB_E2E_RESULT='passed'):
            release.record(api, None)
        self.assertEqual({item['payload']['release_id'] for item in held_candidates(api.items)}, {'B'})
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'output'
            with patch.dict(os.environ, GITHUB_OUTPUT=str(output), GITHUB_STEP_SUMMARY=str(Path(directory) / 'summary')):
                release.select(api, None)
            selection = json.loads(output.read_text().split('selection=', 1)[1])
        self.assertEqual(selection['selection']['release_id'], 'B')

    @patch.dict(os.environ, GITHUB_OUTPUT=os.devnull, TARGET_SHA=SHA, GITHUB_RUN_ID='1', RELEASE_ID='A')
    def test_web_requires_both_backend_run_and_applied_identity(self):
        api = MemoryGitHub()
        release.invalidate(api, None)
        before = json.dumps(api.items)
        for run, identity in [('1', 'B'), ('2', 'A')]:
            with self.subTest(run=run, identity=identity), patch.dict(os.environ, GITHUB_RUN_ID=run, EXPECTED_BACKEND_RELEASE_ID=identity):
                with self.assertRaisesRegex(ValueError, "newer nightly write replaced this run's backend"):
                    release.invalidate(api, None)
                self.assertEqual(json.dumps(api.items), before)

    @patch.dict(os.environ, GITHUB_OUTPUT=os.devnull)
    def test_old_record_retry_cannot_replace_new_held_nightly(self):
        api = MemoryGitHub()
        for run, identity in [('1', 'A'), ('2', 'B')]:
            with patch.dict(os.environ, GITHUB_RUN_ID=run, RELEASE_ID=identity, TARGET_SHA=SHA):
                release.invalidate(api, None)
                if identity == 'B':
                    with patch.dict(os.environ, RELEASE=json.dumps(api.info(run, identity)), DEPLOY_RESULT='success', PROOF_RESULT='passed', WEB_E2E_RESULT='passed'):
                        release.record(api, None)
        with patch.dict(os.environ, GITHUB_RUN_ID='1', TARGET_SHA=SHA, RELEASE=json.dumps(api.info('1', 'A')),
                        DEPLOY_RESULT='success', PROOF_RESULT='passed', WEB_E2E_RESULT='passed'):
            with self.assertRaisesRegex(ValueError, 'newer nightly write'):
                release.record(api, None)
        self.assertEqual([item['payload']['release_id'] for item in held_candidates(api.items)], ['B'])

    @patch.dict(os.environ, GITHUB_OUTPUT=os.devnull, TARGET_SHA=SHA)
    def test_manual_web_write_revokes_held_even_when_invalidation_is_interrupted(self):
        api = MemoryGitHub()
        with patch.dict(os.environ, GITHUB_RUN_ID='1', RELEASE_ID='A'):
            release.invalidate(api, None)
            with patch.dict(os.environ, RELEASE=json.dumps(api.info('1', 'A')), DEPLOY_RESULT='success', PROOF_RESULT='passed', WEB_E2E_RESULT='passed'):
                release.record(api, None)
        # Simulate API loss after the durable marker but before the inactive status.
        request = api.request
        def interrupted(route, data=None):
            if '/statuses' in route:
                raise ValueError('connection lost')
            return request(route, data)
        with patch.object(api, 'request', side_effect=interrupted), patch.dict(os.environ, GITHUB_RUN_ID='2', RELEASE_ID=''):
            with self.assertRaisesRegex(ValueError, 'connection lost'):
                release.invalidate(api, None)
        self.assertTrue(held_candidates(api.items))
        with self.assertRaisesRegex(ValueError, 'newer nightly write'):
            release.select(api, None)

    @patch.dict(os.environ, GITHUB_OUTPUT=os.devnull, TARGET_SHA=SHA, GITHUB_RUN_ID='1', RELEASE_ID='A')
    def test_same_run_web_write_keeps_the_applied_identity_recordable(self):
        api = MemoryGitHub()
        release.invalidate(api, None)  # backend
        with patch.dict(os.environ, EXPECTED_BACKEND_RELEASE_ID='A'):
            release.invalidate(api, None)  # web
        with patch.dict(os.environ, RELEASE=json.dumps(api.info('1', 'A')), DEPLOY_RESULT='success', PROOF_RESULT='passed', WEB_E2E_RESULT='passed'):
            release.record(api, None)
        self.assertEqual([item['payload']['release_id'] for item in held_candidates(api.items)], ['A'])

    def test_gap_gate_and_no_change_rules(self):
        self.assertTrue(cut_decision(SHA, [], NOW)[0])
        self.assertFalse(cut_decision(SHA, [held()], NOW)[0])
        self.assertTrue(cut_decision('b' * 40, [held()], NOW)[0])
        recent = held(date='2026-10-16T18:00:01Z')
        self.assertFalse(cut_decision('b' * 40, [recent], NOW)[0])
        self.assertTrue(cut_decision(SHA, [recent], NOW, manual=True)[0])
        self.assertTrue(cut_decision('b' * 40, [held(date='2026-10-16T18:00:00Z')], NOW)[0])

    def test_completion_does_not_restart_the_reservation_cooldown(self):
        attempt = dict(created_at='2026-10-16T18:00:00Z', payload=dict(channel='nightly-attempt'))
        completed = held(date='2026-10-16T22:00:00Z')
        self.assertTrue(cut_decision('b' * 40, [completed, attempt], NOW)[0])
        self.assertFalse(cut_decision('b' * 40, [completed], NOW)[0])

    def test_failed_cut_never_advances_baseline_and_next_day_retries(self):
        records = [held(2, 'b' * 40, '2026-10-16T02:00:00Z', status='failure', proof='failed'), held()]
        self.assertTrue(cut_decision('b' * 40, records, NOW)[0])
        self.assertTrue(cut_decision('b' * 40, records, NOW, manual=True)[0])
        records[0]['created_at'] = '2026-10-17T02:00:00Z'
        self.assertFalse(cut_decision('b' * 40, records, NOW)[0])
        self.assertTrue(cut_decision('b' * 40, records, NOW, manual=True)[0])

    def test_reserved_cut_consumes_day_without_advancing_completed_baseline(self):
        api = object.__new__(GitHub)
        with patch.object(api, 'request') as request:
            api.reserve_cut(SHA)
        reservation = request.call_args.args[1]
        reservation.update(id=2, created_at='2026-10-17T02:00:00Z')
        self.assertFalse(cut_decision(SHA, [reservation], NOW)[0])
        tomorrow = datetime(2026, 10, 18, tzinfo=timezone.utc)
        self.assertTrue(cut_decision(SHA, [reservation], tomorrow)[0])
        self.assertEqual(held_candidates([reservation], held=False), [])

    def test_newest_held_has_no_age_cutoff_and_has_stable_tie_break(self):
        records = [held(1), held(2), held(3, status='failure'), held(4, proof='failed'), held(5, status='inactive')]
        self.assertEqual([item['id'] for item in held_candidates(records)], [2, 1])

    def test_invalid_newest_does_not_fall_back(self):
        api = object.__new__(GitHub)
        api.repository = 'Q9Labs/chalk'
        run = dict(head_branch='master', head_repository={'full_name': api.repository},
                   path='.github/workflows/nightly.yml', event='schedule')
        records = [held(1), held(2), dict(id=3, created_at='2026-09-01T02:00:00Z',
                   payload=dict(channel='nightly-write', run_id='1', release_id='source'))]
        records[1]['payload']['applied_release_id'] = 'source'
        with patch.object(api, 'deployments', side_effect=lambda environment, *args, **kwargs: records if environment == 'nightly' else []), patch.object(api, 'request', return_value=run):
            with patch.object(api, 'artifact', side_effect=ValueError('corrupt newest')) as download:
                with self.assertRaisesRegex(ValueError, 'corrupt newest'):
                    release.select(api, SimpleNamespace())
        self.assertEqual(download.call_count, 1)

    def test_latest_gate_failure_masks_old_success_not_the_reverse(self):
        api = object.__new__(GitHub)
        old = dict(run_number=1, run_attempt=1, head_sha=SHA, head_branch='master', event='push', conclusion='success')
        new = {**old, 'run_number': 2, 'conclusion': 'failure'}
        with patch.object(api, 'pages', return_value=[old, new]):
            self.assertFalse(api.has_green_gate(SHA))
        with patch.object(api, 'pages', return_value=[old, {**old, 'run_attempt': 2, 'conclusion': None}]):
            self.assertFalse(api.has_green_gate(SHA))

    FRESH = dict(GITHUB_EVENT_NAME='workflow_dispatch', TARGET_SHA=SHA, MANIFEST_RUN_ID='', PAGES_ROLLBACK_ID='', RELEASE_MANAGED='true', DEPLOY_MANAGED='false', DEPLOY_WEB='false')

    def require_gate(self, runs, **inputs):
        api = object.__new__(GitHub)
        with patch.dict(os.environ, {**self.FRESH, **inputs}), patch.object(api, 'pages', return_value=runs) as pages:
            release.require_gate(api, None)
        return pages

    def test_fresh_release_needs_a_green_master_gate_for_the_exact_target(self):
        master = dict(run_number=1, run_attempt=1, head_sha=SHA, head_branch='master', event='push', conclusion='success')
        pages = self.require_gate([master])
        self.assertIn(f'head_sha={SHA}&branch=master', pages.call_args.args[0])
        for name, runs in [('pull request Gate only', [{**master, 'event': 'pull_request'}]),
                           ('failed master Gate', [{**master, 'conclusion': 'failure'}]),
                           ('no Gate run', [])]:
            with self.subTest(name), self.assertRaisesRegex(ValueError, 'no successful Gate run on master'):
                self.require_gate(runs)

    def test_rollback_without_a_new_build_deploys_without_a_gate_check(self):
        for inputs in (dict(MANIFEST_RUN_ID='123', PAGES_ROLLBACK_ID='456', DEPLOY_WEB='true'),
                       dict(MANIFEST_RUN_ID='123', DEPLOY_MANAGED='true'),
                       dict(RELEASE_MANAGED='false')):
            with self.subTest(**inputs):
                self.require_gate([], **inputs).assert_not_called()

    def test_rollback_input_does_not_excuse_a_fresh_build(self):
        for inputs in (dict(PAGES_ROLLBACK_ID='456', RELEASE_MANAGED='false', DEPLOY_WEB='true'),
                       dict(PAGES_ROLLBACK_ID='456', DEPLOY_MANAGED='true')):
            with self.subTest(**inputs), self.assertRaisesRegex(ValueError, 'no successful Gate run on master'):
                self.require_gate([], **inputs)

    def test_gate_check_mirrors_the_fresh_build_jobs(self):
        workflow = (release.ROOT / '.github/workflows/ci.yml').read_text()
        self.assertIn("    needs: require-gate\n    if: (inputs.release_managed || inputs.deploy_managed) && inputs.manifest_run_id == ''\n", workflow)
        self.assertIn("!cancelled() && needs.require-gate.result == 'success' && inputs.deploy_web && inputs.manifest_run_id == ''\n", workflow)

    @patch.dict(os.environ, TARGET_SHA=SHA, GITHUB_RUN_ID='1')
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
            with patch.dict(os.environ, SOURCE_RUN_ID='1', SOURCE_RELEASE_ID='source', SOURCE_ARTIFACT_ID='2', SOURCE_SHA256='a' * 64, TARGET_SHA=SHA, MANAGED_ENVIRONMENT='production'):
                with patch.object(api, 'request', side_effect=lambda route: [] if route.startswith('deployments?') else run), patch.object(api, 'artifact', side_effect=ValueError('checksum mismatch')):
                    with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                        release.prepare(api, SimpleNamespace(reuse=True, directory=output))
            self.assertFalse(output.exists())


class RecoveryTests(unittest.TestCase):
    def run_result(self, directory):
        workflow = (release.ROOT / '.github/workflows/promote.yml').read_text()
        step = workflow.split('      - name: Failed promotion stays failed; require explicit recovery evidence\n')[1]
        command = step.split('      - name:', 1)[0].split('        run:', 1)[1]
        command = textwrap.dedent(command.split('\n', 1)[1]) if command.startswith(' |') else command.strip()
        return subprocess.run(['bash', '-e', '-c', command], cwd=directory, capture_output=True, text=True)

    def test_cancelled_promote_requires_exact_backend_and_pages_evidence(self):
        previous = dict(target_sha=SHA, release_id='previous', run_id='10', manifest_artifact_id='20', manifest_sha256='a' * 64)
        evidence = dict(restored_source_release_id='previous', release_id='fresh-recovery',
                        applied_release_id='fresh-recovery', pages_deployment_id='saved-pages')
        cases = [('success', evidence, True), ('skipped', evidence, False), ('cancelled', evidence, False),
                 ('failure', evidence, False), ('success', {}, False),
                 ('success', {**evidence, 'restored_source_release_id': 'other'}, False),
                 ('success', {**evidence, 'applied_release_id': 'other'}, False),
                 ('success', {**evidence, 'pages_deployment_id': 'other'}, False)]
        with tempfile.TemporaryDirectory() as directory:
            summary = Path(directory) / 'summary.md'
            for status, rollback, recovered in cases:
                with self.subTest(status=status, rollback=rollback):
                    summary.write_text('')
                    with patch.dict(os.environ, GITHUB_STEP_SUMMARY=str(summary), DEPLOY_RESULT='cancelled', PROOF_RESULT='failed',
                                    SELECTION=json.dumps(dict(previous=previous, selection={'release_id': 'nightly'})),
                                    ROLLBACK_RESULT=status, ROLLBACK=json.dumps(rollback), PAGES_ID='saved-pages'):
                        result = self.run_result(directory)
                        self.assertNotEqual(result.returncode, 0)
                        self.assertIn('promotion failed', result.stderr)
                    text = summary.read_text()
                    if recovered:
                        self.assertIn('RECOVERY VERIFIED', text)
                        self.assertNotIn('manual recovery', text)
                    else:
                        self.assertIn('RECOVERY NOT RUN — manual recovery required', text)
                        manual = json.loads(text.split('```json\n')[1].split('```')[0])
                        self.assertEqual(manual['reuse_release_id'], 'previous')
                        self.assertEqual(manual['manifest_run_id'], '10')
                        self.assertEqual(manual['manifest_artifact_id'], '20')
                        self.assertEqual(manual['manifest_sha256'], 'a' * 64)
                        self.assertEqual(manual['target_sha'], SHA)
                        self.assertEqual(manual['pages_rollback_id'], 'saved-pages')
                        self.assertEqual(manual['managed_environment'], 'production')
                        self.assertTrue(manual['deploy_managed'] and manual['deploy_web'])
                        self.assertFalse(manual['release_managed'])

    def test_passing_promotion_does_not_require_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, GITHUB_STEP_SUMMARY=str(Path(directory) / 'summary'), DEPLOY_RESULT='success',
                            PROOF_RESULT='passed', WEB_E2E_RESULT='passed', SELECTION=json.dumps(dict(previous={}, selection={'release_id': 'nightly'}))):
                result = self.run_result(directory)
                self.assertEqual(result.returncode, 0, result.stderr)


class WebBuildTests(unittest.TestCase):
    def test_manual_source_requires_full_sha_and_exact_checkout(self):
        for sha, message in [('master', 'full source SHA'), ('a' * 40, 'checkout does not match')]:
            with self.subTest(sha=sha), self.assertRaisesRegex(ValueError, message):
                web.build('production', sha, Path('/not-created'), release.ROOT)

    def test_build_uses_requested_source_without_requiring_release_tooling_there(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'old-source'
            source.mkdir()
            subprocess.run(['git', 'init', '-q', str(source)], check=True)
            (source / 'apps/web').mkdir(parents=True)
            (source / 'apps/web/wrangler.toml').write_text('name = "fixture"\n[vars]\nold = true\n')
            subprocess.run(['git', '-C', str(source), 'add', '.'], check=True)
            subprocess.run(['git', '-C', str(source), '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
                            'commit', '-qm', 'source predating release tooling'], check=True)
            sha = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
            # Stand in only for the external builder; exercise the public orchestration and archive.
            builder = root / 'pnpm'
            builder.write_text('#!/bin/sh\nset -eu\nmkdir -p apps/web/dist/client\nprintf old-source > apps/web/dist/client/index.html\n')
            builder.chmod(0o755)
            with patch.dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH']):
                web.build('production', sha, root / 'output', source)
            data = (root / 'output/web-production.tar.gz').read_bytes()
            self.assertEqual(web.read_marker(data), dict(environment='production', commit=sha))
            with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
                self.assertEqual(archive.extractfile('dist/client/index.html').read(), b'old-source')
            self.assertFalse((source / 'scripts/releases/web.py').exists())


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
            runtime = repo / 'infrastructure/managed-episode'
            old_files = {name: (runtime / name).read_bytes() for name in original['runtime_artifacts']}
            for name in ('controller/chalk-deployment-controller', 'scripts/generate-release-manifest', 'contracts/release-manifest.schema.json'):
                path = runtime / name
                if path.exists():
                    path.write_bytes(path.read_bytes() + b'\n')
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
                self.assertEqual(applied['runtime_artifacts'], original['runtime_artifacts'])
                # Reproduce the SSM source archive selection offline, from the
                # actual document command, then verify every installed file.
                document = json.loads((runtime / 'ssm/chalk-managed-episode-deploy.json').read_bytes())
                commands = document['mainSteps'][0]['inputs']['runCommand']
                fetch = next(line for line in commands if line.startswith('curl '))
                self.assertIn('archive/$SSM_SourceRevision.tar.gz', fetch)
                archive = subprocess.check_output(['git', '-C', str(repo), 'archive', '--format=tar', applied['source_revision']])
                with tarfile.open(fileobj=io.BytesIO(archive)) as source_archive:
                    for name, expected in applied['runtime_artifacts'].items():
                        installed = source_archive.extractfile('infrastructure/managed-episode/' + name).read()
                        self.assertEqual(installed, old_files[name])
                        self.assertEqual(digest(installed), expected)

    def test_pages_rollback_restores_exact_saved_identity_without_archives(self):
        os.environ.setdefault('GITHUB_OUTPUT', os.devnull)
        with patch.object(web, 'pages', return_value={'id': 'saved'}) as request:
            with patch.object(web, 'current', return_value='saved'):
                web.rollback('chalk-web', 'saved')
            request.assert_called_once_with('chalk-web', '/deployments/saved/rollback', 'POST')
        with patch.object(web, 'pages', return_value={'id': 'other'}):
            with self.assertRaisesRegex(ValueError, 'did not restore'):
                web.rollback('chalk-web', 'saved')

    def test_previous_production_uses_deploy_result_and_manifest_not_nightly_archive(self):
        api = SimpleNamespace(repository='Q9Labs/chalk', deployments=lambda *args, **kwargs: [])
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
        writes = []
        def request(route, data=None):
            if data:
                writes.append((route, data))
            return dict(id=99, head_branch='master', head_repository={'full_name': api.repository}, path='.github/workflows/ci.yml', event='workflow_dispatch')
        api.request = request
        previous = release.previous_production(api)
        self.assertEqual(writes, [])
        self.assertEqual(release.previous_production(api, retain_legacy=True), previous)
        self.assertEqual(previous['release_id'], 'release100')
        self.assertEqual(previous['run_id'], '100')
        self.assertNotIn('web', previous)
        self.assertEqual(writes[0][1]['task'], 'production-release')
        self.assertEqual(release.retained_manifest(writes[0][1]['payload']),
                         json.dumps(dict(release_id='release100', source_revision=SHA)).encode())
        self.assertEqual(writes[1], ('deployments/99/statuses', dict(state='success', auto_inactive=False)))



if __name__ == '__main__':
    unittest.main()
