#!/usr/bin/env bash
set -euo pipefail

# Run on Linux/Instabox. Both downloaded inputs are pinned and verified.
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
curl -fsSL https://github.com/quickjs-ng/quickjs/archive/refs/tags/v0.18.0.tar.gz -o quickjs.tar.gz
echo '28bcd89aa3683fd2a946537e5ce3f11cc46b5cbf3383c7561aaef3df5ff9f1dd  quickjs.tar.gz' | sha256sum -c -
curl -fsSL https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-29/wasi-sdk-29.0-x86_64-linux.tar.gz -o sdk.tar.gz
echo '87d1d1a2879d139cdc624b968efad3d4a97b8078cdff95e63ac88ecafd1a0171  sdk.tar.gz' | sha256sum -c -
tar -xzf quickjs.tar.gz
tar -xzf sdk.tar.gz
sdk="$work/wasi-sdk-29.0-x86_64-linux"
qjs="$work/quickjs-0.18.0"
"$sdk/bin/clang" -O2 -ffile-prefix-map="$work"=. -ffile-prefix-map="$here"=. \
  -D_GNU_SOURCE -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_SIGNAL \
  -I"$qjs" -mexec-model=reactor -Wl,-z,stack-size=1048576 -Wl,--max-memory=33554432 \
  "$here/bridge.c" "$qjs/quickjs.c" "$qjs/dtoa.c" "$qjs/libregexp.c" "$qjs/libunicode.c" \
  -lwasi-emulated-process-clocks -lwasi-emulated-signal -lm -o "$work/quickjs.wasm"
if [[ "${1:-}" == --check ]]; then
  cmp "$work/quickjs.wasm" "$here/quickjs.wasm"
else
  cp "$work/quickjs.wasm" "$here/quickjs.wasm"
fi
sha256sum "$here/quickjs.wasm"
