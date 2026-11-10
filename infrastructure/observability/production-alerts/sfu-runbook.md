# Chalk SFU on-call runbook

This runbook covers the production Chalk SFU node (`chalk_sfu`): what each alert means, how to check it, and the fix. Real addresses, instance ids and webhook URLs stay in private configuration and 1Password, never here. Operator access to a node is by SSH key and the deploy tunnel (see [Own-SFU nodes](../../sfu/README.md)); `<env>` below is `production` or `staging`.

## Where alerts come from and where they go

| Alert                                                       | Source                                                             | Fires when                                                                                                             | Goes to         |
| ----------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | --------------- |
| Node down                                                   | DigitalOcean ping check `chalk-sfu-<env>-ping`                     | The node fails the ping check from every region for 2 minutes                                                          | Discord         |
| CPU, memory or disk high                                    | DigitalOcean alert policies `chalk-sfu-<env>: ...`                 | CPU above 85%, memory above 85% or disk above 80% for 5 minutes                                                        | Discord         |
| Node unreachable, refusing calls, or near its packet budget | Axiom `sfu-readiness` branch, from the collector's `/readyz` probe | At least 4 unhealthy minute samples in 5 minutes, latest still unhealthy                                               | Discord, Oncall |
| Join failures on `chalk_sfu`                                | Axiom connection-report branch                                     | An accepted `join_failed` or `media_start_failed` report with provider `chalk_sfu` (one alert per Episode and failure) | Discord, Oncall |
| Recording failed or stranded                                | Axiom `recording` and `recording-stop` branches                    | A Recording Capture failed in the last 15 minutes, or a stop is stuck for 2 minutes                                    | Discord, Oncall |
| Overflow to `cf_sfu`                                        | Axiom `sfu-overflow` branch                                        | One or more `chalk_sfu.overflow` events in the last 2 minutes                                                          | Discord, Oncall |

Two limits shape this table. DigitalOcean accepts only Slack-format webhooks and answers HTTP 500 to the Oncall URL, so the two DigitalOcean alerts reach Discord only. The Axiom plan allows 3 monitors and no custom-webhook notifier, so every Axiom rule is a branch of the first grouped monitor, and Oncall is a Slack-type notifier. A paid Axiom plan would lift both limits; confirm its price on the Axiom billing page before buying.

The `sfu-readiness` branch needs the collector probe to be on (`CHALK_ALERT_SFU_READY_URL` and the client certificate settings in the collector's private environment, see [Own SFU readiness](README.md#own-sfu-readiness)). Until an operator enables it, node health reaches the team only through the DigitalOcean alerts, and the overflow alert is the signal that the node stopped taking new classes.

Set the DigitalOcean side with `do-monitoring.sh <env> plan|apply|remove` and the Axiom side with `provision.py`. The `remove` action deletes everything the script made.

## Drill an alert without paging Oncall

Production log rows that a drill injects must carry `attributes.alert_drill=true`. The `sfu-overflow` rule ignores rows with that mark and still counts every unmarked `chalk_sfu.overflow` line, so a drill never starts a real Oncall run. To prove the route to Oncall, post a payload with `"drill": true` to the Oncall webhook: the Oncall skill then runs every step and changes nothing. To prove a rule's query, run it in Axiom over a widened window; a query cannot fire an alert.

## Per-alert guide

### Node down

**Meaning.** The node does not answer ping from DigitalOcean's probes in Asia, Europe and the US for 2 minutes. Live classes on it have dropped or will drop. New classes overflow to Cloudflare while the API still has a Cloudflare application for the Tenant, or are refused.

**Check.**

1. Open the Droplet in the DigitalOcean console, or run `doctl compute droplet get <droplet-id>`, and read its status.
2. Read `/readyz` over the mutual-TLS control port with the operator certificate (the last step of every `deploy` run does the same through an SSH tunnel).
3. Try SSH with the operator key. A failed ping with a working SSH login means only ICMP or the cloud firewall changed.

**Fix.**

1. Droplet powered off or locked: power it on from the console.
2. Droplet on but the service stopped: `ssh root@<address> systemctl --user -M chalk-sfu@ restart chalk-sfu`, then check `/readyz`.
3. Droplet gone or not recoverable: rebuild (see [Rebuild a node](#rebuild-a-node)). Use `deploy <env> <address> --force` when live calls remain: without `--force`, deploy waits up to an hour for the node to drain.
4. After recovery, guests rejoin (see [Rejoin steps](#rejoin-steps)).

### CPU, memory or disk high

**Meaning.** The node is near the limit where it closes admission itself (the host guard closes at 90% busy CPU). Calls already running keep working; new Episodes start to overflow.

**Check.** Read the DigitalOcean graphs for the Droplet. On the node, `top` and `journalctl --user -M chalk-sfu@ -u chalk-sfu -n 200` show the media telemetry lines. `/readyz` reports `admissionClosed` and its reason.

**Fix.** If the load is real classes, nothing breaks; plan capacity before the next class (a larger Droplet needs a rebuild, a second node needs a `CHALK_SFU_NODES` change). If one process runs away, restart the service. If disk is full, remove old journal files with `journalctl --vacuum-size=200M` and old container images with `podman image prune`.

### Node unreachable, refusing calls, or near its packet budget (`sfu-readiness`)

**Meaning.** The alert text names the latest readiness reason:

| Reason                                                                     | Meaning                                                                    | First check                            |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------- |
| `unreachable`                                                              | The API host could not connect, handshake or finish `/readyz` in 5 seconds | Node down checklist above              |
| `tls_config`                                                               | A certificate, key or CA file for the probe is missing or invalid          | Collector environment and cert files   |
| `draining`                                                                 | The node answers 503 because it is draining for a deploy                   | A deploy is running or crashed         |
| `http_status`, `invalid_response`                                          | The node answers, but not with a valid ready response                      | Node journal; wrong build              |
| `admission_cpu_steal`, `admission_cpu_busy`, `admission_scheduler_latency` | The node closed admission itself because the host is overloaded            | CPU graph; noisy neighbour on the host |
| `admission_pacer_drops`                                                    | The packet pacer drops packets: the node cannot send media fast enough     | CPU graph; packet rate on `/readyz`    |
| `admission_udp_buffer_errors`                                              | The kernel drops UDP packets: socket buffers are too small or full         | `netstat -su` on the node              |
| `packet_budget`                                                            | Reserved packets are at least 90% of the node's packet budget              | Count of live Episodes on the node     |

**Fix.** The packet and admission reasons clear on their own when load falls. If they stay, restart the service during a quiet minute; if the host itself is overloaded, move future classes to a second node (add it to `CHALK_SFU_NODES`) or lower `CHALK_SFU_NEW_EPISODES`, and see the kill-switch section below.

### Join failures on `chalk_sfu`

**Meaning.** A participant could not join or start media on the Chalk SFU, and the SDK sent a `join_failed` report. The alert names the Tenant, Episode and provider.

**Check.** Search the API log dataset for the Episode id from the alert (`| search "<episode-id>"`). Look for `chalk_sfu.*` events near the report time. Read the node's `/readyz` and journal for the same minute.

**Fix.** One participant with one report is usually the participant's network. Several Episodes in minutes is the node. Restart the service, and if joins keep failing, switch new Episodes to Cloudflare with the kill switch below; live Episodes stay on the node.

### Recording failed or stranded

**Meaning.** A Recording Capture failed in the last 15 minutes, or Sync still reports the Recording as `stopping` more than 2 minutes after capture finished. There may be no complete video for that class.

**Check.** Find the Episode id in the alert and search for it in the API log dataset. Check that `CHALK_SFU_CAPTURE_ENABLED` is on, that the recorder fleet is up, and that the node's `/readyz` answers (capture pulls media from the node).

**Fix.** If the node is healthy, retry the stop or export from the dashboard. If the node was down during the class, tell the customer that a complete video cannot be promised, and check whether any retained source can be recovered.

### Overflow to `cf_sfu`

**Meaning.** A new class did not start on the Chalk SFU. With provider `cf_sfu` it moved to Cloudflare; with `chalk_sfu` it was refused because overflow is off. The `placement_reason` tells why (for example `overflow_no_room`, `overflow_node_protocol_too_old`, host guard closed, draining or silent). Classes keep working on Cloudflare, but the Chalk SFU is not carrying them.

**Check.** Read the reason in the alert, then `/readyz` for `admissionClosed`, `draining`, `protocol` and `packetBudget`. A `protocol_too_old` reason means the node runs a build older than the API sends: deploy the node.

**Fix.** Fix the reason: restart or rebuild the node, deploy the matching build, or add capacity. The alert closes two minutes after the last overflow event.

## Rejoin steps

A node that restarts or is rebuilt with the same node id keeps its name in the Episodes bound to it. Calls on the old process are gone, but the Episode can run again on the node.

1. Check `/readyz` is 200 with `draining: false` and `admissionClosed: null`.
2. If the node address changed, update `CHALK_SFU_NODES` in the API's private settings and restart the API. Keep the node id the same.
3. Ask participants to reload the class page. The SDK asks the API for a new grant and joins the node again.
4. Open one new Episode as a test and check a second participant receives media. `features/media/sfu/tests` has `TestLiveSmoke`, which does the same end to end against a node through the deploy tunnel.

Drill result: after a service restart, `/readyz` answered again within 3 seconds and a fresh Episode with two guests passed the smoke test about 10 seconds later.

## Rebuild a node

Rebuild order: create the Droplet from the cloud-init template, wait for the bootstrap marker, run `deploy <env> <address>`, check `/readyz`, point the API at the node, run the smoke test. The steps are in [Own-SFU nodes](../../sfu/README.md).

Timed drill on a temporary 1 vCPU, 1 GB Droplet (not the production size) in the production region, using the throwaway `bench` environment, then deleted. Certificates already existed. The container image came from a warm local build cache.

| Phase                                                    | Elapsed |
| -------------------------------------------------------- | ------- |
| Droplet active                                           | 35 s    |
| First SSH login                                          | 47 s    |
| Cloud-init finished (bootstrap marker present)           | 163 s   |
| Deploy finished (`/readyz` 200 through the tunnel)       | 198 s   |
| First guest join through the node (`TestLiveSmoke` pass) | 215 s   |
| Restart and rejoin pass                                  | 229 s   |

The drill spent about 3.6 minutes from nothing to a node that carried a test call. A real rebuild adds the time to find the operator, update `CHALK_SFU_NODES` and restart the API, which was not timed; plan on 10 minutes in total. A cold image build, with no local cache, was not timed. Cost: under 1 USD, and the Droplet and firewall were deleted at the end of the run.

### Weekly backup or snapshot

Recommendation: do not turn on weekly backups. The node holds no state of its own (certificates are in 1Password and the private directory, the image and config come from the deploy), so the rebuild above takes under 4 minutes and a backup would only save part of the 163 seconds of cloud-init while restoring a stale image. DigitalOcean weekly backups cost 20% of the Droplet price: 3.60 USD a month for the 18 USD node, 43.20 USD a year. A manual snapshot costs 0.06 USD per GB-month of used disk; confirm the exact price in the DigitalOcean billing page before enabling either.

## Kill-switch steps (timed)

<!-- Owned by the kill-switch drill lane. Add the timed steps here; do not copy them elsewhere. -->

## Direct door / certificate expiry

<!-- Owned by the direct-door firewall and TLS expiry lane. Put the alert, its check and its fix here; this runbook does not duplicate them. -->
