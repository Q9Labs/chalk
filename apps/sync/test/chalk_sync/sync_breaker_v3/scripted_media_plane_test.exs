defmodule ChalkSync.SyncBreakerV3.ScriptedMediaPlaneTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Stateholder.SessionKey
  alias ChalkSync.SyncBreakerV3.ScriptedMediaPlane

  @session %SessionKey{tenant_id: "tenant", room_id: "room", session_id: "session"}

  test "deduplicates stable external operation effects across lost responses and adapter restart" do
    actions = [
      {:grant_publication, :effect_applied_then_response_lost},
      {:grant_publication, :confirmed}
    ]

    {:ok, controller} = ScriptedMediaPlane.start_controller(actions)
    adapter = ScriptedMediaPlane.adapter(controller)

    assert :ambiguous =
             ScriptedMediaPlane.grant_publication(
               adapter,
               "operation-1",
               @session,
               "person",
               :camera
             )

    restarted = ScriptedMediaPlane.restart_adapter(adapter)

    assert :confirmed =
             ScriptedMediaPlane.grant_publication(
               restarted,
               "operation-1",
               @session,
               "person",
               :camera
             )

    assert [%{operation_id: "operation-1"}] = ScriptedMediaPlane.effects(controller)
    assert length(ScriptedMediaPlane.calls(controller)) == 2
    assert ScriptedMediaPlane.projection(controller)["publications"] |> length() == 1

    assert {:ok, restarted_controller} = ScriptedMediaPlane.restart_controller(controller)

    original_projection = ScriptedMediaPlane.projection(controller)
    restarted_projection = ScriptedMediaPlane.projection(restarted_controller)
    assert restarted_projection["incarnation"] == original_projection["incarnation"] + 1

    assert Map.delete(restarted_projection, "incarnation") ==
             Map.delete(original_projection, "incarnation")
  end

  test "uses explicit barriers before and after effects and fences stale observations" do
    actions = [
      {:grant_publication, {:hold_before_effect, :before}},
      {:revoke_publication, {:hold_after_effect, :after}}
    ]

    {:ok, controller} = ScriptedMediaPlane.start_controller(actions)
    adapter = ScriptedMediaPlane.adapter(controller)

    grant =
      Task.async(fn ->
        ScriptedMediaPlane.grant_publication(adapter, "grant-1", @session, "person", :screen)
      end)

    assert_receive {:scripted_media_barrier, :before, :before_effect}
    assert ScriptedMediaPlane.effects(controller) == []
    assert :ok = ScriptedMediaPlane.release(controller, :before)
    assert Task.await(grant) == :confirmed
    version = ScriptedMediaPlane.projection(controller)["observation_version"]

    revoke =
      Task.async(fn ->
        ScriptedMediaPlane.revoke_publication(adapter, "revoke-1", @session, "person", :screen)
      end)

    assert_receive {:scripted_media_barrier, :after, :after_effect}
    assert ScriptedMediaPlane.projection(controller)["publications"] == []
    assert :ok = ScriptedMediaPlane.release(controller, :after)
    assert Task.await(revoke) == :confirmed

    newest = ScriptedMediaPlane.projection(controller)["observation_version"]
    assert {:published, []} = ScriptedMediaPlane.publish_observation(controller, newest)
    assert :stale = ScriptedMediaPlane.publish_observation(controller, version)
  end

  test "bounds scripts before starting the controller" do
    actions = List.duplicate({:grant_publication, :confirmed}, 129)
    assert {:error, :action_limit} = ScriptedMediaPlane.start_controller(actions)
  end
end
