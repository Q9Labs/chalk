defmodule ChalkSync.Live.Episode do
  @moduledoc "Bounded per-Episode media, presence, and directed-request coordination."

  alias ChalkSync.Live.DirectedRequests
  alias ChalkSync.Live.Episode.MediaObservation
  alias ChalkSync.Live.Episode.Projections
  require Projections
  alias ChalkSync.Live.Episode.Publication
  alias ChalkSync.Stateholder
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Postgres.Focus
  alias ChalkSync.Webhooks.Producer, as: WebhookProducer

  @enforce_keys [
    :episode,
    :connections,
    :requests,
    :screen_leases,
    :media_observed_items,
    :media_pauses,
    :media_stops,
    :media_items,
    :media_observation_cursor,
    :media_projection,
    :presence_projection,
    :connection_qualities,
    :app_states,
    :focus_webhooks
  ]
  defstruct [
    :episode,
    :connections,
    :requests,
    :screen_leases,
    :media_observed_items,
    :media_pauses,
    :media_stops,
    :media_items,
    :media_observation_cursor,
    :media_projection,
    :presence_projection,
    :connection_qualities,
    :app_states,
    :focus_webhooks
  ]

  @type t :: %__MODULE__{}

  @spec new(EpisodeKey.t()) :: t()
  def new(%EpisodeKey{} = episode) do
    %__MODULE__{
      episode: episode,
      connections: %{},
      requests: DirectedRequests.new(),
      screen_leases: %{},
      media_observed_items: [],
      media_pauses: %{},
      media_stops: %{},
      media_items: [],
      media_observation_cursor: nil,
      media_projection: nil,
      presence_projection: nil,
      connection_qualities: %{},
      app_states: %{},
      focus_webhooks: %{}
    }
  end

  @spec register(t(), Identity.t(), pid()) ::
          {:ok, t(), [map()], [map()]} | {:error, atom()}
  def register(%__MODULE__{} = state, %Identity{} = identity, socket) when is_pid(socket) do
    with {:ok, authority} <- recovery_authority(state, identity),
         {:ok, requests} <-
           DirectedRequests.register(state.requests, authority.participant_id, socket),
         next = %{
           state
           | connections:
               Map.put(
                 state.connections,
                 socket,
                 authority
               ),
             requests: requests
         },
         {:ok, next, _discarded_frames} <- MediaObservation.refresh_media(next, []),
         {:ok, next, snapshots} <- Projections.replace_live_projections(next) do
      {:ok, next, snapshots, snapshots}
    else
      {:retryable, reason} -> {:error, reason}
      {:error, reason} -> {:error, reason}
    end
  end

  @spec unregister(t(), pid()) :: t()
  def unregister(%__MODULE__{} = state, socket) do
    case Map.pop(state.connections, socket) do
      {nil, _connections} ->
        state

      {authority, connections} ->
        requests =
          DirectedRequests.unregister(
            state.requests,
            authority.participant_id,
            socket
          )

        %{
          state
          | connections: connections,
            requests: requests,
            connection_qualities: Map.delete(state.connection_qualities, socket),
            app_states: close_app_state(state, socket),
            focus_webhooks: drop_socket_focus_webhooks(state.focus_webhooks, socket)
        }
    end
  end

  @doc """
  Records how well one live socket's own link carries the call. The other guests see it in the
  presence stream, so the returned frames are the presence changes to broadcast. A socket that
  reports the tier it already reported changes nothing.
  """
  @spec set_connection_quality(t(), pid(), String.t()) ::
          {:ok, t(), [map()]} | {:error, atom()}
  def set_connection_quality(%__MODULE__{} = state, socket, quality)
      when Projections.is_connection_quality(quality) do
    cond do
      not Map.has_key?(state.connections, socket) ->
        {:error, :not_live}

      Map.get(state.connection_qualities, socket) == quality ->
        {:ok, state, []}

      true ->
        Projections.presence_snapshot(%{
          state
          | connection_qualities: Map.put(state.connection_qualities, socket, quality)
        })
    end
  end

  @doc """
  Records the observable app state one live socket reports. Closing the prior interval is the
  only durable write; a socket loss leaves the intervening time as not reporting.
  """
  @spec set_app_state(t(), pid(), String.t(), boolean()) :: {:ok, t(), [map()]} | {:error, atom()}
  def set_app_state(%__MODULE__{} = state, socket, app_state, windowed)
      when app_state in ["active", "inactive", "background"] and is_boolean(windowed) do
    case Map.fetch(state.connections, socket) do
      :error ->
        {:error, :not_live}

      {:ok, authority} ->
        now_ms = System.system_time(:millisecond)
        current = Map.get(state.app_states, socket)

        if (current && current.state == app_state) and current.windowed == windowed do
          {:ok, state, []}
        else
          replace_app_state(state, socket, authority, current, app_state, windowed, now_ms)
        end
    end
  end

  defp replace_app_state(state, socket, authority, current, app_state, windowed, now_ms) do
    close_reported_app_state(state, socket, authority, current, now_ms)
    report = %{state: app_state, windowed: windowed, started_at_ms: now_ms}
    Process.send_after(self(), {:focus_state_held, socket, now_ms}, 10_000)

    focus_webhooks =
      if current,
        do: Map.delete(state.focus_webhooks, {socket, current.started_at_ms}),
        else: state.focus_webhooks

    Projections.presence_snapshot(%{
      state
      | app_states: Map.put(state.app_states, socket, report),
        focus_webhooks: focus_webhooks
    })
  end

  defp close_app_state(state, socket) do
    case {Map.pop(state.app_states, socket), Map.get(state.connections, socket)} do
      {{nil, app_states}, _authority} ->
        app_states

      {{current, app_states}, authority} when is_map(current) and is_map(authority) ->
        close_reported_app_state(
          state,
          socket,
          authority,
          current,
          System.system_time(:millisecond)
        )

        app_states

      {_result, _authority} ->
        state.app_states
    end
  end

  @doc """
  Emits the live Focus webhook once a reported state has actually held for ten seconds.
  Timer messages for replaced or disconnected reports are stale and do nothing.
  """
  @spec emit_held_focus(t(), pid(), integer()) :: t()
  def emit_held_focus(%__MODULE__{} = state, socket, started_at_ms) do
    with current when is_map(current) <- Map.get(state.app_states, socket),
         true <- current.started_at_ms == started_at_ms,
         authority when is_map(authority) <- Map.get(state.connections, socket),
         false <- Map.has_key?(state.focus_webhooks, {socket, started_at_ms}),
         true <- System.system_time(:millisecond) - started_at_ms >= 10_000 do
      produce_focus_changed(state, authority, current)

      %{
        state
        | focus_webhooks: Map.put(state.focus_webhooks, {socket, started_at_ms}, true)
      }
    else
      _ -> state
    end
  end

  defp close_reported_app_state(_state, _socket, _authority, nil, _ended_at_ms), do: :ok

  defp close_reported_app_state(state, socket, authority, current, ended_at_ms) do
    if ended_at_ms - current.started_at_ms >= 10_000 do
      # The timer normally emits while the state is live. This close-time fallback covers a
      # coordinator that did not run long enough to receive that timer, without double-sending.
      unless Map.has_key?(state.focus_webhooks, {socket, current.started_at_ms}) do
        produce_focus_changed(state, authority, current)
      end
    end

    Focus.close_interval(
      state.episode,
      authority.participant_id,
      current.state,
      current.windowed,
      current.started_at_ms,
      ended_at_ms
    )
  end

  defp produce_focus_changed(state, authority, current) do
    WebhookProducer.produce_focus_changed(state.episode, %{
      id: authority.participant_id,
      identity_id: Map.get(authority, :identity_id),
      space_id: state.episode.space_id,
      episode_id: state.episode.episode_id,
      app_state: current.state,
      windowed: current.windowed,
      since: DateTime.from_unix!(current.started_at_ms, :millisecond)
    })
  end

  defp drop_socket_focus_webhooks(webhooks, socket) do
    keys =
      webhooks
      |> Enum.filter(fn {{candidate, _started_at}, true} -> candidate == socket end)
      |> Enum.map(fn {key, true} -> key end)

    Map.drop(webhooks, keys)
  end

  @spec presence_snapshot(t()) :: {:ok, t(), [map()]} | {:error, atom()}
  def presence_snapshot(%__MODULE__{} = state), do: Projections.presence_snapshot(state)

  @spec live_target(t(), Identity.t(), map()) :: {t(), map()}
  def live_target(%__MODULE__{} = state, %Identity{} = identity, target) do
    with {:ok, authority} <- actor_authority(state, identity),
         source = target_source(target.name),
         :ok <- authorize(authority, target_capability(source)) do
      Publication.apply_live_target(state, identity, authority, source, target)
    else
      {:retryable, reason} -> {state, Publication.live_result(target, :retryable_failure, reason)}
      {:error, reason} -> {state, Publication.live_result(target, :terminal_failure, reason)}
    end
  end

  @spec reconcile(t(), keyword()) :: {:ok, t(), [map()]} | {:error, atom()}
  def reconcile(%__MODULE__{} = state, options \\ []) do
    MediaObservation.refresh_media(state, options)
  end

  @spec directed_request(t(), Identity.t(), map(), integer()) :: {t(), map()}
  def directed_request(%__MODULE__{} = state, %Identity{} = identity, request, now_ms) do
    case actor_authority(state, identity) do
      {:ok, actor} -> authorize_directed_request(state, actor, request, now_ms)
      _unavailable -> {state, directed_result(request.request_id, :rejected)}
    end
  end

  @spec acknowledge_request(t(), Identity.t(), String.t(), integer()) :: t()
  def acknowledge_request(%__MODULE__{} = state, %Identity{} = identity, request_id, now_ms) do
    with {:ok, authority} <- actor_authority(state, identity),
         {:ok, requests} <-
           DirectedRequests.acknowledge(
             state.requests,
             authority.participant_id,
             request_id,
             now_ms
           ) do
      %{state | requests: requests}
    else
      _reason -> state
    end
  end

  @spec expire_requests(t(), integer()) :: {t(), [{pid(), map()}]}
  def expire_requests(%__MODULE__{} = state, now_ms) do
    {requests, expired} = DirectedRequests.expire(state.requests, now_ms)

    deliveries =
      for result <- expired,
          {socket, authority} <- state.connections,
          authority.participant_id == result.actor_participant_id do
        {socket, directed_result(result.request_id, result.result)}
      end

    {%{state | requests: requests}, deliveries}
  end

  defp recovery_authority(state, identity) do
    case actor_authority(state, identity) do
      {:error, :participant_inactive} ->
        case Stateholder.recover(identity, nil) do
          {:ok, %{mode: mode}} when mode != :terminal ->
            {:ok,
             %{
               participant_id: identity.participant_id,
               identity_id: identity.identity_id,
               generation: identity.participant_generation
             }}

          _ ->
            {:error, :participant_inactive}
        end

      result ->
        result
    end
  end

  defp actor_authority(state, identity) do
    Stateholder.participant_authority(
      state.episode,
      identity.participant_id,
      identity.participant_generation
    )
  end

  defp authorize_directed_request(state, actor, request, now_ms) do
    with :ok <- authorize(actor, "requestMediaOthers"),
         {:ok, _target} <-
           Stateholder.participant_authority(
             state.episode,
             request.target_participant_id,
             nil
           ) do
      request =
        request
        |> Map.put(:name, directed_name(request.name))
        |> Map.put(:actor_participant_id, actor.participant_id)

      {requests, result} = DirectedRequests.deliver(state.requests, request, now_ms)
      {%{state | requests: requests}, directed_result(request.request_id, result)}
    else
      {:error, :capability_denied} -> {state, directed_result(request.request_id, :rejected)}
      _target_unavailable -> {state, directed_result(request.request_id, :target_unavailable)}
    end
  end

  defp authorize(%{capabilities: capabilities}, required) do
    if required in capabilities, do: :ok, else: {:error, :capability_denied}
  end

  defp target_source(name) when name in [:set_microphone_enabled, "set_microphone_enabled"],
    do: :microphone

  defp target_source(name) when name in [:set_camera_enabled, "set_camera_enabled"], do: :camera

  defp target_source(name) when name in [:set_screen_share_enabled, "set_screen_share_enabled"],
    do: :screen

  defp target_capability(:microphone), do: "publishAudio"
  defp target_capability(:camera), do: "publishVideo"
  defp target_capability(:screen), do: "publishScreen"

  defp directed_name("request_unmute"), do: :request_unmute
  defp directed_name("request_start_camera"), do: :request_start_camera
  defp directed_name(name), do: name

  defp directed_result(request_id, result) do
    %{
      "type" => "directed_request_result",
      "request_id" => request_id,
      "result" => Atom.to_string(result)
    }
  end
end
