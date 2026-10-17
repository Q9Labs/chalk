"""GitHub boundary uses gh; the cut and held-selection rules are pure."""

import hashlib
import json
import os
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def outputs(values):
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        for key, value in values.items():
            output.write(f'{key}={json.dumps(value) if isinstance(value, (dict, list, bool)) else value}\n')


def payload(item):
    value = item.get('payload') or {}
    return json.loads(value) if isinstance(value, str) else value


def held_candidates(deployments, held=True):
    return sorted((item for item in deployments if (not held or item.get('latest_status') == 'success')
                   and payload(item).get('channel') == 'nightly-cut'
                   and payload(item).get('proof_result') == 'passed'),
                  key=lambda item: (item['created_at'], int(item['id'])), reverse=True)


def cut_decision(target, deployments, now, manual=False):
    if manual:
        return True, 'explicit manual cut'
    if any(payload(item).get('channel') in ('nightly-attempt', 'nightly-cut')
           and datetime.fromisoformat(item['created_at'].replace('Z', '+00:00')).date() >= now.date()
           for item in deployments):
        return False, 'cut already attempted today (UTC)'
    completed = held_candidates(deployments, held=False)
    if not completed:
        return True, 'first completed cut'
    last = completed[0]
    if payload(last)['target_sha'] == target:
        return False, 'master has no new commits'
    return True, 'new master commits'


class GitHub:
    def __init__(self):
        self.repository = os.environ['GITHUB_REPOSITORY']

    def request(self, route, data=None):
        command = ['gh', 'api', f'repos/{self.repository}/{route}']
        if data is not None:
            command += ['--method', 'POST', '--input', '-']
        return json.loads(subprocess.check_output(command, input=None if data is None else json.dumps(data).encode()))

    def pages(self, route, key=None):
        separator = '&' if '?' in route else '?'
        data = subprocess.check_output(['gh', 'api', '--paginate', '--slurp',
                                       f'repos/{self.repository}/{route}{separator}per_page=100'])
        return [item for page in json.loads(data) for item in (page[key] if key else page)]

    def deployments(self, environment, task='nightly-cut', sha=None, manifest_sha256=None):
        # GitHub returns newest IDs first. Page only this environment/task, and
        # inspect statuses only after the payload identifies a usable candidate.
        tasks = (task, 'deploy') if task.startswith('nightly-') else (task,)
        for stored_task in tasks:
            route = f'deployments?environment={environment}&task={stored_task}&per_page=100'
            if sha:
                route += f'&sha={sha}'
            page = 1
            while True:
                items = self.request(f'{route}&page={page}')
                for item in items:
                    info = payload(item)
                    if info.get('channel') != task:
                        continue
                    if task == 'nightly-cut' and info.get('proof_result') != 'passed':
                        continue
                    if manifest_sha256 and info.get('manifest_sha256') != manifest_sha256:
                        continue
                    if task in ('nightly-cut', 'production-release'):
                        status = self.request(f"deployments/{item['id']}/statuses?per_page=1")
                        item['latest_status'] = status[0]['state'] if status else 'pending'
                        if task == 'production-release' and item['latest_status'] != 'success':
                            continue
                    return [item]
                if len(items) < 100:
                    break
                page += 1
        return []

    def reserve_cut(self, sha):
        self.request('deployments', {'ref': sha, 'environment': 'nightly', 'task': 'nightly-attempt', 'auto_merge': False,
                     'required_contexts': [], 'payload': {'channel': 'nightly-attempt'}})

    def gate(self, sha):
        runs = self.pages(f'actions/workflows/gate.yml/runs?head_sha={sha}&branch=master', 'workflow_runs')
        runs = [run for run in runs if run['head_sha'] == sha and run['head_branch'] == 'master'
                and run['event'] in ('push', 'schedule', 'workflow_dispatch')]
        latest = max(runs, key=lambda run: (int(run['run_number']), int(run['run_attempt'])), default=None)
        require(latest and latest['conclusion'] == 'success', f'latest master Gate for {sha} is not successful')

    def artifact(self, run_id, artifact_id, filename, expected=None):
        require(str(run_id).isdigit() and str(artifact_id).isdigit(), 'invalid artifact reference')
        try:
            item = self.request(f'actions/artifacts/{artifact_id}')
        except subprocess.CalledProcessError as error:
            raise ValueError('artifact unavailable; cut a new nightly') from error
        require(not item['expired'], 'artifact expired; cut a new nightly')
        require(str(item['workflow_run']['id']) == str(run_id), 'wrong-run artifact')
        # gh handles authentication, redirects and the Actions archive format.
        with tempfile.TemporaryDirectory() as directory:
            try:
                subprocess.run(['gh', 'run', 'download', str(run_id), '--repo', self.repository,
                                '--name', item['name'], '--dir', directory], check=True)
            except subprocess.CalledProcessError as error:
                raise ValueError('artifact download unavailable; cut a new nightly') from error
            files = list(Path(directory).rglob('*'))
            files = [path for path in files if path.is_file()]
            require(len(files) == 1 and files[0].name == filename, 'artifact must contain exactly the expected file')
            data = files[0].read_bytes()
        require(expected is None or digest(data) == expected, f'{filename} checksum mismatch')
        return data

    def record(self, sha, info, passed):
        item = self.request('deployments', {'ref': sha, 'environment': 'nightly', 'task': 'nightly-cut', 'auto_merge': False,
                            'required_contexts': [], 'payload': info})
        self.request(f"deployments/{item['id']}/statuses", {'state': 'success' if passed else 'failure',
                     'auto_inactive': False, 'log_url': f"https://github.com/{self.repository}/actions/runs/{os.environ['GITHUB_RUN_ID']}"})
        return item['id']
