#!/usr/bin/env python3
"""Prints one capacity run as JSON: node packet rates, CPU, steal and RSS from host.log,
and the live test's own view (repair, pacer drops, stalls, admission) from samples.jsonl."""
import json
import pathlib
import re
import statistics
import sys

SKIP_SECONDS = 120  # joining and the allocator settling


def stats(values):
    if not values:
        return None
    ordered = sorted(values)

    def at(q):
        return round(ordered[min(len(ordered) - 1, int(q * len(ordered)))], 2)

    return {"mean": round(statistics.fmean(ordered), 2), "p50": at(0.5), "p95": at(0.95), "p99": at(0.99), "max": round(ordered[-1], 2)}


def host_series(path):
    rows = []
    for line in path.read_text().splitlines():
        parts = line.split("|")
        if len(parts) != 4 or not parts[1].startswith("cpu") or ":" not in parts[2]:
            continue
        cpu = [int(v) for v in parts[1].split()[1:9]]
        nic = [int(v) for v in parts[2].split(":", 1)[1].split()]
        rss = int(parts[3]) if parts[3].strip().isdigit() else None
        rows.append((int(parts[0]), cpu, nic[1], nic[9], rss))
    rows = sorted({row[0]: row for row in rows}.values())  # one row per second, in case two samplers ran
    series = {"rx_pps": [], "tx_pps": [], "cpu_percent": [], "steal_percent": [], "rss_mib": []}
    start = rows[0][0] if rows else 0
    for before, after in zip(rows, rows[1:]):
        seconds = after[0] - before[0]
        if seconds <= 0 or after[0] - start < SKIP_SECONDS:
            continue
        total = sum(after[1]) - sum(before[1])
        if total <= 0:
            continue
        idle = (after[1][3] + after[1][4]) - (before[1][3] + before[1][4])
        steal = after[1][7] - before[1][7]
        series["cpu_percent"].append(100 * (total - idle - steal) / total)  # our own use of the node's vCPUs
        series["steal_percent"].append(100 * steal / total)
        series["rx_pps"].append((after[2] - before[2]) / seconds)
        series["tx_pps"].append((after[3] - before[3]) / seconds)
        if after[4]:
            series["rss_mib"].append(after[4] / 1024)
    return {name: stats(values) for name, values in series.items()}


def sample_view(path):
    samples = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    steady = [s for s in samples if s.get("elapsed") and s.get("ready")]
    if not steady:
        return {"samples": len(samples)}
    last, host = steady[-1], [s["ready"]["host"] for s in steady]
    first_node = steady[0]["node"]
    return {
        "samples": len(samples),
        "classes": max(s["classes"] for s in samples),
        "sessions": max(s["ready"]["sessions"] for s in steady),
        "reserved_packets": max(s["ready"].get("reservedPackets", 0) for s in steady),
        "packet_budget": last["ready"].get("packetBudget"),
        "node_reported_pps": stats([h["packetsPerSecond"] for h in host]),
        "pacer_queue_p95_ms": stats([h["queueDelayP95Ms"] for h in host]),
        "scheduler_latency_p99_ms": stats([h["schedulerLatencyP99Ms"] for h in host]),
        "steal_percent_node_view": stats([h["stealPercent"] for h in host if h.get("stealPercent") is not None]),
        "admission_reasons": sorted({h["admissionReason"] for h in host if h.get("admissionReason")}),
        "repair_sent": last["node"]["repairSent"] - first_node["repairSent"],
        "repairs_cut": last["node"]["repairsCut"],
        "pacer_dropped": last["node"]["pacerDropped"],
        "video_sent": last["node"]["videoSent"],
        "audio_sent": last["node"]["audioSent"],
        "forwarded_layers": last["node"].get("forwarded"),
        "paused": last["node"].get("paused"),
        "loss_percent": round(100 * (last["peers"]["expected"] - last["peers"]["received"]) / max(1, last["peers"]["expected"]), 3),
        "stalls": {"camera": last["peers"]["videoStalls"], "screen": last["peers"]["screenStalls"], "microphone": last["peers"]["audioStalls"]},
        "longest_stall_ms": last["peers"]["longestStallMs"],
        "udp_receive_buffer_errors": last["ready"]["host"].get("udpReceiveBufferErrors"),
        "generator_cpu_percent": stats([s["generator"]["cpuPercent"] for s in steady]),
        "generator_steal_percent": stats([s["generator"]["stealPercent"] for s in steady]),
    }


def diagnostics_view(path):
    if not path.exists():
        return None
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    return {"max_timer_lateness_ms": round(max((r["maxLatenessNs"] for r in rows), default=0) / 1e6, 1), "missed_ticks": sum(r["missedTicks"] for r in rows)}


def main():
    run = pathlib.Path(sys.argv[1])
    log = (run / "test.log").read_text() if (run / "test.log").exists() else ""
    result = re.findall(r"^--- (PASS|FAIL|SKIP).*$", log, re.M)
    refusals = re.findall(r"class \d+ Participant \d+: .*", log)
    summary = {
        "run": run.name,
        "test_result": result[-1] if result else "none",
        "first_refusal": refusals[0][:300] if refusals else None,
        "node_host": host_series(run / "host.log") if (run / "host.log").exists() else None,
        "test_samples": sample_view(run / "samples.jsonl") if (run / "samples.jsonl").exists() else None,
        "generator_timer": diagnostics_view(run / "diagnostics.jsonl"),
    }
    json.dump(summary, sys.stdout, indent=2)
    print()


main()
