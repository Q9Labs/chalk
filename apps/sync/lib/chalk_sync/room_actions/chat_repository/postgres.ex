defmodule ChalkSync.RoomActions.ChatRepository.Postgres do
  @moduledoc """
  PostgreSQL implementation of the room chat repository.

  Appends lock the authoritative Session and participant generation, serialize
  on the Session chat stream, reserve bounded capacity, and insert the message
  before committing the new head.
  """

  @behaviour ChalkSync.RoomActions.ChatRepository

  alias ChalkSync.Database
  alias ChalkSync.RoomActions.ChatRepository.Message
  alias ChalkSync.RoomActions.ChatRepository.Postgres.Page
  alias ChalkSync.RoomActions.ChatRepository.SQL
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.SessionKey
  alias ChalkSync.UUID

  @transaction_timeout_ms 3_000
  @capabilities ["sendReaction", "sendChat"]

  @impl true
  def authorize(%Identity{} = identity, capability)
      when is_binary(capability) or is_nil(capability) do
    Postgrex.transaction(
      Database.connection(identity.session),
      &authorize_transaction(&1, identity, capability),
      timeout: @transaction_timeout_ms,
      commit_comment: "chalk sync room action authorization"
    )
    |> transaction_result()
  rescue
    _exception -> {:error, :dependency_unavailable}
  catch
    :exit, _reason -> {:error, :dependency_unavailable}
  end

  @impl true
  def participant_capabilities(%Identity{} = identity) do
    Postgrex.transaction(
      Database.connection(identity.session),
      &participant_capabilities_transaction(&1, identity),
      timeout: @transaction_timeout_ms,
      commit_comment: "chalk sync room action capabilities"
    )
    |> transaction_result()
  rescue
    _exception -> {:error, :dependency_unavailable}
  catch
    :exit, _reason -> {:error, :dependency_unavailable}
  end

  @impl true
  def append(
        %Identity{} = identity,
        %{
          client_message_id: client_message_id,
          text: text,
          attachment_ids: attachment_ids
        } = input
      )
      when is_binary(client_message_id) and is_binary(text) and is_list(attachment_ids) do
    with :ok <- validate_input(input) do
      fingerprint = request_fingerprint(text, attachment_ids)

      case append_transaction(identity, input, fingerprint) do
        {:ok, result} ->
          {:ok, result}

        {:error, {:error, reason}} ->
          {:error, reason}

        {:error, _reason} ->
          resolve_uncertain_append(identity, client_message_id, fingerprint)
      end
    end
  rescue
    _exception ->
      resolve_uncertain_append(
        identity,
        client_message_id,
        request_fingerprint(text, attachment_ids)
      )
  catch
    :exit, _reason ->
      resolve_uncertain_append(
        identity,
        client_message_id,
        request_fingerprint(text, attachment_ids)
      )
  end

  def append(%Identity{}, _input), do: {:error, :invalid_payload}

  @impl true
  def head(%SessionKey{} = session) do
    case Postgrex.query(
           Database.connection(session),
           SQL.read_head(),
           session_params(session),
           timeout: 1_000
         ) do
      {:ok, %{rows: []}} -> {:ok, empty_head()}
      {:ok, %{rows: [[head, floor]]}} -> {:ok, head(head, floor)}
      {:error, _reason} -> {:error, :dependency_unavailable}
    end
  rescue
    _exception -> {:error, :dependency_unavailable}
  catch
    :exit, _reason -> {:error, :dependency_unavailable}
  end

  @impl true
  def read_receipts(%SessionKey{} = session) do
    case Postgrex.query(
           Database.connection(session),
           SQL.list_read_receipts(),
           session_params(session),
           timeout: 1_000
         ) do
      {:ok, %{rows: rows}} -> {:ok, Enum.map(rows, &receipt/1)}
      {:error, _reason} -> {:error, :dependency_unavailable}
    end
  rescue
    _exception -> {:error, :dependency_unavailable}
  catch
    :exit, _reason -> {:error, :dependency_unavailable}
  end

  @impl true
  def mark_read(%Identity{} = identity, sequence) when is_binary(sequence) do
    with {parsed, ""} when parsed > 0 <- Integer.parse(sequence) do
      Postgrex.transaction(
        Database.connection(identity.session),
        fn connection -> mark_read_transaction(connection, identity, parsed) end,
        timeout: @transaction_timeout_ms,
        commit_comment: "chalk sync chat read receipt"
      )
      |> transaction_result()
    else
      _ -> {:error, :invalid_payload}
    end
  rescue
    _exception -> {:error, :dependency_unavailable}
  catch
    :exit, _reason -> {:error, :dependency_unavailable}
  end

  def mark_read(%Identity{}, _sequence), do: {:error, :invalid_payload}

  @impl true
  defdelegate read_page(session, request), to: Page, as: :read

  defp mark_read_transaction(connection, identity, sequence) do
    configure_transaction(connection)

    with {:ok, _profile} <- lock_authority(connection, identity) do
      params = session_params(identity.session)

      case Postgrex.query!(connection, SQL.lock_stream_for_read(), params).rows do
        [[head, _floor]] when sequence <= head ->
          upsert_receipt(connection, identity, sequence)

        _ ->
          Postgrex.rollback(connection, {:error, :invalid_payload})
      end
    else
      {:error, reason} -> Postgrex.rollback(connection, {:error, reason})
    end
  end

  defp upsert_receipt(connection, identity, sequence) do
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

    params =
      session_params(identity.session) ++
        [
          uuid(identity.participant_session_id),
          identity.participant_session_generation,
          sequence,
          now
        ]

    case Postgrex.query!(connection, SQL.upsert_read_receipt(), params).rows do
      [row] ->
        %{outcome: :advanced, receipt: receipt(row)}

      [] ->
        existing_params =
          session_params(identity.session) ++
            [uuid(identity.participant_session_id), identity.participant_session_generation]

        [row] = Postgrex.query!(connection, SQL.read_participant_receipt(), existing_params).rows
        %{outcome: :unchanged, receipt: receipt(row)}
    end
  end

  defp authorize_transaction(connection, identity, capability) do
    configure_transaction(connection)

    case lock_authority(connection, identity) do
      {:ok, profile} ->
        if is_nil(capability) or capability in profile.capabilities,
          do: %{display_name: profile.display_name},
          else: Postgrex.rollback(connection, {:error, :capability_denied})

      {:error, reason} ->
        Postgrex.rollback(connection, {:error, reason})
    end
  end

  defp participant_capabilities_transaction(connection, identity) do
    configure_transaction(connection)

    case lock_authority(connection, identity) do
      {:ok, profile} -> capability_state(connection, identity, profile)
      {:error, reason} -> Postgrex.rollback(connection, {:error, reason})
    end
  end

  defp capability_state(connection, identity, profile) do
    participants =
      connection
      |> Postgrex.query!(
        SQL.list_participant_capabilities(),
        session_params(identity.session)
      )
      |> Map.fetch!(:rows)
      |> Map.new(fn [participant_id, role, role_capabilities] ->
        {UUID.load!(participant_id),
         role_capabilities |> Map.get(role, []) |> ordered_capabilities()}
      end)

    %{
      capabilities: ordered_capabilities(profile.capabilities),
      participant_capabilities: participants
    }
  end

  defp append_transaction(identity, input, fingerprint) do
    Postgrex.transaction(
      Database.connection(identity.session),
      fn connection -> append_in_transaction(connection, identity, input, fingerprint) end,
      timeout: @transaction_timeout_ms,
      commit_comment: "chalk sync chat append"
    )
  end

  defp append_in_transaction(connection, identity, input, fingerprint) do
    configure_transaction(connection)

    case select_idempotent(connection, identity, input.client_message_id) do
      nil ->
        append_after_authorization(connection, identity, input, fingerprint)

      existing ->
        idempotent_result(connection, existing, fingerprint)
    end
  end

  defp append_after_authorization(connection, identity, input, fingerprint) do
    with {:ok, profile} <- lock_authority(connection, identity),
         :ok <- require_capability(profile, "sendChat") do
      params = session_params(identity.session)
      Postgrex.query!(connection, SQL.insert_stream(), params)

      [[head_sequence, _floor, _count, _bytes]] =
        Postgrex.query!(connection, SQL.lock_stream(), params).rows

      append_after_stream_lock(
        connection,
        identity,
        profile.display_name,
        input,
        fingerprint,
        head_sequence
      )
    else
      {:error, reason} -> Postgrex.rollback(connection, {:error, reason})
    end
  end

  defp append_after_stream_lock(
         connection,
         identity,
         display_name,
         input,
         fingerprint,
         head_sequence
       ) do
    case select_idempotent(connection, identity, input.client_message_id) do
      nil ->
        with {:ok, attachments} <- lock_attachments(connection, identity, input.attachment_ids) do
          append_new_message(
            connection,
            identity,
            display_name,
            input,
            attachments,
            fingerprint,
            head_sequence + 1
          )
        else
          {:error, reason} -> Postgrex.rollback(connection, {:error, reason})
        end

      existing ->
        idempotent_result(connection, existing, fingerprint)
    end
  end

  defp idempotent_result(_connection, {message, fingerprint}, fingerprint) do
    %{outcome: :duplicate, message: message}
  end

  defp idempotent_result(connection, {_message, _other_fingerprint}, _fingerprint) do
    Postgrex.rollback(connection, {:error, :client_message_id_conflict})
  end

  defp append_new_message(
         connection,
         identity,
         display_name,
         input,
         attachments,
         fingerprint,
         sequence
       ) do
    message = %{
      message_id: UUID.generate(),
      client_message_id: input.client_message_id,
      sequence: Integer.to_string(sequence),
      participant_session_id: identity.participant_session_id,
      display_name: display_name,
      text: input.text,
      attachments: attachments,
      created_at: DateTime.utc_now() |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
    }

    encoded_bytes = Message.encoded_bytes(message)
    params = session_params(identity.session)

    case Postgrex.query!(
           connection,
           SQL.reserve_message(),
           params ++ [sequence, encoded_bytes]
         ).rows do
      [[^sequence]] ->
        insert_message(connection, identity, message, fingerprint, encoded_bytes, sequence)
        attach_files(connection, identity, message, sequence)
        %{outcome: :committed, message: message}

      [] ->
        Postgrex.rollback(connection, {:error, :overloaded})
    end
  end

  defp insert_message(connection, identity, message, fingerprint, encoded_bytes, sequence) do
    Postgrex.query!(
      connection,
      SQL.insert_message(),
      session_params(identity.session) ++
        [
          sequence,
          uuid(message.message_id),
          uuid(identity.participant_session_id),
          identity.participant_session_generation,
          message.client_message_id,
          fingerprint,
          message.display_name,
          message.text,
          encoded_bytes,
          Message.iso_datetime(message.created_at)
        ]
    )
  end

  defp lock_attachments(_connection, _identity, []), do: {:ok, []}

  defp lock_attachments(connection, identity, attachment_ids) do
    dumped_ids = Enum.map(attachment_ids, &uuid/1)

    rows =
      Postgrex.query!(
        connection,
        SQL.lock_attachments(),
        session_params(identity.session) ++ [dumped_ids]
      ).rows

    cond do
      length(rows) != length(attachment_ids) ->
        {:error, :attachment_not_found}

      Enum.any?(rows, fn [_id, _name, _mime, _bytes, status, owner_id, generation] ->
        status != "ready" or UUID.load!(owner_id) != identity.participant_session_id or
            generation != identity.participant_session_generation
      end) ->
        attachment_state_error(rows)

      true ->
        {:ok,
         Enum.map(rows, fn [id, name, mime_type, byte_length, _status, _owner, _generation] ->
           %{
             attachment_id: UUID.load!(id),
             file_name: name,
             mime_type: mime_type,
             byte_length: byte_length
           }
         end)}
    end
  end

  defp attachment_state_error(rows) do
    if Enum.any?(rows, fn [_id, _name, _mime, _bytes, status, _owner, _generation] ->
         status == "attached"
       end),
       do: {:error, :attachment_already_claimed},
       else: {:error, :attachment_not_ready}
  end

  defp attach_files(connection, identity, message, sequence) do
    message.attachments
    |> Enum.with_index()
    |> Enum.each(fn {attachment, ordinal} ->
      rows =
        Postgrex.query!(
          connection,
          SQL.attach_message_files(),
          session_params(identity.session) ++
            [
              sequence,
              ordinal,
              Message.iso_datetime(message.created_at),
              uuid(attachment.attachment_id),
              uuid(identity.participant_session_id),
              identity.participant_session_generation
            ]
        ).rows

      if rows == [], do: Postgrex.rollback(connection, {:error, :attachment_not_ready})
    end)
  end

  defp select_idempotent(connection, identity, client_message_id) do
    params =
      session_params(identity.session) ++
        [
          uuid(identity.participant_session_id),
          identity.participant_session_generation,
          client_message_id
        ]

    case Postgrex.query!(connection, SQL.select_idempotent_message(), params).rows do
      [] -> nil
      [row] -> {Message.from_row(Enum.take(row, 8)), List.last(row)}
    end
  end

  defp resolve_uncertain_append(identity, client_message_id, fingerprint) do
    connection = Database.connection(identity.session, 1)

    case select_idempotent(connection, identity, client_message_id) do
      {message, ^fingerprint} -> {:ok, %{outcome: :duplicate, message: message}}
      {_message, _other_fingerprint} -> {:error, :client_message_id_conflict}
      nil -> {:error, :dependency_unavailable}
    end
  rescue
    _exception -> {:error, :dependency_unavailable}
  catch
    :exit, _reason -> {:error, :dependency_unavailable}
  end

  defp lock_authority(connection, identity) do
    params =
      session_params(identity.session) ++ [uuid(identity.participant_session_id)]

    case Postgrex.query!(connection, SQL.lock_authority(), params).rows do
      [["active", generation, "active", display_name, role, role_capabilities]]
      when generation == identity.participant_session_generation and is_binary(display_name) ->
        {:ok,
         %{
           display_name: display_name,
           capabilities: role_capabilities |> Map.get(role, []) |> ordered_capabilities()
         }}

      [[session_status, _generation, _participant_status, _display_name, _role, _capabilities]]
      when session_status != "active" ->
        {:error, :session_ended}

      [_participant] ->
        {:error, :participant_stale}

      [] ->
        {:error, :participant_stale}
    end
  end

  defp require_capability(profile, capability) do
    if capability in profile.capabilities, do: :ok, else: {:error, :capability_denied}
  end

  defp validate_input(%{
         client_message_id: client_message_id,
         text: text,
         attachment_ids: attachment_ids
       }) do
    cond do
      byte_size(client_message_id) not in 16..64 -> {:error, :invalid_payload}
      byte_size(text) > 16_384 -> {:error, :invalid_payload}
      String.length(text) > 4_000 -> {:error, :invalid_payload}
      length(attachment_ids) > 5 -> {:error, :invalid_payload}
      Enum.uniq(attachment_ids) != attachment_ids -> {:error, :invalid_payload}
      not Enum.all?(attachment_ids, &valid_uuid?/1) -> {:error, :invalid_payload}
      text == "" and attachment_ids == [] -> {:error, :invalid_payload}
      true -> :ok
    end
  end

  defp request_fingerprint(text, attachment_ids) do
    if attachment_ids == [] do
      :crypto.hash(:sha256, text)
    else
      composite_fingerprint(text, attachment_ids)
    end
  end

  defp composite_fingerprint(text, attachment_ids) do
    :crypto.hash(
      :sha256,
      JSON.encode!(%{"version" => 2, "text" => text, "attachment_ids" => attachment_ids})
    )
  end

  defp valid_uuid?(value) when is_binary(value) do
    case UUID.dump(value) do
      {:ok, _uuid} -> true
      _error -> false
    end
  end

  defp valid_uuid?(_value), do: false

  defp transaction_result({:ok, result}), do: {:ok, result}
  defp transaction_result({:error, {:error, reason}}), do: {:error, reason}
  defp transaction_result({:error, _reason}), do: {:error, :dependency_unavailable}

  defp ordered_capabilities(capabilities) do
    Enum.filter(@capabilities, &(&1 in capabilities))
  end

  defp configure_transaction(connection) do
    Postgrex.query!(connection, SQL.transaction_settings(), [])
  end

  defp head(0, nil), do: empty_head()

  defp head(head_sequence, retained_floor) do
    %{
      head_sequence: Integer.to_string(head_sequence),
      retained_floor_sequence: Integer.to_string(retained_floor)
    }
  end

  defp empty_head, do: %{head_sequence: nil, retained_floor_sequence: nil}

  defp receipt([participant_id, generation, sequence, %DateTime{} = read_at]) do
    %{
      participant_session_id: UUID.load!(participant_id),
      participant_session_generation: generation,
      sequence: Integer.to_string(sequence),
      read_at: read_at |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
    }
  end

  defp receipt([participant_id, generation, sequence, %NaiveDateTime{} = read_at]) do
    receipt([
      participant_id,
      generation,
      sequence,
      DateTime.from_naive!(read_at, "Etc/UTC")
    ])
  end

  defp session_params(session) do
    [uuid(session.tenant_id), uuid(session.room_id), uuid(session.session_id)]
  end

  defp uuid(value), do: UUID.dump!(value)
end
