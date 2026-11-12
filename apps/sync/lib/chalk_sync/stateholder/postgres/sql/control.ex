defmodule ChalkSync.Stateholder.Postgres.SQL.Control do
  @moduledoc false

  @head_channel "chalk_sync_heads"

  def head_channel, do: @head_channel

  def notify_head,
    do: "select pg_notify('#{@head_channel}', $1)"
end
