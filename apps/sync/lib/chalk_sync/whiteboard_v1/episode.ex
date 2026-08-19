defmodule ChalkSync.WhiteboardV1.Episode do
  @moduledoc "Whiteboard-v1 operation and snapshot framing over the durable repository."

  alias ChalkSync.Contract.GeneratedWhiteboardV1
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.WhiteboardV1.Multipart
  alias ChalkSync.WhiteboardV1.Repository

  @limits GeneratedWhiteboardV1.limits()
  @snapshot_page_items @limits["snapshotPageMaxItems"]
  @snapshot_page_bytes @limits["snapshotPageEncodedBytes"]
  @snapshot_max_pages @limits["snapshotMaxPages"]
  @snapshot_envelope_reserve_bytes 1_024

  def connect(%Identity{} = identity) do
    with {:ok, context} <- Repository.connect(identity) do
      {:ok,
       %{
         "type" => "welcome",
         "protocol" => "whiteboard-v1",
         "participant_id" => identity.participant_id,
         "participant_generation" => identity.participant_generation,
         "capabilities" => context.capabilities,
         "participant_capabilities" => context.participant_capabilities,
         "scene_id" => context.scene_id,
         "revision" => Integer.to_string(context.revision),
         "can_draw" => context.can_draw,
         "presenting" => context.is_presenting
       }}
    end
  end

  def submit_update(%Identity{} = identity, operation) do
    with {:ok, _validated_frames} <-
           Multipart.update_frames(%{
             "type" => "update",
             "operation_id" => operation.operation_id,
             "scene_id" => operation.scene_id,
             "revision" => "9223372036854775807",
             "elements" => operation.elements
           }),
         {:ok, commit} <- Repository.commit_update(identity, operation),
         {:ok, frames} <-
           Multipart.update_frames(%{
             "type" => "update",
             "operation_id" => commit.operation_id,
             "scene_id" => commit.scene_id,
             "revision" => Integer.to_string(commit.revision),
             "elements" => operation.elements
           }) do
      {:ok, commit_frame(commit), frames}
    end
  end

  def clear(%Identity{} = identity, operation) do
    with {:ok, commit} <- Repository.clear(identity, operation) do
      {:ok, commit_frame(commit),
       %{
         "type" => "reset_required",
         "scene_id" => commit.scene_id,
         "reason" => "scene_changed"
       }}
    end
  end

  def set_draw_permission(%Identity{} = identity, operation) do
    with {:ok, commit} <- Repository.set_draw_permission(identity, operation) do
      {:ok, commit_frame(commit),
       %{
         "type" => "permission_updated",
         "participant_id" => operation.participant_id,
         "can_draw" => operation.can_draw
       }}
    end
  end

  def set_presentation(%Identity{} = identity, operation) do
    with {:ok, commit} <- Repository.set_presentation(identity, operation) do
      {:ok, commit_frame(commit),
       %{
         "type" => "presentation_updated",
         "scene_id" => commit.scene_id,
         "revision" => Integer.to_string(commit.revision),
         "presenting" => commit.presenting
       }}
    end
  end

  def snapshot(%Identity{} = identity, request_id) do
    with {:ok, snapshot} <- Repository.snapshot(identity),
         {:ok, pages} <- pages(snapshot.elements),
         true <- length(pages) <= @snapshot_max_pages do
      {:ok,
       pages
       |> Enum.with_index()
       |> Enum.map(fn {elements, page} ->
         %{
           "type" => "snapshot_page",
           "request_id" => request_id,
           "scene_id" => snapshot.scene_id,
           "revision" => Integer.to_string(snapshot.revision),
           "page" => page,
           "page_count" => length(pages),
           "elements" => elements,
           "app_state" => snapshot.app_state
         }
       end)}
    else
      false -> {:error, :invalid_payload}
      other -> other
    end
  end

  def read_after(%Identity{} = identity, scene_id, revision, include_presentation \\ true) do
    with {:ok, events} <- Repository.read_after(identity, scene_id, revision),
         true <- length(events) <= @snapshot_page_items,
         true <- contiguous?(events, revision),
         {:ok, frames} <- replay_frames(events, include_presentation) do
      {:ok, frames}
    else
      false -> {:error, :cursor_reset_required}
      other -> other
    end
  end

  defp pages([]), do: {:ok, [[]]}

  defp pages(elements) do
    max_element_bytes = @snapshot_page_bytes - @snapshot_envelope_reserve_bytes

    result =
      Enum.reduce_while(elements, {:ok, [], [], 2}, fn element,
                                                       {:ok, completed, current, bytes} ->
        element_bytes = element |> JSON.encode!() |> byte_size()
        separator_bytes = if current == [], do: 0, else: 1

        cond do
          element_bytes + 2 > max_element_bytes ->
            {:halt, {:error, :invalid_payload}}

          length(current) >= @snapshot_page_items or
              bytes + separator_bytes + element_bytes > max_element_bytes ->
            {:cont, {:ok, [Enum.reverse(current) | completed], [element], element_bytes + 2}}

          true ->
            {:cont,
             {:ok, completed, [element | current], bytes + separator_bytes + element_bytes}}
        end
      end)

    case result do
      {:ok, completed, current, _bytes} ->
        {:ok, Enum.reverse([Enum.reverse(current) | completed])}

      failure ->
        failure
    end
  end

  defp commit_frame(commit) do
    %{
      "type" => "commit",
      "operation_id" => commit.operation_id,
      "outcome" => Atom.to_string(commit.outcome),
      "scene_id" => commit.scene_id,
      "revision" => Integer.to_string(commit.revision)
    }
  end

  defp replay_frames(events, include_presentation) do
    Enum.reduce_while(events, {:ok, []}, fn event, {:ok, frames} ->
      result = event_frames(event, include_presentation)

      case result do
        {:ok, event_frames} -> {:cont, {:ok, frames ++ event_frames}}
        failure -> {:halt, failure}
      end
    end)
  end

  defp event_frames(%{type: :update} = update, _include_presentation) do
    Multipart.update_frames(%{
      "type" => "update",
      "operation_id" => update.operation_id,
      "scene_id" => update.scene_id,
      "revision" => Integer.to_string(update.revision),
      "elements" => update.elements
    })
  end

  defp event_frames(%{type: :presentation} = presentation, true) do
    {:ok,
     [
       %{
         "type" => "presentation_updated",
         "scene_id" => presentation.scene_id,
         "revision" => Integer.to_string(presentation.revision),
         "presenting" => presentation.presenting
       }
     ]}
  end

  defp event_frames(%{type: :presentation}, false), do: {:ok, []}

  defp contiguous?(events, revision) do
    events
    |> Enum.map(& &1.revision)
    |> Enum.with_index(revision + 1)
    |> Enum.all?(fn {actual, expected} -> actual == expected end)
  end
end
