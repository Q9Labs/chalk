"""GitHub boundary uses gh; the cut and held-selection rules are pure."""

import hashlib
import json
import os
import random
import re
import subprocess
import sys
import tempfile
import time
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
    def __init__(self, timeout=60):
        self.repository = os.environ['GITHUB_REPOSITORY']
        self.timeout = timeout

    def _call(self, command, route, data=None):
        # Only reads are safe to replay: a failed POST may already have created a deployment.
        # Four 60-second attempts plus at most 21 seconds of backoff: 261 seconds.
        for attempt in range(1, 5):
            try:
                # check_output kills and reaps gh on timeout, including a whole paginated read.
                return subprocess.check_output(command, input=data, stderr=subprocess.PIPE, timeout=self.timeout)
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
                timed_out = isinstance(error, subprocess.TimeoutExpired)
                if timed_out:
                    error = subprocess.CalledProcessError(
                        124, command, output=error.output,
                        stderr=(error.stderr or b'') + f'\ngh api timed out after {self.timeout} seconds\n'.encode())
                message = error.stderr.decode(errors='replace')
                sys.stderr.write(message)
                status = re.search(r'HTTP (\d{3})\b', message)
                transient = timed_out or (500 <= int(status[1]) < 600 if status else
                             any(text in message.lower() for text in
                                 ('error connecting', 'dial tcp', 'connection reset', 'connection refused',
                                  'timeout', 'timed out', 'deadline exceeded', 'unexpected eof')))
                if data is not None or not transient or attempt == 4:
                    raise error
                print(f'GitHub retry {route}: attempt {attempt + 1}/4', file=sys.stderr)
                time.sleep(random.uniform(0, 3 * 2 ** (attempt - 1)))

    def request(self, route, data=None):
        command = ['gh', 'api', f'repos/{self.repository}/{route}']
        if data is not None:
            command += ['--method', 'POST', '--input', '-']
        return json.loads(self._call(command, route, None if data is None else json.dumps(data).encode()))

    def pages(self, route, key=None):
        separator = '&' if '?' in route else '?'
        data = self._call(['gh', 'api', '--paginate', '--slurp',
                           f'repos/{self.repository}/{route}{separator}per_page=100'], route)
        return [item for page in json.loads(data) for item in (page[key] if key else page)]

    def deployments(self, environment, task='nightly-cut', sha=None, manifest_sha256=None):
        # GitHub returns newest IDs first. Page only this environment/task, and
        # inspect statuses only after the payload identifies a usable candidate.
        route = f'deployments?environment={environment}&task={task}&per_page=100'
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
            allowed = {filename}
            release = filename.removesuffix('.media.json') if filename.endswith('.media.json') else filename.removesuffix('.json')
            if item['name'] == 'release-manifest-' + release:
                allowed = {release + '.json', release + '.media.json'}
            actual = {str(path.relative_to(directory)) for path in files}
            require(filename in actual and actual <= allowed, 'artifact contains unexpected or missing release files')
            data = Path(directory, filename).read_bytes()
        require(expected is None or digest(data) == expected, f'{filename} checksum mismatch')
        return data

    def record(self, sha, info, passed):
        item = self.request('deployments', {'ref': sha, 'environment': 'nightly', 'task': 'nightly-cut', 'auto_merge': False,
                            'required_contexts': [], 'payload': info})
        self.request(f"deployments/{item['id']}/statuses", {'state': 'success' if passed else 'failure',
                     'auto_inactive': False, 'log_url': f"https://github.com/{self.repository}/actions/runs/{os.environ['GITHUB_RUN_ID']}"})
        return item['id']
