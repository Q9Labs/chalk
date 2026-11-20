defmodule ChalkSync.Obs.Violation do
  @moduledoc "Raised in closed mode when a call does not match the registry."
  defexception problems: []

  @impl true
  def message(%{problems: problems}), do: "obs: " <> Enum.join(problems, "; ")
end
