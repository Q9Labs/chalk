defmodule ChalkSync.Transport.SocketLiveRequestsTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Observability.Journey
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Transport.Socket.LiveRequests

  defp coordinator do
    spawn_link(fn ->
      receive do
        {:"$gen_call", from, {:live_target, _socket, _identity, _target}} ->
          GenServer.reply(from, {:ok, %{"type" => "live_target_result"}})
      end
    end)
  end

  defp attach(parent) do
    ref = make_ref()

    :telemetry.attach(
      {__MODULE__, ref},
      [:chalk_sync, :observability, :event],
      fn
        _event, _measurements, %{event: "sync.media.intent"} = metadata, _config ->
          send(parent, {:intent, metadata})

        _event, _measurements, _metadata, _config ->
          :ok
      end,
      nil
    )

    on_exit(fn -> :telemetry.detach({__MODULE__, ref}) end)
  end

  test "a live target is stamped with the client's operation id, in the socket's own trace" do
    attach(self())
    episode = %EpisodeKey{tenant_id: "tenant", space_id: "space", episode_id: "episode"}
    identity = %Identity{episode: episode, participant_id: "p1", participant_generation: 1}
    context = %{Journey.new_context() | session_id: "session-1"}

    state = %{
      phase: :live,
      coordinator: coordinator(),
      identity: identity,
      observability: context
    }

    target = %{operation_id: "op-2", name: "set_microphone_enabled", enabled: false}
    before_ms = System.system_time(:millisecond)

    assert {:push, {:text, _frame}, next} = LiveRequests.live_target(target, state)

    assert_received {:intent,
                     %{journey_id: journey_id, session_id: "session-1", attributes: attributes}}

    assert journey_id == context.journey_id
    assert next.observability.journey_id == context.journey_id

    assert %{
             operation_id: "op-2",
             participant_id: "p1",
             source: "microphone",
             enabled: false,
             at_ms: at_ms
           } = attributes

    assert at_ms >= before_ms
    refute_received {:intent, _}
  end
end
