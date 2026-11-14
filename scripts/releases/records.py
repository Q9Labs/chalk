"""Reads a Deployment record's payload."""

import json


def payload(item):
    value = item.get('payload') or {}
    info = json.loads(value) if isinstance(value, str) else value
    # Records cut before the rename keep the old key for the Chalk SFU proof verdict.
    if 'own_sfu_proof_result' in info and 'chalk_sfu_proof_result' not in info:
        info = dict(info, chalk_sfu_proof_result=info['own_sfu_proof_result'])
        del info['own_sfu_proof_result']
    return info
