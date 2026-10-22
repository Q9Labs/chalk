defmodule ChalkSync.WhiteboardV1.DrawPolicyTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.Transport.SocketWhiteboardV1
  alias ChalkSync.UUID
  alias ChalkSync.WhiteboardV1.Fanout
  alias ChalkSync.WhiteboardV1.PostgresRepository

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  setup_all do
    if @database_url do
      previous_connections = Application.get_env(:chalk_sync, :database_connections)
      previous_repository = Application.get_env(:chalk_sync, :whiteboard_v1_repository)
      connections = SyncPostgres.start_connections(@database_url)
      Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))
      Application.delete_env(:chalk_sync, :whiteboard_v1_repository)

      on_exit(fn ->
        restore_env(:database_connections, previous_connections)
        restore_env(:whiteboard_v1_repository, previous_repository)
        Enum.each(connections, &TestProcess.stop/1)
      end)

      {:ok, connections: connections}
    else
      :ok
    end
  end

  setup %{connections: connections} do
    connection = hd(connections)

    fixture =
      SyncPostgres.seed_episode(connection, 3, %{}, %{
        participants: [%{role: "owner"}, %{role: "collaborator"}, %{role: "observer"}]
      })

    on_exit(fn ->
      cleanup_whiteboard(connection, fixture.episode)
      SyncPostgres.cleanup(connection, fixture.episode)
    end)

    [host, collaborator, observer] = fixture.identities

    {:ok,
     episode: fixture.episode, host: host, collaborator: collaborator, observer: observer}
  end

  test "an existing call without a policy keeps the role default and per-person choices", %{
    host: host,
    collaborator: collaborator,
    observer: observer
  } do
    assert drawers(host, collaborator, observer) == %{host: true, collaborator: true, observer: false}

    set_permission(host, collaborator, false, "permission-revoke-0001")
    assert {:error, :permission_denied} = draw(collaborator, "update-revoked-00001")
    assert drawers(host, collaborator, observer) == %{host: true, collaborator: false, observer: false}
  end

  test "one rule combines the policy, the role and the per-person choice", %{
    host: host,
    collaborator: collaborator,
    observer: observer
  } do
    set_policy(host, "hosts", "policy-hosts-000001")
    assert drawers(host, collaborator, observer) == %{host: true, collaborator: false, observer: false}
    assert {:error, :permission_denied} = draw(collaborator, "update-hosts-000001")
    assert {:ok, %{outcome: :committed}} = draw(host, "update-hosts-000002")

    # Under hosts only, a host's earlier choice for a person is kept but ignored.
    set_permission(host, observer, true, "permission-grant-0001")
    assert drawers(host, collaborator, observer) == %{host: true, collaborator: false, observer: false}

    # Picked people draw only when picked, whatever their role.
    set_policy(host, "picked", "policy-picked-00001")
    assert drawers(host, collaborator, observer) == %{host: true, collaborator: false, observer: true}
    assert {:ok, %{outcome: :committed}} = draw(observer, "update-picked-00001")
    assert {:error, :permission_denied} = draw(collaborator, "update-picked-00002")

    set_permission(host, collaborator, true, "permission-grant-0002")
    set_permission(host, observer, false, "permission-revoke-0002")
    assert drawers(host, collaborator, observer) == %{host: true, collaborator: true, observer: false}

    # Everyone goes back to the role default, with the same per-person choices on top.
    set_policy(host, "everyone", "policy-everyone-0001")
    assert drawers(host, collaborator, observer) == %{host: true, collaborator: true, observer: false}
  end

  test "only hosts change the policy and a retried change is a duplicate", %{
    host: host,
    collaborator: collaborator
  } do
    operation = %{operation_id: "policy-retry-000001", policy: "hosts"}

    assert {:error, :permission_denied} =
             PostgresRepository.set_draw_policy(collaborator, operation)

    assert {:ok, %{outcome: :committed}} = PostgresRepository.set_draw_policy(host, operation)
    assert {:ok, %{outcome: :duplicate}} = PostgresRepository.set_draw_policy(host, operation)
    assert {:ok, %{draw_policy: "hosts"}} = PostgresRepository.draw_access(collaborator)
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

  test "a host change reaches the whiteboard on every node", %{
    episode: episode,
    host: host,
    collaborator: collaborator
  } do
    start_fanout(episode)
    set_policy(host, "hosts", "policy-hosts-000002")
    assert_receive :whiteboard_v1_access_changed, 5_000
    assert {:ok, %{can_draw: false}} = PostgresRepository.draw_access(collaborator)

    {:ok, promote} =
      Command.new("draw-policy-promote1", :assign_roles, %{
        "participantId" => collaborator.participant_id,
        "role" => "owner"
      })

    flush_access()
    assert {:ok, %{result: :committed}} = Postgres.begin_role_transition(host, promote, [])
    assert_receive :whiteboard_v1_access_changed, 5_000
    assert {:ok, %{can_draw: true}} = PostgresRepository.draw_access(collaborator)
    assert {:ok, %{outcome: :committed}} = draw(collaborator, "update-promoted-0001")

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

  defp drawers(host, collaborator, observer) do
    %{
      host: can_draw?(host),
      collaborator: can_draw?(collaborator),
      observer: can_draw?(observer)
    }
  end

  defp can_draw?(identity) do
    {:ok, %{can_draw: can_draw}} = PostgresRepository.connect(identity)
    {:ok, %{can_draw: ^can_draw}} = PostgresRepository.draw_access(identity)
    can_draw
  end

  defp set_policy(host, policy, operation_id) do
    assert {:ok, %{outcome: :committed}} =
             PostgresRepository.set_draw_policy(host, %{
               operation_id: operation_id,
               policy: policy
             })
  end

  defp set_permission(host, target, can_draw, operation_id) do
    assert {:ok, %{outcome: :committed}} =
             PostgresRepository.set_draw_permission(host, %{
               operation_id: operation_id,
               participant_id: target.participant_id,
               can_draw: can_draw
             })
  end

  defp draw(identity, operation_id) do
    {:ok, %{scene_id: scene_id}} = PostgresRepository.connect(identity)

    PostgresRepository.commit_update(identity, %{
      operation_id: operation_id,
      scene_id: scene_id,
      elements: [element(operation_id)]
    })
  end

  defp live_socket(identity, draw_policy_negotiated, can_draw) do
    {:ok, initial} = SocketWhiteboardV1.init(%{})
    Process.cancel_timer(initial.hello_timer)
    {:ok, %{scene_id: scene_id, revision: revision}} = PostgresRepository.connect(identity)

    %{
      initial
      | phase: :live,
        identity: identity,
        draw_policy_negotiated: draw_policy_negotiated,
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

  defp element(id) do
    %{
      "id" => id,
      "type" => "rectangle",
      "version" => 1,
      "version_nonce" => 1,
      "index" => "a0",
      "is_deleted" => false,
      "payload" => %{"x" => 10, "y" => 20, "width" => 100, "height" => 60}
    }
  end

  defp cleanup_whiteboard(connection, episode) do
    params = [UUID.dump!(episode.tenant_id), UUID.dump!(episode.space_id)]

    Enum.each(
      [
        "sync_whiteboard_operation_receipts",
        "sync_whiteboard_permissions",
        "sync_whiteboard_draw_policies",
        "sync_whiteboard_elements",
        "sync_whiteboard_scenes"
      ],
      fn table ->
        Postgrex.query!(
          connection,
          "delete from #{table} where tenant_id = $1 and space_id = $2",
          params
        )
      end
    )
  end

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)
end
