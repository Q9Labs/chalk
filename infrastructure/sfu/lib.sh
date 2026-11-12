# Sourced by deploy, the live smoke and the bench scripts, which all reach a node the same way:
# SSH as the operator, a tunnel to the control port, and curl with the operator certificate.
# The ports and the node sizes come from the SFU's own table, internal/config/node.json.

node_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sfu_root="$(cd "${node_dir}/../../features/media/sfu" && pwd)"
sfu_table="${sfu_root}/internal/config/node.json"
export CHALK_SFU_PRIVATE_DIR="${CHALK_SFU_PRIVATE_DIR:-$HOME/.config/chalk-sfu}"
export SFU_SSH_KEY="${SFU_SSH_KEY:-$HOME/.ssh/chalk-sfu-operator_ed25519}"

# node_table prints one value of the table; the arguments are a jq program.
node_table() { jq -r "$@" "$sfu_table"; }
control_port="$(node_table .ports.control)"
media_port="$(node_table .ports.media)"
udp_buffer="$(node_table .udpBufferBytes)"

# sfu_ssh_options <known_hosts file> [ssh option...] sets ssh_options for the operator.
sfu_ssh_options() {
  ssh_options=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$1" "${@:2}" -i "$SFU_SSH_KEY")
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
