defmodule ChalkSync.Fanout.PostgresNotifications do
  @moduledoc """
  Disposable PostgreSQL committed-head hints for node-local coordinators.

  Notifications never carry event payloads and are not required for
  correctness. A reconnect or dropped hint is healed by each coordinator's
  periodic authoritative recovery read.
  """

  use GenServer

  require Logger

  alias ChalkSync.Chat
  alias ChalkSync.Database
  alias ChalkSync.Episodes.Coordinator
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Telemetry
  alias ChalkSync.UUID

  @channel "chalk_sync_heads"
  @collaboration_channels [
    "chalk_collaboration_heads",
    "chalk_collaboration_transient"
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

    {:ok, notifications} =
      Postgrex.Notifications.start_link(Keyword.put(connection_options, :auto_reconnect, true))

    {:ok, listen_ref} = Postgrex.Notifications.listen(notifications, @channel)

    collaboration_refs =
      Map.new(@collaboration_channels, fn channel ->
        {:ok, reference} = Postgrex.Notifications.listen(notifications, channel)
        {reference, channel}
      end)

    {:ok,
     %{
       notifications: notifications,
       listen_ref: listen_ref,
       collaboration_refs: collaboration_refs,
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
      {:ok, episode, revision} ->
        Telemetry.execute([:fanout, :notification], %{}, %{outcome: :valid})
        Coordinator.hint(episode, revision)

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
        %{notifications: notifications, collaboration_refs: collaboration_refs} = state
      )
      when channel in @collaboration_channels and is_map_key(collaboration_refs, listen_ref) and
             :erlang.map_get(listen_ref, collaboration_refs) == channel do
    case Chat.handle_fanout_notification(channel, payload) do
      :ok ->
        {:noreply,
         %{
           state
           | received_count: state.received_count + 1,
             last_received_at_ms: System.monotonic_time(:millisecond)
         }}

      {:error, :invalid_payload} ->
        Logger.warning("discarded malformed space-action notification")
        {:noreply, %{state | malformed_count: state.malformed_count + 1}}
    end
  end

  defp parse_payload(payload) do
    with [tenant_id, space_id, episode_id, encoded_revision] <- String.split(payload, ":"),
         {:ok, _tenant} <- UUID.dump(tenant_id),
         {:ok, _space} <- UUID.dump(space_id),
         {:ok, _episode} <- UUID.dump(episode_id),
         {revision, ""} when revision >= 0 <- Integer.parse(encoded_revision) do
      {:ok,
       %EpisodeKey{
         tenant_id: String.downcase(tenant_id),
         space_id: String.downcase(space_id),
         episode_id: String.downcase(episode_id)
       }, revision}
    else
      _ -> :error
    end
  end
end
