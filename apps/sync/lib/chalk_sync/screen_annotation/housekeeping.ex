defmodule ChalkSync.ScreenAnnotation.Housekeeping do
  @moduledoc "Bounded cleanup for elapsed leases, fading ink, draw requests and operation receipts."

  use GenServer

  alias ChalkSync.Database

  @interval_ms 15_000
  @batch 64
  @receipt_batch 512
  @now "(extract(epoch from statement_timestamp()) * 1000)::bigint"

  def start_link(_options), do: GenServer.start_link(__MODULE__, nil)

  @impl true
  def init(nil) do
    Process.send_after(self(), :sweep, @interval_ms)
    {:ok, nil}
  end

  @impl true
  def handle_info(:sweep, nil) do
    _ = sweep(Database.connection_for(:retention))
    Process.send_after(self(), :sweep, @interval_ms)
    {:noreply, nil}
  end

  def sweep(connection) do
    with {:ok, _} <- run(connection, elapsed_leases(), @batch),
         {:ok, _} <- run(connection, expired_content(), @batch),
         {:ok, _} <- run(connection, expired_receipts(), @receipt_batch) do
      :ok
    end
  end

  defp run(connection, sql, batch),
    do: Postgrex.query(connection, sql, [batch], log: nil, timeout: 1_000)

  defp elapsed_leases do
    """
    with elapsed as (
      select layer.layer_id
      from sync_screen_annotation_layers layer
      join sync_screen_share_leases lease
        on (lease.tenant_id, lease.space_id, lease.episode_id) = (layer.tenant_id, layer.space_id, layer.episode_id)
      where lease.renewed_until <= statement_timestamp()
      order by lease.renewed_until limit $1 for update of lease skip locked
    )
    delete from sync_screen_annotation_layers layer using elapsed where layer.layer_id = elapsed.layer_id
    """
  end

  defp expired_content do
    """
    with due as (
      select layer_id, marks, requests, last_change
      from sync_screen_annotation_layers
      where next_expiry_at_ms <= #{@now}
      order by next_expiry_at_ms limit $1 for update skip locked
    ), fresh as (
      select layer_id, retained_marks, retained_requests, least(next_mark, next_request) as next_expiry,
        case when (last_change->'mark'->>'expires_at_ms')::bigint <= #{@now} then null else last_change end as last_change
      from due
      cross join lateral (
        select coalesce(jsonb_object_agg(key, value), '{}') as retained_marks,
               min((value->>'expires_at_ms')::bigint) as next_mark
        from jsonb_each(marks) where value->>'expires_at_ms' is null or (value->>'expires_at_ms')::bigint > #{@now}
      ) live_marks
      cross join lateral (
        select coalesce(jsonb_object_agg(key, value), '{}') as retained_requests,
               min((value->>'expires_at_ms')::bigint) as next_request
        from jsonb_each(requests) where (value->>'expires_at_ms')::bigint > #{@now}
      ) live_requests
    )
    update sync_screen_annotation_layers layer
    set marks = fresh.retained_marks, requests = fresh.retained_requests,
        next_expiry_at_ms = fresh.next_expiry, last_change = fresh.last_change
    from fresh where layer.layer_id = fresh.layer_id
    """
  end

  defp expired_receipts do
    """
    with expired as (
      select ctid from sync_screen_annotation_receipts where expires_at_ms <= #{@now}
      order by expires_at_ms limit $1 for update skip locked
    )
    delete from sync_screen_annotation_receipts receipt using expired where receipt.ctid = expired.ctid
    """
  end
end
