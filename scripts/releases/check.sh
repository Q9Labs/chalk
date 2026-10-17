#!/usr/bin/env bash
# Focused Linux gate; invoke through scripts/gates/remote.sh.
set -euo pipefail
cd "$(dirname "$0")/../.."
check_root=$(mktemp -d)
trap 'python3 -c "import shutil,sys; shutil.rmtree(sys.argv[1])" "$check_root"' EXIT
python3 -m venv "$check_root/venv"
"$check_root/venv/bin/pip" install --disable-pip-version-check -q -r scripts/releases/requirements.txt
export PATH="$check_root/venv/bin:$PATH"
python -m unittest discover -s scripts/releases -v
node --test scripts/releases/pages-worker.test.mjs
if ! command -v actionlint >/dev/null; then
  GOBIN="$check_root/bin" go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.12
  export PATH="$check_root/bin:$PATH"
fi
python - "$check_root/workflows" <<'PY'
import pathlib, shutil, sys
root = pathlib.Path(sys.argv[1])
shutil.copytree('.github', root / '.github')
proof = root / '.github/workflows/real-call-proof.yml'
if not proof.exists():
    print('Proof workflow not merged: linting its declared workflow_call contract in an isolated fixture.')
    proof.write_text('''name: Real call proof contract
on:
  workflow_call:
    inputs:
      environment:
        type: string
        required: true
      proofs:
        type: string
        default: smoke transcript
    outputs:
      result:
        value: ${{ jobs.contract.outputs.result }}
jobs:
  contract:
    runs-on: ubuntu-24.04
    outputs:
      result: ${{ steps.contract.outputs.result }}
    steps:
      - id: contract
        run: echo result=passed >> "$GITHUB_OUTPUT"
''')
PY
git -C "$check_root/workflows" init --quiet
(cd "$check_root/workflows" && actionlint -oneline .github/workflows/{ci,nightly,promote,release-observation}.yml)
source_sha=$(git rev-parse HEAD)
python scripts/releases/web.py build --target nightly --sha "$source_sha" --output "$check_root/web"
python scripts/releases/web.py build --target production --sha "$source_sha" --output "$check_root/web"
python - "$check_root/web" <<'PY'
import io, pathlib, sys, tarfile
sys.path.insert(0, 'scripts/releases')
from release_set import canonical, digest
from test_release import fixture
from web import deploy, read_marker
root = pathlib.Path(sys.argv[1])
value, _ = fixture()
for target in ('nightly', 'production'):
    archive_path = root / f'web-{target}.tar.gz'
    data = archive_path.read_bytes()
    marker = read_marker(data)
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        javascript = b''.join(archive.extractfile(m).read() for m in archive.getmembers() if m.isfile() and m.name.endswith('.js') and not m.name.endswith('_worker.js'))
    assert marker['config']['api_url'].encode() in javascript, f'{target} API not in compiled JS'
    assert marker['config']['sync_url'].encode() in javascript, f'{target} WSS not in compiled JS'
    value['target_sha'] = marker['config']['commit']
    value['web'][target].update(sha256=digest(data), **marker)
    print(f'{target}: compiled API/WSS config verified; archive SHA256 {digest(data)}')
(root / 'release-set.json').write_bytes(canonical(value))
for target in ('nightly', 'production'):
    deploy(target, root / 'release-set.json', root / f'web-{target}.tar.gz', 'offline-example', dry_run=True)
PY
# Check the CLI argument without uploading or creating a Pages project.
pnpm exec wrangler pages deploy --help | rg -- '--bundle'
