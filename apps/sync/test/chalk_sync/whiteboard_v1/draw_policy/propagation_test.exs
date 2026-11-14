defmodule ChalkSync.WhiteboardV1.DrawPolicyPropagationTest do
  use ChalkSync.WhiteboardV1.DrawPolicyCase, async: false

  alias ChalkSync.Database
  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.Transport.SocketWhiteboardV1
  alias ChalkSync.Transport.SocketWhiteboardV1.Extensions
  alias ChalkSync.UUID
  alias ChalkSync.WhiteboardV1.Fanout
  alias ChalkSync.WhiteboardV1.PostgresRepository

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  test "a host's choice that waits behind a policy change is stored for the new policy", %{
    episode: episode,
    host: host,
    collaborator: collaborator
  } do
    set_policy(host, "picked", "policy-picked-00005")
    set_permission(host, collaborator, true, "permission-pick-00002")

    # The unpick read picked, so on its own it would delete the choice. It
    # lands after everyone, where it must be kept as a block.
    assert {:ok, %{outcome: :committed}} =
             while_policy_changes(episode, host, "everyone", fn ->
               PostgresRepository.set_draw_permission(host, %{
                 operation_id: "permission-unpick-0002",
                 participant_id: collaborator.participant_id,
                 can_draw: false
               })
             end)

    refute can_draw?(collaborator)
  end

  test "a drawing that waits behind a policy change is checked against the new policy", %{
    episode: episode,
    host: host,
    collaborator: collaborator
  } do
    {:ok, %{scene_id: scene_id}} = PostgresRepository.connect(collaborator)

    drawing =
      while_policy_changes(episode, host, "hosts", fn ->
        PostgresRepository.commit_update(collaborator, %{
          operation_id: "update-waiting-00001",
          scene_id: scene_id,
          elements: [element("update-waiting-00001")]
        })
      end)

    assert {:error, :permission_denied} = drawing
  end

  test "only hosts see the per-person choices", %{
    host: host,
    collaborator: collaborator,
    observer: observer
  } do
    set_policy(host, "picked", "policy-picked-00002")
    set_permission(host, observer, true, "permission-grant-0003")

    assert {:ok, %{draw_policy: "picked", grants: [{observer_id, true}]}} =
             PostgresRepository.draw_access(host)

    assert observer_id == observer.participant_id
    assert {:ok, %{grants: []}} = PostgresRepository.draw_access(collaborator)
  end

  test "a role change reaches the whiteboard on every node", %{
    episode: episode,
    host: host,
    collaborator: collaborator,
    observer: observer
  } do
    start_fanout(episode)
    assign_role(host, collaborator, "observer", "draw-policy-demote01")
    assert_receive :whiteboard_v1_access_changed, 5_000
    assert {:ok, %{can_draw: false}} = PostgresRepository.connect(collaborator)

    # Under hosts only, making someone a host lets them draw.
    set_policy(host, "hosts", "policy-hosts-000002")
    flush_access()
    assign_role(host, observer, "owner", "draw-policy-promote1")
    assert_receive :whiteboard_v1_access_changed, 5_000
    assert {:ok, %{can_draw: true}} = PostgresRepository.draw_access(observer)
    assert {:ok, %{outcome: :committed}} = draw(observer, "update-promoted-0001")

    Fanout.unsubscribe(episode)
  end

  test "a per-person change reaches the whiteboard on every node", %{
    episode: episode,
    host: host,
    collaborator: collaborator
  } do
    start_fanout(episode)
    set_permission(host, collaborator, false, "permission-revoke-0003")
    assert_receive :whiteboard_v1_access_changed, 5_000
    Fanout.unsubscribe(episode)
  end

  test "a socket relays only its own permission, in the form its client negotiated", %{
    host: host,
    collaborator: collaborator,
    observer: observer
  } do
    legacy = live_socket(collaborator, false, true)
    set_policy(host, "hosts", "policy-hosts-000003")

    assert {:push, {:text, frame}, legacy} =
             SocketWhiteboardV1.handle_info(:whiteboard_v1_access_changed, legacy)

    collaborator_id = collaborator.participant_id

    assert %{
             "type" => "permission_updated",
             "participant_id" => ^collaborator_id,
             "can_draw" => false
           } = JSON.decode!(frame)

    assert {:ok, _unchanged} =
             SocketWhiteboardV1.handle_info(:whiteboard_v1_access_changed, legacy)

    set_policy(host, "picked", "policy-picked-00003")
    set_permission(host, observer, true, "permission-grant-0004")
    negotiated = live_socket(host, true, true)

    assert {:push, {:text, frame}, _state} =
             SocketWhiteboardV1.handle_info(:whiteboard_v1_access_changed, negotiated)

    observer_id = observer.participant_id

    assert %{
             "type" => "draw_access",
             "policy" => "picked",
             "can_draw" => true,
             "capabilities" => ["drawWhiteboard", "manageWhiteboard"],
             "grants" => [%{"participant_id" => ^observer_id, "can_draw" => true}]
           } = JSON.decode!(frame)
  end

  # Runs the change while another transaction holds the scene lock and sets
  # the policy, so the change has read the old policy and must wait for the new.
  defp while_policy_changes(episode, host, policy, change) do
    {:ok, options} = Database.connection_options(@database_url)
    {:ok, blocker} = Postgrex.start_link(options)
    parent = self()

    holder =
      Task.async(fn ->
        Postgrex.transaction(blocker, fn transaction ->
          hold_scene_and_set_policy(transaction, episode, host, policy)
          send(parent, :scene_locked)

          receive do
            :commit -> :ok
          end
        end)
      end)

    assert_receive :scene_locked, 5_000
    waiting = Task.async(change)
    Process.sleep(200)
    send(holder.pid, :commit)
    assert {:ok, :ok} = Task.await(holder)
    result = Task.await(waiting)
    GenServer.stop(blocker)
    result
  end

  defp hold_scene_and_set_policy(transaction, episode, host, policy) do
    params = [
      UUID.dump!(episode.tenant_id),
      UUID.dump!(episode.space_id),
      UUID.dump!(episode.episode_id)
    ]

    Postgrex.query!(
      transaction,
      "select 1 from sync_whiteboard_scenes where tenant_id = $1 and space_id = $2 and episode_id = $3 and is_current for update",
      params
    )

    Postgrex.query!(
      transaction,
      "insert into sync_whiteboard_draw_policies (tenant_id, space_id, episode_id, policy, updated_by_participant_id) values ($1, $2, $3, $4, $5) on conflict (tenant_id, space_id, episode_id) do update set policy = excluded.policy",
      params ++ [policy, UUID.dump!(host.participant_id)]
    )
  end

  defp assign_role(host, target, role, command_id) do
    {:ok, command} =
      Command.new(command_id, :assign_roles, %{
        "participantId" => target.participant_id,
        "role" => role
      })

    assert {:ok, %{result: :committed}} = Postgres.begin_role_transition(host, command, [])
  end

  defp live_socket(identity, draw_policy?, can_draw) do
    {:ok, initial} = SocketWhiteboardV1.init(%{})
    Process.cancel_timer(initial.hello_timer)
    {:ok, %{scene_id: scene_id, revision: revision}} = PostgresRepository.connect(identity)

    %{
      initial
      | phase: :live,
        connected_at: System.monotonic_time(:millisecond),
        identity: identity,
        extensions: %{Extensions.none() | draw_policy: draw_policy?},
        can_draw: can_draw,
        scene_id: scene_id,
        revision: revision
    }
  end

  # LISTEN is registered before init returns, so every later notify reaches the subscriber.
  defp start_fanout(episode) do
    start_supervised!(
      {Fanout, name: :draw_policy_test_fanout, source_id: "draw-policy-test", url: @database_url}
    )

    Fanout.subscribe(episode)
  end

  defp flush_access do
    receive do
      :whiteboard_v1_access_changed -> flush_access()
    after
      0 -> :ok
    end
  end
end
