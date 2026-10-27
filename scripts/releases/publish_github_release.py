"""Publish a release record after a verified deployment, without redeploying."""

import os
import subprocess

from github_release import GitHub, require


def main():
    channel = os.environ['RELEASE_CHANNEL']
    require(channel in ('nightly', 'production'), 'unknown release channel')
    target = os.environ['TARGET_SHA']
    previous = os.environ.get('PREVIOUS_SHA', '')
    run_id = os.environ['GITHUB_RUN_ID']
    require(run_id.isdigit(), 'invalid workflow run ID')
    github = GitHub()
    tag = f'{channel}-{run_id}'
    existing = next((release for release in github.pages('releases') if release['tag_name'] == tag), None)
    if existing:
        require(github.request(f'commits/{tag}')['sha'] == target, 'existing release points to a different commit')
        print(f'Release already published: {existing["html_url"]}')
        return

    repository_url = f'https://github.com/{github.repository}'
    run_url = f'{repository_url}/actions/runs/{run_id}'
    notes = [f'Verified {channel} deployment of `{target}`.', '', f'[Deployment run]({run_url})']
    if previous:
        added = subprocess.check_output(['git', 'log', '--format=- %s (%h)', f'{previous}..{target}'], text=True).strip()
        removed = subprocess.check_output(['git', 'log', '--format=- %s (%h)', f'{target}..{previous}'], text=True).strip()
        notes += ['', f'[Changes since previous {channel}]({repository_url}/compare/{previous}...{target})']
        if added:
            notes += ['', 'Added commits:', added]
        if removed:
            notes += ['', 'Removed commits:', removed]
        if not added and not removed:
            notes += ['', 'No commits changed.']
    else:
        notes += ['', 'No previous nightly deployment was available for comparison.']
    command = ['gh', 'release', 'create', tag, '--repo', github.repository, '--target', target,
               '--title', f'{channel.capitalize()} {run_id}', '--notes-file', '-']
    if channel == 'nightly':
        command += ['--prerelease', '--latest=false']
    else:
        command.append('--latest')
    subprocess.run(command, input='\n'.join(notes) + '\n', text=True, check=True)


if __name__ == '__main__':
    main()
