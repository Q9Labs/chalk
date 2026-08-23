defmodule ChalkSync.Stateholder.PostgresRoleTransitionTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  @role_capabilities %{
    "owner" => [
      "publishAudio",
      "publishVideo",
      "publishScreen",
      "subscribe",
      "assignRoles",
      "manageAdmission",
      "removeParticipant",
      "endEpisode"
    ],
    "collaborator" => ["publishAudio", "publishVideo", "subscribe"],
    "observer" => ["subscribe"]
  }

  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  setup_all do
    if @database_url do
      previous_connections = Application.get_env(:chalk_sync, :database_connections)
      connections = SyncPostgres.start_connections(@database_url, 6)
      Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

      on_exit(fn ->
        if previous_connections,
          do: Application.put_env(:chalk_sync, :database_connections, previous_connections),
          else: Application.delete_env(:chalk_sync, :database_connections)

        Enum.each(connections, &stop_connection/1)
      end)

      {:ok, connections: connections}
    else
      :ok
    end
  end

  setup %{connections: connections} do
    fixture =
      SyncPostgres.seed_episode(hd(connections), 2, %{role_capabilities: @role_capabilities})

    on_exit(fn -> SyncPostgres.cleanup(hd(connections), fixture.episode) end)
    {:ok, fixture: fixture, connection: hd(connections)}
  end

  test "terminal cleanup failure preserves reduced authority, event linkage, and fences", %{
    fixture: fixture,
    connection: connection
  } do
    [host, guest] = promote_guest(fixture)
    command = role_command("role_cleanup_fail1", guest.participant_id, "observer")

    assert {:ok, %{result: :pending} = parent} =
             Postgres.begin_role_transition(host, command, [publication(guest, :camera)])

    assert {:ok, claimed} = Postgres.claim_operations(64)
    camera = child!(claimed, parent.external_operation_id, :camera)

    assert {:ok, %{result: :failed}} =
             Postgres.finalize_operation(
               fixture.episode,
               camera.external_operation_id,
               {:failed, :provider_denied}
             )

    assert [["observer"]] =
             query(connection, "select role from participants where id = $1", [
               UUID.dump!(guest.participant_id)
             ])

    assert [["rejected", "external_operation_failed", event_id, 4]] =
             query(
               connection,
               "select outcome, rejection_reason, event_id, resulting_revision from sync_command_receipts where external_operation_id = $1",
               [UUID.dump!(parent.external_operation_id)]
             )

    assert is_binary(event_id)
    assert [[1]] = fence_count(connection, parent.external_operation_id)

    assert [["failed", true]] =
             query(
               connection,
               "select status, fence_active from sync_external_operations where external_operation_id = $1",
               [UUID.dump!(parent.external_operation_id)]
             )
  end

  defp promote_guest(fixture) do
    [host, guest] = fixture.identities
    command = role_command("promote_for_cleanup", guest.participant_id, "collaborator")
    assert {:ok, %{result: :committed}} = Postgres.begin_role_transition(host, command, [])
    [host, guest]
  end

  defp role_command(id, participant_id, role) do
    {:ok, command} =
      Command.new(id, :assign_roles, %{
        "participantId" => participant_id,
        "role" => role
      })

    command
  end

  defp publication(identity, source) do
    %{
      participant_id: identity.participant_id,
      source: source,
      enabled: true,
      publication_id: nil
    }
  end

  defp fence_count(connection, parent_id) do
    query(
      connection,
      "select count(*) from sync_publication_fences where external_operation_id = $1",
      [UUID.dump!(parent_id)]
    )
  end

  defp query(connection, sql, params), do: Postgrex.query!(connection, sql, params).rows

  defp stop_connection(connection) do
    if Process.alive?(connection), do: GenServer.stop(connection)
  catch
    :exit, _reason -> :ok
  end

  defp child!(claimed, parent_id, source) do
    {_episode, child} =
      Enum.find(claimed, fn {_episode, operation} ->
        operation.parent_external_operation_id == parent_id and operation.source == source
      end)

    child
  end
end
