defmodule ChalkSync.WhiteboardV1.PostgresRepository.Store do
  @moduledoc """
  Shared transaction, authority, scene lookup, receipt and notification steps of the whiteboard repository.
  """

  alias ChalkSync.Database
  alias ChalkSync.Database.TransactionSettings
  alias ChalkSync.UUID
  alias ChalkSync.WhiteboardV1.Fanout
  alias ChalkSync.WhiteboardV1.SQL

  @doc false
  # A bounded category for close evidence; the error itself can carry query text and values.
  def storage_failure(%DBConnection.ConnectionError{reason: :queue_timeout}), do: "queue_timeout"
  def storage_failure(%DBConnection.ConnectionError{}), do: "connection"
  def storage_failure(%Postgrex.Error{postgres: %{code: :query_canceled}}), do: "timeout"
  def storage_failure(%Postgrex.Error{}), do: "postgres"
  def storage_failure(_error), do: "unknown"


  def transaction(identity, callback) do
    connection = Database.connection(identity.episode)

    case Postgrex.transaction(connection, &run_transaction(&1, callback)) do
      {:ok, result} ->
        result

      {:error, {:domain, failure}} ->
        failure

      {:error, %Postgrex.Error{postgres: %{code: code}}}
      when code in [:lock_not_available, :query_canceled] ->
        {:retryable, :overloaded}

      {:error, _error} ->
        {:retryable, :storage_unavailable}
    end
  end


  defp run_transaction(transaction, callback) do
    Postgrex.query!(transaction, TransactionSettings.sql(:default), [])

    case callback.(transaction) do
      {:ok, _result} = success -> success
      failure -> Postgrex.rollback(transaction, {:domain, failure})
    end
  end


  def authority(connection, identity) do
    params =
      context(identity) ++
        [uuid(identity.participant_id), identity.participant_generation]

    case Postgrex.query(connection, SQL.lock_authority(), params) do
      {:ok, %Postgrex.Result{rows: [[_role, capabilities, can_draw, draw_policy]]}} ->
        role_capabilities =
          Enum.filter(capabilities, &(&1 in ["drawWhiteboard", "manageWhiteboard"]))

        participant_capabilities =
          if can_draw,
            do: Enum.uniq(["drawWhiteboard" | role_capabilities]),
            else: role_capabilities -- ["drawWhiteboard"]

        {:ok,
         %{
           capabilities: role_capabilities,
           participant_capabilities: participant_capabilities,
           can_draw: can_draw,
           draw_policy: draw_policy
         }}

      {:ok, %Postgrex.Result{rows: []}} ->
        {:error, :permission_denied}

      {:error, _error} ->
        {:retryable, :storage_unavailable}
    end
  end


  def current_scene(connection, identity) do
    generated_scene_id = UUID.generate()

    with {:ok, _result} <-
           Postgrex.query(
             connection,
             SQL.ensure_scene(),
             context(identity) ++ [uuid(generated_scene_id)]
           ),
         {:ok,
          %Postgrex.Result{rows: [[scene_id, revision, app_state, is_presenting, presenter_id]]}} <-
           Postgrex.query(connection, SQL.lock_scene(), context(identity)) do
      {:ok,
       %{
         scene_id: UUID.load!(scene_id),
         revision: revision,
         app_state: app_state,
         is_presenting: is_presenting,
         presenter_id: presenter_id
       }}
    else
      {:ok, %Postgrex.Result{rows: []}} ->
        {:retryable, :storage_unavailable}

      {:error, _error} ->
        {:retryable, :storage_unavailable}
    end
  end


  def drawing_scene(connection, identity) do
    with {:ok, authority, scene} <- locked_scene(connection, identity),
         :ok <- require_capability(authority, "drawWhiteboard") do
      {:ok, scene}
    end
  end


  # A policy or per-person change commits while holding the scene lock, so the
  # rule and the policy are read again once this transaction holds it. The
  # first read takes the participant row lock first, which keeps the lock
  # order of every other write.
  def locked_scene(connection, identity) do
    with {:ok, _locked} <- authority(connection, identity),
         {:ok, scene} <- current_scene(connection, identity),
         {:ok, authority} <- authority(connection, identity) do
      {:ok, authority, scene}
    end
  end


  def receipt(connection, identity, operation_id, fingerprint) do
    params = [
      uuid(identity.episode.tenant_id),
      uuid(identity.episode.space_id),
      uuid(identity.participant_id),
      operation_id
    ]

    case Postgrex.query(connection, SQL.select_receipt(), params) do
      {:ok, %Postgrex.Result{rows: []}} ->
        :missing

      {:ok, %Postgrex.Result{rows: [[^fingerprint, scene_id, revision, event_presenting]]}} ->
        {:duplicate, UUID.load!(scene_id), revision, event_presenting}

      {:ok, %Postgrex.Result{rows: [_conflict]}} ->
        {:error, :operation_id_conflict}

      {:error, _error} ->
        {:retryable, :storage_unavailable}
    end
  end


  def insert_receipt(
         connection,
         identity,
         operation_id,
         fingerprint,
         operation_name,
         event
       ) do
    event_encoded_bytes =
      if event.elements, do: event.elements |> JSON.encode!() |> byte_size(), else: 0

    params =
      context(identity) ++
        [
          uuid(identity.participant_id),
          identity.participant_generation,
          operation_id,
          fingerprint,
          operation_name,
          uuid(event.scene_id),
          event.revision,
          event.elements,
          event.presenting,
          event_encoded_bytes
        ]

    case Postgrex.query(connection, SQL.insert_receipt(), params) do
      {:ok, _result} -> :ok
      {:error, _error} -> {:retryable, :storage_unavailable}
    end
  end


  def nullable_uuid(nil), do: nil
  def nullable_uuid(id), do: uuid(id)


  def notify_head(connection, identity, scene_id, revision) do
    payload =
      Enum.join(
        [
          identity.episode.tenant_id,
          identity.episode.space_id,
          identity.episode.episode_id,
          scene_id,
          revision
        ],
        ":"
      )

    case Postgrex.query(connection, SQL.notify_head(), [payload]) do
      {:ok, _result} -> :ok
      {:error, _error} -> {:retryable, :storage_unavailable}
    end
  end


  def notify_access(connection, identity) do
    case Postgrex.query(connection, SQL.notify_access(), [Fanout.access_payload(identity.episode)]) do
      {:ok, _result} -> :ok
      {:error, _error} -> {:retryable, :storage_unavailable}
    end
  end


  def require_capability(authority, capability) do
    if capability in authority.participant_capabilities,
      do: :ok,
      else: {:error, :permission_denied}
  end


  def current_scene?(scene, scene_id) do
    if scene.scene_id == scene_id, do: :ok, else: {:error, :stale_scene}
  end


  def commit(operation_id, outcome, scene_id, revision),
    do: %{
      operation_id: operation_id,
      outcome: outcome,
      scene_id: scene_id,
      revision: revision
    }


  def fingerprint(operation),
    do: :crypto.hash(:sha256, JSON.encode!(operation))


  def context(identity),
    do: [
      uuid(identity.episode.tenant_id),
      uuid(identity.episode.space_id),
      uuid(identity.episode.episode_id)
    ]


  def uuid(value), do: UUID.dump!(value)
end
