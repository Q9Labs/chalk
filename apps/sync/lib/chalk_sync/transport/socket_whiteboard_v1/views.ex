defmodule ChalkSync.Transport.SocketWhiteboardV1.Views do
  @moduledoc """
  Cursor and view presence frames: rate limits, authorization and the view owner hand-off.
  """

  alias ChalkSync.Transport.SocketWhiteboardV1.Extensions
  alias ChalkSync.Transport.SocketWhiteboardV1.Lifecycle
  alias ChalkSync.WhiteboardV1.Episode
  alias ChalkSync.WhiteboardV1.Fanout
  alias ChalkSync.WhiteboardV1.Protocol
  alias ChalkSync.WhiteboardV1.ViewOwner

  defp publish_view(frame, view, state) do
    case ViewOwner.move(state.view_owner, frame, view) do
      :ok -> acknowledge_view(view, state)
      {:error, :overloaded} -> Lifecycle.stop(state, 1013, "view capacity exhausted", :overloaded)
    end
  catch
    :exit, _reason -> Lifecycle.stop(state, 1012, "view owner restarted", :view_owner_restarted)
  end

  defp acknowledge_view(%{input_id: id}, %{extensions: %Extensions{view: :owner}} = state),
    do: {:push, {:text, Protocol.encode!(%{"type" => "view_ack", "input_id" => id})}, state}

  defp acknowledge_view(_view, state), do: {:ok, state}

  def compatible_view(frame, %{extensions: %Extensions{view: :owner}}), do: frame

  def compatible_view(frame, %{extensions: %Extensions{view: :origins}}) do
    frame
    |> Map.drop(["owner_id", "owner_sequence"])
    |> Map.merge(%{
      "origin_participant_id" => frame["participant_id"],
      "origin_sequence" => frame["owner_sequence"],
      "origin_epoch" => frame["owner_id"]
    })
  end

  def compatible_view(frame, _state),
    do: Map.drop(frame, ["owner_id", "owner_sequence"])

  defp admit_view(_view, _identity, {:error, reason}), do: {:error, reason}

  defp admit_view(view, identity, :ok) do
    if authorized_view?(view, identity), do: :ok, else: {:error, :unauthorized}
  end

  defp authorized_view?(%{bring: false}, _identity), do: true

  defp authorized_view?(_bring, identity) do
    case Episode.connect(identity) do
      {:ok, %{"capabilities" => capabilities}} -> "manageWhiteboard" in capabilities
      _unavailable -> false
    end
  end

  defp admit_presence(state, kind) do
    now_ms = System.monotonic_time(:millisecond)
    limit = Map.fetch!(%{bring: 2, cursor: 60, view: 10}, kind)
    {started, count} = Map.get(state.presence_windows, kind, {now_ms, 0})
    {started, count} = if now_ms - started >= 1000, do: {now_ms, 0}, else: {started, count}

    if count < limit do
      {:ok,
       %{state | presence_windows: Map.put(state.presence_windows, kind, {started, count + 1})}}
    else
      {{:error, :rate_limited}, state}
    end
  end

  @doc "A cursor frame from this socket: rate limit it, then fan it out."
  def cursor(cursor, %{identity: identity, display_name: display_name} = state) do
    {admission, next} = admit_presence(state, :cursor)

    with :ok <- admission do
      Fanout.publish_cursor(identity.episode, %{
        "type" => "cursor",
        "participant_id" => identity.participant_id,
        "display_name" => display_name,
        "x" => cursor.x,
        "y" => cursor.y,
        "occurred_at" => occurred_at()
      })
    end

    {:ok, next}
  end

  @doc "A view frame from this socket: rate limit and authorize it, then hand it to the view owner."
  def view(view, %{identity: identity, display_name: display_name} = state) do
    {admission, next} = admit_presence(state, if(view.bring, do: :bring, else: :view))

    case admit_view(view, identity, admission) do
      :ok ->
        frame = %{
          "type" => "view",
          "participant_id" => identity.participant_id,
          "display_name" => display_name,
          "x" => view.x,
          "y" => view.y,
          "width" => view.width,
          "height" => view.height,
          "bring" => view.bring,
          "occurred_at" => occurred_at()
        }

        publish_view(frame, view, next)

      _denied ->
        {:ok, next}
    end
  end

  defp occurred_at do
    DateTime.utc_now() |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
  end
end
