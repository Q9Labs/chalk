# SFU load test

Measures how much media one SFU node forwards on a small machine. It replaces the design's guesses (CPU per packet, memory per PeerConnection) with numbers.

| Command         | What it does                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `loadgen`       | Real Pion peers. Each Participant pushes a camera (2.5 Mbps high layer, 650 kbps low layer, 1,100-byte payloads) and Opus (50 packets/s), then pulls every other Participant, on one PeerConnection. It uses the real mutual-TLS control API. |
| `benchnode`     | The real `control.Start` service, plus a loopback-only pprof server and a one-second JSON sample of host CPU, steal, network, UDP errors, RSS, Go heap and GC pauses. `cmd/sfu` stays untouched.                         |
| `benchcerts`    | A throwaway CA, server certificate and client certificate, like the M1 test PKI.                                                                                                                                         |
| `report`        | Merges `loadgen`'s results with `benchnode`'s samples into one table row per step.                                                                                                                                        |
| `bench.sh`      | Creates the Droplets, runs ramps and profiles, collects results, and deletes the Droplets by tag.                                                                                                                         |

## What the numbers mean

- Receive figures come from packets that reached a subscriber: packets and bytes per stream, loss from RTP sequence gaps, and RFC 3550 interarrival jitter. Each packet's RTP timestamp is its true send time, so jitter holds only the delay the network and the SFU added.
- The generator starts the high layer first and the low layer one second later. M1 forwards the first layer to arrive, so every subscriber receives the high layer. That is the all-high worst case. `videoStreamKbps` in the results proves which layer arrived.
- Load rises in steps of whole Episodes. Each step joins the new Episodes, settles for 15 s, then measures a window (3 min by default). Results are written after every step.
- CPU is percent of the whole host (all vCPUs). The per-packet cost divides CPU time by UDP datagrams in plus out at the SFU, the same unit the design budgets in.
- The generator's own CPU is in every row. A row with generator CPU near 70% or more does not measure the SFU.
- Packet-level work M1 does not do (TWCC, NACK and RTX policy, pacing, layer switching) is not in the numbers.

## Run it locally

```sh
cd features/media/sfu
go run ./tests/load/benchcerts -out /tmp/sfu-bench-certs
SFU_TLS_CERT_FILE=/tmp/sfu-bench-certs/server.pem SFU_TLS_KEY_FILE=/tmp/sfu-bench-certs/server.key \
SFU_CLIENT_CA_FILE=/tmp/sfu-bench-certs/ca.pem SFU_CLIENT_IDENTITY=chalk-api.test \
SFU_CONTROL_ADDR=127.0.0.1:8443 SFU_UDP_ADDR=127.0.0.1:50000 SFU_ANNOUNCE_IPS=127.0.0.1 SFU_ICE_LOOPBACK=true \
go run ./tests/load/benchnode &
go run ./tests/load/loadgen -sfu https://127.0.0.1:8443 -ca /tmp/sfu-bench-certs/ca.pem \
  -cert /tmp/sfu-bench-certs/client.pem -key /tmp/sfu-bench-certs/client.key -loopback \
  -size 4 -steps 1,2 -hold 20s -settle 5s
```

Host CPU, steal and network figures need Linux (`/proc`); elsewhere they read as zero.

## Run it on DigitalOcean

`bench.sh` needs `doctl` signed in, and Go. It keeps keys, addresses and results in `$BENCH_DIR` (default `~/.cache/chalk-sfu-bench`), outside Git. Every Droplet carries the tag `chalk-sfu-bench`, and `down` deletes only by that tag.

```sh
cd features/media/sfu
tests/load/bench.sh up                                  # 1 GiB node, 2 GiB node, generator in sgp1
tests/load/bench.sh ramp 2 2gb-4p 4 1,2,4,6,8,10,12 3m  # node 2, four-person Episodes
tests/load/bench.sh ramp 2 2gb-8p 8 1,2,3,4 3m          # node 2, eight-person Episodes
tests/load/bench.sh profile 2 2gb-profile 4 8           # CPU, heap and allocs profiles at 8 Episodes
tests/load/bench.sh down
```

A ramp stops by itself when host CPU stays above 75% for a minute (`STOP_CPU`), when loss passes 5%, or when a PeerConnection drops. Run `go tool pprof -top results/<label>/benchnode.linux results/<label>/cpu.pprof` on the profile run.

Size the generator so its CPU stays under 70%. The nodes run with `GOGC=200` and the design's `GOMEMLIMIT` (768 MiB on 2 GiB, 384 MiB on 1 GiB).
