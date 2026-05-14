from __future__ import annotations

import subprocess
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class GpuMetrics:
    device_count: int
    utilization_gpu_pct: float
    utilization_memory_pct: float


def _parse_nvidia_smi_output(raw_output: str) -> Optional[GpuMetrics]:
    lines = [line.strip() for line in raw_output.splitlines() if line.strip()]
    if not lines:
        return None

    utilization_values: list[float] = []
    total_memory_used = 0.0
    total_memory_capacity = 0.0

    for line in lines:
        parts = [part.strip() for part in line.split(",")]
        if len(parts) != 3:
            continue
        try:
            gpu_util = float(parts[0])
            memory_used = float(parts[1])
            memory_total = float(parts[2])
        except ValueError:
            continue

        utilization_values.append(gpu_util)
        total_memory_used += memory_used
        total_memory_capacity += memory_total

    if not utilization_values:
        return None

    memory_utilization_pct = (
        (total_memory_used / total_memory_capacity) * 100 if total_memory_capacity > 0 else 0.0
    )

    return GpuMetrics(
        device_count=len(utilization_values),
        utilization_gpu_pct=round(sum(utilization_values) / len(utilization_values), 2),
        utilization_memory_pct=round(memory_utilization_pct, 2),
    )


def read_gpu_metrics(*, timeout_seconds: int = 2) -> Optional[GpuMetrics]:
    try:
        output = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=utilization.gpu,memory.used,memory.total",
                "--format=csv,noheader,nounits",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, subprocess.CalledProcessError):
        return None

    return _parse_nvidia_smi_output(output.stdout)
