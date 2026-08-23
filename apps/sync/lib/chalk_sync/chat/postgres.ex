defmodule ChalkSync.Chat.Repository.Postgres do
  @moduledoc """
  PostgreSQL implementation of the space chat repository.

  Appends lock the authoritative Episode and participant generation, serialize
  on the Episode chat stream, reserve bounded capacity, and insert the message
  before committing the new head.
  """

  @behaviour ChalkSync.Chat.Repository

  alias ChalkSync.Chat.Repository.Message
  alias ChalkSync.Chat.Repository.Postgres.Page
  alias ChalkSync.Chat.Repository.SQL
  alias ChalkSync.Database
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.UUID

  @transaction_timeout_ms 3_000
  @capabilities ["sendReaction", "sendChat"]
  @participant_message_limit 10_000
  @participant_message_bytes_limit 64 * 1_024 * 1_024

  @impl true
  def authorize(%Identity{} = identity, capability)
      when is_binary(capability) or is_nil(capability) do
    Postgrex.transaction(
      Database.connection(identity.episode),
      &authorize_transaction(&1, identity, capability),
      timeout: @transaction_timeout_ms,
      commit_comment: "chalk sync space action authorization"
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
      Database.connection(identity.episode),
      &participant_capabilities_transaction(&1, identity),
      timeout: @transaction_timeout_ms,
      commit_comment: "chalk sync space action capabilities"
    )
    |> transaction_result()
  rescue
    _exception -> {:error, :dependency_unavailable}
  catch
    :exit, _reason -> {:error, :dependency_unavailable}
  end

  @impl true
  def append(%Identity{} = identity, input), do: append(identity, input, fn -> :ok end)

  @impl true
  def append(
        %Identity{} = identity,
        %{
          client_message_id: client_message_id,
          text: text,
          attachment_ids: attachment_ids
        } = input,
        admit_new_message
      )
      when is_binary(client_message_id) and is_binary(text) and is_list(attachment_ids) and
             is_function(admit_new_message, 0) do
    with :ok <- validate_input(input) do
      fingerprint = request_fingerprint(text, attachment_ids)

      case append_transaction(identity, input, fingerprint, admit_new_message) do
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

  def append(%Identity{}, _input, admit_new_message) when is_function(admit_new_message, 0),
    do: {:error, :invalid_payload}

  @impl true
  def head(%EpisodeKey{} = episode) do
    case Postgrex.query(
           Database.connection(episode),
           SQL.read_head(),
           episode_params(episode),
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
  def read_receipts(%EpisodeKey{} = episode) do
    case Postgrex.query(
           Database.connection(episode),
           SQL.list_read_receipts(),
           episode_params(episode),
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
    case Integer.parse(sequence) do
      {parsed, ""} when parsed > 0 ->
        Postgrex.transaction(
          Database.connection(identity.episode),
          fn connection -> mark_read_transaction(connection, identity, parsed) end,
          timeout: @transaction_timeout_ms,
          commit_comment: "chalk sync chat read receipt"
        )
        |> transaction_result()

      _ ->
        {:error, :invalid_payload}
    end
  rescue
    _exception -> {:error, :dependency_unavailable}
  catch
    :exit, _reason -> {:error, :dependency_unavailable}
  end

  def mark_read(%Identity{}, _sequence), do: {:error, :invalid_payload}

  @impl true
  defdelegate read_page(episode, request), to: Page, as: :read

  defp mark_read_transaction(connection, identity, sequence) do
    configure_transaction(connection)

    case lock_authority(connection, identity) do
      {:ok, _profile} ->
        case Postgrex.query!(
               connection,
               SQL.lock_stream_for_read(),
               space_params(identity.episode)
             ).rows do
          [[head, _floor]] when sequence <= head ->
            upsert_receipt(connection, identity, sequence)

          _ ->
            Postgrex.rollback(connection, {:error, :invalid_payload})
        end

      {:error, reason} ->
        Postgrex.rollback(connection, {:error, reason})
    end
  end

  defp upsert_receipt(connection, identity, sequence) do
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

    params =
      episode_params(identity.episode) ++
        [
          uuid(identity.participant_id),
          identity.participant_generation,
          sequence,
          now
        ]

    case Postgrex.query!(connection, SQL.upsert_read_receipt(), params).rows do
      [row] ->
        %{outcome: :advanced, receipt: receipt(row)}

      [] ->
        existing_params =
          episode_params(identity.episode) ++
            [uuid(identity.participant_id), identity.participant_generation]

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
        episode_params(identity.episode)
      )
      |> Map.fetch!(:rows)
      |> Map.new(fn [participant_id, _role, capabilities] ->
        {UUID.load!(participant_id), ordered_capabilities(capabilities)}
      end)

    %{
      capabilities: ordered_capabilities(profile.capabilities),
      participant_capabilities: participants
    }
  end

  defp append_transaction(identity, input, fingerprint, admit_new_message) do
    Postgrex.transaction(
      Database.connection(identity.episode),
      fn connection ->
        append_in_transaction(connection, identity, input, fingerprint, admit_new_message)
      end,
      timeout: @transaction_timeout_ms,
      commit_comment: "chalk sync chat append"
    )
  end

  defp append_in_transaction(connection, identity, input, fingerprint, admit_new_message) do
    configure_transaction(connection)

    case select_idempotent(connection, identity, input.client_message_id) do
      nil ->
        append_after_authorization(
          connection,
          identity,
          input,
          fingerprint,
          admit_new_message
        )

      existing ->
        idempotent_result(connection, existing, fingerprint)
    end
  end

  defp append_after_authorization(
         connection,
         identity,
         input,
         fingerprint,
         admit_new_message
       ) do
    with {:ok, profile} <- lock_authority(connection, identity),
         :ok <- require_capability(profile, "sendChat") do
      params = space_params(identity.episode)
      Postgrex.query!(connection, SQL.insert_stream(), params)

      [[head_sequence, _floor, _count, _bytes]] =
        Postgrex.query!(connection, SQL.lock_stream(), params).rows

      append_after_stream_lock(
        connection,
        identity,
        profile.display_name,
        input,
        fingerprint,
        head_sequence,
        admit_new_message
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
         head_sequence,
         admit_new_message
       ) do
    case select_idempotent(connection, identity, input.client_message_id) do
      nil ->
        append_after_admission(
          connection,
          identity,
          display_name,
          input,
          fingerprint,
          head_sequence,
          admit_new_message
        )

      existing ->
        idempotent_result(connection, existing, fingerprint)
    end
  end

  defp append_after_admission(
         connection,
         identity,
         display_name,
         input,
         fingerprint,
         head_sequence,
         admit_new_message
       ) do
    case admit_new_message.() do
      :ok ->
        append_with_attachments(
          connection,
          identity,
          display_name,
          input,
          fingerprint,
          head_sequence
        )

      {:error, reason} when reason in [:rate_limited, :overloaded] ->
        Postgrex.rollback(connection, {:error, reason})

      _invalid_admission_result ->
        Postgrex.rollback(connection, {:error, :overloaded})
    end
  end

  defp append_with_attachments(
         connection,
         identity,
         display_name,
         input,
         fingerprint,
         head_sequence
       ) do
    usage = participant_usage(connection, identity)
    notify_attachment_commit_attempt(input)

    case lock_attachments(connection, identity, input.attachment_ids) do
      {:ok, attachments} ->
        append_new_message(
          connection,
          identity,
          display_name,
          input,
          attachments,
          fingerprint,
          head_sequence + 1,
          usage
        )

      {:error, reason} ->
        Postgrex.rollback(connection, {:error, reason})
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
         sequence,
         usage
       ) do
    message = %{
      message_id: UUID.generate(),
      client_message_id: input.client_message_id,
      sequence: Integer.to_string(sequence),
      participant_id: identity.participant_id,
      display_name: display_name,
      text: input.text,
      attachments: attachments,
      created_at: DateTime.utc_now() |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
    }

    encoded_bytes = Message.encoded_bytes(message)
    params = space_params(identity.episode)

    case participant_capacity(usage, encoded_bytes) do
      :ok ->
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

      :rate_limited ->
        Postgrex.rollback(connection, {:error, :rate_limited})
    end
  end

  defp participant_usage(connection, identity) do
    [[count, bytes]] =
      Postgrex.query!(
        connection,
        SQL.participant_usage(),
        space_params(identity.episode) ++ [uuid(identity.participant_id)]
      ).rows

    %{count: count, bytes: bytes}
  end

  defp participant_capacity(%{count: count, bytes: bytes}, encoded_bytes) do
    if count < @participant_message_limit and
         bytes + encoded_bytes <= @participant_message_bytes_limit,
       do: :ok,
       else: :rate_limited
  end

  defp insert_message(connection, identity, message, fingerprint, encoded_bytes, sequence) do
    Postgrex.query!(
      connection,
      SQL.insert_message(),
      episode_params(identity.episode) ++
        [
          sequence,
          uuid(message.message_id),
          uuid(identity.participant_id),
          identity.participant_generation,
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
        episode_params(identity.episode) ++ [dumped_ids]
      ).rows

    cond do
      length(rows) != length(attachment_ids) ->
        {:error, :attachment_not_found}

      Enum.any?(rows, fn [_id, _name, _mime, _bytes, status, owner_id, generation] ->
        status != "ready" or UUID.load!(owner_id) != identity.participant_id or
            generation != identity.participant_generation
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

  defp notify_attachment_commit_attempt(input) do
    case Map.get(input, :attachment_commit_observer) do
      observer when is_function(observer, 0) -> observer.()
      _other -> :ok
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
          episode_params(identity.episode) ++
            [
              sequence,
              ordinal,
              Message.iso_datetime(message.created_at),
              uuid(attachment.attachment_id),
              uuid(identity.participant_id),
              identity.participant_generation
            ]
        ).rows

      if rows == [], do: Postgrex.rollback(connection, {:error, :attachment_not_ready})
    end)
  end

  defp select_idempotent(connection, identity, client_message_id) do
    params =
      space_params(identity.episode) ++
        [
          uuid(identity.participant_id),
          identity.participant_generation,
          client_message_id
        ]

    case Postgrex.query!(connection, SQL.select_idempotent_message(), params).rows do
      [] -> nil
      [row] -> {Message.from_row(Enum.take(row, 8)), List.last(row)}
    end
  end

  defp resolve_uncertain_append(identity, client_message_id, fingerprint) do
    connection = Database.connection(identity.episode, 1)

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
      episode_params(identity.episode) ++ [uuid(identity.participant_id)]

    case Postgrex.query!(connection, SQL.lock_authority(), params).rows do
      [["active", generation, "active", display_name, _role, capabilities]]
      when generation == identity.participant_generation and is_binary(display_name) ->
        {:ok,
         %{
           display_name: display_name,
           capabilities: ordered_capabilities(capabilities)
         }}

      [[episode_status, _generation, _participant_status, _display_name, _role, _capabilities]]
      when episode_status != "active" ->
        {:error, :episode_ended}

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
    with :ok <- validate_client_message_id(client_message_id),
         :ok <- validate_text(text),
         :ok <- validate_attachment_ids(attachment_ids) do
      validate_content(text, attachment_ids)
    end
  end

  defp validate_client_message_id(client_message_id) do
    if byte_size(client_message_id) in 16..64, do: :ok, else: {:error, :invalid_payload}
  end

  defp validate_text(text) do
    cond do
      byte_size(text) > 16_384 -> {:error, :invalid_payload}
      String.length(text) > 4_000 -> {:error, :invalid_payload}
      true -> :ok
    end
  end

  defp validate_attachment_ids(attachment_ids) do
    cond do
      length(attachment_ids) > 5 -> {:error, :invalid_payload}
      Enum.uniq(attachment_ids) != attachment_ids -> {:error, :invalid_payload}
      not Enum.all?(attachment_ids, &valid_uuid?/1) -> {:error, :invalid_payload}
      true -> :ok
    end
  end

  defp validate_content("", []), do: {:error, :invalid_payload}
  defp validate_content(_text, _attachment_ids), do: :ok

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

  defp head(nil, nil), do: empty_head()
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
      participant_id: UUID.load!(participant_id),
      participant_generation: generation,
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

  defp episode_params(episode) do
    [uuid(episode.tenant_id), uuid(episode.space_id), uuid(episode.episode_id)]
  end

  defp space_params(episode), do: [uuid(episode.tenant_id), uuid(episode.space_id)]

  defp uuid(value), do: UUID.dump!(value)
end
