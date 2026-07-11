defmodule ChalkSync.DevTools do
  @moduledoc false

  def enabled?, do: Application.fetch_env!(:chalk_sync, :dev_tools)
end
