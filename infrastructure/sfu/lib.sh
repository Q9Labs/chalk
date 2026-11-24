# Sourced by deploy, the live smoke and the bench scripts, which all reach a node the same way:
# SSH as the operator, a tunnel to the control port, and curl with the operator certificate.
# The ports and the node sizes come from the SFU's own table, internal/config/node.json.

node_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# SFU_SOURCE_ROOT points at another checkout's features/media/sfu, so a release can build the node
# from the commit it ships while running this checkout's tooling.
sfu_root="${SFU_SOURCE_ROOT:-$(cd "${node_dir}/../../features/media/sfu" && pwd)}"
sfu_table="${sfu_root}/internal/config/node.json"
export CHALK_SFU_PRIVATE_DIR="${CHALK_SFU_PRIVATE_DIR:-$HOME/.config/chalk-sfu}"
export SFU_SSH_KEY="${SFU_SSH_KEY:-$HOME/.ssh/chalk-sfu-operator_ed25519}"

# node_table prints one value of the table; the arguments are a jq program.
node_table() { jq -r "$@" "$sfu_table"; }
control_port="$(node_table .ports.control)"
media_port="$(node_table .ports.media)"
udp_buffer="$(node_table .udpBufferBytes)"

# SFU_FROM_CI is set by a release, which has no 1Password, doctl or person to trust a new host key.
# Its private directory comes complete from the GitHub environment: the operator certificate is not
# issued, the host firewall is left as the last operator run set it, and an unknown host is refused.

# sfu_operator_cert <env> issues the operator's one-day certificate, unless a release brought one.
sfu_operator_cert() {
  [[ -z "${SFU_FROM_CI:-}" ]] || return 0
  "${node_dir}/certs" "$1" operator >/dev/null
}

# sfu_ssh_options <known_hosts file> [ssh option...] sets ssh_options for the operator.
sfu_ssh_options() {
  local trust=accept-new
  [[ -z "${SFU_FROM_CI:-}" ]] || trust=yes
  ssh_options=(-o BatchMode=yes -o "StrictHostKeyChecking=${trust}" -o "UserKnownHostsFile=$1" "${@:2}" -i "$SFU_SSH_KEY")
}

# sfu_tunnel <local port> <host> forwards the local port to the node's control port, and sets
# tunnel to the ssh process.
sfu_tunnel() {
  ssh "${ssh_options[@]}" -o ExitOnForwardFailure=yes -N -L "$1:127.0.0.1:${control_port}" "root@$2" &
  tunnel=$!
}

# sfu_wait_port <local port> waits until the tunnel accepts connections, and fails when it died.
sfu_wait_port() {
  for _ in $(seq 20); do
    kill -0 "$tunnel" 2>/dev/null || return 1
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && return 0
    sleep 0.5
  done
  return 1
}

# sfu_curl <private dir> <address> <port> <curl argument...> calls the control API at the address
# with the operator certificate. The node's certificate names chalk-sfu, so the URL does too.
sfu_curl() {
  local private="$1" address="$2" port="$3"
  shift 3
  curl --silent --cacert "${private}/ca.crt" --cert "${private}/operator.crt" --key "${private}/operator.key" \
    --resolve "chalk-sfu:${port}:${address}" "$@"
}

# sfu_check_otlp_tokens <private dir> fails when the OTLP endpoint rejects the token in one of the
# directory's header files, so a dead token stops a deploy or a bundle publish before it reaches a
# node, where it would silently switch that signal off. An empty request with a good token is
# refused as empty (422), so only a 401 or 403 condemns the token; a network error proves nothing.
sfu_check_otlp_tokens() {
  local endpoint="${SFU_OTLP_ENDPOINT:-https://api.axiom.co}" pair file headers status
  for pair in otlp-headers:metrics otlp-log-headers:logs otlp-trace-headers:traces; do
    file="$1/${pair%%:*}"
    [[ -f "$file" ]] || continue
    # The file holds an OTEL_EXPORTER_OTLP_*_HEADERS value: comma-separated key=value pairs with
    # URL-encoded values. curl reads the headers from a file so the token stays out of the process list.
    headers="$(mktemp)"
    tr ',' '\n' <"$file" | sed -e 's/=/: /' -e 's/%20/ /g' >"$headers"
    status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 15 -X POST -H @"$headers" \
      -H 'Content-Type: application/x-protobuf' --data-binary '' "${endpoint}/v1/${pair#*:}")" || status=000
    rm -f "$headers"
    case "$status" in
      401 | 403) echo "${endpoint} rejects the token in ${file} (HTTP ${status}); replace it with a current ingest token from 1Password" >&2; return 1 ;;
      000) echo "warning: could not reach ${endpoint} to check the token in ${file}" >&2 ;;
    esac
  done
}
