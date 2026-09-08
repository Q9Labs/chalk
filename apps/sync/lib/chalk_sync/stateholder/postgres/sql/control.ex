defmodule ChalkSync.Stateholder.Postgres.SQL.Control do
  @moduledoc false

  def notify_head,
    do: "select pg_notify('chalk_sync_heads', $1)"
end
