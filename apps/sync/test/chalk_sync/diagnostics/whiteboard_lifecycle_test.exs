defmodule ChalkSync.Diagnostics.WhiteboardLifecycleTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Diagnostics
  alias ChalkSync.Diagnostics.Buffer
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity

  setup do
    previous = Application.get_env(:chalk_sync, :episode_diagnostics)
    buffer = Module.concat(__MODULE__, "Buffer#{System.unique_integer([:positive])}")
    start_supervised!({Buffer, name: buffer}, id: buffer)
    Application.put_env(:chalk_sync, :episode_diagnostics, %{mode: :localhost, buffer: buffer})

    on_exit(fn -> Application.put_env(:chalk_sync, :episode_diagnostics, previous) end)
    %{buffer: buffer}
  end

  test "retains correlated whiteboard transport lifecycle and terminal close code", %{
    buffer: buffer
  } do
    identity = %Identity{
      episode: %EpisodeKey{
        tenant_id: "10000000-0000-4000-8000-000000000001",
        space_id: "20000000-0000-4000-8000-000000000002",
        episode_id: "30000000-0000-4000-8000-000000000003"
      },
      participant_id: "40000000-0000-4000-8000-000000000004",
      participant_generation: 1
    }

    assert :ok =
             Diagnostics.record(:whiteboard_connect_succeeded, identity,
               attributes: %{transport: :websocket}
             )

    assert :ok =
             Diagnostics.record(:whiteboard_disconnect_observed, identity,
               attributes: %{transport: :websocket, close_code: 1008, reason: :permission_denied}
             )

    assert {:ok, scope, entries} = Buffer.take_batch(buffer, 10, 16 * 1024)
    assert scope["participantId"] == identity.participant_id

    assert Enum.map(entries, fn entry ->
             {entry.event["name"], entry.event["attributes"]}
           end) == [
             {"whiteboard.connect", %{"transport" => "websocket"}},
             {"whiteboard.disconnect",
              %{"transport" => "websocket", "close_code" => 1008, "reason" => "permission_denied"}}
           ]
  end
end
