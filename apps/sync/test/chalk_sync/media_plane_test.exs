defmodule ChalkSync.MediaPlaneTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.Stateholder.EpisodeKey

  test "exposes permission and observation controls without a remote capture-enable operation" do
    callbacks = ChalkSync.MediaPlane.behaviour_info(:callbacks)

    assert {:grant_publication, 5} in callbacks
    assert {:revoke_publication, 5} in callbacks
    assert {:remove_participant, 4} in callbacks
    assert {:end_episode, 3} in callbacks
    assert {:observe_episode_publications, 3} in callbacks

    refute Enum.any?(callbacks, fn {name, _arity} ->
             name in [:enable_capture, :force_publication]
           end)
  end

  test "test adapter preserves stable operation ids and scripted outcomes" do
    episode = episode()

    {:ok, adapter} =
      MediaPlaneTestAdapter.start_link(
        outcomes: %{{:revoke_publication, "operation-000001"} => :ambiguous}
      )

    assert :ambiguous =
             MediaPlaneTestAdapter.revoke_publication(
               adapter,
               "operation-000001",
               episode,
               "00000000-0000-4000-8000-000000000004",
               :camera
             )

    assert [{:revoke_publication, "operation-000001", [^episode, _, :camera]}] =
             MediaPlaneTestAdapter.calls(adapter)
  end

  defp episode do
    %EpisodeKey{
      tenant_id: "00000000-0000-4000-8000-000000000001",
      space_id: "00000000-0000-4000-8000-000000000002",
      episode_id: "00000000-0000-4000-8000-000000000003"
    }
  end
end
