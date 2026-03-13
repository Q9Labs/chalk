from __future__ import annotations

import logging
import os
import traceback
from datetime import datetime, timezone

from .gpu_metrics import read_gpu_metrics
from .observability import emit_event
from .worker_config import GPU_METRICS_ENABLED, JOB_QUEUE, PROCESSING_QUEUE


class WorkerMetricsPublisher:
    def __init__(
        self,
        *,
        cloudwatch_client,
        metric_namespace: str,
        logger: logging.Logger,
        enable_gpu_metrics: bool = GPU_METRICS_ENABLED,
    ) -> None:
        self.cloudwatch = cloudwatch_client
        self.metric_namespace = metric_namespace
        self.logger = logger
        self.enable_gpu_metrics = enable_gpu_metrics

    @staticmethod
    def compute_queue_wait_ms(created_at: str | None) -> int | None:
        if not created_at:
            return None

        try:
            created_at_dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            wait_ms = (datetime.now(timezone.utc) - created_at_dt).total_seconds() * 1000
            return max(0, round(wait_ms))
        except Exception:
            return None

    @staticmethod
    def compute_rtf_ratio(
        processing_time_seconds: float | None,
        audio_duration_seconds: int | None,
    ) -> float | None:
        if processing_time_seconds is None:
            return None
        if audio_duration_seconds is None or audio_duration_seconds <= 0:
            return None
        return round(processing_time_seconds / audio_duration_seconds, 6)

    def publish_transcription(
        self,
        *,
        outcome: str,
        duration_ms: int,
        queue_wait_ms: int | None,
        download_size_bytes: int | None,
        processing_time_seconds: float | None,
        audio_duration_seconds: int | None,
        rtf_ratio: float | None,
    ) -> None:
        try:
            environment = os.getenv("ENVIRONMENT", "dev")
            timestamp = datetime.now(timezone.utc)
            metric_data = [
                {
                    "MetricName": "TranscriptionsTotal",
                    "Dimensions": [{"Name": "Environment", "Value": environment}],
                    "Timestamp": timestamp,
                    "Unit": "Count",
                    "Value": 1,
                },
                {
                    "MetricName": "TranscriptionDurationMs",
                    "Dimensions": [{"Name": "Environment", "Value": environment}],
                    "Timestamp": timestamp,
                    "Unit": "Milliseconds",
                    "Value": duration_ms,
                },
                {
                    "MetricName": (
                        "TranscriptionsCompleted"
                        if outcome == "completed"
                        else "TranscriptionsFailed"
                    ),
                    "Dimensions": [{"Name": "Environment", "Value": environment}],
                    "Timestamp": timestamp,
                    "Unit": "Count",
                    "Value": 1,
                },
            ]

            if queue_wait_ms is not None:
                metric_data.append(
                    {
                        "MetricName": "QueueWaitMs",
                        "Dimensions": [{"Name": "Environment", "Value": environment}],
                        "Timestamp": timestamp,
                        "Unit": "Milliseconds",
                        "Value": queue_wait_ms,
                    }
                )

            if processing_time_seconds is not None:
                metric_data.append(
                    {
                        "MetricName": "ProcessingTimeSeconds",
                        "Dimensions": [{"Name": "Environment", "Value": environment}],
                        "Timestamp": timestamp,
                        "Unit": "Seconds",
                        "Value": processing_time_seconds,
                    }
                )

            if audio_duration_seconds is not None and audio_duration_seconds > 0:
                metric_data.append(
                    {
                        "MetricName": "AudioDurationSeconds",
                        "Dimensions": [{"Name": "Environment", "Value": environment}],
                        "Timestamp": timestamp,
                        "Unit": "Seconds",
                        "Value": audio_duration_seconds,
                    }
                )

            if rtf_ratio is not None and rtf_ratio >= 0:
                metric_data.append(
                    {
                        "MetricName": "RtfRatio",
                        "Dimensions": [{"Name": "Environment", "Value": environment}],
                        "Timestamp": timestamp,
                        "Unit": "None",
                        "Value": rtf_ratio,
                    }
                )

            if download_size_bytes is not None and download_size_bytes > 0:
                metric_data.append(
                    {
                        "MetricName": "DownloadSizeBytes",
                        "Dimensions": [{"Name": "Environment", "Value": environment}],
                        "Timestamp": timestamp,
                        "Unit": "Bytes",
                        "Value": download_size_bytes,
                    }
                )

            self.cloudwatch.put_metric_data(
                Namespace=self.metric_namespace,
                MetricData=metric_data,
            )
        except Exception as error:
            emit_event(
                self.logger,
                level=logging.WARNING,
                event={
                    "event": "metrics.transcription_publish_failed",
                    "error": str(error),
                    "error_class": error.__class__.__name__,
                    "error_stack": traceback.format_exc(),
                },
            )

    def publish_gpu(self) -> None:
        if not self.enable_gpu_metrics:
            return

        try:
            gpu_metrics = read_gpu_metrics()
            if gpu_metrics is None:
                return

            environment = os.getenv("ENVIRONMENT", "dev")
            timestamp = datetime.now(timezone.utc)
            self.cloudwatch.put_metric_data(
                Namespace=self.metric_namespace,
                MetricData=[
                    {
                        "MetricName": "GpuUtilizationPercent",
                        "Dimensions": [{"Name": "Environment", "Value": environment}],
                        "Timestamp": timestamp,
                        "Unit": "Percent",
                        "Value": gpu_metrics.utilization_gpu_pct,
                    },
                    {
                        "MetricName": "GpuMemoryUtilizationPercent",
                        "Dimensions": [{"Name": "Environment", "Value": environment}],
                        "Timestamp": timestamp,
                        "Unit": "Percent",
                        "Value": gpu_metrics.utilization_memory_pct,
                    },
                    {
                        "MetricName": "GpuDeviceCount",
                        "Dimensions": [{"Name": "Environment", "Value": environment}],
                        "Timestamp": timestamp,
                        "Unit": "Count",
                        "Value": gpu_metrics.device_count,
                    },
                ],
            )
        except Exception as error:
            emit_event(
                self.logger,
                level=logging.WARNING,
                event={
                    "event": "metrics.gpu_publish_failed",
                    "error": str(error),
                    "error_class": error.__class__.__name__,
                    "error_stack": traceback.format_exc(),
                },
            )

    def publish_queue(self, redis_client) -> None:
        try:
            job_queue_depth = redis_client.llen(JOB_QUEUE)
            processing_queue_depth = redis_client.llen(PROCESSING_QUEUE)
            queue_depth = job_queue_depth + processing_queue_depth
            environment = os.getenv("ENVIRONMENT", "dev")
            timestamp = datetime.now(timezone.utc)
            self.cloudwatch.put_metric_data(
                Namespace=self.metric_namespace,
                MetricData=[
                    {
                        "MetricName": "TranscriptionQueueDepth",
                        "Dimensions": [{"Name": "Environment", "Value": environment}],
                        "Timestamp": timestamp,
                        "Unit": "Count",
                        "Value": queue_depth,
                    },
                    {
                        "MetricName": "TranscriptionJobQueueDepth",
                        "Dimensions": [{"Name": "Environment", "Value": environment}],
                        "Timestamp": timestamp,
                        "Unit": "Count",
                        "Value": job_queue_depth,
                    },
                    {
                        "MetricName": "TranscriptionProcessingQueueDepth",
                        "Dimensions": [{"Name": "Environment", "Value": environment}],
                        "Timestamp": timestamp,
                        "Unit": "Count",
                        "Value": processing_queue_depth,
                    },
                ],
            )
            emit_event(
                self.logger,
                level=logging.INFO,
                event={
                    "event": "whisper.queue_depth",
                    "queue_depth": queue_depth,
                    "job_queue_depth": job_queue_depth,
                    "processing_queue_depth": processing_queue_depth,
                },
            )
        except Exception as error:
            emit_event(
                self.logger,
                level=logging.WARNING,
                event={
                    "event": "metrics.publish_failed",
                    "error": str(error),
                    "error_class": error.__class__.__name__,
                    "error_stack": traceback.format_exc(),
                },
            )
