defmodule ChalkSync.SyncPostgres do
  @moduledoc false

  alias ChalkSync.Database
  alias ChalkSync.ProtocolV2
  alias ChalkSync.Sessions.Reducer
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.SessionKey
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

    fn _session, offset ->
      node_connections =
        if Process.get(:sync_test_node, :first) == :second, do: second, else: first

      Enum.at(node_connections, rem(offset, length(node_connections)))
    end
  end

  def seed_session(connection, participant_count \\ 1) do
    tenant_id = UUID.generate()
    room_id = UUID.generate()
    session_id = UUID.generate()
    session = %SessionKey{tenant_id: tenant_id, room_id: room_id, session_id: session_id}

    participants =
      Enum.map(1..participant_count, fn index ->
        %{
          id: UUID.generate(),
          generation: 1,
          display_name: "Participant #{index}",
          capabilities: ["control:hand"],
          admission_lifecycle_intent_id: UUID.generate()
        }
      end)

    {:ok, _result} =
      Postgrex.transaction(connection, fn transaction ->
        insert_product_rows(transaction, session, participants)
        insert_control(transaction, session)
        state = insert_join_history(transaction, session, participants)
        update_control(transaction, session, state, length(participants))
      end)

    identities =
      Enum.map(participants, fn participant ->
        %Identity{
          session: session,
          participant_session_id: participant.id,
          participant_session_generation: participant.generation,
          admission_lifecycle_intent_id: participant.admission_lifecycle_intent_id,
          capabilities: participant.capabilities
        }
      end)

    %{session: session, identities: identities, state: state_for(session, participants)}
  end

  def seed_pending_join(connection) do
    tenant_id = UUID.generate()
    room_id = UUID.generate()
    session_id = UUID.generate()
    participant_id = UUID.generate()
    intent_id = UUID.generate()
    session = %SessionKey{tenant_id: tenant_id, room_id: room_id, session_id: session_id}
    display_name = "Pending Participant"

    payload = %{
      "participant_session_id" => participant_id,
      "display_name" => display_name
    }

    {:ok, _result} =
      Postgrex.transaction(connection, fn transaction ->
        insert_product_rows(transaction, session, [])
        insert_control(transaction, session)

        Postgrex.query!(
          transaction,
          """
          insert into participants (
            id, name, capabilities, tenant_id, room_id, session_id, generation, status
          ) values ($1, $2, $3, $4, $5, $6, 1, 'joining')
          """,
          [
            uuid(participant_id),
            display_name,
            ["control:hand"],
            uuid(tenant_id),
            uuid(room_id),
            uuid(session_id)
          ]
        )

        insert_pending_intent(
          transaction,
          session,
          intent_id,
          "join_pending_request_0001",
          "participant_joined",
          participant_id,
          1,
          payload
        )

        payload_bytes = payload |> JSON.encode!() |> byte_size()

        Postgrex.query!(
          transaction,
          """
          update sync_session_control
          set snapshot_reserved_bytes = 2048,
              lifecycle_reserved_events = 3,
              lifecycle_reserved_bytes = 49152,
              lifecycle_intent_count = 1,
              lifecycle_intent_bytes = $4,
              lifecycle_reserved_intents = 2,
              lifecycle_reserved_intent_bytes = 32768
          where tenant_id = $1 and room_id = $2 and session_id = $3
          """,
          [uuid(tenant_id), uuid(room_id), uuid(session_id), payload_bytes]
        )
      end)

    identity = %Identity{
      session: session,
      participant_session_id: participant_id,
      participant_session_generation: 1,
      admission_lifecycle_intent_id: intent_id,
      capabilities: ["control:hand"]
    }

    %{session: session, identity: identity, lifecycle_intent_id: intent_id}
  end

  def request_pending_leave(connection, %{session: session, identity: identity} = fixture) do
    intent_id = UUID.generate()
    payload = %{"participant_session_id" => identity.participant_session_id}
    payload_bytes = payload |> JSON.encode!() |> byte_size()

    {:ok, _result} =
      Postgrex.transaction(connection, fn transaction ->
        Postgrex.query!(
          transaction,
          """
          update participants set status = 'leaving'
          where tenant_id = $1 and room_id = $2 and session_id = $3 and id = $4
            and generation = 1 and status = 'active'
          """,
          session_params(session) ++ [uuid(identity.participant_session_id)]
        )

        Postgrex.query!(
          transaction,
          """
          update sync_session_control
          set lifecycle_intent_count = lifecycle_intent_count + 1,
              lifecycle_intent_bytes = lifecycle_intent_bytes + $4,
              lifecycle_reserved_intents = lifecycle_reserved_intents - 1,
              lifecycle_reserved_intent_bytes = lifecycle_reserved_intent_bytes - 16384
          where tenant_id = $1 and room_id = $2 and session_id = $3
          """,
          session_params(session) ++ [payload_bytes]
        )

        insert_pending_intent(
          transaction,
          session,
          intent_id,
          "leave_pending_request_01",
          "participant_left",
          identity.participant_session_id,
          1,
          payload
        )
      end)

    Map.put(fixture, :leave_lifecycle_intent_id, intent_id)
  end

  def request_pending_end(connection, %{session: session} = fixture) do
    intent_id = UUID.generate()
    payload = %{}
    payload_bytes = payload |> JSON.encode!() |> byte_size()

    {:ok, _result} =
      Postgrex.transaction(connection, fn transaction ->
        Postgrex.query!(
          transaction,
          """
          update room_sessions set status = 'ending'
          where tenant_id = $1 and room_id = $2 and id = $3 and status = 'active'
          """,
          session_params(session)
        )

        Postgrex.query!(
          transaction,
          """
          update sync_session_control
          set lifecycle_intent_count = lifecycle_intent_count + 1,
              lifecycle_intent_bytes = lifecycle_intent_bytes + $4,
              lifecycle_reserved_intents = lifecycle_reserved_intents - 1,
              lifecycle_reserved_intent_bytes = lifecycle_reserved_intent_bytes - 16384
          where tenant_id = $1 and room_id = $2 and session_id = $3
          """,
          session_params(session) ++ [payload_bytes]
        )

        insert_pending_intent(
          transaction,
          session,
          intent_id,
          "session_end_request_001",
          "session_ended",
          nil,
          nil,
          payload
        )
      end)

    Map.put(fixture, :end_lifecycle_intent_id, intent_id)
  end

  def cleanup(connection, %SessionKey{} = session) do
    tenant_id = uuid(session.tenant_id)

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
      delete(transaction, "sync_control_events", tenant_id)
      delete(transaction, "sync_lifecycle_intents", tenant_id)
      delete(transaction, "sync_session_control", tenant_id)
      delete(transaction, "participants", tenant_id)
      delete(transaction, "room_sessions", tenant_id)
      delete(transaction, "rooms", tenant_id)
      Postgrex.query!(transaction, "delete from tenants where id = $1", [tenant_id])
    end)
  end

  defp insert_product_rows(connection, session, participants) do
    Postgrex.query!(connection, "insert into tenants (id, name) values ($1, 'Sync Test')", [
      uuid(session.tenant_id)
    ])

    Postgrex.query!(
      connection,
      """
      insert into rooms (id, name, tenant_id, status, slug, media_plane)
      values ($1, 'Sync Test Room', $2, 'active', $3, 'cf_rtk')
      """,
      [uuid(session.room_id), uuid(session.tenant_id), "sync-test-#{session.room_id}"]
    )

    Postgrex.query!(
      connection,
      """
      insert into room_sessions (id, status, room_id, tenant_id, started_at)
      values ($1, 'active', $2, $3, now())
      """,
      [uuid(session.session_id), uuid(session.room_id), uuid(session.tenant_id)]
    )

    Enum.each(participants, fn participant ->
      Postgrex.query!(
        connection,
        """
        insert into participants (
          id, name, capabilities, tenant_id, room_id, session_id,
          generation, status, joined_at
        ) values ($1, $2, $3, $4, $5, $6, $7, 'active', now())
        """,
        [
          uuid(participant.id),
          participant.display_name,
          participant.capabilities,
          uuid(session.tenant_id),
          uuid(session.room_id),
          uuid(session.session_id),
          participant.generation
        ]
      )
    end)
  end

  defp insert_pending_intent(
         connection,
         session,
         intent_id,
         request_key,
         name,
         participant_id,
         generation,
         payload
       ) do
    Postgrex.query!(
      connection,
      """
      insert into sync_lifecycle_intents (
        tenant_id, room_id, session_id, lifecycle_intent_id, request_key,
        request_fingerprint, intent_name, participant_session_id,
        participant_session_generation, payload, status
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
      """,
      [
        uuid(session.tenant_id),
        uuid(session.room_id),
        uuid(session.session_id),
        uuid(intent_id),
        request_key,
        :crypto.hash(:sha256, JSON.encode!(payload)),
        name,
        nullable_uuid(participant_id),
        generation,
        payload
      ]
    )
  end

  defp insert_control(connection, session) do
    state = Reducer.new(session.session_id)

    Postgrex.query!(
      connection,
      """
      insert into sync_session_control (
        tenant_id, room_id, session_id, folded_state, state_schema_version,
        state_digest, snapshot_bytes
      ) values ($1, $2, $3, $4, $5, $6, $7)
      """,
      [
        uuid(session.tenant_id),
        uuid(session.room_id),
        uuid(session.session_id),
        Reducer.snapshot(state),
        Reducer.state_schema_version(),
        Reducer.digest(state),
        Reducer.snapshot_bytes(state)
      ]
    )
  end

  defp insert_join_history(connection, session, participants) do
    Enum.reduce(participants, Reducer.new(session.session_id), fn participant, state ->
      {:ok, event, next_state} =
        Reducer.apply_lifecycle(state, :participant_joined, %{
          "participant_session_id" => participant.id,
          "display_name" => participant.display_name
        })

      insert_join_intent_and_event(connection, session, participant, event, next_state)
      next_state
    end)
  end

  defp insert_join_intent_and_event(connection, session, participant, event, state) do
    intent_id = participant.admission_lifecycle_intent_id
    event_id = UUID.generate()
    request_key = "join_request_#{String.replace(participant.id, "-", "_")}"

    payload = %{
      "participant_session_id" => participant.id,
      "display_name" => participant.display_name
    }

    Postgrex.query!(
      connection,
      """
      insert into sync_lifecycle_intents (
        tenant_id, room_id, session_id, lifecycle_intent_id, request_key,
        request_fingerprint, intent_name, participant_session_id,
        participant_session_generation, payload, status
      ) values ($1, $2, $3, $4, $5, $6, 'participant_joined', $7, $8, $9, 'pending')
      """,
      [
        uuid(session.tenant_id),
        uuid(session.room_id),
        uuid(session.session_id),
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

    encoded_bytes = wire_event |> ProtocolV2.event() |> byte_size()

    Postgrex.query!(
      connection,
      """
      insert into sync_control_events (
        tenant_id, room_id, session_id, event_id, base_revision, revision,
        event_name, payload, lifecycle_intent_id, event_schema_version,
        resulting_state_digest, encoded_bytes
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      """,
      [
        uuid(session.tenant_id),
        uuid(session.room_id),
        uuid(session.session_id),
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

  defp update_control(connection, session, state, participant_count) do
    Postgrex.query!(
      connection,
      """
      update sync_session_control
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
      where tenant_id = $1 and room_id = $2 and session_id = $3
      """,
      [
        uuid(session.tenant_id),
        uuid(session.room_id),
        uuid(session.session_id),
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

  defp state_for(session, participants) do
    Enum.reduce(participants, Reducer.new(session.session_id), fn participant, state ->
      {:ok, _event, state} =
        Reducer.apply_lifecycle(state, :participant_joined, %{
          "participant_session_id" => participant.id,
          "display_name" => participant.display_name
        })

      state
    end)
  end

  defp delete(connection, table, tenant_id) do
    Postgrex.query!(connection, "delete from #{table} where tenant_id = $1", [tenant_id])
  end

  defp session_params(session),
    do: [uuid(session.tenant_id), uuid(session.room_id), uuid(session.session_id)]

  defp uuid(value), do: UUID.dump!(value)
  defp nullable_uuid(nil), do: nil
  defp nullable_uuid(value), do: uuid(value)
end
