defmodule ChalkSync.Transport.SocketPingTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Transport.SocketV1

  defmodule RecordingStateholder do
    @moduledoc false

    def renew_presence(identity) do
      send(:persistent_term.get({__MODULE__, :test}), {:renew_presence, identity})
      :persistent_term.get({__MODULE__, :result})
    end
  end

  setup do
    previous = Application.fetch_env!(:chalk_sync, :stateholder)
    Application.put_env(:chalk_sync, :stateholder, RecordingStateholder)
    :persistent_term.put({RecordingStateholder, :test}, self())
    :persistent_term.put({RecordingStateholder, :result}, :ok)

    on_exit(fn ->
      Application.put_env(:chalk_sync, :stateholder, previous)
      :persistent_term.erase({RecordingStateholder, :test})
      :persistent_term.erase({RecordingStateholder, :result})
    end)

    {:ok, state} = SocketV1.init([])
    identity = %Identity{episode: :episode, participant_id: "p1", participant_generation: 1}
    {:ok, identity: identity, state: %{state | phase: :live, identity: identity}}
  end

  test "a ping answers with pong before the presence renewal runs", %{
    state: state,
    identity: identity
  } do
    assert {:push, {:text, pong}, state} = ping(state)

    assert %{"type" => "pong"} = JSON.decode!(pong)
    refute_received {:renew_presence, _identity}
    assert_received :renew_presence

    assert {:ok, _state} = SocketV1.handle_info(:renew_presence, state)
    assert_received {:renew_presence, ^identity}
  end

  test "each ping renews presence exactly once", %{state: state, identity: identity} do
    {:push, _pong, state} = ping(state)
    {:push, _pong, state} = ping(state)

    assert_received :renew_presence
    assert_received :renew_presence
    refute_received :renew_presence

    {:ok, state} = SocketV1.handle_info(:renew_presence, state)
    {:ok, _state} = SocketV1.handle_info(:renew_presence, state)

    assert_received {:renew_presence, ^identity}
    assert_received {:renew_presence, ^identity}
    refute_received {:renew_presence, _identity}
  end

  test "a failed renewal still closes the socket as service restart", %{state: state} do
    :persistent_term.put({RecordingStateholder, :result}, {:retryable, :database_unavailable})

    assert {:stop, :normal, {1012, "service restart"}, stopped} =
             SocketV1.handle_info(:renew_presence, state)

    assert stopped.terminal == %{close_code: 1012, reason: :dependency_unavailable}
  end

  test "a ping before the socket is live neither renews nor schedules a renewal", %{state: state} do
    state = %{state | phase: :awaiting_hello}

    assert {:push, {:text, _pong}, _state} = ping(state)
    refute_received :renew_presence
    refute_received {:renew_presence, _identity}
  end

  defp ping(state),
    do: SocketV1.handle_in({JSON.encode!(%{"type" => "ping"}), [opcode: :text]}, state)
end
