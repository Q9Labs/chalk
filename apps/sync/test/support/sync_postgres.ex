defmodule ChalkSync.SyncPostgres do
  @moduledoc false

  alias ChalkSync.Database
  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.SyncPostgres.EpisodeRows
  alias ChalkSync.SyncPostgres.PendingJoin
  alias ChalkSync.SyncPostgres.Rows
  alias ChalkSync.UUID

  def database_url! do
    System.get_env("CHALK_SYNC_TEST_DATABASE_URL") || System.fetch_env!("CHALK_DATABASE_URL")
  end

  def start_connections(url, count \\ 4) do
    {:ok, options} = Database.connection_options(url)

    Enum.map(1..count, fn _index ->
      {:ok, connection} = Postgrex.start_link(options)
      # Fixture writes use the new writer protocol. The archived production
      # helper remains untouched and has no such setting.
      Postgrex.query!(connection, "select set_config('chalk.entry_writer','1',false)", [])

      Postgrex.query!(
        connection,
        "update sync_entry_rollout set enforced=true,enforced_at=now(),release_id='test' where singleton",
        []
      )

      connection
    end)
  end

  defdelegate seed_pending_join(connection), to: PendingJoin
  defdelegate seed_pending_join(connection, policy), to: PendingJoin

  def restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  def restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)

  def selector(connections) do
    {first, second} = Enum.split(connections, div(length(connections), 2))

    fn _episode, offset ->
      node_connections =
        if Process.get(:sync_test_node, :first) == :second, do: second, else: first

      Process.get(:sync_test_transaction) ||
        Enum.at(node_connections, rem(offset, length(node_connections)))
    end
  end

  def seed_episode(connection, participant_count \\ 1, policy \\ %{}) do
    seed_episode(connection, participant_count, policy, %{})
  end

  def seed_episode(connection, participant_count, policy, identifiers)
      when is_integer(participant_count) and participant_count > 0 and is_map(policy) and
             is_map(identifiers) do
    tenant_id = Map.get_lazy(identifiers, :tenant_id, &UUID.generate/0)
    space_id = Map.get_lazy(identifiers, :space_id, &UUID.generate/0)
    episode_id = Map.get_lazy(identifiers, :episode_id, &UUID.generate/0)
    episode = %EpisodeKey{tenant_id: tenant_id, space_id: space_id, episode_id: episode_id}
    participant_identifiers = Map.get(identifiers, :participants, [])

    participants =
      Enum.map(1..participant_count, fn index ->
        participant = Enum.at(participant_identifiers, index - 1, %{})
        role = Map.get(participant, :role, if(index == 1, do: "owner", else: "observer"))

        capabilities =
          Map.get(
            participant,
            :capabilities,
            Map.get(Reducer.new(episode_id).role_capabilities, role, [])
          )

        %{
          id: Map.get_lazy(participant, :id, &UUID.generate/0),
          generation: 1,
          display_name: "Participant #{index}",
          capabilities: capabilities,
          role: role,
          admission_lifecycle_intent_id:
            Map.get_lazy(participant, :admission_lifecycle_intent_id, &UUID.generate/0)
        }
      end)

    {:ok, _result} =
      Postgrex.transaction(connection, fn transaction ->
        Postgrex.query!(transaction, "select set_config('chalk.entry_writer','1',true)", [])
        Rows.insert_product_rows(transaction, episode, participants, policy)
        Rows.insert_control(transaction, episode, policy)
        state = EpisodeRows.insert_join_history(transaction, episode, participants, policy)
        EpisodeRows.update_control(transaction, episode, state, length(participants))
      end)

    identities =
      Enum.map(participants, fn participant ->
        %Identity{
          episode: episode,
          participant_id: participant.id,
          participant_generation: participant.generation,
          admission_lifecycle_intent_id: participant.admission_lifecycle_intent_id,
          role: participant.role,
          capabilities: participant.capabilities
        }
      end)

    %{
      episode: episode,
      identities: identities,
      state: EpisodeRows.state_for(episode, participants, policy)
    }
  end

  def cleanup(connection, %EpisodeKey{} = episode) do
    tenant_id = Rows.uuid(episode.tenant_id)

    Postgrex.transaction(connection, fn transaction ->
      Postgrex.query!(transaction, "select set_config('chalk.entry_writer','1',true)", [])

      Postgrex.query!(
        transaction,
        """
        update sync_lifecycle_intents
        set status = 'pending', terminal_reason = null, applied_event_id = null,
            applied_revision = null, completed_at = null
        where tenant_id = $1 and status = 'applied'
        """,
        [tenant_id]
      )

      delete(transaction, "sync_command_receipts", tenant_id)

      Postgrex.query!(
        transaction,
        """
        update sync_external_operations
        set status = 'pending', fence_active = false, last_error_code = null,
            applied_event_id = null, applied_revision = null, completed_at = null
        where tenant_id = $1
        """,
        [tenant_id]
      )

      delete(transaction, "sync_publication_fences", tenant_id)
      delete(transaction, "sync_publication_grant_reservations", tenant_id)
      delete(transaction, "sync_media_stops", tenant_id)
      delete(transaction, "sync_media_pauses", tenant_id)
      delete(transaction, "sync_screen_share_leases", tenant_id)
      delete(transaction, "sync_recordings", tenant_id)
      delete(transaction, "sync_admission_requests", tenant_id)
      delete(transaction, "sync_control_events", tenant_id)
      delete(transaction, "sync_lifecycle_intents", tenant_id)
      delete(transaction, "sync_external_operations", tenant_id)
      delete(transaction, "sync_episode_control", tenant_id)
      delete(transaction, "sync_whiteboard_files", tenant_id)
      delete(transaction, "sync_whiteboard_operation_receipts", tenant_id)
      delete(transaction, "sync_whiteboard_permissions", tenant_id)
      delete(transaction, "sync_whiteboard_draw_policies", tenant_id)
      delete(transaction, "sync_whiteboard_draw_policy_receipts", tenant_id)
      delete(transaction, "sync_whiteboard_elements", tenant_id)
      delete(transaction, "sync_whiteboard_scenes", tenant_id)
      delete(transaction, "sync_chat_read_receipts", tenant_id)
      delete(transaction, "sync_chat_attachments", tenant_id)
      delete(transaction, "sync_chat_messages", tenant_id)
      delete(transaction, "sync_chat_streams", tenant_id)
      delete(transaction, "participants", tenant_id)
      delete(transaction, "episodes", tenant_id)
      delete(transaction, "spaces", tenant_id)

      Postgrex.query!(
        transaction,
        """
        delete from observability_journey_events
        where journey_id in (
          select journey_id from webhook_events where tenant_id = $1
        )
        """,
        [tenant_id]
      )

      Postgrex.query!(transaction, "delete from tenants where id = $1", [tenant_id])
    end)
  end

  defp delete(connection, table, tenant_id) do
    Postgrex.query!(connection, "delete from #{table} where tenant_id = $1", [tenant_id])
  end
end
