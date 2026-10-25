set -eu
python3 - <<'PYREMOTE'
import pathlib,subprocess,json,hashlib
p=pathlib.Path('/run/chalk/env/api.env');old=p.read_bytes();flag=b'CHALK_RECORDING_BUNDLE_V2_ENABLED='
without=b''.join(l for l in old.splitlines(keepends=True) if not l.startswith(flag))
new=without
p.write_bytes(new)
print(json.dumps({'changed':new!=old,'other_bytes_sha256':hashlib.sha256(without).hexdigest()}))
PYREMOTE
