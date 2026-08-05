defmodule ChalkSync.SyncPostgres do
  @moduledoc false

  alias ChalkSync.Database
  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.UUID

  def start_connections(url, count \\ 4) do
    {:ok, options} = Database.connection_options(url)

    Enum.map(1..count, fn _index ->
      {:ok, connection} = Postgrex.start_link(options)
      connection
    end)
  end

  def selector(connections) do
    {first, second} = Enum.split(connections, div(length(connections), 2))

    fn _episode, offset ->
      node_connections =
        if Process.get(:sync_test_node, :first) == :second, do: second, else: first

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
        role = if index == 1, do: "owner", else: "observer"
        participant = Enum.at(participant_identifiers, index - 1, %{})

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
        insert_product_rows(transaction, episode, participants, policy)
        insert_control(transaction, episode, policy)
        state = insert_join_history(transaction, episode, participants, policy)
        update_control(transaction, episode, state, length(participants))
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
      state: state_for(episode, participants, policy)
    }
  end

  def seed_pending_join(connection) do
    tenant_id = UUID.generate()
    space_id = UUID.generate()
    episode_id = UUID.generate()
    participant_id = UUID.generate()
    intent_id = UUID.generate()
    journey_id = UUID.generate()
    parent_journey_event_id = UUID.generate()
    episode = %EpisodeKey{tenant_id: tenant_id, space_id: space_id, episode_id: episode_id}
    display_name = "Pending Participant"

    payload = %{
      "participant_id" => participant_id,
      "display_name" => display_name,
      "role" => "owner"
    }

    {:ok, _result} =
      Postgrex.transaction(connection, fn transaction ->
        insert_product_rows(transaction, episode, [], %{})
        insert_control(transaction, episode, %{})

        Postgrex.query!(
          transaction,
          """
          insert into participants (
            id, name, capabilities, tenant_id, space_id, episode_id, generation, status,
            role
          ) values ($1, $2, $3, $4, $5, $6, 1, 'joining', 'owner')
          """,
          [
            uuid(participant_id),
            display_name,
            Reducer.new(episode_id).role_capabilities["owner"],
            uuid(tenant_id),
            uuid(space_id),
            uuid(episode_id)
          ]
        )

        insert_pending_intent(
          transaction,
          episode,
          intent_id,
          "join_pending_request_0001",
          "participant_joined",
          {participant_id, 1},
          payload,
          {journey_id, parent_journey_event_id}
        )

        payload_bytes = payload |> JSON.encode!() |> byte_size()

        Postgrex.query!(
          transaction,
          """
          update sync_episode_control
          set snapshot_reserved_bytes = 2048,
              lifecycle_reserved_events = 3,
              lifecycle_reserved_bytes = 49152,
              lifecycle_intent_count = 1,
              lifecycle_intent_bytes = $4,
              lifecycle_reserved_intents = 2,
              lifecycle_reserved_intent_bytes = 32768
          where tenant_id = $1 and space_id = $2 and episode_id = $3
          """,
          [uuid(tenant_id), uuid(space_id), uuid(episode_id), payload_bytes]
        )
      end)

    identity = %Identity{
      episode: episode,
      participant_id: participant_id,
      participant_generation: 1,
      admission_lifecycle_intent_id: intent_id,
      role: "owner",
      capabilities: Reducer.new(episode_id).role_capabilities["owner"]
    }

    %{
      episode: episode,
      identity: identity,
      lifecycle_intent_id: intent_id,
      journey_id: journey_id,
      parent_journey_event_id: parent_journey_event_id
    }
  end

  def seed_admission_request(connection, %{episode: episode, state: state} = fixture, opts \\ []) do
    admission_request_id = UUID.generate()
    participant_id = UUID.generate()
    requested_intent_id = UUID.generate()
    join_intent_id = UUID.generate()
    display_name = "Waiting Participant"
    expires_at = Keyword.get(opts, :expires_at, DateTime.add(DateTime.utc_now(), 60, :second))

    admission_payload = %{
      "admission_request_id" => admission_request_id,
      "participant_id" => participant_id,
      "display_name" => display_name,
      "role" => "observer",
      "expires_at_ms" => DateTime.to_unix(expires_at, :millisecond)
    }

    join_payload = %{
      "participant_id" => participant_id,
      "display_name" => display_name,
      "role" => "observer"
    }

    observer_capabilities = Reducer.new(episode.episode_id).role_capabilities["observer"]
    requested_payload_bytes = admission_payload |> JSON.encode!() |> byte_size()
    join_payload_bytes = join_payload |> JSON.encode!() |> byte_size()

    {:ok, _result} =
      Postgrex.transaction(connection, fn transaction ->
        Postgrex.query!(
          transaction,
          """
          insert into participants (
            id, name, capabilities, tenant_id, space_id, episode_id, generation,
            status, role
          ) values ($1, $2, $3, $4, $5, $6, 1, 'joining', 'observer')
          """,
          [
            uuid(participant_id),
            display_name,
            observer_capabilities,
            uuid(episode.tenant_id),
            uuid(episode.space_id),
            uuid(episode.episode_id)
          ]
        )

        insert_pending_intent(
          transaction,
          episode,
          requested_intent_id,
          "admission_request_#{String.replace(admission_request_id, "-", "_")}",
          "admission_requested",
          {nil, nil},
          admission_payload,
          {UUID.generate(), UUID.generate()}
        )

        insert_pending_intent(
          transaction,
          episode,
          join_intent_id,
          "approved_join_#{String.replace(participant_id, "-", "_")}",
          "participant_joined",
          {participant_id, 1},
          join_payload,
          {UUID.generate(), UUID.generate()}
        )

        Postgrex.query!(
          transaction,
          """
          update sync_lifecycle_intents
          set next_attempt_at = 'infinity'::timestamptz
          where tenant_id = $1 and space_id = $2 and episode_id = $3
            and lifecycle_intent_id = $4
          """,
          episode_params(episode) ++ [uuid(join_intent_id)]
        )

        Postgrex.query!(
          transaction,
          """
          insert into sync_admission_requests (
            tenant_id, space_id, episode_id, admission_request_id, request_key,
            request_fingerprint, participant_id, display_name, role, expires_at
          ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'observer', $9)
          """,
          [
            uuid(episode.tenant_id),
            uuid(episode.space_id),
            uuid(episode.episode_id),
            uuid(admission_request_id),
            "waiting_request_#{String.replace(admission_request_id, "-", "_")}",
            :crypto.hash(:sha256, admission_request_id),
            uuid(participant_id),
            display_name,
            expires_at
          ]
        )

        Postgrex.query!(
          transaction,
          """
          update sync_episode_control
          set snapshot_reserved_bytes = snapshot_reserved_bytes + 2048,
              lifecycle_reserved_events = lifecycle_reserved_events + 3,
              lifecycle_reserved_bytes = lifecycle_reserved_bytes + 49152,
              lifecycle_intent_count = lifecycle_intent_count + 2,
              lifecycle_intent_bytes = lifecycle_intent_bytes + $4 + $5,
              lifecycle_reserved_intents = lifecycle_reserved_intents + 1,
              lifecycle_reserved_intent_bytes = lifecycle_reserved_intent_bytes + 16384
          where tenant_id = $1 and space_id = $2 and episode_id = $3
          """,
          episode_params(episode) ++ [requested_payload_bytes, join_payload_bytes]
        )
      end)

    fixture =
      fixture
      |> Map.put(:admission_request_id, admission_request_id)
      |> Map.put(:admission_participant_id, participant_id)
      |> Map.put(:admission_requested_intent_id, requested_intent_id)
      |> Map.put(:admission_join_intent_id, join_intent_id)
      |> Map.put(:admission_payload, admission_payload)

    if Keyword.get(opts, :request_status, :applied) == :applied do
      {:ok, %{result: :applied}} = Postgres.apply_lifecycle_intent(episode, requested_intent_id)

      {:ok, _event, next_state} =
        Reducer.apply_lifecycle(state, :admission_requested, admission_payload)

      Map.put(fixture, :state, next_state)
    else
      Map.put(fixture, :state, state)
    end
  end

  def request_pending_leave(connection, %{episode: episode, identity: identity} = fixture) do
    intent_id = UUID.generate()
    payload = %{"participant_id" => identity.participant_id}
    payload_bytes = payload |> JSON.encode!() |> byte_size()

    {:ok, _result} =
      Postgrex.transaction(connection, fn transaction ->
        Postgrex.query!(
          transaction,
          """
          update participants set status = 'leaving'
          where tenant_id = $1 and space_id = $2 and episode_id = $3 and id = $4
            and generation = 1 and status = 'active'
          """,
          episode_params(episode) ++ [uuid(identity.participant_id)]
        )

        Postgrex.query!(
          transaction,
          """
          update sync_episode_control
          set lifecycle_intent_count = lifecycle_intent_count + 1,
              lifecycle_intent_bytes = lifecycle_intent_bytes + $4,
              lifecycle_reserved_intents = lifecycle_reserved_intents - 1,
              lifecycle_reserved_intent_bytes = lifecycle_reserved_intent_bytes - 16384
          where tenant_id = $1 and space_id = $2 and episode_id = $3
          """,
          episode_params(episode) ++ [payload_bytes]
        )

        insert_pending_intent(
          transaction,
          episode,
          intent_id,
          "leave_pending_request_01",
          "participant_left",
          {identity.participant_id, 1},
          payload,
          {UUID.generate(), UUID.generate()}
        )
      end)

    Map.put(fixture, :leave_lifecycle_intent_id, intent_id)
  end

  def request_pending_end(connection, %{episode: episode} = fixture) do
    intent_id = UUID.generate()
    payload = %{}
    payload_bytes = payload |> JSON.encode!() |> byte_size()

    {:ok, _result} =
      Postgrex.transaction(connection, fn transaction ->
        Postgrex.query!(
          transaction,
          """
          update episodes set status = 'ending'
          where tenant_id = $1 and space_id = $2 and id = $3 and status = 'active'
          """,
          episode_params(episode)
        )

        Postgrex.query!(
          transaction,
          """
          update sync_episode_control
          set lifecycle_intent_count = lifecycle_intent_count + 1,
              lifecycle_intent_bytes = lifecycle_intent_bytes + $4,
              lifecycle_reserved_intents = lifecycle_reserved_intents - 1,
              lifecycle_reserved_intent_bytes = lifecycle_reserved_intent_bytes - 16384
          where tenant_id = $1 and space_id = $2 and episode_id = $3
          """,
          episode_params(episode) ++ [payload_bytes]
        )

        insert_pending_intent(
          transaction,
          episode,
          intent_id,
          "episode_end_request_001",
          "episode_ended",
          {nil, nil},
          payload,
          {UUID.generate(), UUID.generate()}
        )
      end)

    Map.put(fixture, :end_lifecycle_intent_id, intent_id)
  end

  def seed_webhook_endpoint(%{episode: episode} = fixture, connection, event_types) do
    {:ok, endpoint_id} =
      Postgrex.transaction(connection, fn transaction ->
        insert_webhook_endpoint(transaction, episode, event_types)
      end)

    Map.update(fixture, :webhook_endpoint_ids, [endpoint_id], &[endpoint_id | &1])
  end

  def insert_webhook_endpoint(connection, episode, event_types) do
    endpoint_id = UUID.generate()
    revision_id = UUID.generate()

    Postgrex.query!(
      connection,
      "insert into webhook_tenant_state (tenant_id) values ($1) on conflict do nothing",
      [uuid(episode.tenant_id)]
    )

    Postgrex.query!(
      connection,
      "select tenant_id from webhook_tenant_state where tenant_id = $1 for update",
      [uuid(episode.tenant_id)]
    )

    Postgrex.query!(
      connection,
      """
      insert into webhook_endpoints (
        id, tenant_id, name, enabled, revision, current_target_revision,
        current_secret_ciphertext
      ) values ($1, $2, $3, true, 17, 1, $4)
      """,
      [uuid(endpoint_id), uuid(episode.tenant_id), "Sync lifecycle receiver", <<1>>]
    )

    Postgrex.query!(
      connection,
      """
      insert into webhook_endpoint_revisions (
        id, tenant_id, endpoint_id, revision, url_ciphertext, url_redacted,
        api_version, event_types
      ) values ($1, $2, $3, 1, $4, 'https://example.com/chalk', 1, $5)
      """,
      [uuid(revision_id), uuid(episode.tenant_id), uuid(endpoint_id), <<1>>, event_types]
    )

    endpoint_id
  end

  def cleanup(connection, %EpisodeKey{} = episode) do
    tenant_id = uuid(episode.tenant_id)

    Postgrex.transaction(connection, fn transaction ->
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

  defp insert_product_rows(connection, episode, participants, policy) do
    config_snapshot = episode_config_snapshot(episode.episode_id, policy)

    Postgrex.query!(connection, "insert into tenants (id, name) values ($1, 'Sync Test')", [
      uuid(episode.tenant_id)
    ])

    Postgrex.query!(
      connection,
      """
      insert into spaces (id, name, tenant_id, slug, media_plane)
      values ($1, 'Sync Test Space', $2, $3, 'cf_rtk')
      """,
      [uuid(episode.space_id), uuid(episode.tenant_id), "sync-test-#{episode.space_id}"]
    )

    Postgrex.query!(
      connection,
      """
      insert into episodes (
        id, status, space_id, tenant_id, started_at, config_snapshot
      ) values ($1, 'active', $2, $3, now(), $4)
      """,
      [
        uuid(episode.episode_id),
        uuid(episode.space_id),
        uuid(episode.tenant_id),
        config_snapshot
      ]
    )

    Enum.each(participants, fn participant ->
      Postgrex.query!(
        connection,
        """
        insert into participants (
          id, name, capabilities, tenant_id, space_id, episode_id,
          generation, status, joined_at, role
        ) values ($1, $2, $3, $4, $5, $6, $7, 'active', now(), $8)
        """,
        [
          uuid(participant.id),
          participant.display_name,
          participant.capabilities,
          uuid(episode.tenant_id),
          uuid(episode.space_id),
          uuid(episode.episode_id),
          participant.generation,
          participant.role
        ]
      )
    end)
  end

  defp insert_pending_intent(
         connection,
         episode,
         intent_id,
         request_key,
         name,
         {participant_id, generation},
         payload,
         {journey_id, parent_journey_event_id}
       ) do
    Postgrex.query!(
      connection,
      """
      insert into sync_lifecycle_intents (
        tenant_id, space_id, episode_id, lifecycle_intent_id, request_key,
        request_fingerprint, intent_name, participant_id,
        participant_generation, payload, status, journey_id,
        parent_journey_event_id, producing_trace_id, producing_span_id
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $12,
        '11111111111111111111111111111111', '2222222222222222'
      )
      """,
      [
        uuid(episode.tenant_id),
        uuid(episode.space_id),
        uuid(episode.episode_id),
        uuid(intent_id),
        request_key,
        :crypto.hash(:sha256, JSON.encode!(payload)),
        name,
        nullable_uuid(participant_id),
        generation,
        payload,
        uuid(journey_id),
        uuid(parent_journey_event_id)
      ]
    )
  end

  defp insert_control(connection, episode, policy) do
    state = Reducer.new(episode.episode_id, policy)

    Postgrex.query!(
      connection,
      """
      insert into sync_episode_control (
        tenant_id, space_id, episode_id, folded_state, state_schema_version,
        state_digest, snapshot_bytes
      ) values ($1, $2, $3, $4, $5, $6, $7)
      """,
      [
        uuid(episode.tenant_id),
        uuid(episode.space_id),
        uuid(episode.episode_id),
        Reducer.snapshot(state),
        Reducer.state_schema_version(),
        Reducer.digest(state),
        Reducer.snapshot_bytes(state)
      ]
    )
  end

  defp insert_join_history(connection, episode, participants, policy) do
    Enum.reduce(participants, Reducer.new(episode.episode_id, policy), fn participant, state ->
      {:ok, event, next_state} =
        Reducer.apply_lifecycle(state, :participant_joined, %{
          "participant_id" => participant.id,
          "display_name" => participant.display_name,
          "role" => participant.role,
          "admission_revision" => state.revision + 1
        })

      insert_join_intent_and_event(connection, episode, participant, event, next_state)
      next_state
    end)
  end

  defp insert_join_intent_and_event(connection, episode, participant, event, state) do
    intent_id = participant.admission_lifecycle_intent_id
    event_id = UUID.generate()
    request_key = "join_request_#{String.replace(participant.id, "-", "_")}"

    payload = %{
      "participant_id" => participant.id,
      "display_name" => participant.display_name
    }

    Postgrex.query!(
      connection,
      """
      insert into sync_lifecycle_intents (
        tenant_id, space_id, episode_id, lifecycle_intent_id, request_key,
        request_fingerprint, intent_name, participant_id,
        participant_generation, payload, status
      ) values ($1, $2, $3, $4, $5, $6, 'participant_joined', $7, $8, $9, 'pending')
      """,
      [
        uuid(episode.tenant_id),
        uuid(episode.space_id),
        uuid(episode.episode_id),
        uuid(intent_id),
        request_key,
        :crypto.hash(:sha256, request_key),
        uuid(participant.id),
        participant.generation,
        payload
      ]
    )

    wire_event = %{
      event_id: event_id,
      base_revision: event.base_revision,
      revision: event.revision,
      name: event.name,
      payload: event.payload,
      lifecycle_intent_id: intent_id,
      command_id: nil,
      schema_version: Reducer.state_schema_version(),
      resulting_state_digest: Reducer.digest(state)
    }

    encoded_bytes =
      wire_event
      |> Map.update!(:resulting_state_digest, &Base.encode16(&1, case: :lower))
      |> JSON.encode!()
      |> byte_size()

    Postgrex.query!(
      connection,
      """
      insert into sync_control_events (
        tenant_id, space_id, episode_id, event_id, base_revision, revision,
        event_name, payload, lifecycle_intent_id, event_schema_version,
        resulting_state_digest, encoded_bytes
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      """,
      [
        uuid(episode.tenant_id),
        uuid(episode.space_id),
        uuid(episode.episode_id),
        uuid(event_id),
        event.base_revision,
        event.revision,
        event.name,
        event.payload,
        uuid(intent_id),
        Reducer.state_schema_version(),
        Reducer.digest(state),
        encoded_bytes
      ]
    )

    Postgrex.query!(
      connection,
      """
      update sync_lifecycle_intents
      set status = 'applied', applied_event_id = $2, applied_revision = $3,
          completed_at = now()
      where lifecycle_intent_id = $1
      """,
      [uuid(intent_id), uuid(event_id), event.revision]
    )
  end

  defp update_control(connection, episode, state, participant_count) do
    Postgrex.query!(
      connection,
      """
      update sync_episode_control
      set control_revision = $4,
          folded_state = $5,
          state_digest = $6,
          snapshot_bytes = $7,
          lifecycle_event_count = $8,
          lifecycle_event_bytes = $9,
          lifecycle_reserved_events = $10,
          lifecycle_reserved_bytes = $11,
          lifecycle_intent_count = $8,
          lifecycle_intent_bytes = $9,
          lifecycle_reserved_intents = $10,
          lifecycle_reserved_intent_bytes = $11
      where tenant_id = $1 and space_id = $2 and episode_id = $3
      """,
      [
        uuid(episode.tenant_id),
        uuid(episode.space_id),
        uuid(episode.episode_id),
        state.revision,
        Reducer.snapshot(state),
        Reducer.digest(state),
        Reducer.snapshot_bytes(state),
        participant_count,
        participant_count * 512,
        participant_count + 1,
        (participant_count + 1) * 16 * 1024
      ]
    )
  end

  defp state_for(episode, participants, policy) do
    Enum.reduce(participants, Reducer.new(episode.episode_id, policy), fn participant, state ->
      {:ok, _event, state} =
        Reducer.apply_lifecycle(state, :participant_joined, %{
          "participant_id" => participant.id,
          "display_name" => participant.display_name,
          "role" => participant.role,
          "admission_revision" => state.revision + 1
        })

      state
    end)
  end

  defp episode_config_snapshot(episode_id, policy) do
    defaults = Reducer.new(episode_id).role_capabilities
    roles = Map.get(policy, :role_capabilities, Map.get(policy, "role_capabilities", defaults))

    admission_policy =
      Map.get(policy, :admission_policy, Map.get(policy, "admission_policy", "open"))

    admission_mode =
      if is_map(admission_policy),
        do: Map.get(admission_policy, "mode", "open"),
        else: admission_policy

    %{
      "roles" => roles,
      "admission_policy" => %{"mode" => admission_mode},
      "default_episode_duration_seconds" =>
        Map.get(policy, :default_episode_duration_seconds, 86_400),
      "maximum_episode_duration_seconds" =>
        Map.get(policy, :maximum_episode_duration_seconds, 86_400)
    }
  end

  defp delete(connection, table, tenant_id) do
    Postgrex.query!(connection, "delete from #{table} where tenant_id = $1", [tenant_id])
  end

  defp episode_params(episode),
    do: [uuid(episode.tenant_id), uuid(episode.space_id), uuid(episode.episode_id)]

  defp uuid(value), do: UUID.dump!(value)
  defp nullable_uuid(nil), do: nil
  defp nullable_uuid(value), do: uuid(value)
end
