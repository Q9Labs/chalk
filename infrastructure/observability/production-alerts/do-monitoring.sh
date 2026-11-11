#!/usr/bin/env bash
# Reconciles DigitalOcean monitoring for the own-SFU nodes of one environment: alert policies for
# CPU, memory and disk, and a ping uptime check with a "down everywhere" alert. DigitalOcean
# monitoring is free. Alerts go to the Discord channel, which accepts Slack payloads at
# <webhook>/slack. DigitalOcean cannot reach Oncall: it answers HTTP 500 to a Slack webhook URL that
# is not a Slack-format receiver, and it has no plain webhook. Oncall hears of a node outage from
# the Axiom sfu-readiness rule instead (see sfu-runbook.md).
#
#   do-monitoring.sh <production|staging|test> plan      print what apply would do; changes nothing
#   do-monitoring.sh <production|staging|test> apply     create or update the policies and the check
#   do-monitoring.sh <production|staging|test> remove    delete everything this script made (the undo)
#
# Policies apply by Droplet tag, so a rebuilt node that keeps its tag keeps its policies. The ping
# check targets the node's address, so after a rebuild that changes the address, run apply again.
# Needs doctl, jq and DISCORD_WEBHOOK_URL in the environment.
set -euo pipefail

usage="usage: do-monitoring.sh <production|staging|test> <plan|apply|remove>"
environment="${1:?$usage}"
action="${2:?$usage}"
case "$environment" in
  production) tag=chalk-sfu-prod ;;
  staging) tag=chalk-sfu-staging ;;
  test) tag=chalk-sfu-alerttest ;; # a throwaway Droplet that proves the policies fire
  *) echo "$usage" >&2; exit 2 ;;
esac
case "$action" in plan | apply | remove) ;; *) echo "$usage" >&2; exit 2 ;; esac

prefix="chalk-sfu-${environment}"
check_name="${prefix}-ping"
# type, comparison value, window, label. The node closes admission itself at 90% busy CPU, so 85% for
# five minutes means the node is near that line. A 2 GiB node idles near 40% memory.
policies=(
  "v1/insights/droplet/cpu 85 5m cpu-above-85"
  "v1/insights/droplet/memory_utilization_percent 85 5m memory-above-85"
  "v1/insights/droplet/disk_utilization_percent 80 5m disk-above-80"
)

if [[ "$action" != remove ]]; then
  : "${DISCORD_WEBHOOK_URL:?set DISCORD_WEBHOOK_URL}"
  slack_flags=(--slack-urls "${DISCORD_WEBHOOK_URL}/slack" --slack-channels chalk-alerts)
fi

run() { [[ "$action" == plan ]] || doctl "$@" >/dev/null; }

existing_policies="$(doctl monitoring alert list --output json)"
for spec in "${policies[@]}"; do
  read -r type value window label <<<"$spec"
  description="${prefix}: ${label}"
  id="$(jq -r --arg d "$description" '[.[] | select(.description == $d) | .uuid][0] // empty' <<<"$existing_policies")"
  if [[ "$action" == remove ]]; then
    [[ -z "$id" ]] || { doctl monitoring alert delete "$id" --force; echo "deleted policy ${description}"; }
    continue
  fi
  flags=(--type "$type" --compare GreaterThan --value "$value" --window "$window" --tags "$tag" --description "$description" "${slack_flags[@]}")
  if [[ -z "$id" ]]; then run monitoring alert create "${flags[@]}"; else run monitoring alert update "$id" "${flags[@]}"; fi
  echo "policy ${description}: $([[ -z "$id" ]] && echo create || echo update)"
done

node_address="$(doctl compute droplet list --tag-name "$tag" --output json | jq -r 'if length == 1 then .[0].networks.v4[] | select(.type == "public") | .ip_address else empty end')"
existing_check="$(doctl monitoring uptime list --output json | jq -c --arg n "$check_name" '[.[] | select(.name == $n)][0] // empty')"
check_id="$(jq -r '.id // empty' <<<"${existing_check:-null}")"
if [[ "$action" == remove ]]; then
  [[ -z "$check_id" ]] || { doctl monitoring uptime delete "$check_id"; echo "deleted uptime check ${check_name}"; }
  exit 0
fi
[[ -n "$node_address" ]] || { echo "expected exactly one Droplet tagged ${tag}" >&2; exit 1; }
# doctl cannot enable a check on update (an update leaves it disabled), so a check that is missing,
# disabled or aimed at another address is deleted and created again.
if [[ -n "$check_id" ]] && jq -e --arg t "$node_address" '.enabled == true and .target == $t' <<<"$existing_check" >/dev/null; then
  echo "uptime check ${check_name}: keep"
else
  verb="$([[ -z "$check_id" ]] && echo create || echo recreate)"
  if [[ "$action" == apply ]]; then
    [[ -z "$check_id" ]] || doctl monitoring uptime delete "$check_id"
    check_id="$(doctl monitoring uptime create "$check_name" --type ping --target "$node_address" --regions se_asia,eu_west,us_east --enabled true --output json | jq -r '.[0].id // .id')"
  fi
  echo "uptime check ${check_name}: ${verb}"
fi
if [[ "$action" == apply ]]; then
  alert_id="$(doctl monitoring uptime alert list "$check_id" --output json | jq -r --arg n "${check_name}-down" '[.[] | select(.name == $n) | .id][0] // empty')"
  alert_flags=(--name "${check_name}-down" --type down_global --comparison greater_than --threshold 1 --period 2m "${slack_flags[@]}")
  if [[ -z "$alert_id" ]]; then
    doctl monitoring uptime alert create "$check_id" "${alert_flags[@]}" >/dev/null
  else
    doctl monitoring uptime alert update "$check_id" "$alert_id" "${alert_flags[@]}" >/dev/null
  fi
  echo "uptime alert ${check_name}-down: $([[ -z "$alert_id" ]] && echo create || echo update)"
fi
