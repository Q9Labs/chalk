"""Publish two matching M4 dev builds to a new, immutable shared-client cache."""
import argparse
import json
from pathlib import Path
import shutil
import uuid

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--ios-copy', required=True, type=Path)
p.add_argument('--android-copy', required=True, type=Path)
p.add_argument('--destination', required=True, type=Path)
p.add_argument('--source-commit', required=True)
args = p.parse_args()
ios_signature = (args.ios_copy / 'native-ios.stamp').read_text().strip()
android_signature = (args.android_copy / 'native-android.stamp').read_text().strip()
if ios_signature != android_signature:
    p.error('The two builds have different native inputs; do not publish a mixed cache')
if args.destination.exists():
    p.error('Use a new versioned destination; an existing cache may be leased by a lane')
ios_app = Path('native-build/Build/Products/Debug-iphonesimulator/Chalk.app')
apk = Path('apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk')
if not (args.ios_copy / ios_app).is_dir() or not (args.android_copy / apk).is_file():
    p.error('Both native build artifacts are required')
staging = args.destination.with_name(args.destination.name + '.preparing-' + uuid.uuid4().hex)
try:
    shutil.copytree(args.ios_copy / ios_app, staging / ios_app)
    (staging / apk).parent.mkdir(parents=True)
    shutil.copy2(args.android_copy / apk, staging / apk)
    (staging / 'shared-inputs.sha256').write_text(ios_signature + '\n')
    (staging / 'provenance.json').write_text(json.dumps({'source_commit': args.source_commit, 'native_inputs': ios_signature, 'ios_copy': str(args.ios_copy), 'android_copy': str(args.android_copy), 'kind': 'debug simulator/emulator clients; not release proof'}, indent=2))
    staging.rename(args.destination)
finally:
    if staging.exists():
        shutil.rmtree(staging)
print(args.destination)
