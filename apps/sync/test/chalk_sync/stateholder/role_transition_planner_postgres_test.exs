defmodule ChalkSync.Stateholder.RoleTransitionPlannerPostgresTest do
  use ExUnit.Case, async: false

  alias ChalkSync.ExternalOperationConsumer
  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  # A listener must never receive audio the authority would refuse. A source lease at the node
  # is that authority, and a microphone muted in place still holds its lease, so a demotion
  # must revoke it exactly as it revokes a source that is on.
  setup_all do
    if @database_url do
      previous_connections = Application.get_env(:chalk_sync, :database_connections)
      connections = SyncPostgres.start_connections(@database_url)
      Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

      on_exit(fn ->
        if previous_connections,
          do: Application.put_env(:chalk_sync, :database_connections, previous_connections),
          else: Application.delete_env(:chalk_sync, :database_connections)

        Enum.each(connections, &TestProcess.stop/1)
      end)

      {:ok, connection: hd(connections)}
    else
      :ok
    end
  end

  setup %{connection: connection} do
    fixture =
      SyncPostgres.seed_episode(connection, 2, %{}, %{
        participants: [%{role: "owner"}, %{role: "collaborator"}]
      })

    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

    [host, target] = fixture.identities
    {:ok, episode: fixture.episode, host: host, target: target}
  end

  test "demoting a participant whose microphone is muted in place stops and fences it and revokes its lease",
       %{connection: connection, episode: episode, host: host, target: target} do
    publications = [
      publication(target, :microphone, false, "held-microphone"),
      publication(target, :camera, true, "live-camera")
    ]

    assert {:ok, %{result: :pending, external_operation_id: parent_id}} =
             demote(host, target, "demote-muted-source-01", publications)

    assert stop_sources(connection, episode, parent_id) == ["camera", "microphone"]
    assert fenced_sources(connection, episode, target) == ["camera", "microphone"]

    {:ok, adapter} = MediaPlaneTestAdapter.start_link()
    stop = claim_stop(connection, episode, parent_id, "microphone")

    assert :confirmed =
             ExternalOperationConsumer.execute_operation(
               episode,
               stop,
               {MediaPlaneTestAdapter, adapter},
               nil,
               &Postgres.finalize_operation/3
             )

    participant_id = target.participant_id

    assert [{:revoke_publication, _, [^episode, ^participant_id, :microphone]}] =
             MediaPlaneTestAdapter.calls(adapter)
  end

  # A registry entry from an older connection or generation is disabled with its id kept, the
  # same shape as a muted one, and Sync cannot tell them apart. The node records a revoke for a
  # source that has no track, so the stop finishes and the role change still completes.
  test "demoting a participant whose registry holds only a retired entry finishes through a stop that finds no track",
       %{connection: connection, episode: episode, host: host, target: target} do
    publications = [publication(target, :microphone, false, "retired-older-connection")]

    assert {:ok, %{result: :pending, external_operation_id: parent_id}} =
             demote(host, target, "demote-retired-source-01", publications)

    assert stop_sources(connection, episode, parent_id) == ["microphone"]
    assert fenced_sources(connection, episode, target) == ["microphone"]

    {:ok, adapter} = MediaPlaneTestAdapter.start_link()
    stop = claim_stop(connection, episode, parent_id, "microphone")

    assert :confirmed =
             ExternalOperationConsumer.execute_operation(
               episode,
               stop,
               {MediaPlaneTestAdapter, adapter},
               nil,
               &Postgres.finalize_operation/3
             )

    assert parent_status(connection, episode, parent_id) == "applied"
    assert fenced_sources(connection, episode, target) == []
  end

  test "a closed publication has no track or lease, so demoting its participant commits at once",
       %{host: host, target: target} do
    publications = [publication(target, :microphone, false, nil)]

    assert {:ok, %{result: :committed}} =
             demote(host, target, "demote-closed-source-01", publications)
  end

  test "demoting a participant with nothing registered commits at once", %{
    host: host,
    target: target
  } do
    assert {:ok, %{result: :committed}} = demote(host, target, "demote-nothing-open-01", [])
  end

  defp publication(identity, source, enabled, publication_id) do
    %{
      participant_id: identity.participant_id,
      source: source,
      enabled: enabled,
      publication_id: publication_id
    }
  end

  defp demote(host, target, command_id, publications) do
    {:ok, command} =
      Command.new(command_id, :assign_roles, %{
        "participantId" => target.participant_id,
        "role" => "observer"
      })

    Postgres.begin_role_transition(host, command, publications)
  end

  defp stop_sources(connection, episode, parent_id) do
    Postgrex.query!(
      connection,
      """
      select source from sync_external_operations
      where tenant_id = $1 and space_id = $2 and episode_id = $3
        and parent_external_operation_id = $4 and operation_name = 'role_transition_source_stop'
      order by source
      """,
      Scope.episode(episode) ++ [Scope.uuid(parent_id)]
    ).rows
    |> List.flatten()
  end

  defp fenced_sources(connection, episode, target) do
    Postgrex.query!(
      connection,
      """
      select source from sync_publication_fences
      where tenant_id = $1 and space_id = $2 and episode_id = $3 and participant_id = $4
      order by source
      """,
      Scope.episode(episode) ++ [Scope.uuid(target.participant_id)]
    ).rows
    |> List.flatten()
  end

  defp parent_status(connection, episode, parent_id) do
    [[status]] =
      Postgrex.query!(
        connection,
        """
        select status from sync_external_operations
        where tenant_id = $1 and space_id = $2 and episode_id = $3 and external_operation_id = $4
        """,
        Scope.episode(episode) ++ [Scope.uuid(parent_id)]
      ).rows

    status
  end

  defp claim_stop(connection, episode, parent_id, source) do
    [[child_id]] =
      Postgrex.query!(
        connection,
        """
        select external_operation_id from sync_external_operations
        where tenant_id = $1 and space_id = $2 and episode_id = $3
          and parent_external_operation_id = $4 and source = $5
        """,
        Scope.episode(episode) ++ [Scope.uuid(parent_id), source]
      ).rows

    child_id = UUID.load!(child_id)
    {:ok, operations} = Postgres.claim_operations(64)

    {_, claimed} =
      Enum.find(operations, fn {_, operation} -> operation.external_operation_id == child_id end)

    claimed
  end
end
