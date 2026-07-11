defmodule ChalkSync.ObservabilityTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Observability
  alias ChalkSync.Protocol
  alias ChalkSync.Rooms.Room
  alias ChalkSync.Rooms.RoomServer
  alias ChalkSync.Stateholder
  alias ChalkSync.Transport.Socket

  @observability_event [:chalk_sync, :observability, :event]
  @runtime_event [:chalk_sync, :runtime, :health]
  @journey_id "10000000-0000-4000-8000-000000000001"
  @connection_journey_id "10000000-0000-4000-8000-000000000002"
  @exporter_journey_id "10000000-0000-4000-8000-000000000003"
  @revision_journey_id "10000000-0000-4000-8000-000000000004"

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

  test "preserves W3C context and journey ids in protocol frames" do
    traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

    assert {:ok,
            {:ping, %{journey_id: @journey_id, traceparent: ^traceparent, tracestate: "acme=1"}},
            context} =
             Protocol.decode_with_context(
               ~s({"type":"ping","journey_id":"#{@journey_id}","traceparent":"#{traceparent}","tracestate":"acme=1"})
             )

    assert context.journey_id == @journey_id

    encoded = context |> Protocol.encode_pong() |> JSON.decode!()
    assert encoded["journey_id"] == @journey_id
    assert encoded["traceparent"] == traceparent
    assert encoded["tracestate"] == "acme=1"
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

  test "emits stable root and phase telemetry with journey correlation" do
    context = Observability.context(%{"journey_id" => @journey_id})
    context = Observability.root(context, "sync.test.root", %{transport: "websocket"})
    _context = Observability.phase(context, "sync.test.phase", %{outcome: "accepted"})

    assert_event("sync.test.root", @journey_id, "root")
    assert_event("sync.test.phase", @journey_id, "phase")
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

  test "a malformed frame emits a rejected phase and a terminal event" do
    {:ok, state} = Socket.init(%{})
    Process.cancel_timer(state.hello_timer)

    assert {:push, {:text, error}, state} =
             Socket.handle_in({"{not-json", [opcode: :text]}, state)

    assert %{"type" => "error", "code" => "protocol_error"} = JSON.decode!(error)

    journey_id = state.observability.journey_id
    assert_event("sync.websocket.handshake", journey_id, "root")
    assert_event("sync.protocol.rejected", journey_id, "phase")

    assert :ok = Socket.terminate(:normal, state)
    assert_event("sync.connection.closed", journey_id, "terminal")
  end

  test "a hello timeout emits its phase before the terminal close" do
    {:ok, state} = Socket.init(%{})
    Process.cancel_timer(state.hello_timer)

    assert {:stop, :normal, {1002, "hello timeout"}, state} =
             Socket.handle_info(:hello_timeout, state)

    journey_id = state.observability.journey_id
    assert_event("sync.hello.timeout", journey_id, "phase")

    assert :ok = Socket.terminate(:normal, state)
    assert_event("sync.connection.closed", journey_id, "terminal")
  end

  test "subscriber disconnect keeps the joining journey and trace context" do
    room_id = "room-observability-#{System.unique_integer([:positive])}"
    traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

    context =
      Observability.context(%{
        "journey_id" => @connection_journey_id,
        "traceparent" => traceparent,
        "tracestate" => "acme=1"
      })

    assert {:ok, _room_pid, _reply} = RoomServer.join(room_id, "p1", "Ada", self())

    subscriber =
      spawn(fn ->
        receive do
          :disconnect -> :ok
        end
      end)

    assert {:ok, _room_pid, _reply} =
             RoomServer.join(room_id, "p2", "Bo", subscriber, nil, context)

    assert_receive {:sync_event, %{name: "participant_joined"}, _context}

    send(subscriber, :disconnect)

    assert_receive {:sync_event, %{name: "participant_left"}, leave_context}

    assert Observability.frame_fields(leave_context) == %{
             "journey_id" => @connection_journey_id,
             "traceparent" => traceparent,
             "tracestate" => "acme=1"
           }

    assert %{attributes: %{event_name: "participant_left"}} =
             assert_event("sync.room.broadcast", @connection_journey_id, "phase",
               event_name: "participant_left"
             )

    assert %{attributes: %{event_name: "participant_left"}} =
             assert_event("sync.room.event.committed", @connection_journey_id, "phase",
               event_name: "participant_left"
             )
  end

  test "a stateholder revision conflict emits a linked recovery phase" do
    room_id = "room-observability-#{System.unique_integer([:positive])}"
    context = Observability.context(%{"journey_id" => @revision_journey_id})

    assert {:ok, _room_pid, _reply} = RoomServer.join(room_id, "p1", "Ada", self(), nil, context)
    assert {:ok, room} = Stateholder.load(room_id)
    assert {:ok, event, advanced_room} = Room.apply_command(room, "p1", :raise_hand, %{})
    assert :ok = Stateholder.commit(room_id, event.base_revision, event, advanced_room)

    assert {:rejected, :retry} =
             RoomServer.command(room_id, "p1", "c-1", :raise_hand, %{}, context)

    assert_event("sync.room.revision_conflict", @revision_journey_id, "phase")
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
