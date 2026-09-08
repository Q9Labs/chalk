defmodule ChalkSync.Stateholder.Postgres.SQL.Transaction do
  @moduledoc false

  def transaction_settings do
    """
    select
      set_config('lock_timeout', '750ms', true),
      set_config('statement_timeout', '2s', true),
      set_config('synchronous_commit', 'on', true)
    """
  end

  def effective_synchronous_commit,
    do: "select current_setting('synchronous_commit')"
end
