defmodule ChalkSync.Fanout.PostgresNotifications do
  @moduledoc """
  Disposable PostgreSQL committed-head hints for node-local coordinators.

  Notifications never carry event payloads and are not required for
  correctness. A reconnect or dropped hint is healed by each coordinator's
  periodic authoritative recovery read.
  """

  use GenServer

  require Logger

  alias ChalkSync.Database
  alias ChalkSync.RoomActions
  alias ChalkSync.Sessions.Coordinator
  alias ChalkSync.Stateholder.SessionKey
  alias ChalkSync.Telemetry
  alias ChalkSync.UUID

  @channel "chalk_sync_heads"
  @room_action_channels [
    "chalk_room_action_heads",
    "chalk_room_action_transient"
  ]

  def start_link(options \\ []) do
    name = Keyword.get(options, :name, __MODULE__)
    GenServer.start_link(__MODULE__, options, name: name)
  end

  @spec health(GenServer.server()) :: map()
  def health(server \\ __MODULE__), do: GenServer.call(server, :health)

  @impl GenServer
  def init(options) do
    url =
      case Keyword.fetch(options, :url) do
        {:ok, configured_url} -> configured_url
        :error -> Application.fetch_env!(:chalk_sync, :database_url)
      end

    {:ok, connection_options} = Database.connection_options(url)
    {:ok, notifications} = Postgrex.Notifications.start_link(connection_options)
    {:ok, listen_ref} = Postgrex.Notifications.listen(notifications, @channel)

    room_action_refs =
      Map.new(@room_action_channels, fn channel ->
        {:ok, reference} = Postgrex.Notifications.listen(notifications, channel)
        {reference, channel}
      end)

    {:ok,
     %{
       notifications: notifications,
       listen_ref: listen_ref,
       room_action_refs: room_action_refs,
       received_count: 0,
       malformed_count: 0,
       last_received_at_ms: nil
     }}
  end

  @impl GenServer
  def handle_call(:health, _from, state) do
    {:reply, Map.take(state, [:received_count, :malformed_count, :last_received_at_ms]), state}
  end

  @impl GenServer
  def handle_info(
        {:notification, notifications, listen_ref, @channel, payload},
        %{notifications: notifications, listen_ref: listen_ref} = state
      ) do
    case parse_payload(payload) do
      {:ok, session, revision} ->
        Telemetry.execute([:fanout, :notification], %{}, %{outcome: :valid})
        Coordinator.hint(session, revision)

        {:noreply,
         %{
           state
           | received_count: state.received_count + 1,
             last_received_at_ms: System.monotonic_time(:millisecond)
         }}

      :error ->
        Telemetry.execute([:fanout, :notification], %{}, %{outcome: :malformed})
        Logger.warning("discarded malformed sync head notification")
        {:noreply, %{state | malformed_count: state.malformed_count + 1}}
    end
  end

  def handle_info(
        {:notification, notifications, listen_ref, channel, payload},
        %{notifications: notifications, room_action_refs: room_action_refs} = state
      )
      when channel in @room_action_channels and is_map_key(room_action_refs, listen_ref) and
             :erlang.map_get(listen_ref, room_action_refs) == channel do
    case RoomActions.handle_fanout_notification(channel, payload) do
      :ok ->
        {:noreply,
         %{
           state
           | received_count: state.received_count + 1,
             last_received_at_ms: System.monotonic_time(:millisecond)
         }}

      {:error, :invalid_payload} ->
        Logger.warning("discarded malformed room-action notification")
        {:noreply, %{state | malformed_count: state.malformed_count + 1}}
    end
  end

  defp parse_payload(payload) do
    with [tenant_id, room_id, session_id, encoded_revision] <- String.split(payload, ":"),
         {:ok, _tenant} <- UUID.dump(tenant_id),
         {:ok, _room} <- UUID.dump(room_id),
         {:ok, _session} <- UUID.dump(session_id),
         {revision, ""} when revision >= 0 <- Integer.parse(encoded_revision) do
      {:ok,
       %SessionKey{
         tenant_id: String.downcase(tenant_id),
         room_id: String.downcase(room_id),
         session_id: String.downcase(session_id)
       }, revision}
    else
      _ -> :error
    end
  end
end
