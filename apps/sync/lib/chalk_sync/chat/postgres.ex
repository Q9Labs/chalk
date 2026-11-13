defmodule ChalkSync.Chat.Repository.Postgres do
  @moduledoc """
  PostgreSQL implementation of the space chat repository.

  Appends lock the authoritative Episode and participant generation, serialize
  on the Episode chat stream, reserve bounded capacity, and insert the message
  before committing the new head.
  """

  @behaviour ChalkSync.Chat.Repository

  alias ChalkSync.Chat.Postgres.Append
  alias ChalkSync.Chat.Postgres.Input
  alias ChalkSync.Chat.Postgres.Marks
  alias ChalkSync.Chat.Postgres.Store
  alias ChalkSync.Chat.Repository.Postgres.Page
  alias ChalkSync.Chat.Repository.SQL
  alias ChalkSync.Database
  alias ChalkSync.Database.TransactionSettings
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.UUID

  @transaction_timeout_ms TransactionSettings.transaction_timeout_ms()

  # One person may send 30 messages in 10 seconds and hold at most 4% of a Space stream's
  # 250,000 messages and 2 GiB, however many times they rejoin.

  @impl true
  def authorize(%Identity{} = identity, capability)
      when is_binary(capability) or is_nil(capability) do
    Database.guard(
      fn ->
        Postgrex.transaction(
          Database.connection(identity.episode),
          &authorize_transaction(&1, identity, capability),
          timeout: @transaction_timeout_ms,
          commit_comment: "chalk sync space action authorization"
        )
        |> Store.transaction_result()
      end,
      {:error, :dependency_unavailable}
    )
  end

  @impl true
  def participant_capabilities(%Identity{} = identity) do
    Database.guard(
      fn ->
        Postgrex.transaction(
          Database.connection(identity.episode),
          &participant_capabilities_transaction(&1, identity),
          timeout: @transaction_timeout_ms,
          commit_comment: "chalk sync space action capabilities"
        )
        |> Store.transaction_result()
      end,
      {:error, :dependency_unavailable}
    )
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
    with :ok <- Input.validate_input(input) do
      fingerprint = Input.request_fingerprint(text, attachment_ids)

      case Append.append_transaction(identity, input, fingerprint) do
        {:ok, result} ->
          {:ok, result}

        {:error, {:error, reason}} ->
          {:error, reason}

        {:error, _reason} ->
          Append.resolve_uncertain_append(identity, client_message_id, fingerprint)
      end
    end
  rescue
    _exception ->
      Append.resolve_uncertain_append(
        identity,
        client_message_id,
        Input.request_fingerprint(text, attachment_ids)
      )
  catch
    :exit, _reason ->
      Append.resolve_uncertain_append(
        identity,
        client_message_id,
        Input.request_fingerprint(text, attachment_ids)
      )
  end

  def append(%Identity{}, _input), do: {:error, :invalid_payload}

  @impl true
  def head(%EpisodeKey{} = episode) do
    Database.guard(
      fn ->
        case Postgrex.query(
               Database.connection(episode),
               SQL.read_head(),
               Store.episode_params(episode),
               timeout: 1_000
             ) do
          {:ok, %{rows: []}} -> {:ok, Store.empty_head()}
          {:ok, %{rows: [[head, floor]]}} -> {:ok, head(head, floor)}
          {:error, _reason} -> {:error, :dependency_unavailable}
        end
      end,
      {:error, :dependency_unavailable}
    )
  end

  defp head(nil, nil), do: Store.empty_head()
  defp head(0, nil), do: Store.empty_head()

  defp head(head_sequence, retained_floor) do
    %{
      head_sequence: Integer.to_string(head_sequence),
      retained_floor_sequence: Integer.to_string(retained_floor)
    }
  end

  @impl true
  def read_receipts(%EpisodeKey{} = episode) do
    Database.guard(
      fn ->
        case Postgrex.query(
               Database.connection(episode),
               SQL.list_read_receipts(),
               Store.episode_params(episode),
               timeout: 1_000
             ) do
          {:ok, %{rows: rows}} -> {:ok, Enum.map(rows, &Store.receipt/1)}
          {:error, _reason} -> {:error, :dependency_unavailable}
        end
      end,
      {:error, :dependency_unavailable}
    )
  end

  @impl true
  def mark_read(%Identity{} = identity, sequence) when is_binary(sequence) do
    Database.guard(
      fn -> Marks.record_read(identity, sequence) end,
      {:error, :dependency_unavailable}
    )
  end

  def mark_read(%Identity{}, _sequence), do: {:error, :invalid_payload}

  @impl true
  def react(%Identity{} = identity, input) do
    Database.guard(
      fn -> Marks.set_reaction(identity, input) end,
      {:error, :dependency_unavailable}
    )
  end

  @impl true
  defdelegate read_page(episode, request), to: Page, as: :read

  defp authorize_transaction(connection, identity, capability) do
    Store.configure_transaction(connection)

    case Store.lock_authority(connection, identity) do
      {:ok, profile} ->
        if is_nil(capability) or capability in profile.capabilities,
          do: %{display_name: profile.display_name},
          else: Postgrex.rollback(connection, {:error, :capability_denied})

      {:error, reason} ->
        Postgrex.rollback(connection, {:error, reason})
    end
  end

  defp participant_capabilities_transaction(connection, identity) do
    Store.configure_transaction(connection)

    case Store.lock_authority(connection, identity, true) do
      {:ok, profile} -> capability_state(connection, identity, profile)
      {:error, reason} -> Postgrex.rollback(connection, {:error, reason})
    end
  end

  defp capability_state(connection, identity, profile) do
    participants =
      connection
      |> Postgrex.query!(
        SQL.list_participant_capabilities(),
        Store.episode_params(identity.episode)
      )
      |> Map.fetch!(:rows)
      |> Map.new(fn [participant_id, _role, capabilities] ->
        {UUID.load!(participant_id), Store.ordered_capabilities(capabilities)}
      end)

    %{
      capabilities: Store.ordered_capabilities(profile.capabilities),
      participant_capabilities: participants
    }
  end
end
