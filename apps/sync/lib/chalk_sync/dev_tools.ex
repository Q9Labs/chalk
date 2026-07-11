defmodule ChalkSync.DevTools do
  @moduledoc false

  alias ChalkSync.DevTools.TraceHub
  alias ChalkSync.Rooms.RoomServer

  def enabled?, do: Application.fetch_env!(:chalk_sync, :dev_tools)

  def restart_room(room_id) do
    case RoomServer.whereis(room_id) do
      nil ->
        :not_found

      pid ->
        TraceHub.record("room", "restart_requested", %{"room_id" => room_id})
        DynamicSupervisor.terminate_child(ChalkSync.Rooms.Supervisor, pid)
    end
  end
end
