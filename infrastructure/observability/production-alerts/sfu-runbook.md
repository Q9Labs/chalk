# Chalk SFU on-call runbook

This runbook covers the production Chalk SFU node (`chalk_sfu`): what each alert means, how to check it, and the fix. Real addresses, instance ids and webhook URLs stay in private configuration and 1Password, never here. Operator access to a node is by SSH key and the deploy tunnel (see [Own-SFU nodes](../../sfu/README.md)); `<env>` below is `production` or `staging`.

## Where alerts come from and where they go

Which path covers which alert:

| Alert                                                       | Source                                                             | Fires when                                                                                                             | Goes to         |
| ----------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | --------------- |
| Node down                                                   | Axiom `sfu-readiness` branch, reason `unreachable`                 | At least 4 unhealthy minute samples in 5 minutes, latest still unhealthy (the API host cannot reach `/readyz`)         | Discord, Oncall |
| Node down                                                   | DigitalOcean ping check `chalk-sfu-<env>-ping`                     | The node fails the ping check from every region for 2 minutes                                                          | Discord         |
| CPU, memory or disk high                                    | DigitalOcean alert policies `chalk-sfu-<env>: ...`                 | CPU above 85%, memory above 85% or disk above 80% for 5 minutes                                                        | Discord         |
| Node unreachable, refusing calls, or near its packet budget | Axiom `sfu-readiness` branch, from the collector's `/readyz` probe | At least 4 unhealthy minute samples in 5 minutes, latest still unhealthy                                               | Discord, Oncall |
| Join failures on `chalk_sfu`                                | Axiom connection-report branch                                     | An accepted `join_failed` or `media_start_failed` report with provider `chalk_sfu` (one alert per Episode and failure) | Discord, Oncall |
| Recording failed or stranded                                | Axiom `recording` and `recording-stop` branches                    | A Recording Capture failed in the last 15 minutes, or a stop is stuck for 2 minutes                                    | Discord, Oncall |
| Overflow to `cf_sfu`                                        | Axiom `sfu-overflow` branch                                        | One or more `chalk_sfu.overflow` events in the last 2 minutes                                                          | Discord, Oncall |

The rule of thumb: every alert that goes through the collector and Axiom reaches Discord and Oncall. The DigitalOcean alerts reach Discord only. DigitalOcean accepts only Slack-format webhooks and answers HTTP 500 to the Oncall URL. So a node that is down reaches Oncall through the collector's `sfu-readiness` rule (the API host fails to read `/readyz`), and the DigitalOcean ping check is the second, independent signal in Discord. CPU, memory and disk high have no Oncall path: a host that is busy but still answers `/readyz` pages Oncall only once the node closes admission itself (`admission_cpu_busy` and the other admission reasons). The Axiom plan allows 3 monitors and no custom-webhook notifier, so every Axiom rule is a branch of the first grouped monitor, and Oncall is a Slack-type notifier. A paid Axiom plan would lift the Axiom limits; confirm its price on the Axiom billing page before buying. The plan to close the DigitalOcean gap is in [Follow-up: DigitalOcean alerts to Oncall](#follow-up-digitalocean-alerts-to-oncall).

DigitalOcean to Discord is proved at the Discord API, not seen in a client. The `/slack` endpoint of the Discord webhook accepts DigitalOcean's own payload: a captured CPU-alert body, sent once with a "[TEST, planned drill]" prefix, returned HTTP 200 with the body `ok`. That endpoint returns no message id, so the same content was posted once through the standard webhook JSON with `?wait=true` and read back with `GET /webhooks/{id}/{token}/messages/{message id}`: Discord stored a webhook message from "DigitalOcean" with the embed title "Monitor triggered: chalk-sfu-test: cpu-above-85", the description "CPU Utilization Percent is currently at 100.00%, above setting of 85.00% for the last 5m", the Droplet and IP fields and the red colour. The standard-webhook post is a proxy. It does not prove that DigitalOcean's own POST reached Discord, and DigitalOcean's API keeps no delivery history to read. A person has not looked at the channel in a client, so how the message renders there is unconfirmed.

The collector probe is on for the production host (see [the readiness probe](#the-readiness-probe-on-the-production-host)). If it is ever turned off, the `sfu-readiness` branch has no data and cannot alert, so node health reaches the team only through the DigitalOcean alerts.

Set the DigitalOcean side with `do-monitoring.sh <env> plan|apply|remove` and the Axiom side with `provision.py`. The `remove` action deletes everything the script made.

## The readiness probe on the production host

The collector's `/readyz` probe is on for the production node. It runs every minute as part of `chalk-alert-state.service`, which runs as the `chalk` user with `/run/chalk/env/api.env` and, when present, `/etc/chalk-alerts/collector.env`. The variables and what the probe reports are in [Own SFU readiness](README.md#own-sfu-readiness). Use the steps below to enable it on a new host, to renew its certificate copies, or to see how it was set up. Run them as root on the API host (by SSM or SSH).

The probe needs the API's mutual-TLS client certificate, key and CA. On the production host the API reads them from podman secrets mounted only inside its container, so there are no readable host files. Step 2 copies them out of the `chalk` user's podman secret store into `/etc/chalk-alerts/sfu/`. The directories and files belong to root, so a compromised collector cannot change its own settings: `/etc/chalk-alerts` is `root:root 0755`, the `sfu` directory `root:chalk 0750`, and the files `root:chalk 0440`. No value is printed.

1. Install a collector build that knows the probe, and keep the old one for the undo. The count of `CHALK_ALERT_SFU_READY_URL` in the binary must be at least 1. Build as in the README, copy the file to the host, check its `sha256sum` against the one you built, then:

   ```sh
   cp -p /opt/chalk-alerts/collector /opt/chalk-alerts/collector.before-sfu-probe
   install -m 0755 collector.new /opt/chalk-alerts/collector
   grep -a -c CHALK_ALERT_SFU_READY_URL /opt/chalk-alerts/collector
   ```

2. Copy the three files out of the podman secrets. The script finds each secret by the path the API's quadlet mounts it at, writes to a new file first and replaces the old copy only when the whole read worked, so a failed read leaves the working copy in place. It is safe to run again (see Renewal).

   ```sh
   set -euo pipefail
   unitf=/home/chalk/.config/containers/systemd/chalk-api.container
   api=/run/chalk/env/api.env
   val() { sed -n "s/^$1=//p" "$api" | head -1; }
   install -d -m 0755 -o root -g root /etc/chalk-alerts
   install -d -m 0750 -o root -g chalk /etc/chalk-alerts/sfu
   for var in CHALK_SFU_CA_FILE CHALK_SFU_CLIENT_CERT_FILE CHALK_SFU_CLIENT_KEY_FILE; do
     path="$(val $var)"; [ -n "$path" ] || { echo "missing $var"; exit 1; }
     name="$(grep -E "^Secret=[^,]+,.*target=${path}(,|\$)" "$unitf" | sed -E 's/^Secret=([^,]+),.*/\1/' | head -1)"
     [ -n "$name" ] || { echo "no secret mounted at the path of $var"; exit 1; }
     dest="/etc/chalk-alerts/sfu/$(basename "$path")"
     ( umask 077; runuser -u chalk -- env XDG_RUNTIME_DIR=/run/user/$(id -u chalk) podman secret inspect --showsecret --format '{{.SecretData}}' "$name" >"$dest.new" )
     [ -s "$dest.new" ] || { rm -f "$dest.new"; echo "empty secret for $var"; exit 1; }
     chown root:chalk "$dest.new"; chmod 0440 "$dest.new"; mv -f "$dest.new" "$dest"
   done
   ```

   Check the copies: `openssl x509 -in <file> -noout -enddate` for the certificate and the CA, and `openssl pkey -in <file> -noout` for the key.

3. Add the settings, once. The script does nothing if the probe is already set, so a repeat never adds a second line or overwrites the backup of the pre-probe file.

   ```sh
   set -euo pipefail
   api=/run/chalk/env/api.env
   env_file=/etc/chalk-alerts/collector.env
   val() { sed -n "s/^$1=//p" "$api" | head -1; }
   if grep -q '^CHALK_ALERT_SFU_READY_URL=' "$env_file" 2>/dev/null; then echo "probe already set"; exit 0; fi
   node="$(val CHALK_SFU_NODES | cut -d, -f1 | cut -d= -f2-)"
   server_name="$(val CHALK_SFU_SERVER_NAME)"
   [ -n "$node" ] && [ -n "$server_name" ] || { echo "missing node or server name"; exit 1; }
   if [ -e "$env_file" ] && [ ! -e "$env_file.before-sfu-probe" ]; then cp -p "$env_file" "$env_file.before-sfu-probe"; fi
   umask 027
   {
     echo "CHALK_ALERT_SFU_READY_URL=${node}/readyz"
     echo "CHALK_ALERT_SFU_SERVER_NAME=${server_name}"
     echo "CHALK_ALERT_SFU_CA=/etc/chalk-alerts/sfu/$(basename "$(val CHALK_SFU_CA_FILE)")"
     echo "CHALK_ALERT_SFU_CLIENT_CERT=/etc/chalk-alerts/sfu/$(basename "$(val CHALK_SFU_CLIENT_CERT_FILE)")"
     echo "CHALK_ALERT_SFU_CLIENT_KEY=/etc/chalk-alerts/sfu/$(basename "$(val CHALK_SFU_CLIENT_KEY_FILE)")"
   } >>"$env_file"
   chown root:chalk "$env_file"; chmod 0640 "$env_file"
   ```

4. Run the collector once and read one `sfu-readiness` row with value 0:

   ```sh
   systemctl start chalk-alert-state.service && journalctl -u chalk-alert-state.service -n 15 --no-pager
   ```

   Then look for `chalk_alert_rule == 'sfu-readiness'` rows in the log dataset (Axiom). Do not turn the probe on while a deploy has the node draining: the probe would report `draining` and pages after 4 minutes.

**Renewal.** The copies in `/etc/chalk-alerts/sfu/` do not follow the API's secrets. When the API's client certificate or CA is renewed, run step 2 and then step 4. Do not run step 3 again: the settings point at the same file names. A stale copy often still handshakes until the node's trust changes, so it can look fine and then show as `tls_config` or `unreachable` and page after 4 minutes; renew the copies in the same change as the certificate.

**Undo.** Restore the previous binary and settings, move the copies away and run the service once. The rows stop and the branch goes idle on its own. The backup of the pre-probe settings exists only if the file existed before step 3, and it is never overwritten by a repeat:

```sh
cd /opt/chalk-alerts && cp -p collector.before-sfu-probe collector
if [ -f /etc/chalk-alerts/collector.env.before-sfu-probe ]; then cp -p /etc/chalk-alerts/collector.env.before-sfu-probe /etc/chalk-alerts/collector.env; else mv /etc/chalk-alerts/collector.env /etc/chalk-alerts/collector.env.removed-by-undo; fi
mv /etc/chalk-alerts/sfu /etc/chalk-alerts/sfu.removed-by-undo
systemctl start chalk-alert-state.service
```

To stop only the probe and keep the new binary, comment out `CHALK_ALERT_SFU_READY_URL` in `/etc/chalk-alerts/collector.env` and run the service once.

## Follow-up: DigitalOcean alerts to Oncall

Not built here. DigitalOcean alert policies can post only to a Slack-format receiver, and the Oncall webhook is not one, so node down and CPU, memory or disk high reach Discord only. The plan is a small free forwarder: one Cloudflare Worker that accepts DigitalOcean's Slack-format POST, re-posts it to the Oncall webhook in Oncall's payload shape and to Discord, and is set as the policies' Slack URL in `do-monitoring.sh`. Until it exists, the readiness probe is the way Oncall hears of a down node, through the `sfu-readiness` rule.

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

**Check.** Read the DigitalOcean graphs for the Droplet. On the node, `top` and `journalctl _SYSTEMD_USER_UNIT=chalk-sfu.service -n 200` show the media telemetry lines. `/readyz` answers 200 even when the host guard has closed admission; the body field `host.admissionReason` names the reason (`cpu_steal`, `cpu_busy`, `scheduler_latency`, `pacer_drops` or `udp_buffer_errors`) and is absent while the node admits new Episodes.

**Fix.** If the load is real classes, nothing breaks; plan capacity before the next class (a larger Droplet needs a rebuild, a second node needs a `CHALK_SFU_NODES` change). If one process runs away, restart the service. If disk is full, remove old journal files with `journalctl --vacuum-size=200M` and unused container images with `runuser -u chalk-sfu -- podman image prune`.

### Node unreachable, refusing calls, or near its packet budget (`sfu-readiness`)

**Meaning.** The alert text names the latest readiness reason:

| Reason                                                                     | Meaning                                                                    | First check                                                   |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `unreachable`                                                              | The API host could not connect, handshake or finish `/readyz` in 5 seconds | Node down checklist above                                     |
| `tls_config`                                                               | A certificate, key or CA file for the probe is missing or invalid          | Collector environment and cert files                          |
| `draining`                                                                 | The node answers 503 because it is draining for a deploy                   | A deploy is running or crashed                                |
| `http_status`, `invalid_response`                                          | The node answers, but not with a valid ready response                      | Node journal; wrong build                                     |
| `admission_cpu_steal`, `admission_cpu_busy`, `admission_scheduler_latency` | The node closed admission itself because the host is overloaded            | CPU graph; noisy neighbour on the host                        |
| `admission_pacer_drops`                                                    | The packet pacer drops packets: the node cannot send media fast enough     | CPU graph; packet rate on `/readyz`                           |
| `admission_udp_buffer_errors`                                              | The kernel drops UDP packets: socket buffers are too small or full         | `grep Udp /proc/net/snmp` on the node (`RcvbufErrors` rising) |
| `packet_budget`                                                            | Reserved packets are at least 90% of the node's packet budget              | Count of live Episodes on the node                            |

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

**Check.** Read the reason in the alert, then `/readyz` for `host.admissionReason`, `draining`, `protocol`, `packetBudget` and `reservedPackets`. A `protocol_too_old` reason means the node runs a build older than the API sends: deploy the node.

**Fix.** Fix the reason: restart or rebuild the node, deploy the matching build, or add capacity. The alert closes two minutes after the last overflow event.

## Rejoin steps

A node that restarts or is rebuilt with the same node id keeps its name in the Episodes bound to it. Calls on the old process are gone, but the Episode can run again on the node.

1. Check `/readyz` is 200 with `draining: false` and no `host.admissionReason` field. A 200 alone does not mean the node admits new Episodes.
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

## What guests see when the media node restarts or reboots

Measured once on the staging node (1 vCPU, 1 GB Droplet) with two live guests on `chalk_sfu`, sampled every 250 ms. The guests stayed on the same page for both faults. Neither guest reloaded or rejoined by hand, the roster stayed at 2 and no error code appeared. Both are single runs, so read the times as an order of magnitude, not a promise.

| Fault                                                       | Guest-visible state                                                                                                                                                                     | Media frozen | Back to flowing                           |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------- |
| Media node process restart (`systemctl --user ... restart`) | Video and audio freeze at once. About 6 s later each guest shows `reconnecting` for about 5 s, its camera and microphone show `requesting` while they publish again, then `live`.       | about 14 s   | about 13 s after the restart command ends |
| Node host reboot                                            | Video and audio freeze at once. Each guest shows `reconnecting` for about 24 s, with camera and microphone `requesting`, until the host is back and the service is active, then `live`. | about 34 s   | about 37 s after the reboot command       |

Expected behaviour per case:

1. **Process restart.** Tell the class to wait about 15 seconds. The SDK recovers on its own: do not ask guests to reload, since a reload only adds its own join time.
2. **Host reboot.** The Droplet and service were back about 29 s after the reboot command and guests were flowing about 8 s after that. Tell the class to wait under a minute. The test did not cover an outage longer than this, so if the node is still down after 2 minutes, treat it as the Node down case above. How long the SDK keeps trying before it gives up was not measured, so ask guests who are still frozen to reload.

The guests' `reconnecting` state started about 6 s after media stopped in both runs.

## After a host resize or deploy

After a host resize or deploy, run one throwaway two-guest proof before trusting the host. It creates one random-named Episode directly on the node, sends audio and video between two test participants, ends the Episode and checks the node returns to its earlier load. It prints `<env>-live-smoke: PASS` or `FAIL: <reason>`.

```sh
features/media/sfu/scripts/live-smoke production --confirm production
```

On staging, hold the staging lease: `scripts/staging-sfu/staging-lock --holder <you> --purpose live-smoke --run-id <label> -- features/media/sfu/scripts/live-smoke staging --confirm staging`.

## Kill-switch steps (timed)

The procedure to send one Space back to Cloudflare, and to return it, is [Send one Space back to Cloudflare, and return it](../../sfu/README.md#send-one-space-back-to-cloudflare-and-return-it) in the own-SFU README. It holds the commands, who may run them, how to move a live call, the verification, and the measured times. On staging the operator command returned in under 3 s, and both guests of a live call had media on the other plane about 30 s after the flip.

Use the Space setting first: it touches one Space and needs no API reload. Stopping every new Episode (`media-settings new-episodes --state off --operator <name> --reason <text>`) is the second step and needs no API reload, described in the same section.

## Direct door / certificate expiry

<!-- Owned by the direct-door firewall and TLS expiry lane. Put the alert, its check and its fix here; this runbook does not duplicate them. -->
