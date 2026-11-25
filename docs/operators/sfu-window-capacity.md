# Scheduled Chalk SFU capacity

A Scheduled Episode is a plan. It does not open a Space, move a live Episode, or
end it at the expected end time. Use the booking API for the plans and keep the
standing SFU fleet in its existing infrastructure.

The controller looks ahead 25 minutes. It adds the peak concurrent booking
load to live Chalk SFU load. An in-progress booking already covered by a live
Episode in that Space contributes only the remaining expected load. A class
with up to three expected Participants takes one planning slot; four to six
take two, and larger calls take a node. The SFU still decides admission. This
estimate includes the SFU's screen-share reservation, but it is not a claim
about measured video or colocated capture performance.

A 2 vCPU window node is planned for four class slots. A booked window or live
overflow keeps one node's worth of spare capacity. Ordinary off-window load
within the standing capacity does not provision nodes. A controller budget or
provider failure may leave a scheduled window short of capacity; look for
`required_nodes > target_nodes`, `budget_limited=true`, and a persistent gap
between `online` and `target_nodes` in its logs.

## Run the controller

Use a separate service account from the Chalk API. Install the binary built
from `apps/api/cmd/sfu-window-controller` for the same API release as the
database. Supply the environment below from the host's encrypted secret store.
Use a direct connection to the environment's own database, not a
transaction-pooled endpoint: the controller holds a session advisory lock.
The database role needs read access to the schedules, Spaces, Episodes, and
Participants, and read/write access to `sfu_window_nodes`. It does not need the
database owner password. The Chalk API has no DigitalOcean credentials.

| Setting                                                                                                 | Value                                                                                                      |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `CHALK_SFU_WINDOW_ENVIRONMENT`                                                                          | `nightly` or `production`, matching the database, provider account, and certificates                       |
| `CHALK_SFU_WINDOW_MODE`                                                                                 | `scale` for normal operation or `retire` for rollback                                                      |
| `CHALK_SFU_WINDOW_DATABASE_URL`                                                                         | Direct controller DB connection; use `sslmode=verify-full` for remote endpoints                            |
| `CHALK_SFU_APPLICATION_ID`                                                                              | Same pool identity as in the API                                                                           |
| `CHALK_SFU_SERVER_NAME`, `CHALK_SFU_CA_FILE`, `CHALK_SFU_CLIENT_CERT_FILE`, `CHALK_SFU_CLIENT_KEY_FILE` | Same control trust settings as in the API                                                                  |
| `CHALK_SFU_WINDOW_PROVIDER_TOKEN`                                                                       | Dedicated DigitalOcean token for this environment; read Droplets and firewalls; create and delete Droplets |
| `CHALK_SFU_WINDOW_SNAPSHOT_ID`, `CHALK_SFU_WINDOW_REVISION`                                             | Ready-to-boot 2 vCPU snapshot and the exact SFU SHA it runs                                                |
| `CHALK_SFU_WINDOW_REGION`, `CHALK_SFU_WINDOW_VPC_UUID`                                                  | Window pool region and VPC                                                                                 |
| `CHALK_SFU_WINDOW_FIREWALL_ID`                                                                          | ID of the pre-created firewall targeting the environment's window firewall tag                             |
| `CHALK_SFU_WINDOW_STANDING_SLOTS`                                                                       | Verified standing capacity, accounting for the API's standby packet ceiling                                |
| `CHALK_SFU_WINDOW_BUDGET_NODE_HOURS`                                                                    | Rolling 31-day create budget, default 900 node-hours                                                       |

The journal records the firewall ID with each launch. Retire all nodes using
the old firewall before changing that ID. A replacement snapshot must support
the drain incarnation precondition reported by `/readyz`.

Use `chalk-sfu-window-<environment>` and
`chalk-sfu-window-<environment>-firewall` only for the controller's nodes. Attach
the pre-created firewall only to the latter tag. Allow the API/controller's
source addresses to TCP 8443 and the SFU's public media port to clients. The
controller does not open SSH. Keep standing nodes in the release bundle and in
`CHALK_ALERT_SFU_READY_URLS`. Do not put window nodes in either or in
`CHALK_SFU_NODES`: the API reads their routing from Postgres, not from a startup
environment variable. The standing readiness alert is not a window-capacity
alert.

On an unresolved create, find the journal's exact name in the environment's
provider inventory. The controller adopts the one matching Droplet if it
appears. Never submit another create for the same name. If the provider confirms
the request never created a Droplet, remove only that unfulfilled `starting`
intent with no recorded provider ID. A journal entry stuck in drain needs
operator investigation; silence does not prove emptiness.

## Roll out and roll back

1. Prove the exact release and image in Nightly with a 20-class booking against a
   disposable environment. Record the plan, available Droplet IDs before the
   start, media completion, host headroom, and provider disappearance after the
   expected end. Keep a real Episode beyond the expected end to check that the
   controller waits for it instead of ending it.
2. For a separately approved production rollout, first establish two standing
   2 vCPU nodes and verify both with the existing release and readiness checks.
   Drain and replace the 1 vCPU standby without taking down the primary. Verify
   the API's standby ceiling before counting its class slots. Deploy the schema
   and dynamic-routing API with the controller stopped, then enable the
   controller and watch a small scheduled window before routing the full peak.
3. To stop new changes immediately, stop the controller; the API retains
   existing routing. To unwind, set `CHALK_SFU_WINDOW_MODE=retire` and run it
   until all known window Droplets are gone. It fences bindings before drain,
   waits for no live Episode binding and two empty observations on the same
   boot, then deletes by verified provider ID. Do not roll back to an API that
   only knows standing nodes while any live Episode is bound to a window node.
   The schema can stay in place for a binary rollback.

At the supplied $0.0268 per 2 vCPU node-hour, four extra nodes for four hours
plus 25 minutes each day for 31 days cost about $14.68. This excludes standing
nodes, image storage, transfer, and time waiting for a live Episode to finish.
The default budget stops new creates before approximately $24.12 of tracked node-hours. At the
budget it retires excess capacity after the last bound Episode ends; it does
not interrupt an Episode to cap the bill.
