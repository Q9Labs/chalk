"""Validate the immutable member sidecar of a managed media release."""
import re

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.append(str(ROOT / 'scripts/recorder'))
from release_core import require


def validate_members(value):
    required = {'schema_version', 'capture', 'render', 'dispatcher'}
    allowed = required | {'recorder_source_bucket', 'renderer'}
    require(value.get('schema_version') == 1 and required <= set(value) and set(value) <= allowed, 'invalid media members')
    portable = 'recorder_source_bucket' in value
    for role in ('capture', 'render'):
        image = value[role]
        require(re.fullmatch(r'[1-9][0-9]*', str(image['base_snapshot_id' if portable else 'image_id'])), 'invalid recorder image ID')
        if portable:
            require(re.fullmatch(r'[0-9a-f]{64}', image['archive_sha256']), 'invalid recorder archive SHA256')
            require(image['archive_key'] == f"recorder/{role}/{image['archive_sha256']}.tar.gz", 'invalid recorder archive key')
        require(re.fullmatch(r'sha256:[0-9a-f]{64}', image['image_digest']), 'invalid recorder digest')
        require(re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,127}', image['release_id']), 'invalid recorder release')
    if portable:
        require(re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', value['recorder_source_bucket']), 'invalid recorder source bucket')
    archive = value['dispatcher']
    require(re.fullmatch(r'[0-9a-f]{64}', archive['sha256']), 'invalid dispatcher ZIP digest')
    require(archive['version_id'] and archive['version_id'] != 'null', 'dispatcher ZIP must be version-pinned')
    require(re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', archive['bucket']), 'invalid dispatcher bucket')
    require(archive['corpus_digest'] == '' or re.fullmatch(r'[0-9a-f]{64}', archive['corpus_digest'].removeprefix('sha256:')), 'invalid legacy corpus digest')
    require(archive['key'].startswith('transcription-dispatcher/') and '..' not in archive['key'], 'invalid dispatcher artifact key')
    if 'renderer' in value:
        renderer = value['renderer']
        require(re.fullmatch(r'[0-9a-f]{64}', renderer['sha256']), 'invalid renderer ZIP digest')
        require(renderer['version_id'] and renderer['version_id'] != 'null', 'renderer ZIP must be version-pinned')
        require(re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', renderer['bucket']), 'invalid renderer bucket')
        require(renderer['key'].startswith('document-renderer/') and '..' not in renderer['key'], 'invalid renderer artifact key')
    return value

