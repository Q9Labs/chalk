from __future__ import annotations

import os
from typing import Optional

try:
    from opentelemetry import propagate, trace  # type: ignore
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter  # type: ignore
    from opentelemetry.propagators.textmap import DictGetter  # type: ignore
    from opentelemetry.sdk.resources import Resource  # type: ignore
    from opentelemetry.sdk.trace import TracerProvider  # type: ignore
    from opentelemetry.sdk.trace.export import BatchSpanProcessor  # type: ignore
except Exception:  # pragma: no cover
    propagate = None
    trace = None
    OTLPSpanExporter = None
    DictGetter = object
    Resource = None
    TracerProvider = None
    BatchSpanProcessor = None


class _CarrierGetter(DictGetter):
    def get(self, carrier, key):  # type: ignore[override]
        if carrier is None:
            return []
        val = carrier.get(key)
        if val is None:
            return []
        return [val]

    def keys(self, carrier):  # type: ignore[override]
        if carrier is None:
            return []
        return list(carrier.keys())


_getter = _CarrierGetter()


def init_tracing(*, service_name: str, env: str) -> None:
    if trace is None or OTLPSpanExporter is None:
        return

    domain = (os.getenv("AXIOM_DOMAIN") or "").strip()
    token = (os.getenv("AXIOM_TOKEN") or "").strip()
    dataset = (os.getenv("AXIOM_TRACES_DATASET") or "").strip()

    if domain == "" or token == "" or dataset == "":
        return

    resource = Resource.create(
        {
            "service.name": service_name,
            "deployment.environment": env,
            "cloud.region": os.getenv("AWS_REGION") or "unknown",
        }
    )

    exporter = OTLPSpanExporter(
        endpoint=f"https://{domain}/v1/traces",
        headers={
            "Authorization": f"Bearer {token}",
            "X-Axiom-Dataset": dataset,
        },
    )

    provider = TracerProvider(resource=resource)
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)


def extract_context_from_traceparent(traceparent: Optional[str]):
    if propagate is None:
        return None
    if not traceparent:
        return None
    carrier = {"traceparent": traceparent}
    return propagate.extract(carrier, getter=_getter)
