defmodule ChalkSync.WhiteboardV1.Fanout do
  @moduledoc "Disposable local and Postgres whiteboard-v1 durable-head/transient fan-out."

  use GenServer

  require Logger

  alias ChalkSync.Contract.GeneratedWhiteboardV1
  alias ChalkSync.Database
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.UUID
  alias ChalkSync.WhiteboardV1.OriginAgreement
  alias ChalkSync.WhiteboardV1.Protocol
  alias ChalkSync.WhiteboardV1.ViewOrigin

  @head_channel "chalk_whiteboard_v1_heads"
  @cursor_channel "chalk_whiteboard_v1_cursors"
  @origin_channel "chalk_whiteboard_v1_origin_peers"
  @server __MODULE__
  @transient_notification_max_bytes GeneratedWhiteboardV1.metadata()["notifications"][
                                      "transientEnvelopeBytes"
                                    ]

  def start_link(options \\ []) do
    GenServer.start_link(__MODULE__, options, name: Keyword.get(options, :name, @server))
  end

  def subscribe(%EpisodeKey{} = episode), do: :pg.join(group(episode), self())
  def unsubscribe(%EpisodeKey{} = episode), do: :pg.leave(group(episode), self())

  def origin_agreement do
    if Application.fetch_env!(:chalk_sync, :stateholder) == ChalkSync.Stateholder.Postgres,
      do: GenServer.call(@server, :origin_agreement, 250),
      else: :ok
  catch
    :exit, _reason -> {:error, :view_origin_peer_unavailable}
  end

  def broadcast_local(%EpisodeKey{} = episode, frame) do
    Enum.each(:pg.get_members(group(episode)), &send(&1, {:whiteboard_v1_frame, frame}))
    :ok
  end

  def publish_cursor(%EpisodeKey{} = episode, frame, server \\ @server) do
    publish_transient(episode, frame, server)
  end

  def publish_transient(%EpisodeKey{} = episode, frame, server \\ @server) do
    broadcast_local(episode, frame)

    if Process.whereis(server),
      do: GenServer.cast(server, {:publish_transient, episode, frame}),
      else: :ok
  end

  @impl GenServer
  def init(options) do
    source_id = options |> Keyword.fetch!(:source_id) |> source_id()

    url =
      Keyword.get_lazy(options, :url, fn -> Application.fetch_env!(:chalk_sync, :database_url) end)

    {:ok, connection_options} = Database.connection_options(url)

    {:ok, notifications} =
      Postgrex.Notifications.start_link(Keyword.put(connection_options, :auto_reconnect, true))

    {:ok, head_ref} = Postgrex.Notifications.listen(notifications, @head_channel)
    {:ok, cursor_ref} = Postgrex.Notifications.listen(notifications, @cursor_channel)
    {:ok, origin_ref} = Postgrex.Notifications.listen(notifications, @origin_channel)
    {:ok, publisher} = Postgrex.start_link(connection_options)

    send(self(), :origin_probe)

    {:ok,
     %{
       notifications: notifications,
       head_ref: head_ref,
       cursor_ref: cursor_ref,
       origin_ref: origin_ref,
       agreement:
         OriginAgreement.new(ViewOrigin.fingerprint(), System.monotonic_time(:millisecond)),
       announcement_failed: false,
       publisher: publisher,
       source_id: source_id
     }}
  end

  @impl GenServer
  def handle_call(:origin_agreement, _from, state) do
    status =
      if state.announcement_failed,
        do: {:error, :view_origin_peer_unavailable},
        else: OriginAgreement.status(state.agreement, System.monotonic_time(:millisecond))

    {:reply, status, state}
  end

  @impl GenServer
  def handle_cast({:publish_transient, episode, frame}, state) do
    case encode_transient(episode, frame, state.source_id) do
      {:ok, payload} ->
        case Postgrex.query(state.publisher, "select pg_notify('#{@cursor_channel}', $1)", [
               payload
             ]) do
          {:ok, _result} ->
            :ok

          {:error, reason} ->
            Logger.warning("whiteboard transient notification failed: #{inspect(reason)}")
        end

      :too_large ->
        :ok
    end

    {:noreply, state}
  end

  @doc false
  def encode_transient(%EpisodeKey{} = episode, frame, source_id) do
    payload =
      JSON.encode!(%{
        "source_node" => source_id,
        "episode" => episode_map(episode),
        "frame" => frame
      })

    if byte_size(payload) <= @transient_notification_max_bytes,
      do: {:ok, payload},
      else: :too_large
  end

  @impl GenServer
  def handle_info(:origin_probe, state) do
    state = publish_origin(state, true)
    Process.send_after(self(), :origin_heartbeat, 2000)
    {:noreply, state}
  end

  def handle_info(:origin_heartbeat, state) do
    state = publish_origin(state, state.announcement_failed)
    Process.send_after(self(), :origin_heartbeat, 2000)
    {:noreply, state}
  end

  def handle_info(
        {:notification, notifications, ref, @origin_channel, payload},
        %{notifications: notifications, origin_ref: ref} = state
      ) do
    case JSON.decode(payload) do
      {:ok, %{"source" => source, "fingerprint" => fingerprint, "probe" => probe}}
      when is_binary(source) and byte_size(source) == 64 and source != state.source_id and
             is_binary(fingerprint) and byte_size(fingerprint) == 64 and is_boolean(probe) ->
        state = if probe, do: publish_origin(state, false), else: state

        agreement =
          OriginAgreement.observe(
            state.agreement,
            source,
            fingerprint,
            System.monotonic_time(:millisecond)
          )

        {:noreply, %{state | agreement: agreement}}

      _ ->
        {:noreply, state}
    end
  end

  def handle_info(
        {:notification, notifications, head_ref, @head_channel, payload},
        %{notifications: notifications, head_ref: head_ref} = state
      ) do
    case parse_head(payload) do
      {:ok, episode, scene_id, revision} ->
        Enum.each(
          :pg.get_members(group(episode)),
          &send(&1, {:whiteboard_v1_head, scene_id, revision})
        )

      :error ->
        Logger.warning("discarded malformed whiteboard-v1 head notification")
    end

    {:noreply, state}
  end

  def handle_info(
        {:notification, notifications, cursor_ref, @cursor_channel, payload},
        %{notifications: notifications, cursor_ref: cursor_ref} = state
      ) do
    with {:ok,
          %{
            "source_node" => source_node,
            "episode" => episode,
            "frame" => frame
          }} <- JSON.decode(payload),
         false <- source_node == state.source_id,
         {:ok, episode_key} <- episode_key(episode) do
      observe_origin(episode_key, frame)
      broadcast_local(episode_key, frame)
    else
      true -> :ok
      _ -> Logger.warning("discarded malformed whiteboard-v1 transient notification")
    end

    {:noreply, state}
  end

  defp publish_origin(state, probe) do
    payload =
      JSON.encode!(%{
        source: state.source_id,
        fingerprint: state.agreement.fingerprint,
        probe: probe
      })

    case Postgrex.query(state.publisher, "select pg_notify('#{@origin_channel}', $1)", [payload]) do
      {:ok, _result} ->
        agreement =
          if state.announcement_failed,
            do: %{state.agreement | discover_until: System.monotonic_time(:millisecond) + 2000},
            else: state.agreement

        %{state | announcement_failed: false, agreement: agreement}

      {:error, _reason} ->
        unless state.announcement_failed,
          do: Logger.error("whiteboard origin peer announcement failed")

        %{state | announcement_failed: true}
    end
  end

  defp observe_origin(episode, %{"type" => "view"} = frame) do
    # Decode only the client view fields; publisher/display metadata are server-only.
    wire =
      Map.take(
        frame,
        ~w(type x y width height bring origin_participant_id origin_connection_id origin_lead_stamp origin_epoch origin_sequence origin_proof)
      )

    with {:ok, {:view, view}} <- Protocol.decode(JSON.encode!(wire)) do
      ViewOrigin.valid?(view, episode)
    end
  end

  defp observe_origin(_episode, _frame), do: :ok

  defp parse_head(payload) do
    with [tenant_id, space_id, episode_id, scene_id, revision] <- String.split(payload, ":"),
         {:ok, episode} <-
           episode_key(%{
             "tenant_id" => tenant_id,
             "space_id" => space_id,
             "episode_id" => episode_id
           }),
         {:ok, _scene} <- UUID.dump(scene_id),
         {revision, ""} when revision >= 0 <- Integer.parse(revision) do
      {:ok, episode, String.downcase(scene_id), revision}
    else
      _ -> :error
    end
  end

  defp episode_key(%{
         "tenant_id" => tenant_id,
         "space_id" => space_id,
         "episode_id" => episode_id
       }) do
    with {:ok, _tenant} <- UUID.dump(tenant_id),
         {:ok, _space} <- UUID.dump(space_id),
         {:ok, _episode} <- UUID.dump(episode_id) do
      {:ok,
       %EpisodeKey{
         tenant_id: String.downcase(tenant_id),
         space_id: String.downcase(space_id),
         episode_id: String.downcase(episode_id)
       }}
    else
      _ -> :error
    end
  end

  defp episode_key(_episode), do: :error

  defp episode_map(episode),
    do: %{
      "tenant_id" => episode.tenant_id,
      "space_id" => episode.space_id,
      "episode_id" => episode.episode_id
    }

  defp source_id(value) when is_binary(value) do
    :crypto.hash(:sha256, value)
    |> Base.encode16(case: :lower)
  end

  defp group(episode), do: {__MODULE__, EpisodeKey.authority_key(episode)}
end
