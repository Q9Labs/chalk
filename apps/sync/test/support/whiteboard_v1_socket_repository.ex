defmodule ChalkSync.WhiteboardV1.SocketCase.Repository do
  @moduledoc "Stub repository the socket tests install through app env."

  def connect(identity) do
    if hook = Process.get(:whiteboard_connect_hook), do: hook.()

    {:ok,
     %{
       capabilities: Process.get(:current_capabilities, identity.capabilities),
       participant_capabilities: identity.capabilities,
       scene_id: "10000000-0000-4000-8000-000000000001",
       revision: 4,
       can_draw: true,
       is_presenting: false
     }}
  end

  # The Episode's poller runs this, so the answer and the read log live in app env.
  def episode_access(episode) do
    if test = Application.get_env(:chalk_sync, :whiteboard_test_reads),
      do: send(test, {:episode_access_read, episode})

    Process.sleep(Application.get_env(:chalk_sync, :whiteboard_test_read_delay_ms, 0))

    Application.get_env(
      :chalk_sync,
      :whiteboard_test_access,
      {:ok,
       %{
         status: "active",
         participants: %{
           {"20000000-0000-4000-8000-000000000002", 1} => "active",
           {"60000000-0000-4000-8000-000000000006", 1} => "active"
         }
       }}
    )
  end

  def commit_update(_identity, operation) do
    send(self(), {:committed_update, operation})

    {:ok,
     %{
       operation_id: operation.operation_id,
       scene_id: operation.scene_id,
       revision: 5,
       outcome: Process.get(:whiteboard_commit_outcome, :committed),
       elements: Process.get(:whiteboard_committed_elements, operation.elements)
     }}
  end

  def snapshot(_identity) do
    Process.get(:whiteboard_snapshot_failure) ||
      {:ok,
       %{
         scene_id: "10000000-0000-4000-8000-000000000001",
         revision: 4,
         elements: Process.get(:whiteboard_snapshot_elements, []),
         app_state: nil
       }}
  end

  def draw_access(_identity) do
    Process.get(:whiteboard_draw_access) ||
      {:ok,
       %{
         draw_policy: "hosts",
         can_draw: false,
         capabilities: ["drawWhiteboard"],
         grants: []
       }}
  end

  def set_draw_policy(_identity, _operation) do
    Process.get(:whiteboard_draw_policy_failure)
  end

  def read_after(_identity, scene_id, 4) do
    {:ok,
     Process.get(:whiteboard_events_after_four) ||
       [
         %{
           type: :presentation,
           operation_id: "whiteboard-presentation-0001",
           scene_id: scene_id,
           revision: 5,
           presenting: true
         }
       ]}
  end
end
