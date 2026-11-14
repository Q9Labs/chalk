defmodule ChalkSync.Operations.Probe.Database do
  @moduledoc """
  Database readiness: role, schema, durability settings, synchronous standby and lifecycle lag.
  """

  alias ChalkSync.Database
  alias ChalkSync.Operations.Probe.Database.Queries
  alias ChalkSync.Operations.Probe.Report
  alias ChalkSync.UUID

  @lifecycle_lag_limit_ms 30_000
  @query_timeout_ms 1_000

  def database_observations do
    connection = Database.connection_for(:readiness)

    with {:ok,
          %{
            rows: [
              [
                in_recovery,
                synchronous_commit,
                standby_names,
                server_version_num,
                fsync,
                full_page_writes,
                data_checksums
              ]
            ]
          }} <-
           database_query(connection, :role, Queries.role_query()),
         {:ok, %{rows: [[migration_version]]}} <-
           database_query(connection, :migration, Queries.migration_query()),
         {:ok,
          %{
            rows: [
              [
                pending_age_ms,
                retention_cleanup_lag_ms,
                pending,
                due,
                retrying,
                attempts,
                code,
                due_id,
                due_kind,
                due_at,
                due_attempts
              ]
            ]
          }} <-
           database_query(connection, :pending_age, Queries.pending_age_query()),
         {:ok, %{rows: [[synchronous_standbys, wal_lag_bytes]]}} <-
           database_query(connection, :replication, Queries.replication_query()) do
      {:ok,
       %{
         writable_primary: not in_recovery,
         migration_version: migration_version,
         synchronous_commit: synchronous_commit,
         server_version_num: server_version_num,
         fsync: fsync,
         full_page_writes: full_page_writes,
         data_checksums: data_checksums,
         synchronous_standby_names_configured: String.trim(standby_names) != "",
         synchronous_standbys: synchronous_standbys,
         wal_lag_bytes: wal_lag_bytes,
         synchronous_standby_requirement: synchronous_standby_requirement(),
         oldest_pending_lifecycle_intent_ms: pending_age_ms,
         lifecycle_intents: %{
           pending: pending,
           due: due,
           retrying: retrying,
           oldest_attempt_count: attempts,
           oldest_error_code: public_lifecycle_error_code(code)
         },
         retention_cleanup_lag_ms: retention_cleanup_lag_ms
       }, oldest_due_observation(due_id, due_kind, due_at, due_attempts)}
    else
      _error -> {:error, :database_unavailable}
    end
  end

  defp database_query(connection, stage, query) do
    case Postgrex.query(connection, query, [], timeout: @query_timeout_ms) do
      {:error, error} = result ->
        record_database_query_failure(stage, database_error_attributes(error))
        result

      result ->
        result
    end
  rescue
    exception ->
      record_database_query_failure(stage, database_error_attributes(exception))
      reraise exception, __STACKTRACE__
  catch
    :exit, reason ->
      record_database_query_failure(stage, %{error_class: "exit"})
      exit(reason)
  end

  defp record_database_query_failure(stage, attributes) do
    Report.record_failure(
      :database_query,
      :database_unavailable,
      Map.put(attributes, :query_stage, Atom.to_string(stage))
    )
  end

  defp database_error_attributes(%Postgrex.Error{postgres: %{pg_code: sqlstate}}) do
    attributes = %{error_class: "Postgrex.Error"}

    if is_binary(sqlstate) and Regex.match?(~r/\A[0-9A-Z]{5}\z/, sqlstate),
      do: Map.put(attributes, :sqlstate, sqlstate),
      else: attributes
  end

  defp database_error_attributes(%{__struct__: error_class}),
    do: %{error_class: inspect(error_class)}

  defp database_error_attributes(_error), do: %{error_class: "unknown"}

  def validate_observed_database(database, oldest_due) do
    case validate_database(database) do
      {:error, reason} = error ->
        measurements =
          database
          |> Map.delete(:lifecycle_intents)
          |> Map.merge(%{
            lifecycle_pending: database.lifecycle_intents.pending,
            lifecycle_due: database.lifecycle_intents.due,
            lifecycle_retrying: database.lifecycle_intents.retrying,
            lifecycle_lag_limit_ms: @lifecycle_lag_limit_ms,
            minimum_migration:
              Application.fetch_env!(:chalk_sync, :minimum_compatible_sync_migration),
            max_wal_lag_bytes: Application.get_env(:chalk_sync, :max_synchronous_wal_lag_bytes, 0)
          })

        if reason == :lifecycle_intent_lag do
          Report.record_failure(:database_validation, reason, Map.merge(measurements, oldest_due))
          {:error, reason, %{database: database}}
        else
          Report.record_failure(:database_validation, reason, measurements)
          error
        end

      result ->
        result
    end
  end

  defp oldest_due_observation(nil, _kind, _due_at, _attempts),
    do: %{oldest_due_intent: "none"}

  defp oldest_due_observation(id, kind, due_at, attempts) do
    %{
      oldest_due_intent_id: UUID.load!(id),
      oldest_due_intent_kind: kind,
      oldest_due_intent_due_at: DateTime.to_iso8601(due_at),
      oldest_due_intent_attempts: attempts
    }
  end

  defp public_lifecycle_error_code(nil), do: nil

  defp public_lifecycle_error_code(code)
       when code in ~w(dependency_unavailable overloaded decision_unavailable episode_not_found
                      lifecycle_intent_not_found invalid_state admission_request_not_found
                      participant_not_found invalid_lifecycle_intent stale_participant_generation
                      invalid_lifecycle_transition episode_ending recording_in_progress),
       do: code

  defp public_lifecycle_error_code(_code), do: "other"

  @doc false
  def validate_database(observations) do
    minimum_migration =
      Application.fetch_env!(:chalk_sync, :minimum_compatible_sync_migration)

    require_standby? = Application.get_env(:chalk_sync, :require_synchronous_standby, false)
    max_wal_lag = Application.get_env(:chalk_sync, :max_synchronous_wal_lag_bytes, 0)

    case validate_primary_database(observations, minimum_migration) do
      :ok -> validate_synchronous_standby(observations, require_standby?, max_wal_lag)
      error -> error
    end
  end

  defp validate_primary_database(observations, minimum_migration) do
    with :ok <- validate_primary_role_and_schema(observations, minimum_migration),
         :ok <- validate_durability_settings(observations) do
      validate_lifecycle_lag(observations)
    end
  end

  defp validate_primary_role_and_schema(observations, minimum_migration) do
    cond do
      not observations.writable_primary ->
        {:error, :database_not_writable_primary}

      observations.migration_version < minimum_migration ->
        {:error, :incompatible_database_migration}

      observations.server_version_num < 180_000 ->
        {:error, :unsupported_postgres_version}

      true ->
        :ok
    end
  end

  defp validate_durability_settings(observations) do
    cond do
      observations.fsync != "on" or observations.full_page_writes != "on" or
          observations.data_checksums != "on" ->
        {:error, :unsafe_database_durability}

      observations.synchronous_commit not in ["on", "remote_apply"] ->
        {:error, :synchronous_commit_disabled}

      true ->
        :ok
    end
  end

  defp validate_lifecycle_lag(%{oldest_pending_lifecycle_intent_ms: age_ms})
       when age_ms >= @lifecycle_lag_limit_ms,
       do: {:error, :lifecycle_intent_lag}

  defp validate_lifecycle_lag(_observations), do: :ok

  defp validate_synchronous_standby(_observations, false, _max_wal_lag), do: :ok

  defp validate_synchronous_standby(observations, true, max_wal_lag) do
    cond do
      not observations.synchronous_standby_names_configured ->
        {:error, :synchronous_standby_not_configured}

      observations.synchronous_standbys < 1 ->
        {:error, :synchronous_standby_unavailable}

      observations.wal_lag_bytes > max_wal_lag ->
        {:error, :synchronous_standby_lag}

      true ->
        :ok
    end
  end

  @doc false
  @spec synchronous_standby_requirement() :: String.t()
  def synchronous_standby_requirement do
    require_standby? = Application.get_env(:chalk_sync, :require_synchronous_standby, false)

    cond do
      Application.get_env(:chalk_sync, :local_parity, false) and not require_standby? ->
        "disabled_local_parity"

      require_standby? ->
        "required"

      true ->
        "not_required"
    end
  end
end
