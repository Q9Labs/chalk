defmodule ChalkSync.Operations.Probe do
  @moduledoc false

  alias ChalkSync.Database
  alias ChalkSync.Fanout.PostgresNotifications
  alias ChalkSync.LifecycleConsumer
  alias ChalkSync.Retention.Scheduler, as: RetentionScheduler
  alias ChalkSync.Stateholder.SessionKey

  @query_timeout_ms 1_000

  @spec run(keyword()) :: {:ok, map()} | {:error, atom()}
  def run(options \\ []) do
    boot? = Keyword.get(options, :boot?, false)

    with :ok <- production_modules(),
         {:ok, database} <- database_observations(),
         :ok <- validate_database(database),
         {:ok, processes} <- process_observations(boot?) do
      {:ok, %{database: database, processes: processes}}
    end
  rescue
    _exception -> {:error, :probe_failed}
  catch
    :exit, _reason -> {:error, :probe_failed}
  end

  defp production_modules do
    adapter = Application.fetch_env!(:chalk_sync, :stateholder)
    verifier = Application.fetch_env!(:chalk_sync, :token_verifier)
    require_auth? = Application.get_env(:chalk_sync, :require_production_auth, false)

    cond do
      adapter != ChalkSync.Stateholder.Postgres ->
        {:error, :non_production_stateholder}

      require_auth? and verifier == ChalkSync.Auth.DevTokenVerifier ->
        {:error, :development_token_verifier}

      require_auth? and
          (not Code.ensure_loaded?(verifier) or not function_exported?(verifier, :verify, 1)) ->
        {:error, :invalid_token_verifier}

      true ->
        :ok
    end
  end

  defp database_observations do
    connection = Database.connection(readiness_session())

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
           Postgrex.query(connection, role_query(), [], timeout: @query_timeout_ms),
         {:ok, %{rows: [[migration_version]]}} <-
           Postgrex.query(connection, migration_query(), [], timeout: @query_timeout_ms),
         {:ok, %{rows: [[pending_age_ms, retention_cleanup_lag_ms]]}} <-
           Postgrex.query(connection, pending_age_query(), [], timeout: @query_timeout_ms),
         {:ok, %{rows: [[synchronous_standbys, wal_lag_bytes]]}} <-
           Postgrex.query(connection, replication_query(), [], timeout: @query_timeout_ms) do
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
         oldest_pending_lifecycle_intent_ms: pending_age_ms,
         retention_cleanup_lag_ms: retention_cleanup_lag_ms
       }}
    else
      _error -> {:error, :database_unavailable}
    end
  end

  @doc false
  def validate_database(observations) do
    required_migration = Application.fetch_env!(:chalk_sync, :required_sync_migration)
    require_standby? = Application.get_env(:chalk_sync, :require_synchronous_standby, false)
    max_wal_lag = Application.get_env(:chalk_sync, :max_synchronous_wal_lag_bytes, 0)

    case validate_primary_database(observations, required_migration) do
      :ok -> validate_synchronous_standby(observations, require_standby?, max_wal_lag)
      error -> error
    end
  end

  defp validate_primary_database(observations, required_migration) do
    with :ok <- validate_primary_role_and_schema(observations, required_migration),
         :ok <- validate_durability_settings(observations) do
      validate_lifecycle_lag(observations)
    end
  end

  defp validate_primary_role_and_schema(observations, required_migration) do
    cond do
      not observations.writable_primary ->
        {:error, :database_not_writable_primary}

      observations.migration_version != required_migration ->
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
       when age_ms >= 30_000,
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

  defp process_observations(boot?) do
    with true <- alive?(ChalkSync.Sessions.Supervisor),
         true <- alive?(ChalkSync.CommandTaskSupervisor),
         true <- alive?(ChalkSync.Sessions.CommandAdmission),
         true <- alive?(PostgresNotifications),
         true <- alive?(LifecycleConsumer),
         true <- alive?(RetentionScheduler),
         {:ok, fanout} <- safe_health(PostgresNotifications),
         {:ok, lifecycle} <- safe_health(LifecycleConsumer),
         {:ok, retention} <- safe_health(RetentionScheduler),
         :ok <- validate_lifecycle_health(lifecycle, boot?) do
      {:ok,
       %{
         coordinator_supervisor: "ok",
         command_admission: "ok",
         notification_listener: "ok",
         notification_count: fanout.received_count,
         lifecycle_consumer: "ok",
         lifecycle_consecutive_failures: lifecycle.consecutive_failures,
         retention_cleanup: retention.status,
         retention_cleanup_consecutive_failures: retention.consecutive_failures
       }}
    else
      _error -> {:error, :required_process_unavailable}
    end
  end

  defp validate_lifecycle_health(_health, true), do: :ok

  defp validate_lifecycle_health(health, false) do
    now = System.monotonic_time(:millisecond)

    cond do
      health.consecutive_failures >= 2 -> {:error, :lifecycle_consumer_unavailable}
      is_nil(health.last_success_at_ms) -> {:error, :lifecycle_consumer_initializing}
      now - health.last_success_at_ms > 2_000 -> {:error, :lifecycle_consumer_stale}
      true -> :ok
    end
  end

  defp safe_health(PostgresNotifications) do
    {:ok, PostgresNotifications.health()}
  catch
    :exit, _reason -> {:error, :notification_listener_unavailable}
  end

  defp safe_health(LifecycleConsumer) do
    {:ok, LifecycleConsumer.health()}
  catch
    :exit, _reason -> {:error, :lifecycle_consumer_unavailable}
  end

  defp safe_health(RetentionScheduler) do
    {:ok, RetentionScheduler.health()}
  catch
    :exit, _reason -> {:error, :retention_cleanup_unavailable}
  end

  defp alive?(name) when is_atom(name), do: is_pid(Process.whereis(name))

  defp readiness_session do
    %SessionKey{tenant_id: "readiness", room_id: "readiness", session_id: "readiness"}
  end

  defp role_query do
    """
    select
      pg_is_in_recovery(),
      current_setting('synchronous_commit'),
      current_setting('synchronous_standby_names'),
      current_setting('server_version_num')::integer,
      current_setting('fsync'),
      current_setting('full_page_writes'),
      current_setting('data_checksums')
    """
  end

  defp migration_query do
    """
    select coalesce(max(version_id), 0)
    from (
      select distinct on (version_id) version_id, is_applied
      from goose_db_version
      order by version_id, id desc
    ) latest
    where is_applied
    """
  end

  defp pending_age_query do
    """
    select
      (
        select coalesce(
          (extract(epoch from (now() - min(created_at))) * 1000)::bigint,
          0
        )
        from sync_lifecycle_intents
        where status = 'pending'
      ),
      (
        select coalesce(
          (extract(epoch from (now() - min(session.ended_at) - interval '7 days')) * 1000)::bigint,
          0
        )
        from room_sessions session
        join sync_session_control control
          on control.tenant_id = session.tenant_id
          and control.room_id = session.room_id
          and control.session_id = session.id
        where session.status = 'ended'
          and session.ended_at <= now() - interval '7 days'
          and control.retention_cleaned_at is null
      )
    """
  end

  defp replication_query do
    """
    select
      count(*)::bigint,
      coalesce(max(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)), 0)::bigint
    from pg_stat_replication
    where state = 'streaming' and sync_state in ('sync', 'quorum')
    """
  end
end
