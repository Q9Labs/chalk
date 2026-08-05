defmodule ChalkSync.ObservabilityTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Observability

  @observability_event [:chalk_sync, :observability, :event]
  @runtime_event [:chalk_sync, :runtime, :health]
  @journey_id "10000000-0000-4000-8000-000000000001"
  @connection_journey_id "10000000-0000-4000-8000-000000000002"
  @exporter_journey_id "10000000-0000-4000-8000-000000000003"

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

  test "a partially correlated frame preserves the connection journey" do
    traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
    current = Observability.context(%{"journey_id" => @connection_journey_id})
    incoming = Observability.context(%{"traceparent" => traceparent})

    merged = Observability.merge(current, incoming)

    assert merged.journey_id == @connection_journey_id
    assert Observability.frame_fields(merged)["traceparent"] == traceparent
  end

  test "a later W3C context fills an uncorrelated root span" do
    traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
    previous = Application.get_env(:chalk_sync, :observability)

    Application.put_env(:chalk_sync, :observability, enabled: true)
    on_exit(fn -> Application.put_env(:chalk_sync, :observability, previous) end)

    current =
      %{"journey_id" => @connection_journey_id}
      |> Observability.context()
      |> Observability.root("sync.test.local_root", %{})

    assert_event("sync.test.local_root", @connection_journey_id, "root")

    fields =
      current
      |> Observability.merge(Observability.context(%{"traceparent" => traceparent}))
      |> Observability.frame_fields()

    assert fields["journey_id"] == @connection_journey_id
    assert fields["traceparent"] == traceparent
  end

  test "a later observed journey replaces a locally generated journey" do
    current = Observability.merge(nil, nil)

    fields =
      current
      |> Observability.merge(Observability.context(%{"journey_id" => @connection_journey_id}))
      |> Observability.frame_fields()

    assert fields["journey_id"] == @connection_journey_id
  end

  test "preserves first observed journey and W3C context across conflicting frames" do
    first_traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
    later_traceparent = "00-5bf92f3577b34da6a3ce929d0e0e4736-10f067aa0ba902b7-01"

    current =
      Observability.context(%{
        "journey_id" => @connection_journey_id,
        "traceparent" => first_traceparent,
        "tracestate" => "acme=first"
      })

    incoming =
      Observability.context(%{
        "journey_id" => @exporter_journey_id,
        "traceparent" => later_traceparent,
        "tracestate" => "acme=later"
      })

    fields = current |> Observability.merge(incoming) |> Observability.frame_fields()

    assert fields["journey_id"] == @connection_journey_id
    assert fields["traceparent"] == first_traceparent
    assert fields["tracestate"] == "acme=first"
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

  test "emits stable root and phase telemetry with journey correlation" do
    context = Observability.context(%{"journey_id" => @journey_id})
    context = Observability.root(context, "sync.test.root", %{transport: "websocket"})
    _context = Observability.phase(context, "sync.test.phase", %{outcome: "accepted"})

    assert_event("sync.test.root", @journey_id, "root")
    assert_event("sync.test.phase", @journey_id, "phase")
  end

  test "emits a bounded Episode event phase using the canonical subject" do
    context = Observability.context(%{"journey_id" => @journey_id})
    _context = Observability.episode_event(context, %{name: "participant_joined"})

    assert %{attributes: %{event_name: "participant_joined"}} =
             assert_event("sync.episode.event.committed", @journey_id, "phase")
  end

  test "does not retain unbounded Episode event names" do
    context = Observability.context(%{"journey_id" => @journey_id})
    _context = Observability.episode_event(context, %{name: "unexpected_event"})

    assert %{attributes: %{event_name: "other"}} =
             assert_event("sync.episode.event.committed", @journey_id, "phase")
  end

  test "replaces invalid incoming journey ids with API-compatible UUIDs" do
    context = Observability.context(%{"journey_id" => "journey-invalid"})
    context = Observability.phase(context, "sync.test.generated", %{})

    assert context.journey_id =~
             ~r/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

    refute context.journey_id == "journey-invalid"
  end

  test "runtime health reports bounded BEAM measurements" do
    Observability.runtime_health()

    assert_receive {:telemetry_event, @runtime_event, measurements, %{component: "beam"}}
    assert is_integer(measurements.memory_total_bytes)
    assert is_integer(measurements.process_count)
    assert is_integer(measurements.process_limit)
    assert is_integer(measurements.run_queue)

    metadata =
      assert_event("sync.runtime.health", _journey_id = nil, "phase", allow_any_journey?: true)

    assert metadata.attributes.memory_total_bytes == measurements.memory_total_bytes
    assert metadata.attributes.process_count == measurements.process_count
    assert metadata.attributes.process_limit == measurements.process_limit
    assert metadata.attributes.run_queue == measurements.run_queue
  end

  test "an exporter-side failure cannot break correlation emission" do
    previous = Application.get_env(:chalk_sync, :observability)

    Application.put_env(:chalk_sync, :observability,
      enabled: true,
      event_sink: fn _metadata -> raise "collector unavailable" end
    )

    on_exit(fn -> Application.put_env(:chalk_sync, :observability, previous) end)

    context = Observability.context(%{"journey_id" => @exporter_journey_id})

    assert %{journey_id: @exporter_journey_id} =
             Observability.phase(context, "sync.test.export", %{})

    assert_event("sync.test.export", @exporter_journey_id, "phase")
  end

  defp assert_event(event_name, journey_id, stage, options \\ []) do
    allow_any_journey? = Keyword.get(options, :allow_any_journey?, false)
    expected_event_name = Keyword.get(options, :event_name)

    await_event(event_name, journey_id, stage, allow_any_journey?, expected_event_name, 20)
  end

  defp await_event(
         _event_name,
         _journey_id,
         _stage,
         _allow_any_journey?,
         _expected_event_name,
         0
       ) do
    flunk("expected observability event was not emitted")
  end

  defp await_event(
         event_name,
         journey_id,
         stage,
         allow_any_journey?,
         expected_event_name,
         attempts
       ) do
    receive do
      {:telemetry_event, @observability_event, %{count: 1}, metadata} ->
        matches? =
          metadata.event == event_name and metadata.stage == stage and
            (allow_any_journey? or metadata.journey_id == journey_id) and
            (is_nil(expected_event_name) or metadata.attributes.event_name == expected_event_name)

        if matches? do
          metadata
        else
          await_event(
            event_name,
            journey_id,
            stage,
            allow_any_journey?,
            expected_event_name,
            attempts - 1
          )
        end
    after
      500 -> flunk("timed out waiting for observability event #{event_name}")
    end
  end
end
