"""Verify and compute document-renderer release bindings without rebuilding code."""
import json
import re
from zipfile import ZipFile

from release_core import digest, require
from alchemy_renderer import read_inputs


def renderer_inputs(provider):
    return read_inputs(provider, 'production')


def binding_target(manifest):
    release = manifest['component_releases']['api']['release_id']
    require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{7,127}', release) and 'latest' not in release.lower(), 'invalid API release binding')
    return release


def check_binding(function, release, code_hash):
    require(function['State'] == 'Active' and function['LastUpdateStatus'] == 'Successful', 'document renderer update is not healthy')
    require(function['Environment']['Variables']['CHALK_RELEASE_ID'] == release, 'document renderer runtime release binding mismatch')
    require(function['CodeSha256'] == code_hash, 'document renderer ZIP digest changed')


def release_environment(provider, inputs, zip_path):
    function = provider.aws('lambda', 'get-function-configuration', '--function-name', inputs['function_name'])
    with ZipFile(zip_path) as archive:
        names = set(archive.namelist())
    require({'bootstrap', 'lib/libpdfium.so'} <= names, 'document renderer ZIP lacks its runtime or PDFium library')
    return function['Environment']['Variables']


def release_config_digest(environment, inputs):
    environment = {**environment, 'CHALK_RELEASE_ID': inputs['release_id'], 'CHALK_RELEASE_MANIFEST_DIGEST': inputs['release_manifest_digest']}
    environment.pop('CHALK_CONFIG_DIGEST', None)
    return 'sha256:' + digest(json.dumps(environment, sort_keys=True, separators=(',', ':')))


def verify_renderer(provider, inputs, release):
    release = release or inputs['release_id']
    require(inputs['release_id'] == release, 'document renderer state release binding mismatch')
    function = provider.aws('lambda', 'get-function-configuration', '--function-name', inputs['function_name'])
    check_binding(function, release, inputs['artifact_sha256_base64'])
    return {'release_id': release, 'verified': True}
