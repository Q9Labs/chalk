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
    :connection_qualities
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
    :connection_qualities
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
      connection_qualities: %{}
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
            connection_qualities: Map.delete(state.connection_qualities, socket)
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
