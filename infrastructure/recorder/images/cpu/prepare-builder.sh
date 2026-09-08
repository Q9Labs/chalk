#!/usr/bin/env bash
set -euo pipefail

go_version="1.25.13"
go_archive_sha256="39042a078ea9ceebe3ecda4a7188f0f5b96e14a071d27923ba7f40b456e85ae3"
node_version="22.23.2"
node_archive_sha256="d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307"
pnpm_version="10.26.2"
toolchain_root="/opt/chalk-recorder/toolchains"

[[ "$(id -u)" == "0" ]] || { echo "prepare-builder must run as root" >&2; exit 1; }
[[ "$(uname -s)" == "Linux" && "$(uname -m)" == "x86_64" ]] || { echo "CPU recorder images require Linux x86_64" >&2; exit 1; }
source /etc/os-release
[[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]] || { echo "CPU recorder images require Ubuntu 24.04" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl ffmpeg jq xz-utils

install -d -m 0755 "$toolchain_root"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT

if [[ ! -x "$toolchain_root/go-${go_version}/bin/go" ]]; then
  curl -fsSLo "$temporary_directory/go.tar.gz" "https://go.dev/dl/go${go_version}.linux-amd64.tar.gz"
  printf '%s  %s\n' "$go_archive_sha256" "$temporary_directory/go.tar.gz" | sha256sum --check --strict
  install -d "$temporary_directory/go-extract"
  tar -C "$temporary_directory/go-extract" -xzf "$temporary_directory/go.tar.gz"
  mv "$temporary_directory/go-extract/go" "$toolchain_root/go-${go_version}"
fi
[[ "$("$toolchain_root/go-${go_version}/bin/go" version)" == "go version go${go_version} linux/amd64" ]] || { echo "installed Go toolchain does not match the pinned version" >&2; exit 1; }

if [[ ! -x "$toolchain_root/node-${node_version}/bin/node" ]]; then
  curl -fsSLo "$temporary_directory/node.tar.xz" "https://nodejs.org/dist/v${node_version}/node-v${node_version}-linux-x64.tar.xz"
  printf '%s  %s\n' "$node_archive_sha256" "$temporary_directory/node.tar.xz" | sha256sum --check --strict
  install -d "$temporary_directory/node-extract"
  tar -C "$temporary_directory/node-extract" -xJf "$temporary_directory/node.tar.xz"
  mv "$temporary_directory/node-extract/node-v${node_version}-linux-x64" "$toolchain_root/node-${node_version}"
fi
[[ "$("$toolchain_root/node-${node_version}/bin/node" --version)" == "v${node_version}" ]] || { echo "installed Node.js toolchain does not match the pinned version" >&2; exit 1; }

ln -sfn "$toolchain_root/go-${go_version}/bin/go" /usr/local/bin/go
for executable in node npm npx corepack; do
  ln -sfn "$toolchain_root/node-${node_version}/bin/$executable" "/usr/local/bin/$executable"
done
export COREPACK_HOME="$toolchain_root/corepack"
corepack enable --install-directory "$toolchain_root/node-${node_version}/bin" pnpm
corepack prepare "pnpm@${pnpm_version}" --activate
ln -sfn "$toolchain_root/node-${node_version}/bin/pnpm" /usr/local/bin/pnpm

ffmpeg_encoders="$(ffmpeg -hide_banner -encoders 2>/dev/null)"
grep -Fq 'libx264 ' <<<"$ffmpeg_encoders" || { echo "Ubuntu FFmpeg does not expose libx264" >&2; exit 1; }
go version
node --version
pnpm --version
