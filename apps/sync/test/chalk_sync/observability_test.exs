defmodule ChalkSync.ObservabilityTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Observability

  @observability_event [:chalk_sync, :observability, :event]
  @runtime_event [:chalk_sync, :runtime, :health]
  @journey_id "10000000-0000-4000-8000-000000000001"

  setup do
    handler_id = "observability-test-#{System.unique_integer([:positive])}"
    parent = self()

    :ok =
      :telemetry.attach_many(
        handler_id,
        [@observability_event, @runtime_event],
        fn event, measurements, metadata, _config ->
          send(parent, {:telemetry_event, event, measurements, metadata})
        end,
        nil
      )

    on_exit(fn -> :telemetry.detach(handler_id) end)
    :ok
  end

  test "preserves unsampled trace flags and tracestate through durable context reconstruction" do
    traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00"
    tracestate = "acme=first"

    observed =
      Observability.context(%{
        "journey_id" => @journey_id,
        "traceparent" => traceparent,
        "tracestate" => tracestate
      })
      |> Observability.observed_operation_context()

    assert observed.producing_traceparent == traceparent
    assert observed.producing_tracestate == tracestate

    persisted =
      Observability.persisted_context(
        observed.journey_id,
        observed.producing_trace_id,
        observed.producing_span_id,
        observed.producing_traceparent,
        observed.producing_tracestate
      )

    fields = Observability.frame_fields(persisted)
    assert fields["traceparent"] == traceparent
    assert fields["tracestate"] == tracestate
  end
end
