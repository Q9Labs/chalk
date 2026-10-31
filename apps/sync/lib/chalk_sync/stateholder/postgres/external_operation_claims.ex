defmodule ChalkSync.Stateholder.Postgres.ExternalOperationClaims do
  @moduledoc false

  alias ChalkSync.Database
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Postgres.ExternalOperationRecord
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationClaims, as: SQL
  alias ChalkSync.UUID

  @minimum_dispatch_lease_ttl_ms 30_000
  # 3s prepare-entry-leave transaction + 3s finalization transaction + 5s safety.
  @dispatch_lease_safety_margin_ms 11_000

  def dispatch_lease_ttl_ms do
    adapter_timeout_ms =
      Application.get_env(:chalk_sync, :external_operation_adapter_timeout_ms, 35_000)

    max(@minimum_dispatch_lease_ttl_ms, adapter_timeout_ms + @dispatch_lease_safety_margin_ms)
  end

  def claim_operations(connection, limit, excluded_episodes, episode_limit, owner_id) do
    owner_id = UUID.dump!(owner_id)

    leases =
      Postgrex.query!(
        connection,
        SQL.claim_dispatch_episodes(),
        [
          owner_id,
          Enum.map(excluded_episodes, &UUID.dump!/1),
          episode_limit,
          dispatch_lease_ttl_ms()
        ],
        timeout: 2_000
      ).rows
      |> Enum.map(fn [tenant_id, episode_id, lease_owner_id, fence] ->
        %{
          tenant_id: UUID.load!(tenant_id),
          episode_id: UUID.load!(episode_id),
          owner_id: UUID.load!(lease_owner_id),
          fence: fence
        }
      end)

    if leases == [] do
      []
    else
      claim_leased_operations(connection, limit, leases, owner_id)
    end
  end

  def claim_local_operations(connection, limit),
    do: claim_operation_rows(connection, SQL.claim_local_operations(), limit)

  def renew_dispatch_lease(
        %EpisodeKey{} = episode,
        %{owner_id: owner_id, fence: fence}
      )
      when is_binary(owner_id) and is_integer(fence) do
    params = [
      UUID.dump!(episode.tenant_id),
      UUID.dump!(episode.episode_id),
      UUID.dump!(owner_id),
      fence,
      dispatch_lease_ttl_ms()
    ]

    case Postgrex.query(
           Database.connection(episode),
           SQL.renew_dispatch_lease(),
           params,
           timeout: 2_000
         ) do
      {:ok, %{num_rows: 1}} -> :ok
      {:ok, %{num_rows: 0}} -> {:error, :dispatch_lease_lost}
      {:error, _reason} -> {:retryable, :dependency_unavailable}
    end
  rescue
    _exception -> {:retryable, :dependency_unavailable}
  catch
    :exit, _reason -> {:retryable, :dependency_unavailable}
  end

  def renew_dispatch_lease(_episode, _dispatch_lease),
    do: {:error, :dispatch_lease_lost}

  def release_dispatch_lease(
        %EpisodeKey{} = episode,
        %{owner_id: owner_id, fence: fence}
      )
      when is_binary(owner_id) and is_integer(fence) do
    Postgrex.query(
      Database.connection(episode),
      SQL.release_dispatch_lease(),
      [
        UUID.dump!(episode.tenant_id),
        UUID.dump!(episode.episode_id),
        UUID.dump!(owner_id),
        fence
      ],
      timeout: 2_000
    )

    :ok
  rescue
    _exception -> :ok
  catch
    :exit, _reason -> :ok
  end

  def release_dispatch_lease(_episode, _dispatch_lease), do: :ok

  defp claim_leased_operations(connection, limit, leases, owner_id) do
    lease_by_episode =
      Map.new(leases, fn lease ->
        {{lease.tenant_id, lease.episode_id}, %{owner_id: lease.owner_id, fence: lease.fence}}
      end)

    rows =
      Postgrex.query!(
        connection,
        SQL.claim_leased_operations(),
        [
          limit,
          Enum.map(leases, &UUID.dump!(&1.tenant_id)),
          Enum.map(leases, &UUID.dump!(&1.episode_id)),
          Enum.map(leases, & &1.fence),
          owner_id
        ],
        timeout: 2_000
      ).rows

    claimed_episodes =
      MapSet.new(rows, fn row ->
        {UUID.load!(Enum.at(row, 0)), UUID.load!(Enum.at(row, 2))}
      end)

    release_empty_leases(connection, leases, claimed_episodes, owner_id)

    Enum.map(rows, fn row ->
      operation = ExternalOperationRecord.from_row(row)
      tenant_id = UUID.load!(Enum.at(row, 0))
      episode_id = UUID.load!(Enum.at(row, 2))
      dispatch_lease = Map.fetch!(lease_by_episode, {tenant_id, episode_id})

      {
        %EpisodeKey{
          tenant_id: tenant_id,
          space_id: UUID.load!(Enum.at(row, 1)),
          episode_id: episode_id
        },
        %{operation | dispatch_lease: dispatch_lease}
      }
    end)
  end

  defp release_empty_leases(connection, leases, claimed_episodes, owner_id) do
    empty_leases =
      Enum.reject(leases, fn lease ->
        MapSet.member?(claimed_episodes, {lease.tenant_id, lease.episode_id})
      end)

    if empty_leases != [] do
      Postgrex.query!(
        connection,
        SQL.release_dispatch_leases(),
        [
          Enum.map(empty_leases, &UUID.dump!(&1.tenant_id)),
          Enum.map(empty_leases, &UUID.dump!(&1.episode_id)),
          Enum.map(empty_leases, & &1.fence),
          owner_id
        ],
        timeout: 2_000
      )
    end
  end

  defp claim_operation_rows(
         connection,
         query,
         limit,
         excluded_episodes \\ [],
         episode_limit \\ 64
       ) do
    params = [limit, Enum.map(excluded_episodes, &UUID.dump!/1), episode_limit]
    %{rows: rows} = Postgrex.query!(connection, query, params, timeout: 2_000)

    Enum.map(rows, fn row ->
      operation = ExternalOperationRecord.from_row(row)

      {%EpisodeKey{
         tenant_id: UUID.load!(Enum.at(row, 0)),
         space_id: UUID.load!(Enum.at(row, 1)),
         episode_id: UUID.load!(Enum.at(row, 2))
       }, operation}
    end)
  end

  def read_operation(%EpisodeKey{} = episode, external_operation_id)
      when is_binary(external_operation_id) do
    case UUID.dump(external_operation_id) do
      {:ok, id} -> read_operation_row(episode, id)
      :error -> :not_found
    end
  catch
    :exit, _reason -> {:retryable, :decision_unavailable}
  end

  defp read_operation_row(episode, id) do
    case Postgrex.query(
           Database.connection(episode, 1),
           SQL.read_operation(),
           Scope.episode(episode) ++ [id],
           timeout: 1_000
         ) do
      {:ok, %{rows: [row]}} -> {:ok, ExternalOperationRecord.from_row(row)}
      {:ok, %{rows: []}} -> :not_found
      {:error, _reason} -> {:retryable, :decision_unavailable}
    end
  end
end
