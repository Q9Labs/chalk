#!/bin/bash -l
# Linux, root. Runs audio-ready-rig.mjs with its browsers inside the `arlab` namespace behind the userspace UDP shaper.
# usage: AR_SHAPER=userspace audio-ready-userspace-run.sh   (SR_* and AR_* variables pass through to the rig)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
ports="${AR_PROXY_PORTS:-8080 4100 4870}"
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  "$here/audio-ready-netns.sh" down
}
trap cleanup EXIT
"$here/audio-ready-netns.sh" down
"$here/audio-ready-netns.sh" up
python3 "$here/audio-ready-shaper.py" &
pids+=($!)
# The services listen on 127.0.0.1 of the host: one proxy exposes them on the veth address, one inside the namespace maps them back to 127.0.0.1.
node "$here/audio-ready-tcpproxy.mjs" 10.99.0.1 127.0.0.1 $ports &
pids+=($!)
ip netns exec arlab node "$here/audio-ready-tcpproxy.mjs" 127.0.0.1 10.99.0.1 $ports &
pids+=($!)
real=$(node -e 'process.stdout.write(require(require.resolve("playwright", {paths: [process.cwd()]})).chromium.executablePath())')
wrapper=$(mktemp /tmp/ar-chromium.XXXXXX)
printf '#!/bin/sh\nexec ip netns exec arlab %s "$@"\n' "$real" | install -m 755 /dev/stdin "$wrapper"
export SR_CHROMIUM="$wrapper" AR_SHAPER=userspace
node "$here/audio-ready-rig.mjs"
