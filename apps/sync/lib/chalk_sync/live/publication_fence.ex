defmodule ChalkSync.Live.PublicationFence do
  @moduledoc "Source-specific Postgres publication-fence checks."

  alias ChalkSync.Stateholder.SessionKey
  alias ChalkSync.UUID

  @sources [:microphone, :camera, :screen]

  @spec check(
          Postgrex.conn(),
          SessionKey.t(),
          String.t(),
          pos_integer(),
          atom(),
          String.t(),
          DateTime.t()
        ) :: :clear | :owned | {:fenced, String.t()} | {:error, atom()}
  def check(
        connection,
        session,
        participant_session_id,
        participant_generation,
        source,
        external_operation_id,
        now
      )
      when participant_generation > 0 and source in @sources do
    params = [
      UUID.dump!(session.tenant_id),
      UUID.dump!(session.session_id),
      UUID.dump!(participant_session_id),
      participant_generation,
      Atom.to_string(source),
      now
    ]

    case Postgrex.query(connection, query(), params, timeout: 1_000) do
      {:ok, %{rows: []}} ->
        :clear

      {:ok, %{rows: [[operation_id]]}} ->
        operation_id = UUID.load!(operation_id)
        if operation_id == external_operation_id, do: :owned, else: {:fenced, operation_id}

      {:error, _error} ->
        {:error, :dependency_unavailable}
    end
  end

  def check(_connection, _session, _participant, generation, _source, _operation, _now)
      when not is_integer(generation) or generation <= 0,
      do: {:error, :invalid_generation}

  def check(_connection, _session, _participant, _generation, _source, _operation, _now),
    do: {:error, :invalid_source}

  defp query do
    """
    select external_operation_id
    from sync_publication_fences
    where tenant_id = $1
      and session_id = $2
      and participant_session_id = $3
      and participant_generation = $4
      and source = $5
      and expires_at > $6
    """
  end
end
