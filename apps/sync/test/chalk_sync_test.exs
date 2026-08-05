defmodule ChalkSyncTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.WhiteboardV1.Fanout

  test "supervision tree is running with core children" do
    children = Supervisor.which_children(ChalkSync.Supervisor)
    ids = Enum.map(children, fn {id, _pid, _type, _mods} -> id end)

    assert ChalkSync.Stateholder.Memory in ids
  end

  test "supervised process groups accept whiteboard subscriptions" do
    episode = %EpisodeKey{
      tenant_id: "11111111-1111-4111-8111-111111111111",
      space_id: "22222222-2222-4222-8222-222222222222",
      episode_id: "33333333-3333-4333-8333-333333333333"
    }

    assert is_pid(Process.whereis(:pg))
    assert :ok = Fanout.subscribe(episode)
    assert :ok = Fanout.broadcast_local(episode, %{"type" => "cursor"})
    assert_receive {:whiteboard_v1_frame, %{"type" => "cursor"}}
    assert :ok = Fanout.unsubscribe(episode)
  end
end
