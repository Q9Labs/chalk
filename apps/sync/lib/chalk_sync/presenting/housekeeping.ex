defmodule ChalkSync.Presenting.Housekeeping do
  @moduledoc "Bounded cleanup for expired Stage Document operation receipts."

  use GenServer

  alias ChalkSync.Database

  @interval_ms 15_000
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
    case Postgrex.query(connection, expired_receipts(), [@receipt_batch],
           log: nil,
           timeout: 1_000
         ) do
      {:ok, _} -> :ok
      failure -> failure
    end
  end

  defp expired_receipts do
    """
    with expired as (
      select ctid from sync_presenting_receipts where expires_at_ms <= #{@now}
      order by expires_at_ms limit $1 for update skip locked
    )
    delete from sync_presenting_receipts receipt using expired where receipt.ctid = expired.ctid
    """
  end
end
