defmodule ChalkSync.WhiteboardV1.Reducer do
  @moduledoc "Pure Excalidraw 0.18.1 element merge used by whiteboard-v1."

  @spec merge([map()], [map()]) :: [map()]
  def merge(current, incoming) when is_list(current) and is_list(incoming) do
    current
    |> Map.new(&{&1["id"], &1})
    |> merge_incoming(incoming)
    |> Map.values()
    |> Enum.sort_by(&{&1["index"], &1["id"]})
  end

  defp merge_incoming(elements, incoming) do
    Enum.reduce(incoming, elements, &merge_candidate/2)
  end

  defp merge_candidate(candidate, merged) do
    existing = Map.get(merged, candidate["id"])

    if is_nil(existing) or wins?(candidate, existing),
      do: Map.put(merged, candidate["id"], candidate),
      else: merged
  end

  defp wins?(candidate, existing) do
    if candidate["version"] == existing["version"],
      do: candidate["version_nonce"] < existing["version_nonce"],
      else: candidate["version"] > existing["version"]
  end
end
