defmodule ChalkSync.Live.ScreenShareLease do
  @moduledoc "Postgres-backed single-screen-share lease coordination."

  alias ChalkSync.Stateholder.SessionKey
  alias ChalkSync.UUID

  @default_renewal_ms 10_000
  @default_hard_lifetime_ms 30_000
  @max_renewal_ms 30_000
  @max_hard_lifetime_ms 120_000
  @expiry_batch_limit 500

  @type lease :: %{
          lease_id: String.t(),
          owner_participant_session_id: String.t(),
          owner_generation: pos_integer(),
          lease_generation: pos_integer(),
          status: :active,
          acquired_at: DateTime.t(),
          renewed_until: DateTime.t(),
          hard_expires_at: DateTime.t()
        }

  @spec acquire(Postgrex.conn(), SessionKey.t(), String.t(), pos_integer(), keyword()) ::
          {:ok, lease()}
          | {:error, :screen_share_in_use | :invalid_lease_bounds | :dependency_unavailable}
  def acquire(connection, session, owner_participant_session_id, owner_generation, options \\ [])
      when owner_generation > 0 do
    now = Keyword.get(options, :now, DateTime.utc_now())
    renewal_ms = Keyword.get(options, :renewal_ms, @default_renewal_ms)
    hard_lifetime_ms = Keyword.get(options, :hard_lifetime_ms, @default_hard_lifetime_ms)

    with :ok <- valid_bounds(renewal_ms, hard_lifetime_ms) do
      lease_id = Keyword.get(options, :lease_id, UUID.generate())
      renewed_until = DateTime.add(now, renewal_ms, :millisecond)
      hard_expires_at = DateTime.add(now, hard_lifetime_ms, :millisecond)

      params = [
        UUID.dump!(session.tenant_id),
        UUID.dump!(session.room_id),
        UUID.dump!(session.session_id),
        UUID.dump!(lease_id),
        UUID.dump!(owner_participant_session_id),
        owner_generation,
        now,
        renewed_until,
        hard_expires_at
      ]

      case Postgrex.query(connection, acquire_query(), params, timeout: 1_000) do
        {:ok, %{rows: [row]}} -> {:ok, load(row)}
        {:ok, %{rows: []}} -> {:error, :screen_share_in_use}
        {:error, _error} -> {:error, :dependency_unavailable}
      end
    end
  end

  @spec renew(Postgrex.conn(), SessionKey.t(), lease(), keyword()) ::
          {:ok, lease()}
          | {:error, :lease_expired | :invalid_lease_bounds | :dependency_unavailable}
  def renew(connection, session, lease, options \\ []) do
    now = Keyword.get(options, :now, DateTime.utc_now())
    renewal_ms = Keyword.get(options, :renewal_ms, @default_renewal_ms)

    with :ok <- valid_renewal(renewal_ms) do
      requested_until = DateTime.add(now, renewal_ms, :millisecond)

      params = [
        UUID.dump!(session.tenant_id),
        UUID.dump!(session.session_id),
        UUID.dump!(lease.lease_id),
        lease.lease_generation,
        UUID.dump!(lease.owner_participant_session_id),
        lease.owner_generation,
        now,
        requested_until
      ]

      case Postgrex.query(connection, renew_query(), params, timeout: 1_000) do
        {:ok, %{rows: [row]}} -> {:ok, load(row)}
        {:ok, %{rows: []}} -> {:error, :lease_expired}
        {:error, _error} -> {:error, :dependency_unavailable}
      end
    end
  end

  @spec release(Postgrex.conn(), SessionKey.t(), lease()) ::
          :ok | {:error, :lease_not_owned | :dependency_unavailable}
  def release(connection, session, lease) do
    params = [
      UUID.dump!(session.tenant_id),
      UUID.dump!(session.session_id),
      UUID.dump!(lease.lease_id),
      lease.lease_generation,
      UUID.dump!(lease.owner_participant_session_id),
      lease.owner_generation
    ]

    case Postgrex.query(connection, release_query(), params, timeout: 1_000) do
      {:ok, %{num_rows: 1}} -> :ok
      {:ok, %{num_rows: 0}} -> {:error, :lease_not_owned}
      {:error, _error} -> {:error, :dependency_unavailable}
    end
  end

  @spec expire(Postgrex.conn(), DateTime.t(), pos_integer()) ::
          {:ok, non_neg_integer()} | {:error, :invalid_limit | :dependency_unavailable}
  def expire(connection, now, limit \\ @expiry_batch_limit)

  def expire(connection, now, limit) when limit in 1..@expiry_batch_limit do
    case Postgrex.query(connection, expire_query(), [now, limit], timeout: 1_000) do
      {:ok, %{num_rows: count}} -> {:ok, count}
      {:error, _error} -> {:error, :dependency_unavailable}
    end
  end

  def expire(_connection, _now, _limit), do: {:error, :invalid_limit}

  defp valid_bounds(renewal_ms, hard_lifetime_ms) do
    if renewal_ms in 1..@max_renewal_ms and hard_lifetime_ms in renewal_ms..@max_hard_lifetime_ms,
      do: :ok,
      else: {:error, :invalid_lease_bounds}
  end

  defp valid_renewal(renewal_ms) do
    if renewal_ms in 1..@max_renewal_ms, do: :ok, else: {:error, :invalid_lease_bounds}
  end

  defp load([
         lease_id,
         owner_participant_session_id,
         owner_generation,
         lease_generation,
         status,
         acquired_at,
         renewed_until,
         hard_expires_at
       ]) do
    %{
      lease_id: UUID.load!(lease_id),
      owner_participant_session_id: UUID.load!(owner_participant_session_id),
      owner_generation: owner_generation,
      lease_generation: lease_generation,
      status: String.to_existing_atom(status),
      acquired_at: acquired_at,
      renewed_until: renewed_until,
      hard_expires_at: hard_expires_at
    }
  end

  defp returning do
    """
    lease_id, owner_participant_session_id, owner_generation, lease_generation,
    status, acquired_at, renewed_until, hard_expires_at
    """
  end

  defp acquire_query do
    """
    insert into sync_screen_share_leases (
      tenant_id, room_id, session_id, lease_id, owner_participant_session_id,
      owner_generation, lease_generation, status, acquired_at, renewed_until, hard_expires_at
    ) values ($1, $2, $3, $4, $5, $6, 1, 'active', $7, $8, $9)
    on conflict (tenant_id, session_id) do update
    set room_id = excluded.room_id,
        lease_id = case when #{same_active_owner()} then sync_screen_share_leases.lease_id else excluded.lease_id end,
        owner_participant_session_id = case when #{same_active_owner()} then sync_screen_share_leases.owner_participant_session_id else excluded.owner_participant_session_id end,
        owner_generation = case when #{same_active_owner()} then sync_screen_share_leases.owner_generation else excluded.owner_generation end,
        lease_generation = case when #{same_active_owner()} then sync_screen_share_leases.lease_generation else sync_screen_share_leases.lease_generation + 1 end,
        status = 'active',
        acquired_at = case when #{same_active_owner()} then sync_screen_share_leases.acquired_at else excluded.acquired_at end,
        renewed_until = case when #{same_active_owner()} then greatest(sync_screen_share_leases.renewed_until, least(sync_screen_share_leases.hard_expires_at, excluded.renewed_until)) else excluded.renewed_until end,
        hard_expires_at = case when #{same_active_owner()} then sync_screen_share_leases.hard_expires_at else excluded.hard_expires_at end
    where least(sync_screen_share_leases.renewed_until, sync_screen_share_leases.hard_expires_at)
          <= excluded.acquired_at or #{same_active_owner()}
    returning #{returning()}
    """
  end

  defp same_active_owner do
    """
    sync_screen_share_leases.owner_participant_session_id = excluded.owner_participant_session_id
    and sync_screen_share_leases.owner_generation = excluded.owner_generation
    and least(sync_screen_share_leases.renewed_until, sync_screen_share_leases.hard_expires_at) > excluded.acquired_at
    """
  end

  defp renew_query do
    """
    update sync_screen_share_leases
    set renewed_until = least(hard_expires_at, $8)
    where tenant_id = $1
      and session_id = $2
      and lease_id = $3
      and lease_generation = $4
      and owner_participant_session_id = $5
      and owner_generation = $6
      and renewed_until > $7
      and hard_expires_at > $7
    returning #{returning()}
    """
  end

  defp release_query do
    """
    delete from sync_screen_share_leases
    where tenant_id = $1
      and session_id = $2
      and lease_id = $3
      and lease_generation = $4
      and owner_participant_session_id = $5
      and owner_generation = $6
    """
  end

  defp expire_query do
    """
    delete from sync_screen_share_leases
    where ctid in (
      select ctid
      from sync_screen_share_leases
      where least(renewed_until, hard_expires_at) <= $1
      order by least(renewed_until, hard_expires_at), lease_id
      for update skip locked
      limit $2
    )
    """
  end
end
