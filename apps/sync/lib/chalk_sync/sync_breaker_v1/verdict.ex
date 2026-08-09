defmodule ChalkSync.SyncBreakerV1.Verdict do
  @moduledoc false

  def from_invariants(invariants, dependencies \\ [])
      when is_map(invariants) and is_list(dependencies) do
    invariants_hold? =
      map_size(invariants) > 0 and
        invariants |> Map.values() |> Enum.all?(&(&1 === true))

    dependencies_pass? = Enum.all?(dependencies, &pass?/1)
    if invariants_hold? and dependencies_pass?, do: "pass", else: "fail"
  end

  def pass?(%{"verdict" => "pass"}), do: true
  def pass?(_result), do: false
end
