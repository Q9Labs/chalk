defmodule ChalkSync.MediaPlaneTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.Stateholder.SessionKey

  test "exposes permission and observation controls without a remote capture-enable operation" do
    callbacks = ChalkSync.MediaPlane.behaviour_info(:callbacks)

    assert {:grant_publication, 5} in callbacks
    assert {:revoke_publication, 5} in callbacks
    assert {:remove_participant, 4} in callbacks
    assert {:end_session, 3} in callbacks
    assert {:observe_session_publications, 2} in callbacks

    refute Enum.any?(callbacks, fn {name, _arity} ->
             name in [:enable_capture, :force_publication]
           end)
  end

  test "test adapter preserves stable operation ids and scripted outcomes" do
    session = session()

    {:ok, adapter} =
      MediaPlaneTestAdapter.start_link(
        outcomes: %{{:revoke_publication, "operation-000001"} => :ambiguous}
      )

    assert :ambiguous =
             MediaPlaneTestAdapter.revoke_publication(
               adapter,
               "operation-000001",
               session,
               "00000000-0000-4000-8000-000000000004",
               :camera
             )

    assert [{:revoke_publication, "operation-000001", [^session, _, :camera]}] =
             MediaPlaneTestAdapter.calls(adapter)
  end

  defp session do
    %SessionKey{
      tenant_id: "00000000-0000-4000-8000-000000000001",
      room_id: "00000000-0000-4000-8000-000000000002",
      session_id: "00000000-0000-4000-8000-000000000003"
    }
  end
end
