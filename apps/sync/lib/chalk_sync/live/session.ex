defmodule ChalkSync.Live.Session do
  @moduledoc "Bounded per-Session media, presence, and directed-request coordination."

  alias ChalkSync.Database
  alias ChalkSync.Live.DirectedRequests
  alias ChalkSync.Live.MediaPlaneCall
  alias ChalkSync.Live.Projection
  alias ChalkSync.Live.ScreenShareLease
  alias ChalkSync.Stateholder
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.SessionKey
  alias ChalkSync.UUID

  @enforce_keys [
    :session,
    :connections,
    :requests,
    :screen_leases,
    :media_items,
    :media_observation_cursor,
    :media_projection,
    :presence_projection
  ]
  defstruct [
    :session,
    :connections,
    :requests,
    :screen_leases,
    :media_items,
    :media_observation_cursor,
    :media_projection,
    :presence_projection
  ]

  @type t :: %__MODULE__{}

  @spec new(SessionKey.t()) :: t()
  def new(%SessionKey{} = session) do
    %__MODULE__{
      session: session,
      connections: %{},
      requests: DirectedRequests.new(),
      screen_leases: %{},
      media_items: [],
      media_observation_cursor: nil,
      media_projection: nil,
      presence_projection: nil
    }
  end

  @spec register(t(), Identity.t(), pid()) ::
          {:ok, t(), [map()], [map()]} | {:error, atom()}
  def register(%__MODULE__{} = state, %Identity{} = identity, socket) when is_pid(socket) do
    with {:ok, authority} <- actor_authority(state, identity),
         {:ok, requests} <-
           DirectedRequests.register(state.requests, authority.participant_session_id, socket),
         next = %{
           state
           | connections: Map.put(state.connections, socket, authority),
             requests: requests
         },
         {:ok, next, _discarded_frames} <- refresh_media(next, []),
         {:ok, next, snapshots} <- replace_live_projections(next) do
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
            authority.participant_session_id,
            socket
          )

        %{state | connections: connections, requests: requests}
    end
  end

  @spec live_target(t(), Identity.t(), map()) :: {t(), map()}
  def live_target(%__MODULE__{} = state, %Identity{} = identity, target) do
    with {:ok, authority} <- actor_authority(state, identity),
         source = target_source(target.name),
         :ok <- authorize(authority, target_capability(source)) do
      apply_live_target(state, identity, authority, source, target)
    else
      {:retryable, reason} -> {state, live_result(target, :retryable_failure, reason)}
      {:error, reason} -> {state, live_result(target, :terminal_failure, reason)}
    end
  end

  @spec reconcile(t(), keyword()) :: {:ok, t(), [map()]} | {:error, atom()}
  def reconcile(%__MODULE__{} = state, options \\ []) do
    refresh_media(state, options)
  end

  @spec presence_snapshot(t()) :: {:ok, t(), [map()]} | {:error, atom()}
  def presence_snapshot(%__MODULE__{} = state) do
    case reconcile_projection(:presence, state.presence_projection, presence_items(state)) do
      {:ok, projection, frames} -> {:ok, %{state | presence_projection: projection}, frames}
      {:error, reason} -> {:error, reason}
    end
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
             authority.participant_session_id,
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
          authority.participant_session_id == result.actor_participant_session_id do
        {socket, directed_result(result.request_id, result.result)}
      end

    {%{state | requests: requests}, deliveries}
  end

  defp refresh_media(state, options) do
    with {:ok, observation} <- observed_media(state) do
      apply_media_observation(state, observation, options)
    end
  end

  defp apply_media_observation(state, observation, options) do
    cursor = {observation.incarnation, observation.sequence}

    case compare_media_cursor(cursor, state.media_observation_cursor) do
      :older ->
        {:ok, state, []}

      :equal ->
        apply_equal_media_observation(state, observation.publications)

      :newer ->
        apply_newer_media_observation(state, cursor, observation.publications, options)
    end
  end

  defp apply_equal_media_observation(state, publications) do
    media_items = normalize_media_items(publications)

    if media_items == state.media_items,
      do: {:ok, state, []},
      else: {:error, :dependency_unavailable}
  end

  defp apply_newer_media_observation(state, cursor, publications, options) do
    media_items = normalize_media_items(publications)

    with {:ok, next} <- reconcile_screen_leases(state, media_items, options) do
      next = %{next | media_items: media_items, media_observation_cursor: cursor}

      case reconcile_projection(:media, state.media_projection, media_items) do
        {:ok, projection, frames} ->
          {:ok, %{next | media_projection: projection}, frames}

        {:error, reason} ->
          {:error, reason}
      end
    end
  end

  defp replace_live_projections(state) do
    with {:ok, media_projection, media_frame} <- Projection.replace(:media, state.media_items),
         {:ok, presence_projection, presence_frame} <-
           Projection.replace(:presence, presence_items(state)) do
      next = %{
        state
        | media_projection: media_projection,
          presence_projection: presence_projection
      }

      {:ok, next, [media_frame, presence_frame]}
    end
  end

  defp reconcile_projection(stream, nil, items) do
    case Projection.replace(stream, items) do
      {:ok, projection, frame} -> {:ok, projection, [frame]}
      {:error, reason} -> {:error, reason}
    end
  end

  defp reconcile_projection(_stream, projection, items),
    do: Projection.reconcile(projection, items)

  defp observed_media(state) do
    case media_plane() do
      nil ->
        {:ok, %{incarnation: 0, sequence: 0, publications: []}}

      {module, adapter} ->
        observe_media(module, adapter, state)
    end
  end

  defp observe_media(module, adapter, state) do
    MediaPlaneCall.invoke(fn ->
      module.observe_session_publications(adapter, state.session)
    end)
    |> observed_media_result()
  end

  defp observed_media_result(
         {:ok,
          %{incarnation: incarnation, sequence: sequence, publications: publications} =
            observation}
       )
       when is_integer(incarnation) and incarnation >= 0 and is_integer(sequence) and
              sequence >= 0 and is_list(publications) do
    {:ok, observation}
  end

  defp observed_media_result({:error, reason}), do: {:error, reason}
  defp observed_media_result(_invalid), do: {:error, :dependency_unavailable}

  defp normalize_media_items(publications) do
    publications
    |> Enum.map(&media_item/1)
    |> Enum.sort_by(&{&1["participant_session_id"], &1["source"]})
  end

  defp compare_media_cursor(_cursor, nil), do: :newer
  defp compare_media_cursor(cursor, cursor), do: :equal
  defp compare_media_cursor(cursor, current) when cursor < current, do: :older
  defp compare_media_cursor(_cursor, _current), do: :newer

  defp presence_items(state) do
    state.connections
    |> Map.values()
    |> Enum.uniq_by(& &1.participant_session_id)
    |> Enum.map(fn authority ->
      %{
        "participant_session_id" => authority.participant_session_id,
        "state" => "connected",
        "speaking" => false,
        "active_speaker" => false
      }
    end)
  end

  defp media_item(item) do
    %{
      "participant_session_id" => item.participant_session_id,
      "source" => Atom.to_string(item.source),
      "enabled" => item.enabled,
      "publication_id" => item.publication_id
    }
  end

  defp apply_live_target(state, identity, authority, source, %{enabled: true} = target) do
    enable_publication(state, identity, authority, source, target)
  end

  defp apply_live_target(state, _identity, authority, source, target) do
    case media_plane() do
      nil ->
        {state, live_result(target, :retryable_failure, :dependency_unavailable)}

      {module, adapter} ->
        outcome =
          MediaPlaneCall.invoke(fn ->
            module.revoke_publication(
              adapter,
              target.operation_id,
              state.session,
              authority.participant_session_id,
              source
            )
          end)
          |> provider_outcome()

        state = maybe_release_screen_lease(state, authority, source, false, outcome)
        {state, live_result(target, outcome)}
    end
  end

  defp enable_publication(state, identity, authority, source, target) do
    with {module, adapter} <- media_plane() || {:error, :dependency_unavailable},
         {:ok, reservation} <-
           Stateholder.reserve_publication_grant(identity, target.operation_id, source) do
      enable_reserved_publication(
        state,
        authority,
        source,
        target,
        reservation,
        module,
        adapter
      )
    else
      {:retryable, reason} -> {state, live_result(target, :retryable_failure, reason)}
      {:error, reason} -> {state, live_result(target, :terminal_failure, reason)}
    end
  end

  defp enable_reserved_publication(
         state,
         authority,
         :screen,
         target,
         reservation,
         module,
         adapter
       ) do
    case acquire_screen_lease(state, authority, target.operation_id) do
      {:ok, lease} ->
        outcome =
          if screen_observed?(state.media_items, authority.participant_session_id),
            do: :satisfied,
            else: grant(module, adapter, state, authority, :screen, target.operation_id)

        {reported, retain?} = complete_grant(state, reservation, outcome)
        retain_or_release_screen_lease(state, authority, lease, retain?, target, reported)

      {:error, reason} ->
        _ = complete_grant(state, reservation, {:terminal_failure, reason})
        {state, screen_lease_failure(target, reason)}
    end
  end

  defp enable_reserved_publication(
         state,
         authority,
         source,
         target,
         reservation,
         module,
         adapter
       ) do
    outcome = grant(module, adapter, state, authority, source, target.operation_id)
    {reported, _retain?} = complete_grant(state, reservation, outcome)
    {state, live_result(target, reported)}
  end

  defp grant(module, adapter, state, authority, source, operation_id) do
    MediaPlaneCall.invoke(fn ->
      module.grant_publication(
        adapter,
        operation_id,
        state.session,
        authority.participant_session_id,
        source
      )
    end)
    |> provider_outcome()
  end

  defp complete_grant(state, reservation, outcome) do
    completion =
      Stateholder.complete_publication_grant(
        state.session,
        reservation.reservation_id,
        outcome
      )

    completed_grant_result(outcome, completion)
  end

  defp completed_grant_result(outcome, {:ok, %{result: :authorized}}),
    do: {retryable_provider_outcome(outcome), retain_grant_authority?(outcome)}

  defp completed_grant_result(_outcome, {:ok, %{result: :cleanup_required}}),
    do: {{:terminal_failure, :authority_changed}, false}

  defp completed_grant_result(_outcome, {:retryable, reason}),
    do: {{:retryable_failure, reason}, true}

  defp completed_grant_result(_outcome, {:error, _reason}),
    do: {{:terminal_failure, :authority_changed}, false}

  defp retryable_provider_outcome(:ambiguous),
    do: {:retryable_failure, :dependency_unavailable}

  defp retryable_provider_outcome(outcome), do: outcome

  defp provider_outcome({:error, reason}), do: {:retryable_failure, reason}
  defp provider_outcome(outcome), do: outcome

  defp retain_grant_authority?({:terminal_failure, _reason}), do: false
  defp retain_grant_authority?(_outcome), do: true

  defp retain_or_release_screen_lease(state, authority, lease, true, target, outcome) do
    leases = Map.put(state.screen_leases, authority.participant_session_id, lease)
    {%{state | screen_leases: leases}, live_result(target, outcome)}
  end

  defp retain_or_release_screen_lease(state, _authority, lease, false, target, outcome) do
    _ = release_screen_lease(state, lease)
    {state, live_result(target, outcome)}
  end

  defp maybe_release_screen_lease(state, authority, :screen, false, outcome)
       when outcome in [:confirmed, :satisfied] do
    case Map.pop(state.screen_leases, authority.participant_session_id) do
      {nil, _leases} ->
        state

      {lease, leases} ->
        _ = release_screen_lease(state, lease)
        %{state | screen_leases: leases}
    end
  end

  defp maybe_release_screen_lease(state, _authority, _source, _enabled, _outcome), do: state

  defp reconcile_screen_leases(state, media_items, options) do
    case observed_screen_participants(media_items) do
      [] -> release_absent_screen_leases(state, media_items, options)
      [participant_id] -> reconcile_single_screen(state, media_items, participant_id, options)
      _conflicting -> {:error, :conflicting_screen_publications}
    end
  end

  defp reconcile_single_screen(state, media_items, participant_id, options) do
    with {:ok, state} <- release_absent_screen_leases(state, media_items, options) do
      case Map.fetch(state.screen_leases, participant_id) do
        {:ok, _lease} -> {:ok, state}
        :error -> acquire_observed_screen_lease(state, participant_id, options)
      end
    end
  end

  defp release_absent_screen_leases(state, media_items, options) do
    Enum.reduce_while(state.screen_leases, {:ok, state}, fn
      {participant_id, lease}, {:ok, current} ->
        result =
          if screen_observed?(media_items, participant_id) do
            reconcile_observed_screen_lease(current, participant_id, lease, options)
          else
            {:ok, release_and_forget_screen_lease(current, participant_id, lease)}
          end

        case result do
          {:ok, next} -> {:cont, {:ok, next}}
          {:error, _reason} = error -> {:halt, error}
        end
    end)
  end

  defp reconcile_observed_screen_lease(state, participant_id, lease, options) do
    case Stateholder.participant_authority(state.session, participant_id, lease.owner_generation) do
      {:ok, %{generation: generation}} when generation == lease.owner_generation ->
        renew_screen_lease(state, participant_id, lease, options)

      {:retryable, reason} ->
        {:error, reason}

      _authority_changed ->
        {:ok, release_and_forget_screen_lease(state, participant_id, lease)}
    end
  end

  defp renew_screen_lease(state, participant_id, lease, options) do
    with {:ok, connection} <- database_connection(state),
         {:ok, renewed} <- ScreenShareLease.renew(connection, state.session, lease, options) do
      {:ok, %{state | screen_leases: Map.put(state.screen_leases, participant_id, renewed)}}
    else
      {:error, :lease_expired} ->
        rotate_screen_lease(state, participant_id, lease, options)

      {:error, reason} ->
        {:error, reason}
    end
  catch
    :exit, _reason -> {:error, :dependency_unavailable}
  end

  defp rotate_screen_lease(state, participant_id, lease, options) do
    with {:ok, connection} <- database_connection(state),
         {:ok, rotated} <-
           ScreenShareLease.acquire(
             connection,
             state.session,
             participant_id,
             lease.owner_generation,
             options
           ) do
      {:ok, %{state | screen_leases: Map.put(state.screen_leases, participant_id, rotated)}}
    else
      {:error, reason} -> {:error, reason}
    end
  catch
    :exit, _reason -> {:error, :dependency_unavailable}
  end

  defp acquire_observed_screen_lease(state, participant_id, options) do
    with {:ok, authority} <- Stateholder.participant_authority(state.session, participant_id, nil),
         {:ok, connection} <- database_connection(state),
         {:ok, lease} <-
           ScreenShareLease.acquire(
             connection,
             state.session,
             participant_id,
             authority.generation,
             options
           ) do
      {:ok, %{state | screen_leases: Map.put(state.screen_leases, participant_id, lease)}}
    else
      {:retryable, reason} -> {:error, reason}
      {:error, reason} -> {:error, reason}
    end
  catch
    :exit, _reason -> {:error, :dependency_unavailable}
  end

  defp release_and_forget_screen_lease(state, participant_id, lease) do
    _ = release_screen_lease(state, lease)
    %{state | screen_leases: Map.delete(state.screen_leases, participant_id)}
  end

  defp screen_observed?(media_items, participant_id) do
    Enum.any?(media_items, fn item ->
      item["participant_session_id"] == participant_id and item["source"] == "screen" and
        item["enabled"]
    end)
  end

  defp observed_screen_participants(media_items) do
    media_items
    |> Enum.filter(&(&1["source"] == "screen" and &1["enabled"]))
    |> Enum.map(& &1["participant_session_id"])
    |> Enum.uniq()
  end

  defp actor_authority(state, identity) do
    Stateholder.participant_authority(
      state.session,
      identity.participant_session_id,
      identity.participant_session_generation
    )
  end

  defp acquire_screen_lease(state, authority, operation_id) do
    with {:ok, connection} <- database_connection(state) do
      ScreenShareLease.acquire(
        connection,
        state.session,
        authority.participant_session_id,
        authority.generation,
        screen_lease_options(operation_id)
      )
    end
  catch
    :exit, _reason -> {:error, :dependency_unavailable}
  end

  defp screen_lease_options(operation_id) do
    case UUID.dump(operation_id) do
      {:ok, _uuid} -> [lease_id: operation_id]
      :error -> []
    end
  end

  defp release_screen_lease(state, lease) do
    with {:ok, connection} <- database_connection(state) do
      ScreenShareLease.release(connection, state.session, lease)
    end
  catch
    :exit, _reason -> {:error, :dependency_unavailable}
  end

  defp database_connection(state) do
    configured = Application.get_env(:chalk_sync, :database_connections)

    if configured || Process.whereis(ChalkSync.Database.Registry),
      do: {:ok, Database.connection(state.session)},
      else: {:error, :dependency_unavailable}
  end

  defp authorize_directed_request(state, actor, request, now_ms) do
    with :ok <- authorize(actor, "requestMediaOthers"),
         {:ok, _target} <-
           Stateholder.participant_authority(
             state.session,
             request.target_participant_session_id,
             nil
           ) do
      request =
        request
        |> Map.put(:name, directed_name(request.name))
        |> Map.put(:actor_participant_session_id, actor.participant_session_id)

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

  defp screen_lease_failure(target, :dependency_unavailable),
    do: live_result(target, :retryable_failure, :dependency_unavailable)

  defp screen_lease_failure(target, reason),
    do: live_result(target, :terminal_failure, reason)

  defp directed_name("request_unmute"), do: :request_unmute
  defp directed_name("request_start_camera"), do: :request_start_camera
  defp directed_name(name), do: name

  defp name_string(name) when is_atom(name), do: Atom.to_string(name)
  defp name_string(name) when is_binary(name), do: name

  defp live_result(target, {outcome, error_code})
       when outcome in [:retryable_failure, :terminal_failure],
       do: live_result(target, outcome, error_code)

  defp live_result(target, outcome), do: live_result(target, outcome, nil)

  defp live_result(target, outcome, error_code) do
    %{
      "type" => "live_target_result",
      "operation_id" => target.operation_id,
      "name" => name_string(target.name),
      "outcome" => Atom.to_string(outcome),
      "error_code" => error_code && Atom.to_string(error_code)
    }
  end

  defp directed_result(request_id, result) do
    %{
      "type" => "directed_request_result",
      "request_id" => request_id,
      "result" => Atom.to_string(result)
    }
  end

  defp media_plane, do: Application.get_env(:chalk_sync, :media_plane)
end
