#!/usr/bin/env bash
# One M4 queue lease owns both builds and browser runs.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
proof_dir="${ASSET_PROOF_ROOT:-/Users/agents/lanes/selfhost-assets/evidence}"
mkdir -p "$proof_dir"
saved="$(mktemp -d)"
files=(apps/web/src/routes/__root.tsx apps/web/src/routes/dashboard.sign-in.tsx apps/web/call-states.html packages/whiteboard/src/react/WhiteboardCanvas.tsx packages/whiteboard/src/react/mathjax-renderer.ts apps/web/scripts/sync-public-assets.ts)
restore() {
  for index in "${!files[@]}"; do cp "$saved/$index" "${files[$index]}"; done
}
cleanup() { restore; if [[ -d "$saved/fonts" ]]; then mv "$saved/fonts" apps/web/public/fonts; fi; rm -r "$saved"; }
trap cleanup EXIT
for index in "${!files[@]}"; do cp "${files[$index]}" "$saved/$index"; done
mv apps/web/public/fonts "$saved/fonts"
for file in "${files[@]}"; do git show "origin/master:$file" > "$file"; done
measure() {
  node apps/web/tests/selfhost-assets/sizes.mjs "$1" "$proof_dir"
}
for label in before after; do
  if [[ "$label" == after ]]; then restore; mv "$saved/fonts" apps/web/public/fonts; fi
  export ASSET_PROOF_DIR="$proof_dir/$label"
  if [[ "$label" == before ]]; then export ASSET_PROOF_BASELINE=1; else unset ASSET_PROOF_BASELINE; fi
  pnpm exec turbo run build --filter=web...
  measure "$label"
  ASSET_PROOF_ONLY=1 node apps/web/tests/dashboard-ui/run.mjs
  pnpm --filter web exec vitest run src/call-states/assets.test.ts
done
unset ASSET_PROOF_DIR ASSET_PROOF_BASELINE
pnpm run gate -- --base origin/master
