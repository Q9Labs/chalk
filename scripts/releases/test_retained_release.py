"""Public release operations with an offline GitHub transport and real files."""

import base64
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import release
from github_release import GitHub, digest
from test_release import MemoryGitHub, SHA


class RetainedReleaseTests(unittest.TestCase):
    def test_rollback_prepares_exact_retained_bytes_after_all_actions_data_expires(self):
        api = MemoryGitHub()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = b'{\n "release_id": "previous", "source_revision": "' + SHA.encode() + b'"\n}\n'
            (root / 'previous.json').write_bytes(data)
            with patch.dict(os.environ, GITHUB_RUN_ID='1', TARGET_SHA=SHA, RELEASE_ID='previous',
                            MANIFEST_SHA256=digest(data), MANIFEST_ARTIFACT_ID='10', GITHUB_OUTPUT=os.devnull):
                release.retain_production(api, SimpleNamespace(directory=root))
                self.assertEqual(api.items[0]['task'], 'production-release')
                self.assertEqual(api.items[0]['latest_status'], 'pending')
                proof = root / 'proof.json'
                proof.write_text(json.dumps(dict(release_id='previous', status='deployed', health='passed',
                                                 deployment_phase='complete', rolled_back=False)))
                with patch.dict(os.environ, DEPLOYMENT_RESULT=str(proof), DEPLOYMENT_ID='1'):
                    release.complete_production(api, None)
            info = release.previous_production(api)
            self.assertEqual(info['manifest_sha256'], digest(data))
            # A deleted run and expired artifacts must not be read on rollback.
            with patch.object(api, 'artifact', side_effect=AssertionError('expired Actions artifact read')):
                with patch.object(api, 'request', side_effect=AssertionError('deleted Actions run read')):
                    self.assertEqual(release.manifest_bytes(api, info), data)
            api.items[0]['payload']['manifest_base64'] = base64.b64encode(data + b' ').decode()
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                release.manifest_bytes(api, info)

    def test_bad_manifest_and_incomplete_deploy_never_become_rollback_sources(self):
        api = MemoryGitHub()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'bad.json').write_bytes(b'{}')
            with patch.dict(os.environ, RELEASE_ID='bad', MANIFEST_SHA256='a' * 64):
                with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                    release.retain_production(api, SimpleNamespace(directory=root))
            self.assertEqual(api.items, [])
            proof = root / 'proof.json'
            proof.write_text(json.dumps(dict(release_id='bad', status='deployed', health='passed',
                                             deployment_phase='host-ready', rolled_back=False)))
            with patch.dict(os.environ, RELEASE_ID='bad', DEPLOYMENT_RESULT=str(proof), DEPLOYMENT_ID='1'):
                with self.assertRaisesRegex(ValueError, 'proof is invalid'):
                    release.complete_production(api, None)
            self.assertEqual(api.items, [])

    def test_expired_baseline_rebuilds_instead_of_forwarding_dead_artifact_ids(self):
        api = MemoryGitHub()
        info = api.info('1', 'old')
        info.update(channel='nightly-cut', proof_result='passed', target_sha=SHA, recorder_control=True)
        api.items.append(dict(id=1, environment='nightly', payload=info, latest_status='inactive', created_at='2026-10-16T00:00:00Z'))
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'output'
            with patch.dict(os.environ, GITHUB_OUTPUT=str(output)):
                with patch.object(api, 'artifact', side_effect=ValueError('artifact expired')):
                    release.plan(api, SimpleNamespace(manual=True))
            values = output.read_text()
            self.assertIn('should_cut=true', values)
            self.assertNotIn('baseline_artifact_id', values)
            self.assertIn('recorder_control=true', values)
            self.assertEqual(api.items[-1]['payload']['channel'], 'nightly-attempt')

    def test_expired_legacy_baseline_never_silently_disables_unknown_components(self):
        api = MemoryGitHub()
        info = api.info('1', 'legacy')
        info.update(channel='nightly-cut', proof_result='passed', target_sha=SHA)
        api.items.append(dict(id=1, environment='nightly', payload=info, latest_status='inactive',
                              created_at='2026-10-16T00:00:00Z'))
        with patch.dict(os.environ, GITHUB_OUTPUT=os.devnull):
            with patch.object(api, 'artifact', side_effect=ValueError('artifact expired')):
                with self.assertRaisesRegex(ValueError, 'enabled component set'):
                    release.plan(api, SimpleNamespace(manual=True))
        self.assertEqual(len(api.items), 1)

    def test_dispatcher_infrastructure_change_is_refused_before_build_or_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            subprocess.run(['git', 'init', '-q', str(repo)], check=True)
            target = repo / 'infrastructure/opentofu/modules/aws-transcription-dispatcher/main.tf'
            target.parent.mkdir(parents=True)
            target.write_text('# old\n')
            def commit():
                subprocess.run(['git', '-C', str(repo), 'add', '.'], check=True)
                subprocess.run(['git', '-C', str(repo), '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
                                'commit', '-qm', 'fixture'], check=True)
                return subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
            base = commit()
            target.write_text('# new\n')
            head = commit()
            previous = Path.cwd()
            try:
                os.chdir(repo)
                with self.assertRaisesRegex(ValueError, 'transcription build inputs changed'):
                    release.guard_runtime(base, head)
            finally:
                os.chdir(previous)


class DeploymentLookupTests(unittest.TestCase):
    def api(self, respond):
        api = object.__new__(GitHub)
        api.request = respond
        return api

    def test_first_decisive_cut_stops_paging_and_only_candidates_get_statuses(self):
        calls = []
        def request(route):
            calls.append(route)
            if '/statuses?' in route:
                return [dict(state='success')]
            return [dict(id=105, payload=dict(channel='unrelated')),
                    dict(id=104, payload=dict(channel='nightly-cut', proof_result='failed')),
                    dict(id=103, payload=dict(channel='nightly-cut', proof_result='passed'))] + [
                        dict(id=i, payload=dict(channel='nightly-cut', proof_result='passed')) for i in range(97)]
        records = self.api(request).deployments('nightly')
        self.assertEqual(records[0]['id'], 103)
        self.assertEqual(calls, ['deployments?environment=nightly&task=nightly-cut&per_page=100&page=1',
                                 'deployments/103/statuses?per_page=1'])

    def test_deleted_web_archive_tells_operator_to_cut_a_new_nightly(self):
        api = self.api(lambda route: (_ for _ in ()).throw(subprocess.CalledProcessError(1, ['gh', 'api'])))
        with self.assertRaisesRegex(ValueError, 'cut a new nightly'):
            api.artifact('1', '2', 'web-production.tar.gz')

    def test_marker_and_reservation_lookups_never_fetch_statuses(self):
        for task in ('nightly-write', 'nightly-attempt'):
            calls = []
            def request(route):
                calls.append(route)
                return [dict(id=5, payload=dict(channel=task))]
            self.assertEqual(self.api(request).deployments('nightly', task)[0]['id'], 5)
            self.assertEqual(calls, [f'deployments?environment=nightly&task={task}&per_page=100&page=1'])

    def test_production_filters_sha_and_hash_then_skips_unhealthy_candidates(self):
        calls = []
        def request(route):
            calls.append(route)
            if '/statuses?' in route:
                return [dict(state='failure' if '/3/' in route else 'success')]
            return [dict(id=4, payload=dict(channel='production-release', manifest_sha256='other')),
                    dict(id=3, payload=dict(channel='production-release', manifest_sha256='exact')),
                    dict(id=2, payload=dict(channel='production-release', manifest_sha256='exact'))]
        records = self.api(request).deployments('production', 'production-release', sha=SHA, manifest_sha256='exact')
        self.assertEqual(records[0]['id'], 2)
        self.assertEqual(len(calls), 3)
        self.assertIn(f'&sha={SHA}&page=1', calls[0])
        self.assertEqual(calls[1:], ['deployments/3/statuses?per_page=1', 'deployments/2/statuses?per_page=1'])

    def test_legacy_default_task_records_remain_selectable_without_reading_unrelated_statuses(self):
        for task in ('nightly-cut', 'nightly-write', 'nightly-attempt'):
            calls = []
            def request(route):
                calls.append(route)
                if '/statuses?' in route:
                    return [dict(state='success')]
                if f'task={task}&' in route:
                    return []
                return [dict(id=2, payload=dict(channel='unrelated')),
                        dict(id=1, payload=dict(channel=task, proof_result='passed'))]
            records = self.api(request).deployments('nightly', task)
            self.assertEqual(records[0]['id'], 1)
            self.assertEqual(calls[:2], [f'deployments?environment=nightly&task={task}&per_page=100&page=1',
                                        'deployments?environment=nightly&task=deploy&per_page=100&page=1'])
            self.assertEqual(len(calls), 3 if task == 'nightly-cut' else 2)

    def test_pagination_continues_only_until_a_relevant_record(self):
        calls = []
        def request(route):
            calls.append(route)
            if route.endswith('page=1'):
                return [dict(id=i, payload=dict(channel='other')) for i in range(100)]
            return [dict(id=1, payload=dict(channel='nightly-write'))]
        self.assertEqual(self.api(request).deployments('nightly', 'nightly-write')[0]['id'], 1)
        self.assertEqual(len(calls), 2)


if __name__ == '__main__':
    unittest.main()
