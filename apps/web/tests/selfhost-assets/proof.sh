#!/usr/bin/env bash
# One M4 queue lease owns both builds and browser runs.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
proof_dir="${ASSET_PROOF_ROOT:-/Users/agents/lanes/selfhost-assets/evidence}"
mkdir -p "$proof_dir"
saved="$(mktemp -d)"
files=(apps/web/src/lib/whiteboard-assets.ts apps/web/src/routes/__root.tsx apps/web/src/routes/dashboard.sign-in.tsx apps/web/call-states.html packages/whiteboard/src/react/WhiteboardCanvas.tsx packages/whiteboard/src/react/mathjax-renderer.ts apps/web/scripts/sync-public-assets.ts apps/web/vite.config.ts apps/web/vite.call-states.config.ts)
restore() {
  for index in "${!files[@]}"; do cp "$saved/$index" "${files[$index]}"; done
}
cleanup() { restore; if [[ -d "$saved/fonts" ]]; then mv "$saved/fonts" apps/web/public/fonts; fi; rm -r "$saved"; }
trap cleanup EXIT
for index in "${!files[@]}"; do cp "${files[$index]}" "$saved/$index"; done
mv apps/web/public/fonts "$saved/fonts"
for file in "${files[@]}"; do
  if git cat-file -e "origin/master:$file" 2>/dev/null; then git show "origin/master:$file" > "$file"; else : > "$file"; fi
done
measure() {
  node apps/web/tests/selfhost-assets/sizes.mjs "$1" "$proof_dir"
}
for label in before after; do
  if [[ "$label" == after ]]; then restore; mv "$saved/fonts" apps/web/public/fonts; fi
  export ASSET_PROOF_DIR="$proof_dir/$label"
  pnpm exec turbo run build --filter=web...
  measure "$label"
  if [[ "$label" == before ]]; then
    if ASSET_PROOF_ONLY=1 node apps/web/tests/dashboard-ui/run.mjs > "$proof_dir/before-web.log" 2>&1; then
      echo 'Expected the original Google Fonts requests to fail the new assertion' >&2; exit 1
    fi
    rg 'sent an external request' "$proof_dir/before-web.log"
    if pnpm --filter web exec vitest run src/call-states/assets.test.ts > "$proof_dir/before-call.log" 2>&1; then
      echo 'Expected the original board CDN requests to fail the new assertion' >&2; exit 1
    fi
    rg 'external HTTP requests' "$proof_dir/before-call.log"
  else
    ASSET_PROOF_ONLY=1 node apps/web/tests/dashboard-ui/run.mjs
    pnpm --filter web exec vitest run src/call-states/assets.test.ts
  fi
done
unset ASSET_PROOF_DIR
pnpm run gate -- --base origin/master
