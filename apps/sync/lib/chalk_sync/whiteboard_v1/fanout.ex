defmodule ChalkSync.WhiteboardV1.Fanout do
  @moduledoc "Disposable local and Postgres whiteboard-v1 head/cursor fan-out."

  use GenServer

  require Logger

  alias ChalkSync.Database
  alias ChalkSync.Stateholder.SessionKey
  alias ChalkSync.UUID

  @head_channel "chalk_whiteboard_v1_heads"
  @cursor_channel "chalk_whiteboard_v1_cursors"
  @server __MODULE__

  def start_link(options \\ []) do
    GenServer.start_link(__MODULE__, options, name: Keyword.get(options, :name, @server))
  end

  def subscribe(%SessionKey{} = session), do: :pg.join(group(session), self())
  def unsubscribe(%SessionKey{} = session), do: :pg.leave(group(session), self())

  def broadcast_local(%SessionKey{} = session, frame) do
    Enum.each(:pg.get_members(group(session)), &send(&1, {:whiteboard_v1_frame, frame}))
    :ok
  end

  def publish_cursor(%SessionKey{} = session, frame, server \\ @server) do
    broadcast_local(session, frame)

    if Process.whereis(server),
      do: GenServer.cast(server, {:publish_cursor, session, frame}),
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
    {:ok, publisher} = Postgrex.start_link(connection_options)

    {:ok,
     %{
       notifications: notifications,
       head_ref: head_ref,
       cursor_ref: cursor_ref,
       publisher: publisher,
       source_id: source_id
     }}
  end

  @impl GenServer
  def handle_cast({:publish_cursor, session, frame}, state) do
    payload =
      JSON.encode!(%{
        "source_node" => state.source_id,
        "session" => session_map(session),
        "frame" => frame
      })

    if byte_size(payload) <= 1_024 do
      case Postgrex.query(state.publisher, "select pg_notify('#{@cursor_channel}', $1)", [payload]) do
        {:ok, _result} ->
          :ok

        {:error, reason} ->
          Logger.warning("whiteboard cursor notification failed: #{inspect(reason)}")
      end
    end

    {:noreply, state}
  end

  @impl GenServer
  def handle_info(
        {:notification, notifications, head_ref, @head_channel, payload},
        %{notifications: notifications, head_ref: head_ref} = state
      ) do
    case parse_head(payload) do
      {:ok, session, scene_id, revision} ->
        Enum.each(
          :pg.get_members(group(session)),
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
            "session" => session,
            "frame" => frame
          }} <- JSON.decode(payload),
         false <- source_node == state.source_id,
         {:ok, session_key} <- session_key(session) do
      broadcast_local(session_key, frame)
    else
      true -> :ok
      _ -> Logger.warning("discarded malformed whiteboard-v1 cursor notification")
    end

    {:noreply, state}
  end

  defp parse_head(payload) do
    with [tenant_id, room_id, session_id, scene_id, revision] <- String.split(payload, ":"),
         {:ok, session} <-
           session_key(%{
             "tenant_id" => tenant_id,
             "room_id" => room_id,
             "session_id" => session_id
           }),
         {:ok, _scene} <- UUID.dump(scene_id),
         {revision, ""} when revision >= 0 <- Integer.parse(revision) do
      {:ok, session, String.downcase(scene_id), revision}
    else
      _ -> :error
    end
  end

  defp session_key(%{
         "tenant_id" => tenant_id,
         "room_id" => room_id,
         "session_id" => session_id
       }) do
    with {:ok, _tenant} <- UUID.dump(tenant_id),
         {:ok, _room} <- UUID.dump(room_id),
         {:ok, _session} <- UUID.dump(session_id) do
      {:ok,
       %SessionKey{
         tenant_id: String.downcase(tenant_id),
         room_id: String.downcase(room_id),
         session_id: String.downcase(session_id)
       }}
    else
      _ -> :error
    end
  end

  defp session_key(_session), do: :error

  defp session_map(session),
    do: %{
      "tenant_id" => session.tenant_id,
      "room_id" => session.room_id,
      "session_id" => session.session_id
    }

  defp source_id(value) when is_binary(value) do
    :crypto.hash(:sha256, value)
    |> Base.encode16(case: :lower)
  end

  defp group(session), do: {__MODULE__, SessionKey.authority_key(session)}
end
