# The one TLA+ tools pin for every model under tools/formal. Source it, then call
# tla2tools_jar to get the path of the verified jar. It downloads the jar once.
# v1.7.4 is the latest stable release. Pre-release assets such as v1.8.0 get
# re-published, which breaks a checksum pin.
TLA_VERSION=1.7.4
TLA_SHA256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88

tla2tools_sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

tla2tools_jar() {
  local jar="${TLA2TOOLS_JAR:-${XDG_CACHE_HOME:-$HOME/.cache}/chalk-tla/tla2tools-${TLA_SHA256:0:12}.jar}"
  if [[ ! -f "$jar" ]] || [[ "$(tla2tools_sha256 "$jar")" != "$TLA_SHA256" ]]; then
    mkdir -p "$(dirname "$jar")"
    curl -fsSL -o "$jar.part" "https://github.com/tlaplus/tlaplus/releases/download/v$TLA_VERSION/tla2tools.jar"
    if [[ "$(tla2tools_sha256 "$jar.part")" != "$TLA_SHA256" ]]; then
      rm -f "$jar.part"
      echo "tla2tools.jar v$TLA_VERSION checksum mismatch" >&2
      return 2
    fi
    mv "$jar.part" "$jar"
  fi
  printf '%s\n' "$jar"
}
