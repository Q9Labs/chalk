defmodule ChalkSync.Transport.SocketWhiteboardV1.Observation do
  @moduledoc false

  alias ChalkSync.Obs
  alias ChalkSync.UUID

  def commit(state, commit) do
    emit(state, "board.sync_edit", commit["operation_id"], %{
      board_step: commit["outcome"],
      board_scene_id: commit["scene_id"],
      board_revision: commit["revision"]
    })
  end

  def refusal(state, operation_id, code) do
    emit(state, "board.sync_edit", operation_id, %{
      board_step: "refused",
      board_failure: Atom.to_string(code)
    })
  end

  def delivery(state, %{"type" => "update"} = frame), do: update(state, frame)

  def delivery(state, %{"type" => "update_part", "part" => part, "part_count" => count} = frame)
      when part == count - 1,
      do: update(state, frame)

  def delivery(_state, _frame), do: :ok

  defp update(state, frame) do
    emit(state, "board.sync_delivery", frame["operation_id"], %{
      board_step: "update",
      board_scene_id: frame["scene_id"],
      board_revision: frame["revision"]
    })
  end

  def snapshot(state, [first | _] = pages) do
    emit(state, "board.sync_snapshot", first["request_id"], %{
      board_step: "snapshot",
      board_scene_id: first["scene_id"],
      board_revision: first["revision"],
      board_element_count: Enum.reduce(pages, 0, &(length(&1["elements"]) + &2))
    })
  end

  # Legacy peers can supply opaque correlation strings. Do not copy arbitrary user text to telemetry.
  defp emit(%{identity: identity}, name, correlation, fields) do
    with {:ok, bytes} <- UUID.dump(correlation) do
      episode = identity.episode

      Obs.fact(
        name,
        Map.merge(fields, %{
          board_correlation_id: UUID.load!(bytes),
          tenant_id: episode.tenant_id,
          space_id: episode.space_id,
          episode_id: episode.episode_id,
          participant_id: identity.participant_id,
          generation: identity.participant_generation
        })
      )
    end

    :ok
  end
end
